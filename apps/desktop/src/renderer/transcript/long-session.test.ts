/**
 * The mock engine's long session through the renderer's reducer: it builds exactly the number of
 * items asked for, of every kind, so the performance tests measure what they claim to.
 */
import { describe, expect, it } from "vitest";
import { LONG_SESSION_ID, longSessionScenario } from "../../mock-engine/long-session.ts";
import { harness } from "../../mock-engine/test-support.ts";
import { emptyEngineSlice, reduceAll } from "../state/reducer.ts";

async function load(items: number) {
  const h = harness({ scenarios: [longSessionScenario(items)] });
  const peer = await h.connect();
  const snapshot = await peer.request("session.resume", { sessionId: LONG_SESSION_ID });
  const replay = await peer.request("session.replay", { sessionId: LONG_SESSION_ID, afterSeq: 0 });
  peer.close();
  h.engine.dispose();
  const started = performance.now();
  const slice = reduceAll(emptyEngineSlice(), [
    { type: "summaries", sessions: [snapshot.session] },
    { type: "snapshot", snapshot },
    { type: "replay", sessionId: LONG_SESSION_ID, events: replay.events, done: true },
  ]);
  return { slice, ms: performance.now() - started, events: replay.events.length };
}

describe("the long session in the reducer", () => {
  it("makes exactly the items asked for", async () => {
    for (const items of [100, 777, 5_000]) {
      const { slice } = await load(items);
      expect(slice.transcripts[LONG_SESSION_ID]).toHaveLength(items);
    }
  });

  it("has every kind of item, decisions answered and nothing left running", async () => {
    const { slice } = await load(5_000);
    const items = slice.transcripts[LONG_SESSION_ID] ?? [];
    const kinds = new Set(items.map((item) => item.kind));
    for (const kind of [
      "user",
      "assistant",
      "reasoning",
      "tool",
      "permission",
      "question",
      "plan",
      "note",
      "compaction",
      "turn-summary",
    ]) {
      expect(kinds, kind).toContain(kind);
    }
    for (const item of items) {
      if (item.kind === "permission" || item.kind === "question" || item.kind === "plan") {
        expect(item.state).toBe("answered");
      }
      if (item.kind === "tool") expect(item.state).not.toBe("running");
      if (item.kind === "assistant") expect(item.streaming).toBe(false);
    }
    expect(slice.sessions[LONG_SESSION_ID]?.loaded).toBe(true);
    expect(slice.pending[LONG_SESSION_ID] ?? []).toEqual([]);
  });
});
