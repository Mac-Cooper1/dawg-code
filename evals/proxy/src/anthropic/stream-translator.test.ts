import { describe, expect, test } from "vitest";
import { chunk } from "../fake-upstream.ts";
import { type SseEvent, SseParser } from "../sse.ts";
import { AnthropicStreamTranslator } from "./stream-translator.ts";

function run(chunks: unknown[], end: "finish" | "fail" = "finish") {
  let text = "";
  const t = new AnthropicStreamTranslator({
    model: "claude-x",
    estimatedInputTokens: 42,
    write: (s) => {
      text += s;
    },
  });
  t.start();
  for (const c of chunks) t.onChunk(c);
  if (end === "finish") t.finish();
  else t.fail("api_error", "broken");
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const parser = new SseParser((e: SseEvent) =>
    events.push({ event: e.event, data: JSON.parse(e.data) as Record<string, unknown> }),
  );
  parser.push(text);
  parser.end();
  for (const e of events) expect(e.data.type).toBe(e.event);
  return events;
}

/** Compact view: event names with block index and delta type. */
function shape(events: ReturnType<typeof run>): string[] {
  return events.map(({ event, data }) => {
    if (event === "content_block_start") {
      const block = data.content_block as Record<string, unknown>;
      return `start ${data.index} ${block.type}`;
    }
    if (event === "content_block_delta") {
      return `delta ${data.index} ${(data.delta as Record<string, unknown>).type}`;
    }
    if (event === "content_block_stop") return `stop ${data.index}`;
    return event;
  });
}

describe("AnthropicStreamTranslator", () => {
  test("plain text", () => {
    const events = run([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      chunk({}, {}, "stop"),
      {
        id: "x",
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      },
    ]);
    expect(shape(events)).toEqual([
      "message_start",
      "ping",
      "start 0 text",
      "delta 0 text_delta",
      "delta 0 text_delta",
      "stop 0",
      "message_delta",
      "message_stop",
    ]);
    const start = events[0]?.data.message as Record<string, unknown>;
    expect(start).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 42, output_tokens: 0 },
    });
    expect(String(start.id)).toMatch(/^msg_/);
    expect(events[6]?.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: 20,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      },
    });
  });

  test("reasoning, text, more reasoning and several tool calls get sequential indices", () => {
    const events = run([
      chunk({ reasoning_content: "Think" }),
      chunk({ reasoning_content: "ing" }),
      chunk({ content: "I'll read two files." }),
      chunk({ reasoning_content: "Also grep." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_a",
            type: "function",
            function: { name: "Read", arguments: '{"pa' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: "call b!",
            type: "function",
            function: { name: "Read", arguments: '{"path":"b"}' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
      chunk({
        tool_calls: [
          {
            index: 2,
            id: "call_c",
            type: "function",
            function: { name: "Grep", arguments: '{"pattern":' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 2, function: { arguments: '"x"}' } }] }),
      chunk({}, {}, "tool_calls"),
    ]);
    expect(shape(events)).toEqual([
      "message_start",
      "ping",
      "start 0 thinking",
      "delta 0 thinking_delta",
      "delta 0 thinking_delta",
      "stop 0",
      "start 1 text",
      "delta 1 text_delta",
      "stop 1",
      "start 2 thinking",
      "delta 2 thinking_delta",
      "stop 2",
      "start 3 tool_use",
      "delta 3 input_json_delta",
      "stop 3",
      "start 4 tool_use",
      "delta 4 input_json_delta",
      "stop 4",
      "start 5 tool_use",
      "delta 5 input_json_delta",
      "stop 5",
      "message_delta",
      "message_stop",
    ]);
    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as { type: string }).type === "tool_use",
    );
    expect(toolStarts.map((e) => e.data.content_block)).toEqual([
      { type: "tool_use", id: "call_a", name: "Read", input: {} },
      { type: "tool_use", id: "call_b_", name: "Read", input: {} },
      { type: "tool_use", id: "call_c", name: "Grep", input: {} },
    ]);
    const inputs = events
      .filter((e) => (e.data.delta as { type?: string } | undefined)?.type === "input_json_delta")
      .map((e) => JSON.parse((e.data.delta as { partial_json: string }).partial_json));
    expect(inputs).toEqual([{ path: "a" }, { path: "b" }, { pattern: "x" }]);
    const delta = events.find((e) => e.event === "message_delta");
    expect((delta?.data.delta as { stop_reason?: string } | undefined)?.stop_reason).toBe(
      "tool_use",
    );
  });

  test("malformed tool arguments still produce well-formed JSON input", () => {
    const events = run([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "c",
            type: "function",
            function: { name: "Edit", arguments: '{"file_path": "a.ts", ' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 1, id: "d", type: "function", function: { name: "Edit", arguments: "[1,2]" } },
        ],
      }),
      chunk({}, {}, "tool_calls"),
    ]);
    const inputs = events
      .filter((e) => (e.data.delta as { type?: string } | undefined)?.type === "input_json_delta")
      .map((e) => (e.data.delta as { partial_json: string }).partial_json);
    expect(inputs).toEqual(["{}", "{}"]);
  });

  test("finish_reason length maps to max_tokens; failures end with an error event", () => {
    const events = run([chunk({ content: "a" }), chunk({}, {}, "length")]);
    const delta = events.find((e) => e.event === "message_delta");
    expect((delta?.data.delta as { stop_reason?: string } | undefined)?.stop_reason).toBe(
      "max_tokens",
    );

    const failed = run([chunk({ content: "a" })], "fail");
    expect(shape(failed).slice(-1)).toEqual(["error"]);
    expect(failed.at(-1)?.data).toEqual({
      type: "error",
      error: { type: "api_error", message: "broken" },
    });
  });

  test("an error chunk from the upstream is reported", () => {
    const t = new AnthropicStreamTranslator({
      model: "m",
      estimatedInputTokens: 0,
      write: () => {},
    });
    expect(t.onChunk({ error: { message: "slot unavailable" } })).toBe("slot unavailable");
  });
});
