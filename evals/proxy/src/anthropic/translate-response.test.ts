import { describe, expect, test } from "vitest";
import { ChatAccumulator } from "../chat-accumulator.ts";
import { completion } from "../fake-upstream.ts";
import {
  buildMessage,
  mapStopReason,
  sanitizeToolId,
  toolInput,
  translateUpstreamError,
} from "./translate-response.ts";

describe("translate-response", () => {
  test("stop reasons", () => {
    expect(mapStopReason("stop", false)).toBe("end_turn");
    expect(mapStopReason("length", false)).toBe("max_tokens");
    expect(mapStopReason("tool_calls", true)).toBe("tool_use");
    // Some servers say "stop" even when they emitted tool calls.
    expect(mapStopReason("stop", true)).toBe("tool_use");
    expect(mapStopReason("content_filter", false)).toBe("refusal");
    expect(mapStopReason(null, false)).toBe("end_turn");
  });

  test("tool input is always an object", () => {
    expect(toolInput('{"a":1}')).toEqual({ a: 1 });
    expect(toolInput("")).toEqual({});
    expect(toolInput("[1]")).toEqual({});
    expect(toolInput('{"a":')).toEqual({});
  });

  test("tool ids are made safe", () => {
    expect(sanitizeToolId("call_ok-1")).toBe("call_ok-1");
    expect(sanitizeToolId("call:1/2")).toBe("call_1_2");
    expect(sanitizeToolId(null)).toMatch(/^toolu_[0-9a-f]+$/);
  });

  test("non-streamed message with reasoning, text and a tool call", () => {
    const acc = new ChatAccumulator();
    acc.applyCompletion(
      completion(
        {
          reasoning_content: "plan",
          content: "Running it.",
          tool_calls: [
            {
              id: "c",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"ls"}' },
            },
          ],
        },
        "tool_calls",
      ),
    );
    expect(buildMessage(acc, "claude-x")).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "thinking", thinking: "plan", signature: "" },
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "c", name: "Bash", input: { command: "ls" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  test("context overflow errors become 'prompt is too long'", () => {
    const vllm = translateUpstreamError(
      400,
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens in the messages.",
        },
      }),
    );
    expect(vllm.status).toBe(400);
    expect(vllm.body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: expect.stringMatching(/^prompt is too long: 40000 tokens > 32768 maximum/),
      },
    });
    const plain = translateUpstreamError(503, "busy");
    expect(plain.body).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "busy" },
    });
  });
});
