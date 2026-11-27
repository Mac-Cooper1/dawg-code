/**
 * The synthetic long session: it follows the protocol, has the mix it promises, and the engine
 * serves it like any recorded session (snapshot, replay, the streamed turn on the next prompt).
 */
import type { EngineEvent } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import {
  LONG_SESSION_ID,
  longSessionEvents,
  longSessionScenario,
  parseLongSession,
  STREAM_DELTAS,
} from "./long-session.ts";
import { BUILT_IN_SCENARIOS } from "./scenarios.ts";
import { harness } from "./test-support.ts";

function count(events: readonly EngineEvent[], name: string): number {
  return events.filter((event) => event.event === name).length;
}

describe("parseLongSession", () => {
  it("reads a whole number of items and ignores anything else", () => {
    const logged: string[] = [];
    const log = (line: string) => logged.push(line);
    expect(parseLongSession(undefined, log)).toBeNull();
    expect(parseLongSession("", log)).toBeNull();
    expect(parseLongSession("5000", log)).toBe(5000);
    expect(parseLongSession(" 250 ", log)).toBe(250);
    expect(logged).toEqual([]);
    expect(parseLongSession("lots", log)).toBeNull();
    expect(parseLongSession("12.5", log)).toBeNull();
    expect(parseLongSession("3", log)).toBeNull();
    expect(parseLongSession("9000000", log)).toBeNull();
    expect(logged).toHaveLength(4);
    expect(logged[0]).toContain('DAWG_MOCK_LONG_SESSION="lots"');
  });
});

describe("the long session", () => {
  it("follows the protocol's ordering rules and ends with nothing open", () => {
    for (const items of [100, 1_001, 5_000]) {
      expect(checkConformance(longSessionEvents(items), { requireClosed: true })).toEqual([]);
    }
  });

  it("has every kind of item a long day leaves, and no streaming events", () => {
    const events = longSessionEvents(5_000);
    expect(count(events, "turn.started")).toBeGreaterThan(400);
    expect(count(events, "permission.requested")).toBeGreaterThanOrEqual(10);
    expect(count(events, "question.asked")).toBeGreaterThanOrEqual(10);
    expect(count(events, "plan.proposed")).toBeGreaterThanOrEqual(10);
    expect(count(events, "compaction.started")).toBeGreaterThanOrEqual(3);
    const finished = events.flatMap((event) =>
      event.event === "turn.finished" ? [event.payload.stopReason] : [],
    );
    expect(finished).toContain("interrupted");
    const displays = new Set(
      events.flatMap((event) =>
        event.event === "tool.finished" && event.payload.display
          ? [event.payload.display.kind]
          : [],
      ),
    );
    expect([...displays].sort()).toEqual(["command", "diff", "file", "search"]);
    expect(
      events.some(
        (event) => event.event === "message.finished" && event.payload.text.includes("```"),
      ),
    ).toBe(true);
    for (const name of ["message.delta", "reasoning.delta", "tool.progress", "prompt.progress"]) {
      expect(count(events, name)).toBe(0);
    }
  });

  it("is the same on every run", () => {
    expect(longSessionEvents(500)).toEqual(longSessionEvents(500));
  });

  it("streams its next turn in many small pieces", () => {
    const { recordings } = longSessionScenario(200);
    const stream = recordings["stream.jsonl"] ?? [];
    expect(checkConformance(stream, { midSession: true, requireClosed: true })).toEqual([]);
    expect(count(stream, "message.delta")).toBeGreaterThanOrEqual(STREAM_DELTAS);
    expect(count(stream, "message.delta")).toBeLessThan(STREAM_DELTAS + 200);
  });

  it("is served by the mock engine: listed, replayed, and streamed on the next prompt", async () => {
    const h = harness({ scenarios: [...BUILT_IN_SCENARIOS, longSessionScenario(300)] });
    const peer = await h.connect();
    const { sessions } = await peer.request("session.list", {});
    expect(sessions.map((session) => session.id)).toContain(LONG_SESSION_ID);
    await peer.request("session.resume", { sessionId: LONG_SESSION_ID });
    const replay = await peer.request("session.replay", {
      sessionId: LONG_SESSION_ID,
      afterSeq: 0,
    });
    expect(replay.hasMore).toBe(false);
    expect(checkConformance(replay.events, { requireClosed: true })).toEqual([]);
    await peer.request("session.prompt", {
      sessionId: LONG_SESSION_ID,
      prompt: { content: [{ type: "text", text: "Summarise the day." }], mentions: [] },
    });
    await h.runAll();
    const live = peer.of(LONG_SESSION_ID);
    expect(count(live, "message.delta")).toBeGreaterThanOrEqual(STREAM_DELTAS);
    expect(live.at(-1)?.event).toBe("session.status");
    peer.close();
    h.engine.dispose();
  });
});
