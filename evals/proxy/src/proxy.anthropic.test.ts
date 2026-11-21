import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  chunk,
  completion,
  type FakeHandler,
  type FakeUpstream,
  openRequest,
  rawRequest,
  sendJson,
  sendSse,
  startFakeUpstream,
} from "./fake-upstream.ts";
import { type ProxyOptions, type RunningProxy, startProxy } from "./proxy.ts";
import { type ProxyRecord, ProxyRecordSchema } from "./record.ts";
import { SseParser } from "./sse.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Setup {
  upstream: FakeUpstream;
  proxy: RunningProxy;
  records(): Promise<ProxyRecord[]>;
}

async function setup(handler: FakeHandler, options: Partial<ProxyOptions> = {}): Promise<Setup> {
  const upstream = await startFakeUpstream(handler);
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-proxy-anthropic-"));
  const recordPath = path.join(dir, "records.jsonl");
  const proxy = await startProxy({ upstream: upstream.url, recordPath, log: () => {}, ...options });
  cleanups.push(async () => {
    await proxy.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    upstream,
    proxy,
    async records() {
      await proxy.close();
      return (await readFile(recordPath, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => ProxyRecordSchema.parse(JSON.parse(l)))
        .sort((a, b) => a.seq - b.seq);
    },
  };
}

const anthropicHeaders = {
  "content-type": "application/json",
  "x-api-key": "dummy-key",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "some-beta-2099-01-01,another-beta",
};

const readTool = {
  name: "Read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

async function post(
  s: Setup,
  body: unknown,
  pathname = "/v1/messages?beta=true",
  headers = anthropicHeaders,
) {
  const res = await rawRequest(`${s.proxy.url}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = res.body.toString("utf8");
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

function parseEvents(text: string): { event: string; data: Record<string, unknown> }[] {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const parser = new SseParser((e) => events.push({ event: e.event, data: JSON.parse(e.data) }));
  parser.push(text);
  parser.end();
  return events;
}

describe("Anthropic Messages translation", () => {
  test("non-streamed plain text", async () => {
    const s = await setup((_req, res) =>
      sendJson(
        res,
        200,
        completion({ content: "Hi there." }, "stop", {
          usage: {
            prompt_tokens: 50,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      ),
    );
    const res = await post(s, {
      model: "claude-test",
      max_tokens: 256,
      system: "Be nice.",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(res.status).toBe(200);
    const message = res.json();
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "Hi there." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 40 },
    });
    expect(message.id).toMatch(/^msg_/);

    const seen = s.upstream.requests[0];
    expect(seen?.url).toBe("/v1/chat/completions");
    expect(seen?.headers.authorization).toBe("Bearer dummy-key");
    expect(seen?.headers["x-api-key"]).toBeUndefined();
    expect(seen?.headers["anthropic-beta"]).toBeUndefined();
    expect(seen?.json).toEqual({
      model: "claude-test",
      max_tokens: 256,
      messages: [
        { role: "system", content: "Be nice." },
        { role: "user", content: "Hello" },
      ],
    });

    const [record] = await s.records();
    expect(record).toMatchObject({
      api: "anthropic.messages",
      path: "/v1/messages",
      upstream_path: "/v1/chat/completions",
      model: "claude-test",
      stream: false,
      status: 200,
      request: { messages: 1, tools: 0 },
      usage: { prompt_tokens: 50, completion_tokens: 3, cached_tokens: 40 },
      finish_reason: "stop",
      error: null,
    });
  });

  test("a multi-turn tool loop: tool_use, then tool_result, then the answer", async () => {
    let turn = 0;
    const s = await setup((_req, res) => {
      turn++;
      if (turn === 1) {
        sendJson(
          res,
          200,
          completion(
            {
              content: "Reading it.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "Read", arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            "tool_calls",
          ),
        );
      } else {
        sendJson(res, 200, completion({ content: "a.ts exports a." }, "stop"));
      }
    });
    const first = await post(s, {
      model: "m",
      max_tokens: 100,
      tools: [readTool],
      messages: [{ role: "user", content: "What does a.ts export?" }],
    });
    const assistant = first.json();
    expect(assistant.stop_reason).toBe("tool_use");
    expect(assistant.content).toEqual([
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.ts" } },
    ]);

    const second = await post(s, {
      model: "m",
      max_tokens: 100,
      tools: [readTool],
      messages: [
        { role: "user", content: "What does a.ts export?" },
        { role: "assistant", content: assistant.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "export const a = 1;" }],
        },
      ],
    });
    expect(second.json()).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "a.ts exports a." }],
    });
    expect(
      (s.upstream.requests[1]?.json as { messages?: unknown[] } | undefined)?.messages,
    ).toEqual([
      { role: "user", content: "What does a.ts export?" },
      {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
    ]);
    const records = await s.records();
    expect(records[0]?.tool_calls).toEqual([
      expect.objectContaining({ name: "Read", arguments_valid_json: true, schema_valid: true }),
    ]);
    expect(records[1]?.request).toMatchObject({ messages: 3, tools: 1 });
  });

  test("streamed: reasoning, text and parallel tool calls", async () => {
    const s = await setup((_req, res) =>
      sendSse(res, [
        chunk({ role: "assistant", reasoning_content: "Need both files." }),
        chunk({ content: "Reading both." }),
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "Read", arguments: '{"path":"b.ts","x":1}' },
            },
          ],
        }),
        chunk({}, {}, "tool_calls"),
        { id: "x", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
      ]),
    );
    const res = await post(s, {
      model: "claude-test",
      max_tokens: 1000,
      stream: true,
      tools: [readTool],
      messages: [{ role: "user", content: "Read a.ts and b.ts" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseEvents(res.text);
    const view = events.map((e) =>
      e.event === "content_block_start"
        ? `start ${e.data.index} ${(e.data.content_block as { type: string }).type}`
        : e.event === "content_block_delta"
          ? `delta ${e.data.index} ${(e.data.delta as { type: string }).type}`
          : e.event === "content_block_stop"
            ? `stop ${e.data.index}`
            : e.event,
    );
    expect(view).toEqual([
      "message_start",
      "ping",
      "start 0 thinking",
      "delta 0 thinking_delta",
      "stop 0",
      "start 1 text",
      "delta 1 text_delta",
      "stop 1",
      "start 2 tool_use",
      "delta 2 input_json_delta",
      "stop 2",
      "start 3 tool_use",
      "delta 3 input_json_delta",
      "stop 3",
      "message_delta",
      "message_stop",
    ]);
    const messageDelta = events.find((e) => e.event === "message_delta")?.data;
    expect(messageDelta).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(s.upstream.requests[0]?.json).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    const [record] = await s.records();
    expect(record).toMatchObject({
      api: "anthropic.messages",
      stream: true,
      status: 200,
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    });
    expect(record?.tool_calls.map((t) => [t.id, t.arguments_valid_json, t.schema_valid])).toEqual([
      ["call_a", true, true],
      ["call_b", true, false],
    ]);
  });

  test("malformed arguments give well-formed responses and are recorded as invalid", async () => {
    const bad = '{"path": "a.ts"';
    let streamed = false;
    const s = await setup((_req, res) => {
      if (streamed) {
        void sendSse(res, [
          chunk({
            tool_calls: [
              { index: 0, id: "c1", type: "function", function: { name: "Read", arguments: bad } },
            ],
          }),
          chunk({}, {}, "tool_calls"),
        ]);
      } else {
        sendJson(
          res,
          200,
          completion(
            {
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "Read", arguments: bad } },
              ],
            },
            "tool_calls",
          ),
        );
      }
    });
    const plain = await post(s, {
      model: "m",
      max_tokens: 10,
      tools: [readTool],
      messages: [{ role: "user", content: "x" }],
    });
    expect(plain.json().content).toEqual([{ type: "tool_use", id: "c1", name: "Read", input: {} }]);
    streamed = true;
    const stream = await post(s, {
      model: "m",
      max_tokens: 10,
      stream: true,
      tools: [readTool],
      messages: [{ role: "user", content: "x" }],
    });
    const deltas = parseEvents(stream.text).filter(
      (e) => (e.data.delta as { type?: string } | undefined)?.type === "input_json_delta",
    );
    expect(deltas.map((e) => (e.data.delta as { partial_json: string }).partial_json)).toEqual([
      "{}",
    ]);
    const records = await s.records();
    for (const record of records) {
      expect(record.tool_calls).toEqual([
        expect.objectContaining({ name: "Read", arguments_valid_json: false, schema_valid: null }),
      ]);
    }
  });

  test("images reach the upstream as image_url parts", async () => {
    const s = await setup((_req, res) =>
      sendJson(res, 200, completion({ content: "A cat." }, "stop")),
    );
    await post(s, {
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
            { type: "text", text: "What is it?" },
          ],
        },
      ],
    });
    expect(
      (s.upstream.requests[0]?.json as { messages?: unknown[] } | undefined)?.messages,
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "text", text: "What is it?" },
        ],
      },
    ]);
  });

  test("tool_choice is translated", async () => {
    const s = await setup((_req, res) => sendJson(res, 200, completion({ content: "ok" }, "stop")));
    const cases: [unknown, unknown][] = [
      [{ type: "auto" }, "auto"],
      [{ type: "any" }, "required"],
      [
        { type: "tool", name: "Read" },
        { type: "function", function: { name: "Read" } },
      ],
      [{ type: "none" }, "none"],
    ];
    for (const [choice] of cases) {
      await post(s, {
        model: "m",
        max_tokens: 5,
        tools: [readTool],
        tool_choice: choice,
        messages: [{ role: "user", content: "x" }],
      });
    }
    expect(
      s.upstream.requests.map((r) => (r.json as { tool_choice: unknown }).tool_choice),
    ).toEqual(cases.map(([, expected]) => expected));
  });

  test("unknown fields, beta headers, cache_control and server tools are tolerated", async () => {
    const s = await setup((_req, res) => sendJson(res, 200, completion({ content: "ok" }, "stop")));
    const res = await post(s, {
      model: "m",
      max_tokens: 5,
      thinking: { type: "enabled", budget_tokens: 2000 },
      metadata: { user_id: "abc" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      container: "c",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: [
        readTool,
        { type: "web_search_20250305", name: "web_search" },
        { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srv", name: "web_search", input: {} },
            { type: "web_search_tool_result", tool_use_id: "srv", content: [] },
            { type: "text", text: "found" },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    });
    expect(res.status).toBe(200);
    const sent = s.upstream.requests[0]?.json as { tools: { function: { name: string } }[] };
    expect(sent.tools.map((t) => t.function.name)).toEqual(["Read"]);
  });

  test("upstream errors become Anthropic-shaped errors", async () => {
    let mode = "context";
    const s = await setup((_req, res) => {
      if (mode === "context") {
        sendJson(res, 400, {
          error: {
            code: 400,
            message: "the request exceeds the available context size, try increasing it",
            type: "exceed_context_size_error",
            n_prompt_tokens: 140000,
            n_ctx: 131072,
          },
        });
      } else if (mode === "500") {
        sendJson(res, 500, { error: { message: "model crashed" } });
      } else {
        res.writeHead(429, { "content-type": "text/plain" });
        res.end("slow down");
      }
    });
    const body = { model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }] };
    const context = await post(s, body);
    expect(context.status).toBe(400);
    expect(context.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(/^prompt is too long: 140000 tokens > 131072 maximum/),
      },
    });
    mode = "500";
    const crashed = await post(s, { ...body, stream: true });
    expect(crashed.status).toBe(500);
    expect(crashed.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "model crashed" },
    });
    mode = "429";
    const limited = await post(s, body);
    expect(limited.status).toBe(429);
    expect(limited.json().error).toEqual({ type: "rate_limit_error", message: "slow down" });
    const records = await s.records();
    expect(records.map((r) => r.status)).toEqual([400, 500, 429]);
    expect(records[1]?.error).toBe("upstream HTTP 500: model crashed");
  });

  test("connection refused gives an Anthropic api_error", async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const s = await setup(() => {}, { upstream: `http://127.0.0.1:${deadPort}/v1` });
    const res = await post(s, {
      model: "m",
      max_tokens: 5,
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  test("an error in the middle of a stream becomes an error event", async () => {
    const s = await setup((_req, res) =>
      sendSse(res, [
        chunk({ content: "partial" }),
        { error: { code: 500, message: "slot crashed" } },
      ]),
    );
    const res = await post(s, {
      model: "m",
      max_tokens: 5,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    const events = parseEvents(res.text);
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { type: "error", error: { type: "api_error", message: "slot crashed" } },
    });
    expect(events.some((e) => e.event === "message_stop")).toBe(false);
    const [record] = await s.records();
    expect(record?.error).toBe("slot crashed");
  });

  test("pings keep a quiet stream alive", async () => {
    const s = await setup(
      (_req, res) =>
        sendSse(res, [chunk({ content: "a" }), chunk({ content: "b" }), chunk({}, {}, "stop")], {
          delayMs: 120,
        }),
      { pingIntervalMs: 40 },
    );
    const res = await post(s, {
      model: "m",
      max_tokens: 5,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    const pings = parseEvents(res.text).filter((e) => e.event === "ping");
    expect(pings.length).toBeGreaterThan(1);
  });

  test("a client disconnect aborts the translated upstream stream", async () => {
    const s = await setup(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 200 && !res.destroyed; i++) {
        res.write(`data: ${JSON.stringify(chunk({ content: `t${i}` }))}\n\n`);
        await new Promise((r) => setTimeout(r, 20));
      }
      res.end();
    });
    const { req, res } = await openRequest(`${s.proxy.url}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: "m",
        max_tokens: 5,
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    });
    await new Promise((resolve) => res.once("data", resolve));
    req.destroy();
    await s.upstream.requests[0]?.aborted;
    const [record] = await s.records();
    expect(record?.error).toBe("client disconnected");
  });

  test("the real key replaces the client's x-api-key; --upstream-model renames the model", async () => {
    const s = await setup(
      (_req, res) => sendJson(res, 200, completion({ content: "ok" }, "stop")),
      {
        upstreamKeyEnv: "K",
        env: { K: "real-key-abcdef" },
        upstreamModel: "qwen-local",
      },
    );
    const res = await post(s, {
      model: "claude-x",
      max_tokens: 5,
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.json().model).toBe("claude-x");
    const seen = s.upstream.requests[0];
    expect(seen?.headers.authorization).toBe("Bearer real-key-abcdef");
    expect((seen?.json as { model?: string } | undefined)?.model).toBe("qwen-local");
    const [record] = await s.records();
    expect(record).toMatchObject({ model: "claude-x", upstream_model: "qwen-local" });
  });

  test("invalid JSON and missing messages give invalid_request_error", async () => {
    const s = await setup(() => {});
    const res = await rawRequest(`${s.proxy.url}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders,
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString("utf8")).error.type).toBe("invalid_request_error");
    expect(s.upstream.requests).toHaveLength(0);
  });

  test("a stream cut off before finish_reason or [DONE] ends with an error event", async () => {
    const s = await setup((_req, res) =>
      sendSse(res, [chunk({ content: "half an ans" })], { done: false }),
    );
    const res = await post(s, {
      model: "m",
      max_tokens: 5,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    const events = parseEvents(res.text);
    expect(events.at(-1)?.event).toBe("error");
    expect(events.some((e) => e.event === "message_stop")).toBe(false);
    const [record] = await s.records();
    expect(record?.error).toMatch(/ended before the response was complete/);
  });

  test("an upstream that ignores stream:true still yields a proper event stream", async () => {
    const s = await setup((_req, res) =>
      sendJson(
        res,
        200,
        completion(
          {
            content: "Done.",
            reasoning_content: "hmm",
            tool_calls: [
              { id: "t1", type: "function", function: { name: "Read", arguments: '{"path":"x"}' } },
            ],
          },
          "tool_calls",
        ),
      ),
    );
    const res = await post(s, {
      model: "m",
      max_tokens: 5,
      stream: true,
      tools: [readTool],
      messages: [{ role: "user", content: "x" }],
    });
    const events = parseEvents(res.text);
    const starts = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => (e.data.content_block as { type: string }).type);
    expect(starts).toEqual(["thinking", "text", "tool_use"]);
    expect(events.at(-1)?.event).toBe("message_stop");
  });
});

describe("count_tokens", () => {
  test("uses llama-server's input_tokens endpoint when available", async () => {
    const s = await setup((req, res) => {
      if (req.url === "/v1/chat/completions/input_tokens") {
        sendJson(res, 200, { object: "response.input_tokens", input_tokens: 77 });
      } else sendJson(res, 404, { error: { message: "no" } });
    });
    const res = await post(
      s,
      {
        model: "m",
        system: "s",
        tools: [readTool],
        messages: [{ role: "user", content: "hello" }],
      },
      "/v1/messages/count_tokens?beta=true",
    );
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ input_tokens: 77 });
    expect(res.headers["x-dawg-token-count"]).toBe("upstream");
    expect(s.upstream.requests[0]?.json).toMatchObject({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ],
      tools: [{ type: "function" }],
    });
    const [record] = await s.records();
    expect(record).toMatchObject({ api: "other", path: "/v1/messages/count_tokens", status: 200 });
  });

  test("falls back to an estimate and stops asking an upstream without the endpoint", async () => {
    const s = await setup((_req, res) => sendJson(res, 404, { error: { message: "not found" } }));
    const body = { model: "m", messages: [{ role: "user", content: "x".repeat(700) }] };
    const first = await post(s, body, "/v1/messages/count_tokens");
    expect(first.status).toBe(200);
    expect(first.headers["x-dawg-token-count"]).toMatch(/^estimate/);
    const tokens = first.json().input_tokens;
    expect(tokens).toBeGreaterThanOrEqual(200);
    expect(tokens).toBeLessThan(220);
    await post(s, body, "/v1/messages/count_tokens");
    expect(s.upstream.requests).toHaveLength(1);
  });
});
