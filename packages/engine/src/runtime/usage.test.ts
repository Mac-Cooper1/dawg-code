import { text, toolCall } from "@dawg/mock-model";
import type { ContextBreakdown, Usage } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCompactor } from "./__fixtures__/fakes.ts";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { splitContext } from "./usage.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const sum = (b: ContextBreakdown) => b.systemPrompt + b.instructions + b.tools + b.messages;

function usageEvents(harness: Harness, sessionId: string): Usage[] {
  return harness.ofType(sessionId, "usage.updated").map((e) => e.payload.usage as Usage);
}

describe("splitContext", () => {
  it("scales the estimate to the total in whole tokens, the remainder going to messages", () => {
    const split = splitContext(
      { systemPrompt: 333, instructions: 111, tools: 222, messages: 334 },
      2001,
    );
    expect(sum(split)).toBe(2001);
    expect(split).toEqual({ systemPrompt: 666, instructions: 222, tools: 444, messages: 669 });
    const shrunk = splitContext({ systemPrompt: 10, instructions: 0, tools: 10, messages: 0 }, 7);
    expect(sum(shrunk)).toBe(7);
    expect(shrunk.messages).toBeGreaterThanOrEqual(0);
    expect(splitContext({ systemPrompt: 0, instructions: 0, tools: 0, messages: 0 }, 50)).toEqual({
      systemPrompt: 0,
      instructions: 0,
      tools: 0,
      messages: 50,
    });
  });
});

describe("context usage", () => {
  it("reports the compaction limit and a split that adds up, with instruction files apart", async () => {
    h = await startHarness({
      files: { "CLAUDE.md": `${"Always run the tests before you finish. ".repeat(40)}\n` },
      mock: { contextWindow: 10_000 },
      script: [toolCall("Read", { file_path: "CLAUDE.md" }), text("done")],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("read it"));
    const updates = usageEvents(h, session.id);
    expect(updates).toHaveLength(2);
    for (const usage of updates) {
      // The fake profile compacts at 65% of the window.
      expect(usage.compactAt).toBe(6500);
      expect(usage.breakdown).not.toBeNull();
      expect(sum(usage.breakdown as ContextBreakdown)).toBe(usage.contextUsed);
      expect(usage.breakdown?.instructions).toBeGreaterThan(0);
      expect(usage.breakdown?.tools).toBeGreaterThan(0);
      expect(usage.breakdown?.systemPrompt).toBeGreaterThan(0);
    }
    const [first, second] = updates as [Usage, Usage];
    // The file's contents joined the conversation; the prefix stayed as it was.
    expect(second.breakdown?.messages).toBeGreaterThan(first.breakdown?.messages ?? 0);
    expect(session.snapshot().usage).toEqual(second);
    expect(session.contextUsage()).toEqual({
      contextWindow: 10_000,
      contextUsed: second.contextUsed,
      measured: true,
      compactAt: 6500,
      breakdown: second.breakdown,
    });
  });

  it("estimates before the first request, and updates after compaction and on resume", async () => {
    h = await startHarness({
      files: { "CLAUDE.md": "Use tabs.\n" },
      engine: { compactor: fakeCompactor() },
      script: [text("one"), text("two")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const before = session.contextUsage();
    expect(before.measured).toBe(false);
    expect(before.contextUsed).toBe(sum(before.breakdown));
    expect(before.breakdown.instructions).toBeGreaterThan(0);
    expect(session.snapshot().usage).toBeNull();

    await session.run(ask("first"));
    await session.run(ask("second"));
    const count = usageEvents(h, session.id).length;
    expect((await session.compact()).outcome).toBe("completed");
    const afterCompaction = usageEvents(h, session.id).slice(count);
    expect(afterCompaction).toHaveLength(1);
    const compacted = afterCompaction[0] as Usage;
    expect(sum(compacted.breakdown as ContextBreakdown)).toBe(compacted.contextUsed);

    await session.close();
    const resumed = await h.engine.resumeSession(session.id);
    const restored = resumed.snapshot().usage as Usage;
    // The context left by the compaction, not the last reply's.
    expect(restored.contextUsed).toBe(compacted.contextUsed);
    expect(restored.compactAt).toBe(compacted.compactAt);
    expect(sum(restored.breakdown as ContextBreakdown)).toBe(restored.contextUsed);
    expect(restored.breakdown?.instructions).toBeGreaterThan(0);
  });

  it("has no compaction limit when the window is unknown", async () => {
    h = await startHarness({ mock: { contextWindow: 0 }, script: [text("hi")] });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("hello"));
    const usage = session.snapshot().usage as Usage;
    expect(usage.compactAt).toBeNull();
    expect(sum(usage.breakdown as ContextBreakdown)).toBe(usage.contextUsed);
  });
});
