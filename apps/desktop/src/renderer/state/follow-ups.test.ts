import { describe, expect, it } from "vitest";
import {
  applyLive,
  applyReplay,
  createStream,
  HOME,
  makeSnapshot,
  makeSummary,
} from "./__fixtures__/streams.ts";
import { followUps } from "./follow-ups.ts";
import { emptyEngineSlice, reduce } from "./reducer.ts";
import { initialAppState } from "./store.ts";
import type { AppState, EngineSlice } from "./types.ts";

function app(slice: EngineSlice, patch: Partial<AppState> = {}): AppState {
  return { ...initialAppState(HOME), ...slice, ...patch };
}

function turn(sessionId: string, seq: number, stopReason: "completed" | "interrupted") {
  const stream = createStream(sessionId, { seq });
  stream.emit("turn.started", {
    turnId: `t${seq}`,
    prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
    command: null,
  });
  stream.emit("turn.finished", {
    turnId: `t${seq}`,
    stopReason,
    finalText: null,
    error: null,
    durationMs: 10,
  });
  return stream.events;
}

describe("followUps", () => {
  it("treats sessions seen for the first time as seen up to their current seq", () => {
    const prev = app(emptyEngineSlice(), {
      ui: { ...initialAppState(HOME).ui, seenSeq: { known: 3 } },
    });
    const next = reduce(emptyEngineSlice(), {
      type: "summaries",
      sessions: [makeSummary("known", { lastSeq: 9 }), makeSummary("fresh", { lastSeq: 7 })],
    });
    const { ui } = followUps(prev, next);
    expect(ui.seenSeq).toEqual({ known: 3, fresh: 7 });
  });

  it("reports turns that end in a loaded session, once", () => {
    let slice = applyReplay(
      reduce(emptyEngineSlice(), { type: "snapshot", snapshot: makeSnapshot(makeSummary("s1")) }),
      "s1",
      [],
    );
    const prev = app(slice);
    slice = applyLive(slice, turn("s1", 0, "completed"));
    const { ended } = followUps(prev, slice);
    expect(ended).toEqual([{ sessionId: "s1", turnId: "t0", stopReason: "completed" }]);
    // Nothing changed: nothing to report.
    expect(followUps(app(slice), slice).ended).toEqual([]);
  });

  it("ignores turns a replay walks through before the session is loaded", () => {
    const slice = reduce(emptyEngineSlice(), {
      type: "snapshot",
      snapshot: makeSnapshot(makeSummary("s1", { lastSeq: 4 })),
    });
    const prev = app(slice);
    const page = reduce(slice, {
      type: "replay",
      sessionId: "s1",
      events: turn("s1", 0, "completed"),
      done: false,
    });
    expect(followUps(prev, page).ended).toEqual([]);
  });

  it("keeps the selected session seen, resets seen marks after a restart, and clears stopped marks", () => {
    let slice = applyReplay(
      reduce(emptyEngineSlice(), { type: "snapshot", snapshot: makeSnapshot(makeSummary("s1")) }),
      "s1",
      [],
    );
    const base = initialAppState(HOME);
    const prev = app(slice, {
      layout: { ...base.layout, selectedSessionId: "s1" },
      ui: { ...base.ui, seenSeq: { s1: 0 }, stoppedByUser: { s1: true } },
    });
    const started = createStream("s1");
    started.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    slice = applyLive(slice, started.events);
    const { ui } = followUps(prev, slice);
    expect(ui.seenSeq.s1).toBe(1);
    expect(ui.stoppedByUser).toEqual({});

    const restarted = reduce(slice, {
      type: "snapshot",
      snapshot: makeSnapshot(makeSummary("s1", { lastSeq: 0 })),
    });
    const after = followUps(
      { ...prev, ...slice, ui: { ...ui, seenSeq: { s1: 50 } }, layout: base.layout },
      restarted,
    );
    expect(after.ui.seenSeq.s1).toBe(0);
  });
});
