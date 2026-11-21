import { readFile } from "node:fs/promises";
import { parseServerInfo } from "@dawg/models";
import { afterEach, describe, expect, test } from "vitest";
import {
  contextOverflow,
  dropped,
  empty,
  httpError,
  invalidResponse,
  malformedToolCall,
  nonStreaming,
  reasoning,
  stalled,
  streamError,
  text,
  toolCall,
  toolCalls,
} from "./builders.ts";
import { type MockModel, startMockModel } from "./server.ts";
import type { MockModelOptions } from "./types.ts";

type Json = Record<string, unknown>;
let mock: MockModel | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function start(options: MockModelOptions = {}): Promise<MockModel> {
  mock = await startMockModel(options);
  return mock;
}

const userMessages = (content = "hello") => [
  { role: "system", content: "You are terse." },
  { role: "user", content },
];

function post(m: MockModel, body: Json, path = "/chat/completions", key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  return fetch(`${m.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function parseEvents(raw: string): (Json | "[DONE]")[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .map((data) => (data === "[DONE]" ? "[DONE]" : (JSON.parse(data) as Json)));
}

async function streamed(m: MockModel, extra: Json = {}) {
  const res = await post(m, { messages: userMessages(), stream: true, ...extra });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  return parseEvents(await res.text());
}

const firstMessage = (body: Json) => ((body.choices as Json[])[0]?.message ?? {}) as Json;

const delta = (e: Json | "[DONE]") =>
  e === "[DONE]" ? undefined : ((e.choices as Json[])[0]?.delta as Json | undefined);

async function fixture(name: string) {
  const path = new URL(`./__fixtures__/llama-server/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as { status: number; chunks: string[] };
}

describe("streamed replies", () => {
  test("text in chunks, then finish and [DONE]", async () => {
    const m = await start({ script: [text("Hello, world!", { pacing: { chunkSize: 5 } })] });
    const events = await streamed(m);
    expect(delta(events[0] as Json)).toEqual({ role: "assistant", content: null });
    expect(events.slice(1, 4).map((e) => delta(e)?.content)).toEqual(["Hello", ", wor", "ld!"]);
    const finish = events[4] as Json;
    expect((finish.choices as Json[])[0]).toEqual({ finish_reason: "stop", index: 0, delta: {} });
    expect(finish.timings).toMatchObject({ predicted_n: expect.any(Number) });
    expect(events.at(-1)).toBe("[DONE]");
    m.assertDone();
  });

  test("text given as explicit chunks keeps them, multi-byte characters intact", async () => {
    const m = await start({ script: [text(["Hé", "llo 👋", " there"])] });
    const events = await streamed(m);
    const pieces = events.map((e) => delta(e)?.content).filter((c) => typeof c === "string");
    expect(pieces).toEqual(["Hé", "llo 👋", " there"]);
  });

  test("chunking by size never splits a surrogate pair", async () => {
    const m = await start({ script: [text("👋👋👋", { pacing: { chunkSize: 1 } })] });
    const pieces = (await streamed(m)).map((e) => delta(e)?.content).filter(Boolean);
    expect(pieces).toEqual(["👋", "👋", "👋"]);
  });

  test("include_usage adds a usage chunk with empty choices, like llama-server", async () => {
    const m = await start({ script: [text("hi")] });
    const events = await streamed(m, { stream_options: { include_usage: true } });
    const finish = events.at(-3) as Json;
    const usage = events.at(-2) as Json;
    expect(finish.timings).toBeUndefined();
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(usage.timings).toMatchObject({ cache_n: 0, prompt_n: expect.any(Number) });
  });

  test("return_progress sends progress chunks first; timings_per_token adds timings", async () => {
    const m = await start({ script: [text("ok then")], progressBatch: 4 });
    const events = await streamed(m, { return_progress: true, timings_per_token: true });
    const progress = events.filter((e) => e !== "[DONE]" && e.prompt_progress);
    expect(progress.length).toBeGreaterThan(1);
    const last = (progress.at(-1) as Json).prompt_progress as Json;
    expect(last.processed).toBe(last.total);
    expect(Object.keys(last)).toEqual(["total", "cache", "processed", "time_ms"]);
    const content = events.filter((e) => typeof delta(e)?.content === "string");
    expect(content.every((e) => (e as Json).timings !== undefined)).toBe(true);
  });

  test("reasoning streams as reasoning_content before the text", async () => {
    const m = await start({ script: [reasoning("Think first.", "Answer.")] });
    const deltas = (await streamed(m)).map(delta).filter((d) => d && !("role" in d));
    expect(deltas[0]).toEqual({ reasoning_content: "Think first." });
    expect(deltas[1]).toEqual({ content: "Answer." });
  });

  test("tool calls stream like llama-server: head delta, then argument pieces", async () => {
    const m = await start({
      script: [toolCall("Read", { file_path: "/a.txt" }, { pacing: { argumentChunkSize: 6 } })],
    });
    const events = await streamed(m);
    const calls = events.map((e) => delta(e)?.tool_calls as Json[] | undefined).filter(Boolean);
    expect(calls[0]).toEqual([
      {
        index: 0,
        id: "call_0_0",
        type: "function",
        function: { name: "Read", arguments: '{"file' },
      },
    ]);
    expect(calls.slice(1).map((c) => ((c?.[0]?.function ?? {}) as Json).arguments)).toEqual([
      '_path"',
      ':"/a.t',
      'xt"}',
    ]);
    const finish = events.at(-2) as Json;
    expect((finish.choices as Json[])[0]?.finish_reason).toBe("tool_calls");
  });

  test("tool call styles: whole, no-index, no-id, explicit argument chunks", async () => {
    const two = [
      { name: "A", arguments: ['{"x"', ":1}"], id: "first" },
      { name: "B", arguments: { y: 2 } },
    ];
    const m = await start({
      script: [
        toolCalls(two, { pacing: { toolCallStyle: "whole" } }),
        toolCalls(two, { pacing: { toolCallStyle: "no-index" } }),
        toolCalls(two, { pacing: { toolCallStyle: "no-id" } }),
      ],
    });
    const callsOf = (events: (Json | "[DONE]")[]) =>
      events.flatMap((e) => (delta(e)?.tool_calls as Json[] | undefined) ?? []);

    const whole = callsOf(await streamed(m));
    expect(whole).toHaveLength(2);
    expect(whole[0]).toMatchObject({ index: 0, id: "first", function: { arguments: '{"x":1}' } });
    expect(whole[1]).toMatchObject({
      index: 1,
      id: "call_0_1",
      function: { arguments: '{"y":2}' },
    });

    const noIndex = callsOf(await streamed(m));
    expect(noIndex.every((c) => !("index" in c))).toBe(true);
    expect(noIndex[1]).toEqual({ function: { arguments: ":1}" } });

    const noId = callsOf(await streamed(m));
    expect(noId.every((c) => !("id" in c))).toBe(true);
    expect(noId[0]).toMatchObject({ index: 0, function: { name: "A", arguments: '{"x"' } });
  });

  test("malformed tool-call arguments are sent exactly as scripted", async () => {
    const m = await start({ script: [malformedToolCall("Edit", '{"file_path": "/a", ')] });
    const args = (await streamed(m))
      .flatMap((e) => (delta(e)?.tool_calls as Json[] | undefined) ?? [])
      .map((c) => (c.function as Json).arguments)
      .join("");
    expect(args).toBe('{"file_path": "/a", ');
  });

  test("an empty reply has only the role chunk and a stop", async () => {
    const m = await start({ script: [empty()] });
    const events = await streamed(m);
    expect(events).toHaveLength(3);
    expect(((events[1] as Json).choices as Json[])[0]?.finish_reason).toBe("stop");
  });

  test("wire options: CRLF, comment lines, tiny writes", async () => {
    const m = await start({
      script: [text("abc", { wire: { lineEnding: "crlf", comments: true, bytesPerWrite: 7 } })],
    });
    const res = await post(m, { messages: userMessages(), stream: true });
    const raw = await res.text();
    expect(raw).toContain(": keep-alive\r\ndata: ");
    expect(raw.endsWith("data: [DONE]\r\n\r\n")).toBe(true);
    expect(parseEvents(raw).at(-1)).toBe("[DONE]");
  });

  test("pacing delays events", async () => {
    const m = await start({ script: [text("abcd", { pacing: { chunkSize: 1, delayMs: 15 } })] });
    const started = performance.now();
    await streamed(m);
    expect(performance.now() - started).toBeGreaterThanOrEqual(60);
  });
});

describe("faults", () => {
  test("drop destroys the socket part-way", async () => {
    const m = await start({ script: [dropped(text("abcdefgh", { pacing: { chunkSize: 2 } }), 3)] });
    const res = await post(m, { messages: userMessages(), stream: true });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let received = "";
    const decoder = new TextDecoder();
    await expect(
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          received += decoder.decode(value);
        }
      })(),
    ).rejects.toThrow();
    expect(parseEvents(received)).toHaveLength(3);
  });

  test("drop on a non-streaming request closes without an answer", async () => {
    const m = await start({ script: [dropped(text("x"), 0)] });
    await expect(post(m, { messages: userMessages() })).rejects.toThrow();
  });

  test("stall keeps the response open until the client leaves; close() still works", async () => {
    const m = await start({ script: [stalled(text("abc"), 2)] });
    const controller = new AbortController();
    const res = await fetch(`${m.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: userMessages(), stream: true }),
      signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const pending = reader.read();
    const outcome = await Promise.race([
      pending.then(() => "data"),
      new Promise((r) => setTimeout(() => r("quiet"), 100)),
    ]);
    // Both scripted events may arrive in one read; what matters is that nothing ends the stream.
    if (outcome === "data") {
      const again = await Promise.race([
        reader.read().then(() => "data"),
        new Promise((r) => setTimeout(() => r("quiet"), 100)),
      ]);
      expect(again).toBe("quiet");
    } else {
      expect(outcome).toBe("quiet");
    }
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await waitFor(() => m.openConnections === 0);
  });

  test("close() ends a stalled stream", async () => {
    const m = await start({ script: [stalled(text("abc"), 1)] });
    const res = await post(m, { messages: userMessages(), stream: true });
    const reading = res.text();
    await waitFor(() => m.openConnections === 1);
    await m.close();
    await expect(reading).rejects.toThrow();
  });

  test("HTTP error with the default OpenAI-style body, or a custom body", async () => {
    const m = await start({
      script: [httpError(503, "Loading model"), httpError(429, undefined, { detail: "slow down" })],
    });
    const first = await post(m, { messages: userMessages(), stream: true });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: { code: 503, message: "Loading model", type: "unavailable_error" },
    });
    const second = await post(m, { messages: userMessages(), stream: true });
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ detail: "slow down" });
  });

  test("context overflow has the real server's shape", async () => {
    const m = await start({ script: [contextOverflow(5320, 2048)] });
    const res = await post(m, { messages: userMessages(), stream: true });
    const real = await fixture("error-context-overflow");
    expect(res.status).toBe(real.status);
    expect(await res.json()).toEqual(JSON.parse(real.chunks.join("")));
  });

  test("enforceContextWindow rejects long prompts without using a reply", async () => {
    const m = await start({
      script: [text("fits")],
      contextWindow: 50,
      enforceContextWindow: true,
    });
    const res = await post(m, { messages: userMessages("x".repeat(400)), stream: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: Json };
    expect(body.error).toMatchObject({ type: "exceed_context_size_error", n_ctx: 50 });
    expect(m.pending()).toEqual({ main: 1 });
  });

  test("non_streaming answers a streaming request with a JSON completion", async () => {
    const m = await start({ script: [nonStreaming(text("whole"))] });
    const res = await post(m, { messages: userMessages(), stream: true });
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Json;
    expect(body.object).toBe("chat.completion");
    expect(firstMessage(body).content).toBe("whole");
  });

  test("stream_error sends llama-server's mid-stream error event and no [DONE]", async () => {
    const m = await start({
      script: [streamError(text("abcdef", { pacing: { chunkSize: 2 } }), 2, "boom")],
    });
    const events = await streamed(m);
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toEqual({ error: { code: 500, message: "boom", type: "server_error" } });
  });

  test("invalid answers with something that is not a chat completion", async () => {
    const m = await start({ script: [invalidResponse()] });
    const res = await post(m, { messages: userMessages(), stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("matching and bookkeeping", () => {
  test("records requests without the key, and returns the messages of request n", async () => {
    const m = await start({ script: [text("a"), text("b")], apiKey: "test-key" });
    await (
      await post(m, { messages: userMessages("one"), stream: true }, undefined, "test-key")
    ).text();
    await (await post(m, { messages: userMessages("two") }, undefined, "test-key")).text();
    expect(m.chatRequests).toHaveLength(2);
    expect(m.messages(1)).toEqual(userMessages("two"));
    expect(m.messages(-2)).toEqual(userMessages("one"));
    const recorded = m.requests[0];
    expect(recorded?.headers.authorization).toBeUndefined();
    expect(recorded).toMatchObject({ method: "POST", path: "/v1/chat/completions", lane: "main" });
    expect(recorded?.rawBody).not.toContain("test-key");
  });

  test("a required API key: 401 without it, /health stays open", async () => {
    const m = await start({ script: [text("a")], apiKey: "test-key" });
    const denied = await post(m, { messages: userMessages() });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      error: { message: "Invalid API Key", type: "authentication_error", code: 401 },
    });
    expect((await fetch(`${m.url}/health`)).status).toBe(200);
    expect((await fetch(`${m.url}/props`)).status).toBe(401);
    expect(m.pending()).toEqual({ main: 1 });
  });

  test("a lane answers side requests without consuming the main conversation", async () => {
    const m = await start({
      script: {
        replies: [text("main 1"), text("main 2")],
        lanes: { title: { match: { system: "Write a title" }, replies: [text("A title")] } },
      },
    });
    const ask = async (system: string) => {
      const res = await post(m, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: "hi" },
        ],
      });
      const body = (await res.json()) as Json;
      return firstMessage(body).content;
    };
    expect(await ask("You are an agent.")).toBe("main 1");
    expect(await ask("Write a title for this chat.")).toBe("A title");
    expect(await ask("You are an agent.")).toBe("main 2");
    expect(m.chatRequests.map((r) => r.lane)).toEqual(["main", "title", "main"]);
    m.assertDone();
  });

  test("function matchers, lanes and replies added while running", async () => {
    const m = await start();
    m.addLane("small", { match: (r) => (r.body as Json).max_tokens === 5 });
    m.addLaneReplies("small", text("tiny"));
    m.addReplies(text("big"));
    const content = async (body: Json) => {
      const json = (await (await post(m, body)).json()) as Json;
      return firstMessage(json).content;
    };
    expect(await content({ messages: userMessages(), max_tokens: 5 })).toBe("tiny");
    expect(await content({ messages: userMessages() })).toBe("big");
    m.assertDone();
  });

  test("a request with nothing left gets a clear error and assertDone reports it", async () => {
    const m = await start({ script: [text("only")] });
    await (await post(m, { messages: userMessages() })).text();
    const res = await post(m, { messages: userMessages(), stream: true });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: Json };
    expect(body.error.message).toContain("no scripted reply left for chat request #1 (lane main)");
    expect(() => m.assertDone()).toThrow(/request 1: no scripted reply left/);
  });

  test("assertDone lists unused replies", async () => {
    const m = await start({ script: [text("a", { label: "greeting" }), text("b")] });
    expect(() => m.assertDone()).toThrow(/lane main: 2 unused replies \(greeting, #1\)/);
  });

  test("cache simulation: a repeated prefix reports cached tokens per slot", async () => {
    const m = await start({ script: [text("a"), text("b"), text("c")] });
    const usageOf = async (body: Json) => {
      const json = (await (await post(m, body)).json()) as Json;
      return json.usage as {
        prompt_tokens: number;
        prompt_tokens_details: { cached_tokens: number };
      };
    };
    const first = await usageOf({ messages: userMessages() });
    expect(first.prompt_tokens_details.cached_tokens).toBe(0);
    const longer = [
      ...userMessages(),
      { role: "assistant", content: "a" },
      { role: "user", content: "more" },
    ];
    const second = await usageOf({ messages: longer });
    expect(second.prompt_tokens_details.cached_tokens).toBeGreaterThan(first.prompt_tokens / 2);
    const otherSlot = await usageOf({ messages: longer, id_slot: 1 });
    expect(otherSlot.prompt_tokens_details.cached_tokens).toBe(0);
  });
});

describe("server endpoints", () => {
  test("/props and /v1/models parse with the supervisor's own reader", async () => {
    const m = await start({
      contextWindow: 4096,
      totalSlots: 2,
      model: "tiny",
      templateCaps: { reasoning_effort_levels: ["low", "high"] },
    });
    const props = await (await fetch(`${m.url}/props`)).json();
    const models = await (await fetch(`${m.baseUrl}/models`)).json();
    const info = parseServerInfo(props, models);
    expect(info).toMatchObject({ modelId: "tiny", contextWindow: 4096, totalSlots: 2 });
    expect(info.templateCaps.reasoning_effort_levels).toEqual(["low", "high"]);
    expect(m.endpoint).toMatchObject({
      kind: "bundled",
      baseUrl: m.baseUrl,
      model: "tiny",
      contextWindow: 4096,
      capabilities: { cacheControl: true },
    });
  });

  test("health and loading", async () => {
    const m = await start({ loading: true });
    const loading = await fetch(`${m.url}/health`);
    expect(loading.status).toBe(503);
    expect(await loading.json()).toEqual({
      error: { code: 503, message: "Loading model", type: "unavailable_error" },
    });
    m.setLoading(false);
    expect(await (await fetch(`${m.url}/health`)).json()).toEqual({ status: "ok" });
  });

  test("the token-count endpoint answers in the real shape without using replies", async () => {
    const m = await start({ script: [text("a")], countTokens: (t) => t.length });
    const res = await post(m, { messages: userMessages() }, "/chat/completions/input_tokens");
    const real = await fixture("input-tokens");
    const body = (await res.json()) as Json;
    expect(Object.keys(body)).toEqual(Object.keys(JSON.parse(real.chunks.join(""))));
    expect(body.input_tokens).toBe(JSON.stringify({ tools: [], messages: userMessages() }).length);
    expect(m.pending()).toEqual({ main: 1 });
  });

  test("the openai flavour leaves out llama-server's extras", async () => {
    const m = await start({ kind: "remote", script: [text("hi")] });
    expect(m.endpoint.capabilities.cacheControl).toBe(false);
    expect((await fetch(`${m.url}/props`)).status).toBe(404);
    const count = await post(m, { messages: userMessages() }, "/chat/completions/input_tokens");
    expect(count.status).toBe(404);
    const events = await streamed(m, {
      return_progress: true,
      timings_per_token: true,
      stream_options: { include_usage: true },
    });
    expect(events.some((e) => e !== "[DONE]" && (e.timings || e.prompt_progress))).toBe(false);
    expect(events.some((e) => e !== "[DONE]" && e.usage)).toBe(true);
  });

  test("unknown paths and bad bodies", async () => {
    const m = await start();
    expect((await fetch(`${m.url}/nope`)).status).toBe(404);
    const bad = await post(m, { model: "x" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: { code: 400, message: "'messages' is required", type: "invalid_request_error" },
    });
  });
});

describe("parity with captured llama-server traffic", () => {
  const keys = (o: unknown) => Object.keys(o as Json);

  test("streamed chunks use the same fields in the same order", async () => {
    const real = parseEvents((await fixture("stream-text-extras")).chunks.join(""));
    const m = await start({ script: [text("Hello.")] });
    const ours = await streamed(m, {
      return_progress: true,
      timings_per_token: true,
      stream_options: { include_usage: true },
    });
    const progressOf = (events: typeof real) =>
      events.find((e) => e !== "[DONE]" && e.prompt_progress);
    const contentOf = (events: typeof real) =>
      events.find((e) => typeof delta(e)?.content === "string");
    const usageOf = (events: typeof real) => events.find((e) => e !== "[DONE]" && e.usage);
    for (const pick of [progressOf, contentOf, usageOf]) {
      expect(keys(pick(ours))).toEqual(keys(pick(real)));
    }
    expect(keys((progressOf(ours) as Json).prompt_progress)).toEqual(
      keys((progressOf(real) as Json).prompt_progress),
    );
    expect(keys((usageOf(ours) as Json).timings)).toEqual(keys((usageOf(real) as Json).timings));
    expect(keys((usageOf(ours) as Json).usage)).toEqual(keys((usageOf(real) as Json).usage));
    expect(ours.at(-1)).toBe(real.at(-1));
  });

  test("tool-call deltas match the real layout", async () => {
    const real = parseEvents((await fixture("stream-tool-call")).chunks.join(""));
    const m = await start({ script: [toolCall("get_weather", { city: "Paris" })] });
    const ours = await streamed(m);
    const calls = (events: typeof real) =>
      events.flatMap((e) => (delta(e)?.tool_calls as Json[] | undefined) ?? []);
    expect(keys(calls(ours)[0])).toEqual(["index", "id", "type", "function"]);
    expect(keys(calls(real)[0]).sort()).toEqual(keys(calls(ours)[0]).sort());
    expect(keys(calls(ours)[1])).toEqual(keys(calls(real)[1]));
  });

  test("non-streamed completions match the real layout", async () => {
    const realText = JSON.parse((await fixture("nonstream-text")).chunks.join("")) as Json;
    const realTool = JSON.parse((await fixture("nonstream-tool-call")).chunks.join("")) as Json;
    const m = await start({ script: [text("Hello."), toolCall("get_weather", { city: "Paris" })] });
    const a = (await (await post(m, { messages: userMessages() })).json()) as Json;
    const b = (await (await post(m, { messages: userMessages() })).json()) as Json;
    expect(keys(a)).toEqual(keys(realText));
    const message = (body: Json) => (body.choices as Json[])[0]?.message as Json;
    expect(keys(message(b))).toEqual(keys(message(realTool)));
    expect(message(b).content).toBe("");
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
