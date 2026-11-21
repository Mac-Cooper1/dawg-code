import { createServer } from "node:net";
import {
  contextOverflow,
  dropped,
  empty,
  httpError,
  invalidResponse,
  type MockModel,
  type MockModelOptions,
  malformedToolCall,
  nonStreaming,
  reasoning,
  stalled,
  startMockModel,
  streamError,
  text,
  toolCall,
  toolCalls,
} from "@dawg/mock-model";
import { afterEach, describe, expect, test } from "vitest";
import type { Message } from "../contracts/messages.ts";
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  type ToolSchema,
} from "../contracts/model.ts";
import { createModelClient, type ModelClientOptions } from "./client.ts";

type Json = Record<string, unknown>;
let mock: MockModel | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function setup(options: MockModelOptions = {}, clientOptions: ModelClientOptions = {}) {
  mock = await startMockModel(options);
  return { mock, client: createModelClient(mock.endpoint, clientOptions) };
}

const tools: ToolSchema[] = [
  {
    name: "Read",
    description: "Reads a file.",
    parameters: { type: "object", properties: { file_path: { type: "string" } } },
  },
];

const messages: Message[] = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", kind: "prompt", content: [{ type: "text", text: "hello" }] },
];

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  messages,
  tools,
  ...extra,
});

async function collect(client: ModelClient, req: ModelRequest = request()) {
  const events: ModelStreamEvent[] = [];
  for await (const event of client.stream(req)) events.push(event);
  const last = events.at(-1);
  if (last?.type !== "finished") throw new Error("the stream did not finish");
  return { events, reply: last.reply };
}

async function failure(client: ModelClient, req: ModelRequest = request()): Promise<ModelError> {
  try {
    await collect(client, req);
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error("expected the stream to fail");
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const kinds = (events: ModelStreamEvent[]) => events.map((e) => e.type);

describe("replies", () => {
  test("text: deltas in order, then finished, with usage from timings and the usage chunk", async () => {
    const { client, mock } = await setup({
      script: [text("Hello, world!", { pacing: { chunkSize: 4 } })],
      apiKey: "test-key",
    });
    const { events, reply } = await collect(client);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hell",
      "o, w",
      "orld",
      "!",
    ]);
    expect(events.at(-1)?.type).toBe("finished");
    expect(reply).toMatchObject({
      content: "Hello, world!",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      model: "mock-model",
    });
    expect(reply.usage).toEqual({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      cachedTokens: 0,
      promptTokensPerSecond: 1000,
      completionTokensPerSecond: 50,
      promptMs: expect.any(Number),
      completionMs: expect.any(Number),
    });
    expect(mock.chatRequests[0]?.headers["content-type"]).toBe("application/json");
    mock.assertDone();
  });

  test("progress events come first on the bundled runtime", async () => {
    const { client } = await setup({ script: [text("ok")], progressBatch: 8 });
    const { events } = await collect(client);
    const first = events.findIndex((e) => e.type === "prompt_progress");
    expect(first).toBe(0);
    const progress = events.filter((e) => e.type === "prompt_progress");
    expect(progress.at(-1)).toMatchObject({ processed: expect.any(Number), cached: 0 });
  });

  test("reasoning then text", async () => {
    const { client } = await setup({ script: [reasoning("Let me think.", "Done.")] });
    const { events, reply } = await collect(client);
    expect(kinds(events).filter((k) => k !== "prompt_progress")).toEqual([
      "reasoning_delta",
      "text_delta",
      "finished",
    ]);
    expect(reply).toMatchObject({ reasoning: "Let me think.", content: "Done." });
  });

  test("a single tool call, written one byte at a time", async () => {
    const { client } = await setup({
      script: [
        toolCall(
          "Read",
          { file_path: "/tmp/日本.txt" },
          { pacing: { argumentChunkSize: 1 }, wire: { bytesPerWrite: 1 } },
        ),
      ],
    });
    const { events, reply } = await collect(client);
    expect(events.filter((e) => e.type === "tool_call_started")).toEqual([
      { type: "tool_call_started", index: 0, id: "call_0_0", name: "Read" },
    ]);
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.toolCalls).toEqual([
      { id: "call_0_0", name: "Read", arguments: '{"file_path":"/tmp/日本.txt"}' },
    ]);
    const deltas = events.flatMap((e) => (e.type === "tool_call_delta" ? [e.arguments] : []));
    expect(deltas.length).toBeGreaterThan(10);
  });

  const two = [
    { name: "Read", arguments: { file_path: "a" }, id: "x1" },
    { name: "Grep", arguments: ['{"pat', 'tern":', '"b"}'], id: "x2" },
  ];
  test.each(["split", "whole", "no-index"] as const)(
    "several tool calls streamed %s assemble the same way",
    async (style) => {
      const { client } = await setup({
        script: [toolCalls(two, { text: "Two calls.", pacing: { toolCallStyle: style } })],
      });
      const { events, reply } = await collect(client);
      expect(reply.content).toBe("Two calls.");
      expect(reply.toolCalls).toEqual([
        { id: "x1", name: "Read", arguments: '{"file_path":"a"}' },
        { id: "x2", name: "Grep", arguments: '{"pattern":"b"}' },
      ]);
      const started = events.filter((e) => e.type === "tool_call_started");
      expect(started.map((e) => (e.type === "tool_call_started" ? e.index : -1))).toEqual([0, 1]);
    },
  );

  test("calls without ids get empty ids", async () => {
    const { client } = await setup({
      script: [toolCalls(two, { pacing: { toolCallStyle: "no-id" } })],
    });
    const { reply } = await collect(client);
    expect(reply.toolCalls.map((c) => [c.id, c.name])).toEqual([
      ["", "Read"],
      ["", "Grep"],
    ]);
  });

  test("malformed arguments are passed through untouched", async () => {
    const { client } = await setup({ script: [malformedToolCall("Edit", '{"a": 1,')] });
    const { reply } = await collect(client);
    expect(reply.toolCalls).toEqual([{ id: "call_0_0", name: "Edit", arguments: '{"a": 1,' }]);
  });

  test("an empty reply finishes with nothing in it", async () => {
    const { client } = await setup({ script: [empty()] });
    const { events, reply } = await collect(client);
    expect(kinds(events).filter((k) => k !== "prompt_progress")).toEqual(["finished"]);
    expect(reply).toMatchObject({
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
    });
  });

  test("CRLF, comment lines and multi-byte text split across writes", async () => {
    const { client } = await setup({
      script: [
        text("naïve café 👋🏽 done", {
          pacing: { chunkSize: 3 },
          wire: { lineEnding: "crlf", comments: true, bytesPerWrite: 5 },
        }),
      ],
    });
    const { reply } = await collect(client);
    expect(reply.content).toBe("naïve café 👋🏽 done");
  });

  test("a non-streamed answer to a streaming request is accepted", async () => {
    const { client } = await setup({
      script: [nonStreaming(toolCall("Read", { file_path: "a" }))],
    });
    const { events, reply } = await collect(client);
    expect(kinds(events)).toEqual(["tool_call_started", "tool_call_delta", "finished"]);
    expect(reply.toolCalls[0]).toEqual({
      id: "call_0_0",
      name: "Read",
      arguments: '{"file_path":"a"}',
    });
    expect(reply.usage.promptTokens).toEqual(expect.any(Number));
  });

  test("a repeated prefix reports cached tokens", async () => {
    const { client } = await setup({ script: [text("one"), text("two")] });
    const first = await collect(client);
    const longer: Message[] = [
      ...messages,
      { role: "assistant", content: "one", toolCalls: [] },
      { role: "user", kind: "prompt", content: [{ type: "text", text: "again" }] },
    ];
    const second = await collect(client, request({ messages: longer }));
    expect(first.reply.usage.cachedTokens).toBe(0);
    expect(second.reply.usage.cachedTokens).toBeGreaterThan(0);
  });
});

describe("requests", () => {
  test("bundled: runtime extras and the key; byte-identical bodies for the same input", async () => {
    const { client, mock } = await setup({ script: [text("a"), text("b")], apiKey: "test-key" });
    await collect(client, request({ slot: 1 }));
    await collect(client, request({ slot: 1 }));
    const [a, b] = mock.chatRequests;
    expect(a?.body).toMatchObject({
      model: "mock-model",
      stream: true,
      stream_options: { include_usage: true },
      cache_prompt: true,
      id_slot: 1,
      timings_per_token: true,
      return_progress: true,
    });
    expect(a?.rawBody).toBe(b?.rawBody);
    expect(a?.headers.authorization).toBeUndefined(); // the mock never records it
  });

  test("other kinds: a plain OpenAI request, usage without timings", async () => {
    const { client, mock } = await setup({ kind: "remote", script: [text("hi")] });
    const { reply, events } = await collect(client, request({ slot: 1 }));
    const body = mock.chatRequests[0]?.body as Json;
    for (const extra of ["cache_prompt", "id_slot", "timings_per_token", "return_progress"]) {
      expect(body).not.toHaveProperty(extra);
    }
    expect(events.some((e) => e.type === "prompt_progress")).toBe(false);
    expect(reply.usage).toEqual({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      cachedTokens: 0,
      promptTokensPerSecond: null,
      completionTokensPerSecond: null,
      promptMs: null,
      completionMs: null,
    });
  });

  test("countTokens: exact on the bundled runtime, null elsewhere or on failure", async () => {
    const bundled = await setup({ countTokens: (t) => t.length });
    const count = await bundled.client.countTokens({ messages, tools });
    const body = bundled.mock.requests[0]?.body as Json;
    expect(bundled.mock.requests[0]?.path).toBe("/v1/chat/completions/input_tokens");
    expect(count).toBe(JSON.stringify({ tools: body.tools, messages: body.messages }).length);
    await bundled.mock.close();

    const remote = await startMockModel({ kind: "remote" });
    mock = remote;
    expect(await createModelClient(remote.endpoint).countTokens({ messages, tools })).toBeNull();
    expect(remote.requests).toHaveLength(0);

    const broken = createModelClient({ ...remote.endpoint, kind: "bundled" });
    expect(await broken.countTokens({ messages, tools })).toBeNull(); // 404 from the openai flavour
  });
});

describe("failures", () => {
  test("a dropped stream is stream_interrupted with the partial reply", async () => {
    const { client } = await setup({
      script: [dropped(text("abcdefgh", { pacing: { chunkSize: 2 } }), 4)],
      progressBatch: 1_000_000,
    });
    const error = await failure(client);
    expect(error.kind).toBe("stream_interrupted");
    expect(error.retryable).toBe(true);
    expect(error.partial?.content.length).toBeGreaterThan(0);
  });

  test("a drop right after the headers has no partial", async () => {
    const { client } = await setup({ script: [dropped(text("abc"), 0)] });
    const error = await failure(client);
    expect(error).toMatchObject({ kind: "stream_interrupted", retryable: true, partial: null });
  });

  test("HTTP errors carry the status and the server's message", async () => {
    const { client } = await setup({
      script: [
        httpError(503, "Loading model"),
        httpError(400, "bad field"),
        httpError(429, undefined, "slow down"),
      ],
    });
    expect(await failure(client)).toMatchObject({
      kind: "http",
      status: 503,
      retryable: true,
      message: "HTTP 503: Loading model",
    });
    expect(await failure(client)).toMatchObject({ kind: "http", status: 400, retryable: false });
    expect(await failure(client)).toMatchObject({
      kind: "http",
      status: 429,
      retryable: true,
      message: "HTTP 429: slow down",
    });
  });

  test("context overflow, in the real shape and in common OpenAI-style wordings", async () => {
    const { client } = await setup({
      script: [
        contextOverflow(9000, 8192),
        httpError(400, undefined, {
          error: {
            message:
              "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        }),
        httpError(400, undefined, {
          object: "error",
          message:
            "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (4000 in the messages, 1000 in the completion).",
          type: "BadRequestError",
          code: 400,
        }),
      ],
    });
    for (let i = 0; i < 3; i++) {
      expect(await failure(client)).toMatchObject({
        kind: "context_overflow",
        status: 400,
        retryable: false,
      });
    }
  });

  test("an error event mid-stream ends the reply with the partial text", async () => {
    const { client } = await setup({
      script: [streamError(text("abcdef", { pacing: { chunkSize: 2 } }), 4, "slot crashed")],
      progressBatch: 1_000_000,
    });
    const error = await failure(client);
    expect(error).toMatchObject({ kind: "stream_interrupted", status: 500, retryable: true });
    expect(error.message).toContain("slot crashed");
    expect(error.partial?.content).toBe("ab");
  });

  test("an error event before any content is an http error", async () => {
    const { client } = await setup({ script: [streamError(text("abc"), 0, "refused")] });
    expect(await failure(client)).toMatchObject({ kind: "http", status: 500, partial: null });
  });

  test("something that is not a chat completion is invalid_response", async () => {
    const { client } = await setup({
      script: [
        invalidResponse(),
        invalidResponse(
          'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {oops\n\n',
          "text/event-stream",
        ),
        invalidResponse('data: {"hello":"world"}\n\n', "text/event-stream"),
        invalidResponse('{"object":"list","data":[]}', "application/json"),
      ],
    });
    const html = await failure(client);
    expect(html).toMatchObject({ kind: "invalid_response", retryable: false });
    expect(html.message).toContain("text/html");
    const broken = await failure(client);
    expect(broken).toMatchObject({ kind: "invalid_response" });
    expect(broken.partial?.content).toBe("a");
    expect(await failure(client)).toMatchObject({ kind: "invalid_response" });
    expect(await failure(client)).toMatchObject({ kind: "invalid_response" });
  });

  test("other servers' conventions: an `event: error` event, SSE sent as text/plain", async () => {
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
    const { client } = await setup({
      script: [
        invalidResponse('event: error\ndata: {"message":"overloaded"}\n\n', "text/event-stream"),
        invalidResponse(
          `${chunk("plain ")}${chunk("text")}data: [DONE]\n\n`,
          "text/plain; charset=utf-8",
        ),
      ],
    });
    const error = await failure(client);
    expect(error).toMatchObject({ kind: "http", partial: null });
    expect(error.message).toContain("overloaded");
    const { reply } = await collect(client);
    expect(reply).toMatchObject({ content: "plain text", finishReason: "unknown" });
  });

  test("nothing listening is a connection error", async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    const client = createModelClient({
      kind: "bundled",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "x",
      contextWindow: 1,
      capabilities: { tools: true, vision: false, reasoning: false, cacheControl: true },
    });
    const error = await failure(client);
    expect(error).toMatchObject({ kind: "connection", retryable: true, partial: null });
    expect(error.message).toContain("ECONNREFUSED");
    expect(await client.countTokens({ messages, tools })).toBeNull();
  });

  test("idle timeout: a stream that stalls part-way", async () => {
    const { client, mock } = await setup(
      {
        script: [stalled(text("abcdef", { pacing: { chunkSize: 2 } }), 4)],
        progressBatch: 1_000_000,
      },
      { idleTimeoutMs: 150 },
    );
    const started = performance.now();
    const error = await failure(client);
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
    expect(error.partial?.content).toBe("ab");
    expect(performance.now() - started).toBeLessThan(2000);
    await waitFor(() => mock.openConnections === 0);
  });

  test("idle timeout: headers but no events", async () => {
    const { client } = await setup({ script: [stalled(text("abc"), 0)] }, { idleTimeoutMs: 100 });
    expect(await failure(client)).toMatchObject({ kind: "timeout", partial: null });
  });

  test("a slow caller does not count as an idle server", async () => {
    const { client } = await setup(
      { script: [text("abc", { pacing: { chunkSize: 1 } })] },
      { idleTimeoutMs: 60 },
    );
    let content = "";
    for await (const event of client.stream(request())) {
      if (event.type === "text_delta") content += event.text;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(content).toBe("abc");
  });

  test("abort mid-stream throws aborted promptly and leaves no open socket", async () => {
    const { client, mock } = await setup({
      script: [stalled(text("abcdef", { pacing: { chunkSize: 2 } }), 4)],
      progressBatch: 1_000_000,
    });
    const controller = new AbortController();
    const seen: ModelStreamEvent[] = [];
    const run = (async () => {
      for await (const event of client.stream(request({ signal: controller.signal }))) {
        seen.push(event);
        if (event.type === "text_delta") setTimeout(() => controller.abort(), 20);
      }
    })();
    const started = performance.now();
    const error = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: "aborted", retryable: false });
    expect((error as ModelError).partial?.content).toBe("ab");
    expect(performance.now() - started).toBeLessThan(1000);
    await waitFor(() => mock.openConnections === 0);
  });

  test("an already aborted signal fails before sending", async () => {
    const { client, mock } = await setup({ script: [text("a")] });
    const error = await failure(client, request({ signal: AbortSignal.abort() }));
    expect(error.kind).toBe("aborted");
    expect(mock.requests).toHaveLength(0);
  });

  test("leaving the loop early closes the connection", async () => {
    const { client, mock } = await setup({
      script: [stalled(text("abcdef", { pacing: { chunkSize: 2 } }), 4)],
      progressBatch: 1_000_000,
    });
    for await (const event of client.stream(request())) {
      if (event.type === "text_delta") break;
    }
    await waitFor(() => mock.openConnections === 0);
  });
});
