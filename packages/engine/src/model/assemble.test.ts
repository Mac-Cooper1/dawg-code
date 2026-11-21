import { describe, expect, test } from "vitest";
import type { ModelStreamEvent } from "../contracts/model.ts";
import { ChunkError, ReplyAssembler, toUsage } from "./assemble.ts";
import { errorDetails, httpError, isContextOverflow, streamErrorEvent } from "./errors.ts";

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const call = (entry: Record<string, unknown>) => chunk({ tool_calls: [entry] });

function run(chunks: unknown[]) {
  const assembler = new ReplyAssembler();
  const events: ModelStreamEvent[] = [];
  for (const c of chunks) events.push(...assembler.accept(c));
  const done = assembler.complete();
  return { events: [...events, ...done.events], reply: done.reply };
}

describe("ReplyAssembler tool calls", () => {
  test("a server that numbers every call 0 but gives each its own id", () => {
    const { reply } = run([
      call({ index: 0, id: "a", function: { name: "Read", arguments: '{"x":1}' } }),
      call({ index: 0, id: "b", function: { name: "Grep", arguments: '{"y":2}' } }),
      chunk({}, "tool_calls"),
    ]);
    expect(reply.toolCalls).toEqual([
      { id: "a", name: "Read", arguments: '{"x":1}' },
      { id: "b", name: "Grep", arguments: '{"y":2}' },
    ]);
  });

  test("no index and no id: a named delta starts a call, the rest continue it", () => {
    const { reply, events } = run([
      call({ function: { name: "Read", arguments: '{"x"' } }),
      call({ function: { arguments: ":1}" } }),
      call({ function: { name: "Grep" } }),
      call({ function: { arguments: "{}" } }),
    ]);
    expect(reply.toolCalls).toEqual([
      { id: "", name: "Read", arguments: '{"x":1}' },
      { id: "", name: "Grep", arguments: "{}" },
    ]);
    expect(events.filter((e) => e.type === "tool_call_started").length).toBe(2);
  });

  test("arguments before the name are held until the call is announced", () => {
    const { events } = run([
      call({ index: 0, function: { arguments: '{"a"' } }),
      call({ index: 0, id: "c1", function: { name: "Edit", arguments: ":1}" } }),
    ]);
    expect(events).toEqual([
      { type: "tool_call_started", index: 0, id: "c1", name: "Edit" },
      { type: "tool_call_delta", index: 0, arguments: '{"a"' },
      { type: "tool_call_delta", index: 0, arguments: ":1}" },
    ]);
  });

  test("a call that never got a name is still announced at the end", () => {
    const { events, reply } = run([call({ index: 0, function: { arguments: "{}" } })]);
    expect(events).toEqual([
      { type: "tool_call_started", index: 0, id: "", name: "" },
      { type: "tool_call_delta", index: 0, arguments: "{}" },
    ]);
    expect(reply.finishReason).toBe("unknown");
  });

  test("server indexes that skip numbers still give dense event indexes", () => {
    const { events } = run([
      call({ index: 3, id: "x", function: { name: "A", arguments: "{}" } }),
      call({ index: 7, id: "y", function: { name: "B", arguments: "{}" } }),
    ]);
    expect(events.filter((e) => e.type === "tool_call_started").map((e) => e.index)).toEqual([
      0, 1,
    ]);
  });

  test("object arguments and the legacy function_call form", () => {
    expect(
      run([call({ index: 0, function: { name: "A", arguments: { k: 1 } } })]).reply.toolCalls,
    ).toEqual([{ id: "", name: "A", arguments: '{"k":1}' }]);
    const legacy = run([chunk({ function_call: { name: "B", arguments: "{}" } }, "function_call")]);
    expect(legacy.reply.toolCalls).toEqual([{ id: "", name: "B", arguments: "{}" }]);
    expect(legacy.reply.finishReason).toBe("tool_calls");
  });
});

describe("ReplyAssembler content", () => {
  test("`reasoning` is read as well as `reasoning_content`", () => {
    const { reply } = run([
      chunk({ reasoning: "a" }),
      chunk({ reasoning_content: "b" }),
      chunk({ content: "c" }),
    ]);
    expect(reply).toMatchObject({ reasoning: "ab", content: "c" });
  });

  test("finish reasons map onto the contract's set", () => {
    const finish = (reason: string) => run([chunk({}, reason)]).reply.finishReason;
    expect(finish("stop")).toBe("stop");
    expect(finish("length")).toBe("length");
    expect(finish("tool_calls")).toBe("tool_calls");
    expect(finish("content_filter")).toBe("content_filter");
    expect(finish("something_new")).toBe("unknown");
  });

  test("errors and things that are not chunks", () => {
    const assembler = new ReplyAssembler();
    expect(() => assembler.accept([])).toThrow(ChunkError);
    expect(() => assembler.accept({ hello: 1 })).toThrow("not a chat-completion chunk");
    expect(() => assembler.accept({ error: { message: "x" } })).toThrow(ChunkError);
    expect(assembler.partial()).toBeNull();
  });
});

describe("toUsage", () => {
  test("nothing reported gives nulls", () => {
    expect(toUsage(null, null)).toEqual({
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      promptTokensPerSecond: null,
      completionTokensPerSecond: null,
      promptMs: null,
      completionMs: null,
    });
  });

  test("a fully cached prompt has no prompt speed", () => {
    const usage = toUsage(null, {
      cache_n: 50,
      prompt_n: 0,
      prompt_ms: 0,
      prompt_per_second: 0,
      predicted_n: 0,
      predicted_ms: 0,
      predicted_per_second: 0,
    });
    expect(usage).toMatchObject({
      promptTokens: 50,
      cachedTokens: 50,
      promptTokensPerSecond: null,
      completionTokensPerSecond: null,
    });
  });

  test("OpenAI-style cached_tokens when there are no timings", () => {
    expect(
      toUsage(
        { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } },
        null,
      ),
    ).toMatchObject({ promptTokens: 10, completionTokens: 2, cachedTokens: 8 });
  });
});

describe("error mapping", () => {
  test.each([
    "request (5320 tokens) exceeds the available context size (2048 tokens), try increasing it",
    "the request exceeds the available context size, try increasing it",
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.",
    "Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 8192 tokens, which is not enough.",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "Input is longer than the model's context window",
    "Context length exceeded",
  ])("context overflow: %s", (message) => {
    expect(isContextOverflow({ message, type: null, code: null })).toBe(true);
    expect(httpError(400, "Bad Request", JSON.stringify({ error: { message } })).kind).toBe(
      "context_overflow",
    );
  });

  test.each(["Invalid API Key", "'messages' is required", "Failed to parse grammar"])(
    "not an overflow: %s",
    (message) => {
      expect(isContextOverflow({ message, type: null, code: null })).toBe(false);
    },
  );

  test("overflow is only considered for 400, 413 and 422", () => {
    const body = JSON.stringify({ error: { type: "exceed_context_size_error", message: "x" } });
    expect(httpError(400, "", body).kind).toBe("context_overflow");
    expect(httpError(500, "", body).kind).toBe("http");
  });

  test("message sources and retryability", () => {
    expect(errorDetails({ error: "plain" }).message).toBe("plain");
    expect(errorDetails({ object: "error", message: "vllm style" }).message).toBe("vllm style");
    expect(errorDetails({ detail: "fastapi" }).message).toBe("fastapi");
    expect(httpError(502, "Bad Gateway", "<html>gateway</html>")).toMatchObject({
      kind: "http",
      retryable: true,
      message: "HTTP 502: <html>gateway</html>",
    });
    expect(httpError(404, "Not Found", "")).toMatchObject({
      retryable: false,
      message: "HTTP 404: Not Found",
    });
    expect(httpError(408, "", "").retryable).toBe(true);
  });

  test("errors inside a stream", () => {
    const partial = { content: "so far", reasoning: "", toolCalls: [] };
    expect(streamErrorEvent({ code: 500, message: "boom" }, partial)).toMatchObject({
      kind: "stream_interrupted",
      status: 500,
      retryable: true,
      partial,
    });
    expect(streamErrorEvent({ code: 503, message: "busy" }, null)).toMatchObject({
      kind: "http",
      status: 503,
      retryable: true,
    });
    expect(
      streamErrorEvent({ code: 400, message: "x", type: "exceed_context_size_error" }, partial),
    ).toMatchObject({ kind: "context_overflow", retryable: false });
  });
});
