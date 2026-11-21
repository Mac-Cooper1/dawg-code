import { describe, expect, test } from "vitest";
import { ChatAccumulator } from "./chat-accumulator.ts";
import { chunk, completion } from "./fake-upstream.ts";

describe("ChatAccumulator", () => {
  test("rebuilds tool calls from fragments split across chunks, by index", () => {
    const acc = new ChatAccumulator();
    const fragments = [
      chunk({ role: "assistant", content: "Let me " }),
      chunk({ content: "look." }),
      chunk({
        tool_calls: [
          { index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] }),
      chunk({
        tool_calls: [
          {
            index: 1,
            id: "call_b",
            type: "function",
            function: { name: "Grep", arguments: '{"pat' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: 'tern":"x"}' } }] }),
      chunk({}, {}, "tool_calls"),
      {
        id: "chatcmpl-test",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    ];
    for (const f of fragments) acc.applyChunk(f);
    expect(acc.content).toBe("Let me look.");
    expect(acc.finishReason).toBe("tool_calls");
    expect(acc.toolCalls()).toEqual([
      { id: "call_a", name: "Read", arguments: '{"file_path":"a.ts"}' },
      { id: "call_b", name: "Grep", arguments: '{"pattern":"x"}' },
    ]);
    expect(acc.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 4 });
  });

  test("tolerates fragments without index and names repeated on every fragment", () => {
    const acc = new ChatAccumulator();
    acc.applyChunk(chunk({ tool_calls: [{ id: "a", function: { name: "X", arguments: "{" } }] }));
    acc.applyChunk(chunk({ tool_calls: [{ function: { name: "X", arguments: "}" } }] }));
    acc.applyChunk(chunk({ tool_calls: [{ id: "b", function: { name: "Y", arguments: "{}" } }] }));
    expect(acc.toolCalls()).toEqual([
      { id: "a", name: "X", arguments: "{}" },
      { id: "b", name: "Y", arguments: "{}" },
    ]);
  });

  test("reads reasoning_content, timings and errors", () => {
    const acc = new ChatAccumulator();
    acc.applyChunk(chunk({ reasoning_content: "think " }));
    acc.applyChunk(chunk({ reasoning_content: "more" }));
    acc.applyChunk(
      chunk(
        {},
        {
          timings: {
            cache_n: 100,
            prompt_n: 5,
            prompt_per_second: 50,
            predicted_n: 3,
            predicted_per_second: 20,
            prompt_ms: 100,
            predicted_ms: 150,
          },
        },
        "stop",
      ),
    );
    expect(acc.reasoning).toBe("think more");
    expect(acc.timings).toEqual({
      cache_n: 100,
      prompt_n: 5,
      prompt_per_second: 50,
      predicted_n: 3,
      predicted_per_second: 20,
      prompt_ms: 100,
      predicted_ms: 150,
    });
    acc.applyChunk({ error: { code: 500, message: "boom" } });
    expect(acc.error).toBe("boom");
  });

  test("non-streamed completion", () => {
    const acc = new ChatAccumulator();
    acc.applyCompletion(
      completion(
        {
          content: null,
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
    expect(acc.toolCalls()).toEqual([{ id: "c", name: "Bash", arguments: '{"command":"ls"}' }]);
    expect(acc.usage.prompt_tokens).toBe(100);
    expect(acc.usage.cached_tokens).toBeNull();
  });
});
