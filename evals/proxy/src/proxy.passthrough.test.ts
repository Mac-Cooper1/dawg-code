import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
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
  sleep,
  startFakeUpstream,
} from "./fake-upstream.ts";
import { type ProxyOptions, type RunningProxy, startProxy } from "./proxy.ts";
import { type ProxyRecord, ProxyRecordSchema } from "./record.ts";

interface Setup {
  upstream: FakeUpstream;
  proxy: RunningProxy;
  dir: string;
  recordPath: string;
  /** Close the proxy (flushing records) and read them, sorted by seq. */
  records(): Promise<ProxyRecord[]>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(handler: FakeHandler, options: Partial<ProxyOptions> = {}): Promise<Setup> {
  const upstream = await startFakeUpstream(handler);
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-proxy-test-"));
  const recordPath = path.join(dir, "records.jsonl");
  const proxy = await startProxy({
    upstream: upstream.url,
    recordPath,
    log: () => {},
    ...options,
  });
  cleanups.push(async () => {
    await proxy.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    upstream,
    proxy,
    dir,
    recordPath,
    async records() {
      await proxy.close();
      const text = await readFile(recordPath, "utf8");
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => ProxyRecordSchema.parse(JSON.parse(l)))
        .sort((a, b) => a.seq - b.seq);
    },
  };
}

const editTool = {
  type: "function",
  function: {
    name: "Edit",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" }, old_string: { type: "string" } },
      required: ["file_path", "old_string"],
      additionalProperties: false,
    },
  },
};

describe("OpenAI pass-through", () => {
  test("non-streamed request and response are forwarded byte for byte", async () => {
    const responseBody =
      '{ "id":"x",  "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],\n "usage":{"prompt_tokens":7,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}} }';
    const s = await setup((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-upstream-header": "yes",
        "set-cookie": ["a=1", "b=2"],
        "content-length": Buffer.byteLength(responseBody),
      });
      res.end(responseBody);
    });
    const requestBody =
      '{"model":"m1",\n  "messages":[{"role":"user","content":"héllo"}], "cache_prompt":true, "id_slot":2, "return_progress":true, "timings_per_token":true, "seed": 12345678901234567890}';
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions?api-version=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-key",
        "x-custom": "kept",
        connection: "keep-alive, x-hop",
        "x-hop": "dropped",
      },
      body: requestBody,
    });
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(responseBody);
    expect(res.headers["x-upstream-header"]).toBe("yes");
    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);

    const seen = s.upstream.requests[0];
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/v1/chat/completions?api-version=1");
    expect(seen?.body.toString("utf8")).toBe(requestBody);
    expect(seen?.headers.authorization).toBe("Bearer client-key");
    expect(seen?.headers["x-custom"]).toBe("kept");
    expect(seen?.headers["x-hop"]).toBeUndefined();
    expect(seen?.headers.host).toBe(`127.0.0.1:${s.upstream.port}`);

    const [record] = await s.records();
    expect(record).toMatchObject({
      seq: 1,
      api: "openai.chat",
      method: "POST",
      path: "/v1/chat/completions",
      model: "m1",
      stream: false,
      status: 200,
      request: { messages: 1, tools: 0, body_bytes: Buffer.byteLength(requestBody) },
      usage: { prompt_tokens: 7, completion_tokens: 2, cached_tokens: 3 },
      timings: null,
      tool_calls: [],
      finish_reason: "stop",
      error: null,
      usage_injected: false,
    });
    expect(new Date(record?.started_at ?? "").getTime()).toBeGreaterThan(0);
  });

  test("streamed response is relayed chunk by chunk, byte for byte", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    const first = `data: ${JSON.stringify(chunk({ role: "assistant", content: "Hel" }))}\n\n`;
    const rest = [
      `data: ${JSON.stringify(chunk({ content: "lo" }))}\n\n`,
      `data: ${JSON.stringify(chunk({}, {}, "stop"))}\n\n`,
      `data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const s = await setup(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(first);
      await released;
      for (const piece of rest) res.write(piece);
      res.end();
    });
    const { res } = await openRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.statusCode).toBe(200);
    const received: Buffer[] = [];
    // The first chunk must arrive while the upstream is still holding the rest back.
    const firstChunk = await new Promise<Buffer>((resolve) => res.once("data", resolve));
    received.push(firstChunk);
    expect(firstChunk.toString("utf8")).toBe(first);
    release();
    for await (const c of res) received.push(c as Buffer);
    expect(Buffer.concat(received).toString("utf8")).toBe(first + rest.join(""));

    const [record] = await s.records();
    expect(record).toMatchObject({
      api: "openai.chat",
      stream: true,
      status: 200,
      usage: { prompt_tokens: 11, completion_tokens: 2, cached_tokens: null },
      finish_reason: "stop",
      usage_injected: false,
      error: null,
    });
    expect(record?.ttfb_ms).not.toBeNull();
  });

  test("injects stream_options.include_usage when missing, leaving the other bytes alone", async () => {
    const s = await setup(async (req, res) => {
      const usage = (req.json as { stream_options?: { include_usage?: boolean } }).stream_options
        ?.include_usage
        ? [{ id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }]
        : [];
      await sendSse(res, [chunk({ content: "ok" }), chunk({}, {}, "stop"), ...usage]);
    });
    const body = '{"model":"m",  "stream":true,"messages":[{"role":"user","content":"x"}]}';
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.body.toString("utf8")).toContain('"usage":{"prompt_tokens":5');
    expect(s.upstream.requests[0]?.body.toString("utf8")).toBe(
      `{"stream_options":{"include_usage":true},${body.slice(1)}`,
    );

    // Existing stream_options without include_usage: merged.
    await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, stream_options: { foo: 1 }, messages: [] }),
    });
    expect(s.upstream.requests[1]?.json).toMatchObject({
      stream_options: { foo: 1, include_usage: true },
    });

    const records = await s.records();
    expect(records[0]).toMatchObject({
      usage_injected: true,
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
    expect(records[1]?.usage_injected).toBe(true);
  });

  test("--no-inject-usage leaves streamed requests untouched", async () => {
    const s = await setup((_req, res) => sendSse(res, [chunk({ content: "ok" }, {}, "stop")]), {
      injectUsage: false,
    });
    const body = '{"model":"m","stream":true,"messages":[]}';
    await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(s.upstream.requests[0]?.body.toString("utf8")).toBe(body);
    const [record] = await s.records();
    expect(record).toMatchObject({
      usage_injected: false,
      usage: { prompt_tokens: null, completion_tokens: null, cached_tokens: null },
    });
  });

  test("swaps the client's credentials for the real key and never writes the key down", async () => {
    const secret = "sk-real-secret-value-123";
    const s = await setup(
      (req, res) =>
        sendJson(res, 401, {
          error: { message: `bad key ${String(req.headers.authorization)}` },
        }),
      { upstreamKeyEnv: "TEST_UPSTREAM_KEY", env: { TEST_UPSTREAM_KEY: secret } },
    );
    const bodiesDir = path.join(s.dir, "bodies");
    // Restart with a bodies dir to check those too.
    await s.proxy.close();
    const proxy = await startProxy({
      upstream: s.upstream.url,
      recordPath: s.recordPath,
      upstreamKeyEnv: "TEST_UPSTREAM_KEY",
      env: { TEST_UPSTREAM_KEY: secret },
      bodiesDir,
      log: () => {},
    });
    const res = await rawRequest(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer dummy-client-key",
        "x-api-key": "dummy-x-api-key",
        "api-key": "dummy-azure-key",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(401);
    const seen = s.upstream.requests[0];
    expect(seen?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(seen?.headers["x-api-key"]).toBeUndefined();
    expect(seen?.headers["api-key"]).toBeUndefined();
    await proxy.close();

    const recordText = await readFile(s.recordPath, "utf8");
    expect(recordText).not.toContain(secret);
    expect(recordText).toContain("[REDACTED]");
    const files = await readdir(bodiesDir);
    expect(files).toEqual(["000001.json"]);
    const dump = await readFile(path.join(bodiesDir, "000001.json"), "utf8");
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("dummy-client-key");
    expect(dump).not.toContain("dummy-x-api-key");
    expect(dump).not.toContain("dummy-azure-key");
    expect(JSON.parse(dump)).toMatchObject({
      seq: 1,
      request: { path: "/v1/chat/completions", headers: { authorization: "[REDACTED]" } },
      upstream_request: { headers: { authorization: "[REDACTED]" } },
      upstream_response: { status: 401 },
    });
  });

  test("refuses to start when the key env var is missing", async () => {
    await expect(
      startProxy({
        upstream: "http://127.0.0.1:1/v1",
        recordPath: path.join(os.tmpdir(), "never.jsonl"),
        upstreamKeyEnv: "DEFINITELY_NOT_SET_ENV",
        env: {},
      }),
    ).rejects.toThrow(/DEFINITELY_NOT_SET_ENV/);
  });

  test("reconstructs streamed tool calls and validates them", async () => {
    const s = await setup((_req, res) =>
      sendSse(res, [
        chunk({ role: "assistant", content: null }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "c0",
              type: "function",
              function: { name: "Edit", arguments: '{"file_pa' },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts","old_string":"x"}' } }],
        }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "c1",
              type: "function",
              function: { name: "Edit", arguments: '{"file_path":' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '"b.ts", "old_string": ' } }] }),
        chunk({
          tool_calls: [
            {
              index: 2,
              id: "c2",
              type: "function",
              function: { name: "Edit", arguments: '{"file_path":"c.ts"' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 2, function: { arguments: ',"bogus":true}' } }] }),
        chunk({
          tool_calls: [
            {
              index: 3,
              id: "c3",
              type: "function",
              function: { name: "Mystery", arguments: "{}" },
            },
          ],
        }),
        chunk({}, {}, "tool_calls"),
      ]),
    );
    await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "go" }],
        tools: [editTool],
      }),
    });
    const [record] = await s.records();
    expect(record?.request.tools).toBe(1);
    expect(record?.finish_reason).toBe("tool_calls");
    expect(record?.tool_calls.map((t) => [t.name, t.arguments_valid_json, t.schema_valid])).toEqual(
      [
        ["Edit", true, true],
        ["Edit", false, null],
        ["Edit", true, false],
        ["Mystery", true, null],
      ],
    );
    expect(record?.tool_calls[1]?.error).toMatch(/invalid JSON/);
    expect(record?.tool_calls[2]?.error).toMatch(/additional properties|required/);
    expect(record?.tool_calls[3]?.error).toBe("unknown tool");
  });

  test("non-streamed tool calls, a tool with an uncompilable schema, and llama-server timings", async () => {
    const timings = {
      cache_n: 236,
      prompt_n: 1,
      prompt_ms: 30.9,
      prompt_per_token_ms: 30.9,
      prompt_per_second: 32.3,
      predicted_n: 35,
      predicted_ms: 661,
      predicted_per_token_ms: 18.9,
      predicted_per_second: 52.9,
    };
    const s = await setup((_req, res) =>
      sendJson(
        res,
        200,
        completion(
          {
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "Weird", arguments: '{"x":1}' } },
              {
                id: "b",
                type: "function",
                function: { name: "Edit", arguments: '{"file_path":"f","old_string":"o"}' },
              },
            ],
          },
          "tool_calls",
          { timings },
        ),
      ),
    );
    const weird = {
      type: "function",
      function: { name: "Weird", parameters: { type: 12, $ref: 7 } },
    };
    await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [], tools: [weird, editTool] }),
    });
    const [record] = await s.records();
    expect(record?.tool_calls.map((t) => t.schema_valid)).toEqual([null, true]);
    expect(record?.timings).toEqual({
      cache_n: 236,
      prompt_n: 1,
      prompt_per_second: 32.3,
      predicted_n: 35,
      predicted_per_second: 52.9,
      prompt_ms: 30.9,
      predicted_ms: 661,
    });
  });

  test("captures timings from the final streamed chunk", async () => {
    const s = await setup((_req, res) =>
      sendSse(res, [
        chunk({ content: "a" }),
        chunk(
          {},
          {
            timings: {
              cache_n: 900,
              prompt_n: 12,
              prompt_per_second: 300.5,
              predicted_n: 1,
              predicted_per_second: 40,
            },
          },
          "stop",
        ),
      ]),
    );
    await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    const [record] = await s.records();
    expect(record?.timings).toMatchObject({ cache_n: 900, prompt_n: 12, prompt_per_second: 300.5 });
  });

  test("a stream that ends early is passed through as-is and flagged in the record", async () => {
    const s = await setup((_req, res) =>
      sendSse(res, [chunk({ content: "cut" })], { done: false }),
    );
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(res.body.toString("utf8")).toBe(
      `data: ${JSON.stringify(chunk({ content: "cut" }))}\n\n`,
    );
    const [record] = await s.records();
    expect(record?.error).toMatch(/ended before the response was complete/);
  });

  test("a client disconnect aborts the upstream request", async () => {
    const s = await setup(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 200 && !res.destroyed; i++) {
        res.write(`data: ${JSON.stringify(chunk({ content: `t${i}` }))}\n\n`);
        await sleep(20);
      }
      res.end();
    });
    const { req, res } = await openRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    await new Promise((resolve) => res.once("data", resolve));
    req.destroy();
    await s.upstream.requests[0]?.aborted;
    const [record] = await s.records();
    expect(record?.error).toBe("client disconnected");
    expect(s.upstream.requests[0]?.completed).toBe(false);
  });

  test("a client that leaves before the response starts also aborts the upstream", async () => {
    let arrived: () => void = () => {};
    const upstreamGotIt = new Promise<void>((r) => {
      arrived = r;
    });
    const s = await setup(() => {
      arrived(); // and never answer
    });
    const req = http.request(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      agent: false,
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ model: "m", messages: [] }));
    await upstreamGotIt;
    req.destroy();
    await s.upstream.requests[0]?.aborted;
    const [record] = await s.records();
    expect(record).toMatchObject({ status: null, error: "client disconnected" });
  });

  test("upstream 500 is passed through and recorded", async () => {
    const s = await setup((_req, res) => sendJson(res, 500, { error: { message: "kaboom" } }));
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ error: { message: "kaboom" } });
    const [record] = await s.records();
    expect(record).toMatchObject({ status: 500, error: "upstream HTTP 500: kaboom" });
  });

  test("connection refused becomes a 502 and an error in the record", async () => {
    // Grab a free port, then close it so nothing listens there.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const s = await setup(() => {}, {});
    await s.proxy.close();
    const proxy = await startProxy({
      upstream: `http://127.0.0.1:${deadPort}/v1`,
      recordPath: s.recordPath,
      log: () => {},
    });
    const res = await rawRequest(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body.toString("utf8")).error.code).toBe("upstream_unreachable");
    await proxy.close();
    const record = JSON.parse((await readFile(s.recordPath, "utf8")).trim());
    expect(record.status).toBe(502);
    expect(record.error).toMatch(/connection refused/);
  });

  test("an upstream that never answers times out with 504", async () => {
    const s = await setup(() => {}, { idleTimeoutMs: 150 });
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(504);
    const [record] = await s.records();
    expect(record?.error).toMatch(/timed out/);
  });

  test("an upstream that stalls mid-stream is cut off after the idle timeout", async () => {
    const s = await setup(
      async (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(chunk({ content: "a" }))}\n\n`);
        // then nothing
      },
      { idleTimeoutMs: 200 },
    );
    const { res } = await openRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    const outcome = await new Promise<string>((resolve) => {
      res.on("data", () => {});
      res.on("end", () => resolve("end"));
      res.on("error", () => resolve("error"));
      res.on("aborted", () => resolve("aborted"));
    });
    expect(outcome).not.toBe("end");
    const [record] = await s.records();
    expect(record?.error).toMatch(/timed out/);
  });

  test("gzip-encoded responses reach the client unchanged and are still parsed", async () => {
    const payload = gzipSync(
      Buffer.from(JSON.stringify(completion({ content: "zipped" }, "stop"))),
    );
    const s = await setup((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": payload.length,
      });
      res.end(payload);
    });
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.body.equals(payload)).toBe(true);
    const [record] = await s.records();
    expect(record?.usage.prompt_tokens).toBe(100);
  });

  test("several-MB bodies pass through intact", async () => {
    const s = await setup((req, res) => sendJson(res, 200, { size: req.body.length }));
    const big = "x".repeat(6 * 1024 * 1024);
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: big }] });
    const res = await rawRequest(`${s.proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ size: Buffer.byteLength(body) });
    expect(s.upstream.requests[0]?.body.toString("utf8")).toBe(body);
    const [record] = await s.records();
    expect(record?.request.body_bytes).toBe(Buffer.byteLength(body));
  });

  test("other /v1 requests are forwarded and recorded as 'other'; unknown paths get 404", async () => {
    const s = await setup((req, res) => sendJson(res, 200, { object: "list", path: req.url }));
    const models = await rawRequest(`${s.proxy.url}/v1/models`);
    expect(JSON.parse(models.body.toString("utf8"))).toEqual({
      object: "list",
      path: "/v1/models",
    });
    const missing = await rawRequest(`${s.proxy.url}/healthz`);
    expect(missing.status).toBe(404);
    const records = await s.records();
    expect(records.map((r) => [r.seq, r.api, r.method, r.path, r.status])).toEqual([
      [1, "other", "GET", "/v1/models", 200],
      [2, "other", "GET", "/healthz", 404],
    ]);
  });

  test("an upstream base URL with a path prefix keeps the prefix", async () => {
    const s = await setup((req, res) => sendJson(res, 200, { url: req.url }));
    await s.proxy.close();
    const proxy = await startProxy({
      upstream: `http://127.0.0.1:${s.upstream.port}/api/v1/`,
      recordPath: s.recordPath,
      log: () => {},
    });
    const res = await rawRequest(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ url: "/api/v1/chat/completions" });
    await proxy.close();
  });

  test("listens on loopback only", async () => {
    const s = await setup((_req, res) => sendJson(res, 200, {}));
    expect(s.proxy.url).toBe(`http://127.0.0.1:${s.proxy.port}`);
  });
});
