import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import {
  fixedIds,
  runStep,
  scriptedSteps,
  steppingClock,
  type TempStore,
  tempStore,
} from "./__fixtures__/script.ts";

let t: TempStore;

beforeEach(async () => {
  t = await tempStore({ now: steppingClock(), newId: fixedIds() });
});
afterEach(async () => {
  await t.cleanup();
});

describe("Markdown export", () => {
  it("renders prompts, replies, tool calls, trimmed results, notes, state and compactions", async () => {
    const writer = await t.store.create({ cwd: "/work/project" });
    const history: Message[] = [];
    for (const step of scriptedSteps()) await runStep(writer, history, step);
    await writer.appendMessage({
      role: "assistant",
      content: "Here is a fence inside a reply:\n```ts\nconst x = 1;\n```",
      toolCalls: [
        {
          id: "call_7",
          name: "Write",
          arguments: "{not valid json",
          rawArguments: "{not valid json",
        },
      ],
    });
    await writer.appendMessage({
      role: "tool",
      toolCallId: "call_7",
      toolName: "Write",
      content: [{ type: "text", text: "```\nresult with a fence\n```" }],
      isError: false,
    });
    await writer.close();

    const markdown = await t.store.exportMarkdown("/work/project", writer.sessionId, {
      maxResultChars: 300,
    });
    await expect(markdown).toMatchFileSnapshot("./__fixtures__/export.snapshot.md");
  });

  it("can leave reasoning out", async () => {
    const writer = await t.store.create({ cwd: "/work/project" });
    await writer.appendMessage({
      role: "assistant",
      content: "hi",
      reasoning: "secret plan",
      toolCalls: [],
    });
    await writer.close();
    const withReasoning = await t.store.exportMarkdown("/work/project", writer.sessionId);
    const without = await t.store.exportMarkdown("/work/project", writer.sessionId, {
      reasoning: false,
    });
    expect(withReasoning).toContain("secret plan");
    expect(without).not.toContain("secret plan");
  });
});
