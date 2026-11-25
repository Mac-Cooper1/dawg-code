/**
 * Background commands in the reducer and the pane selectors: the snapshot's list, then
 * `background.updated` events, where the latest event per command is its state. A replay
 * rebuilds the same list.
 */
import { describe, expect, it } from "vitest";
import {
  applyLive,
  applyReplay,
  createStream,
  makeBackgroundTask,
  makeSummary,
  openSession,
  T0,
} from "./__fixtures__/streams.ts";
import { emptyEngineSlice, reduceAll } from "./reducer.ts";
import { selectPlanPane, selectTasksPane } from "./selectors.ts";
import { initialAppState } from "./store.ts";
import type { AppStore, EngineSlice } from "./types.ts";

function appState(slice: EngineSlice): AppStore {
  return {
    ...initialAppState("/Users/you"),
    ...slice,
    resolvedTheme: "dark",
    actions: {} as AppStore["actions"],
  };
}

function lifecycle() {
  const stream = createStream("s1");
  stream.emit("background.updated", { task: makeBackgroundTask("bg1") });
  stream.emit("background.updated", {
    task: makeBackgroundTask("bg2", { command: "pytest -q", description: null }),
  });
  stream.emit("background.updated", {
    task: makeBackgroundTask("bg1", {
      status: "stopped",
      signal: "SIGTERM",
      stopReason: "requested",
      endedAt: T0 + 5_000,
      outputBytes: 120,
    }),
  });
  stream.emit("background.updated", {
    task: makeBackgroundTask("bg2", {
      command: "pytest -q",
      description: null,
      status: "failed",
      exitCode: 1,
      endedAt: T0 + 9_000,
      outputBytes: 4_000,
    }),
  });
  return stream;
}

describe("background commands in the reducer", () => {
  it("starts from the snapshot's list", () => {
    const running = makeBackgroundTask("bg1");
    const slice = openSession(makeSummary("s1"), { background: [running] });
    expect(slice.sessions.s1?.background).toEqual([running]);
  });

  it("keeps the latest event per command, oldest command first", () => {
    const slice = applyLive(openSession(makeSummary("s1")), lifecycle().events);
    const list = slice.sessions.s1?.background ?? [];
    expect(list.map((task) => [task.taskId, task.status])).toEqual([
      ["bg1", "stopped"],
      ["bg2", "failed"],
    ]);
    expect(list[0]?.stopReason).toBe("requested");
    expect(list[1]?.exitCode).toBe(1);
  });

  it("rebuilds the same list from a replay", () => {
    const stream = lifecycle();
    const live = applyLive(openSession(makeSummary("s1")), stream.events);
    // A window that opens the session later: the snapshot has the current list, then the replay.
    const current = live.sessions.s1?.background ?? [];
    const replayed = applyReplay(
      openSession(makeSummary("s1", { lastSeq: stream.seq }), { background: current }),
      "s1",
      stream.events,
    );
    expect(replayed.sessions.s1?.background).toEqual(current);
  });

  it("ignores an event it has already applied", () => {
    const stream = createStream("s1");
    const started = stream.emit("background.updated", { task: makeBackgroundTask("bg1") });
    stream.emit("background.updated", {
      task: makeBackgroundTask("bg1", { status: "completed", exitCode: 0, endedAt: T0 + 1 }),
    });
    let slice = applyLive(openSession(makeSummary("s1")), stream.events);
    slice = reduceAll(slice, [{ type: "event", event: started }]);
    expect(slice.sessions.s1?.background[0]?.status).toBe("completed");
  });
});

describe("selectTasksPane", () => {
  it("shows the task list and background commands, and keeps an unchanged view", () => {
    const stream = lifecycle();
    stream.emit("tasks.updated", { tasks: [{ content: "Run the tests", status: "pending" }] });
    const state = appState(applyLive(openSession(makeSummary("s1")), stream.events));
    const view = selectTasksPane(state, "s1");
    expect(view?.open).toBe(true);
    expect(view?.tasks).toHaveLength(1);
    expect(view?.background.map((task) => task.taskId)).toEqual(["bg1", "bg2"]);
    expect(selectTasksPane({ ...state, notices: [] }, "s1")).toBe(view);
    expect(selectTasksPane(state, "missing")).toBeNull();
  });
});

describe("selectPlanPane", () => {
  function propose(stream: ReturnType<typeof createStream>, requestId: string, plan: string) {
    stream.emit("plan.proposed", {
      turnId: "t1",
      requestId,
      toolCallId: `c-${requestId}`,
      plan,
      planPath: "/Users/you/code/tally/.dawg/plans/plan.md",
      modeBeforePlan: "default",
    });
  }

  it("is empty until a plan is proposed, then shows the latest", () => {
    const stream = createStream("s1");
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Plan it" }], mentions: [] },
      command: null,
    });
    const before = applyReplay(openSession(makeSummary("s1")), "s1", stream.events);
    expect(selectPlanPane(appState(before), "s1")).toMatchObject({ loaded: true, plan: null });

    propose(stream, "r1", "# First");
    stream.emit("request.resolved", {
      kind: "plan",
      turnId: "t1",
      requestId: "r1",
      outcome: "answered",
      response: { decision: "reject", message: "Shorter, please" },
    });
    propose(stream, "r2", "# Second");
    const state = appState(applyReplay(openSession(makeSummary("s1")), "s1", stream.events));
    const view = selectPlanPane(state, "s1");
    expect(view?.plan?.plan).toBe("# Second");
    expect(view?.plan?.state).toBe("pending");
    expect(view?.planCount).toBe(2);
    expect(selectPlanPane({ ...state, notices: [] }, "s1")).toBe(view);
  });

  it("says when the history is not loaded yet", () => {
    const slice = reduceAll(emptyEngineSlice(), [
      { type: "summaries", sessions: [makeSummary("s1")] },
    ]);
    expect(selectPlanPane(appState(slice), "s1")).toMatchObject({ loaded: false, plan: null });
  });
});
