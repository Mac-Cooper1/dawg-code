/** Summarising from a point (rewind's "summarise from here"): the request the compactor sends. */
import { startMockModel, text } from "@dawg/mock-model";
import { describe, expect, test } from "vitest";
import type { Message, UserMessage } from "../contracts/messages.ts";
import { createModelClient } from "../model/index.ts";
import { buildPromptPrefix } from "../prompt/index.ts";
import { createCompactor } from "./compact.ts";
import { partialSummaryNote } from "./summary.ts";

const note = (value: string): UserMessage => ({
  role: "user",
  kind: "note",
  content: [{ type: "text", text: value }],
});
const prompt = (value: string): UserMessage => ({
  role: "user",
  kind: "prompt",
  content: [{ type: "text", text: value }],
});
const reply = (value: string): Message => ({ role: "assistant", content: value, toolCalls: [] });

describe("summarising from a point", () => {
  test("sends the whole history, asking about the part from the chosen message on", async () => {
    const mock = await startMockModel({ contextWindow: 65_536, script: [text("## Goal\nB")] });
    try {
      const history = [
        note("Session context."),
        prompt("First, rename the module."),
        reply("Renamed."),
        prompt("Second, add a cache layer to the loader."),
        reply("Added."),
      ];
      const result = await createCompactor().compact({
        prefix: buildPromptPrefix({ tools: [], instructions: "" }),
        history,
        client: createModelClient(mock.endpoint),
        focus: "the cache",
        tasks: [],
        recentFiles: [],
        from: 3,
        signal: new AbortController().signal,
      });
      expect(result.summary).toBe("## Goal\nB");
      const sent = mock.messages(0) as { role: string; content: string }[];
      // Everything is sent, so the cached prompt is reused, then the request.
      expect(sent).toHaveLength(history.length + 2);
      const ask = JSON.stringify(sent.at(-1));
      expect(ask).toContain('begins \\"Second, add a cache layer to the loader.\\"');
      expect(ask).toContain("everything before it stays as it is");
      expect(ask).toContain("concentrate on: the cache");
    } finally {
      await mock.close();
    }
  });

  test("the note that replaces that part says the messages above it are unchanged", () => {
    const message = partialSummaryNote("## Goal\nB", [{ content: "Cache", status: "pending" }]);
    const body = message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(body).toContain("the messages above it are unchanged");
    expect(body).toContain("## Goal\nB");
    expect(body).toContain("- pending: Cache");
  });
});
