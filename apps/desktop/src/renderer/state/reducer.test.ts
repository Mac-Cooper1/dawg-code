import type { EngineEvent } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { finishInterrupted, fullTurn, interruptedTurn } from "./__fixtures__/scenarios.ts";
import {
  applyLive,
  applyReplay,
  comparable,
  createStream,
  makeSnapshot,
  makeSummary,
  makeUsage,
  openSession,
  PROJECT,
  T0,
  withoutStreaming,
} from "./__fixtures__/streams.ts";
import { emptyEngineSlice, reduce, reduceAll } from "./reducer.ts";
import { INTERRUPTED_NOTE } from "./transcript-events.ts";
import type { EngineSlice, TranscriptItem } from "./types.ts";

function items(state: EngineSlice, id = "s1"): TranscriptItem[] {
  return state.transcripts[id] ?? [];
}

function kinds(state: EngineSlice, id = "s1"): string[] {
  return items(state, id).map((item) => item.kind);
}

function find<K extends TranscriptItem["kind"]>(
  state: EngineSlice,
  kind: K,
  id = "s1",
): Extract<TranscriptItem, { kind: K }>[] {
  return items(state, id).filter(
    (item): item is Extract<TranscriptItem, { kind: K }> => item.kind === kind,
  );
}

describe("snapshots", () => {
  it("opens the session with everything the snapshot knows, without raising the high-water mark", () => {
    const summary = makeSummary("s1", { status: "waiting", lastSeq: 40, mode: "plan" });
    const state = openSession(summary, {
      activeTurnId: "t1",
      usage: makeUsage({ requests: 3, promptTokens: 9000, cachedTokens: 8000 }),
      tasks: [{ content: "Write tests", status: "pending" }],
      additionalDirectories: ["/Users/you/code/shared"],
      pending: [
        {
          kind: "question",
          turnId: "t1",
          requestId: "q1",
          toolCallId: "c1",
          questions: [{ question: "How?", options: [], multiSelect: false }],
        },
      ],
    });
    const session = state.sessions.s1;
    expect(session).toMatchObject({
      open: true,
      loaded: false,
      status: "waiting",
      waitingOn: "question",
      activeTurnId: "t1",
      highWaterSeq: 0,
      additionalDirectories: ["/Users/you/code/shared"],
    });
    expect(session?.tasks).toHaveLength(1);
    expect(session?.usage?.totals.requests).toBe(3);
    expect(session?.commands.map((command) => command.name)).toEqual(["compact", "help"]);
    expect(state.pending.s1).toEqual([{ kind: "question", requestId: "q1", turnId: "t1" }]);
    expect(state.projects[PROJECT]).toEqual({ dir: PROJECT, name: "tally" });
  });

  it("marks the session loaded when the replay is done", () => {
    let state = openSession(makeSummary("s1"));
    state = reduce(state, { type: "replay", sessionId: "s1", events: [], done: false });
    expect(state.sessions.s1?.loaded).toBe(false);
    state = reduce(state, { type: "replay", sessionId: "s1", events: [], done: true });
    expect(state.sessions.s1?.loaded).toBe(true);
  });
});

describe("a full turn, live", () => {
  const stream = createStream();
  fullTurn(stream);
  const state = applyLive(openSession(makeSummary("s1")), stream.events);

  it("builds the items in display order", () => {
    expect(kinds(state)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "tool",
      "permission",
      "tool",
      "tasks",
      "assistant",
      "turn-summary",
    ]);
    expect(items(state).map((item) => item.id)).toEqual([
      "user:t1",
      "reasoning:t1-m1",
      "assistant:t1-m1",
      "tool:t1-c1",
      "permission:t1-p1",
      "tool:t1-c2",
      "tasks:t1",
      "assistant:t1-m2",
      "summary:t1",
    ]);
  });

  it("keeps the person's message whole", () => {
    const [user] = find(state, "user");
    expect(user).toMatchObject({
      text: "Fix the failing split test\n\nIt loses a cent.",
      mentions: [{ path: "src/tally/money.py" }],
      images: [],
      command: null,
    });
  });

  it("times the reasoning from its first delta to the first text", () => {
    const [reasoning] = find(state, "reasoning");
    expect(reasoning).toMatchObject({
      text: "The split rounds each share.",
      streaming: false,
      durationMs: 4900,
    });
    const assistants = find(state, "assistant");
    expect(assistants.map((item) => [item.text, item.streaming])).toEqual([
      ["Let me look at money.py.", false],
      ["Found it: rounding each share loses a cent.", false],
    ]);
  });

  it("links the permission card to its call and records the answer", () => {
    const [permission] = find(state, "permission");
    expect(permission).toMatchObject({
      requestId: "t1-p1",
      state: "answered",
      response: { behavior: "allow", scope: "once" },
    });
    const bash = find(state, "tool").find((tool) => tool.toolName === "Bash");
    expect(bash?.permissionRequestId).toBe("t1-p1");
    expect(state.pending.s1).toEqual([]);
  });

  it("fills in tool output, status line and result", () => {
    const bash = find(state, "tool").find((tool) => tool.toolName === "Bash");
    expect(bash).toMatchObject({
      state: "error",
      statusLine: "8 of 8 tests · 1 failure",
      output: [
        { stream: "stdout", text: "..F..\n1 failed, 7 passed\n" },
        { stream: "stderr", text: "warning: slow\n" },
      ],
      durationMs: 2100,
    });
    expect(bash?.display?.kind).toBe("command");
    expect(find(state, "tool").some((tool) => tool.toolName === "TodoWrite")).toBe(false);
  });

  it("keeps one tasks item per turn and the session's task list", () => {
    expect(find(state, "tasks")).toHaveLength(1);
    expect(find(state, "tasks")[0]?.tasks).toHaveLength(2);
    expect(state.sessions.s1?.tasks).toHaveLength(2);
  });

  it("ends with a turn summary counted over the turn", () => {
    const [summary] = find(state, "turn-summary");
    expect(summary).toMatchObject({
      stopReason: "completed",
      durationMs: 48_000,
      modelRequests: 2,
      cachedPercent: 89,
    });
    expect(state.sessions.s1).toMatchObject({
      status: "idle",
      activeTurnId: null,
      promptProgress: null,
      highWaterSeq: stream.seq,
      lastTurn: { turnId: "t1", stopReason: "completed", error: null, finishedSeq: stream.seq - 1 },
    });
  });

  it("counts a second turn from where the first left off", () => {
    const next = createStream("s1", { seq: stream.seq, time: stream.time });
    fullTurn(next, {
      turnId: "t2",
      usageBefore: { requests: 2, promptTokens: 45_000, cachedTokens: 40_000 },
    });
    const after = applyLive(state, next.events);
    const summaries = find(after, "turn-summary");
    expect(summaries.map((summary) => summary.modelRequests)).toEqual([2, 2]);
    expect(find(after, "tasks").map((item) => item.id)).toEqual(["tasks:t1", "tasks:t2"]);
  });
});

describe("streaming state", () => {
  it("creates no empty bubbles and reads the prompt with a rate", () => {
    const stream = createStream();
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Hi" }], mentions: [] },
      command: null,
    });
    stream.emit("prompt.progress", { turnId: "t1", total: 10_000, cached: 4000, processed: 4000 });
    stream.emit(
      "prompt.progress",
      { turnId: "t1", total: 10_000, cached: 4000, processed: 6000 },
      1000,
    );
    let state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(state.sessions.s1?.promptProgress).toEqual({
      turnId: "t1",
      total: 10_000,
      cached: 4000,
      processed: 6000,
      tokensPerSecond: 2000,
      secondsLeft: 2,
    });

    stream.emit("message.started", { turnId: "t1", messageId: "m1" });
    stream.emit("message.delta", { turnId: "t1", messageId: "m1", text: "\n\n" });
    state = applyLive(state, stream.events.slice(-2));
    expect(state.sessions.s1?.promptProgress).toBeNull();
    expect(kinds(state)).toEqual(["user"]);

    stream.emit("message.delta", { turnId: "t1", messageId: "m1", text: "Hello" });
    state = applyLive(state, stream.events.slice(-1));
    expect(find(state, "assistant")[0]).toMatchObject({ text: "Hello", streaming: true });

    stream.emit("message.finished", {
      turnId: "t1",
      messageId: "m1",
      text: "",
      reasoning: null,
      toolCalls: [],
    });
    state = applyLive(state, stream.events.slice(-1));
    expect(kinds(state)).toEqual(["user"]);
  });

  it("clears read progress once the prompt is read", () => {
    const stream = createStream();
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Hi" }], mentions: [] },
      command: null,
    });
    stream.emit("prompt.progress", { turnId: "t1", total: 100, cached: 0, processed: 50 });
    stream.emit("prompt.progress", { turnId: "t1", total: 100, cached: 0, processed: 100 });
    const state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(state.sessions.s1?.promptProgress).toBeNull();
  });
});

describe("replays", () => {
  const stream = createStream();
  fullTurn(stream);
  interruptedTurn(stream);
  finishInterrupted(stream);
  const live = applyLive(openSession(makeSummary("s1", { lastSeq: stream.seq })), stream.events);

  it("rebuild exactly the live transcript when nothing is dropped", () => {
    const replayed = applyReplay(
      openSession(makeSummary("s1", { lastSeq: stream.seq })),
      "s1",
      stream.events,
      7,
    );
    expect(items(replayed)).toEqual(items(live));
    expect(replayed.sessions.s1?.loaded).toBe(true);
    expect(replayed.sessions.s1?.lastTurn).toEqual(live.sessions.s1?.lastTurn);
  });

  it("rebuild the same final items when deltas and progress are dropped", () => {
    const replayed = applyReplay(
      openSession(makeSummary("s1", { lastSeq: stream.seq })),
      "s1",
      withoutStreaming(stream.events),
    );
    expect(comparable(items(replayed))).toEqual(comparable(items(live)));
    const [reasoning] = find(replayed, "reasoning");
    expect(reasoning?.streaming).toBe(false);
    expect(reasoning?.durationMs).toBeGreaterThan(0);
  });

  it("ignore duplicates and overlapping pages", () => {
    const again = applyLive(live, stream.events);
    expect(again).toBe(live);
    const overlap = reduceAll(live, [
      { type: "replay", sessionId: "s1", events: stream.events.slice(10), done: false },
    ]);
    expect(overlap).toBe(live);
  });

  it("apply live events held back during the replay without doubling them", () => {
    const base = openSession(makeSummary("s1", { lastSeq: 20 }));
    const replayed = applyReplay(base, "s1", stream.events.slice(0, 20));
    // Events 15 to the end arrived live while the replay ran; the overlap is dropped.
    const caughtUp = applyLive(replayed, stream.events.slice(14));
    expect(items(caughtUp)).toEqual(items(live));
  });
});

describe("robustness", () => {
  it("drops events for sessions it does not know, and live events for closed sessions", () => {
    const stream = createStream("ghost");
    fullTurn(stream);
    const empty = emptyEngineSlice();
    expect(applyLive(empty, stream.events)).toBe(empty);

    const listed = reduce(empty, { type: "summaries", sessions: [makeSummary("ghost")] });
    expect(applyLive(listed, stream.events)).toBe(listed);
    // A replay works on a stored session whether or not it is open.
    const replayed = applyReplay(listed, "ghost", stream.events);
    expect(items(replayed, "ghost").length).toBeGreaterThan(0);
  });

  it("gives each session the same result whatever the interleaving across sessions", () => {
    const a = createStream("a");
    const b = createStream("b", { time: T0 + 50 });
    fullTurn(a);
    fullTurn(b, { turnId: "u1" });
    interruptedTurn(b, "u2");
    finishInterrupted(b, "u2");
    const base = reduceAll(emptyEngineSlice(), [
      { type: "snapshot", snapshot: makeSnapshot(makeSummary("a")) },
      { type: "snapshot", snapshot: makeSnapshot(makeSummary("b")) },
    ]);
    const separate = applyLive(applyLive(base, a.events), b.events);
    // Interleave: b first in bursts, then a, alternating unevenly.
    const mixed: EngineEvent[] = [];
    let i = 0;
    let j = 0;
    while (i < a.events.length || j < b.events.length) {
      for (let k = 0; k < 3 && j < b.events.length; k++) mixed.push(b.events[j++] as EngineEvent);
      if (i < a.events.length) mixed.push(a.events[i++] as EngineEvent);
    }
    const together = reduceAll(
      base,
      mixed.map((event) => ({ type: "event", event })),
    );
    expect(items(together, "a")).toEqual(items(separate, "a"));
    expect(items(together, "b")).toEqual(items(separate, "b"));
    expect(together.sessions.a?.highWaterSeq).toBe(a.seq);
  });

  it("keeps untouched sessions, transcripts and pending lists by identity", () => {
    const a = createStream("a");
    const b = createStream("b");
    fullTurn(a);
    fullTurn(b);
    let state = reduceAll(emptyEngineSlice(), [
      { type: "snapshot", snapshot: makeSnapshot(makeSummary("a")) },
      { type: "snapshot", snapshot: makeSnapshot(makeSummary("b")) },
    ]);
    state = applyLive(state, [...a.events, ...b.events]);
    const more = createStream("a", { seq: a.seq, time: a.time });
    more.emit("session.status", { status: "working", waitingOn: null, message: null });
    const next = applyLive(state, more.events);
    expect(next.sessions.b).toBe(state.sessions.b);
    expect(next.transcripts.b).toBe(state.transcripts.b);
    expect(next.transcripts.a).toBe(state.transcripts.a);
    expect(next.pending).toBe(state.pending);
    expect(next.projects).toBe(state.projects);
    expect(next.sessions.a).not.toBe(state.sessions.a);
  });

  it("resets a session whose engine restarted from scratch and rebuilds it from 0", () => {
    const stream = createStream();
    fullTurn(stream);
    interruptedTurn(stream);
    finishInterrupted(stream);
    const state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(state.sessions.s1?.highWaterSeq).toBe(stream.seq);

    // The restarted engine only has the first turn.
    const restarted = createStream();
    fullTurn(restarted);
    const resumed = reduce(state, {
      type: "snapshot",
      snapshot: makeSnapshot(makeSummary("s1", { lastSeq: restarted.seq })),
    });
    expect(resumed.sessions.s1?.highWaterSeq).toBe(0);
    expect(resumed.sessions.s1?.loaded).toBe(false);
    expect(items(resumed)).toEqual([]);
    const rebuilt = applyReplay(resumed, "s1", restarted.events);
    expect(items(rebuilt).map((item) => item.id)).toEqual(
      items(applyLive(openSession(makeSummary("s1")), restarted.events)).map((item) => item.id),
    );
  });

  it("closes what an interrupted turn left streaming", () => {
    const stream = createStream();
    interruptedTurn(stream, "t1");
    let state = applyLive(openSession(makeSummary("s1")), stream.events);
    const tool = find(state, "tool")[0];
    expect(tool?.state).toBe("running");
    expect(state.sessions.s1?.activeTurnId).toBe("t1");

    // An interrupt that lands while a message still streams, without its message.finished.
    const cut = createStream("s1", { seq: stream.seq, time: stream.time });
    cut.emit("message.started", { turnId: "t1", messageId: "t1-m2" });
    cut.emit("message.delta", { turnId: "t1", messageId: "t1-m2", text: "Half a sen" });
    cut.emit("turn.finished", {
      turnId: "t1",
      stopReason: "interrupted",
      finalText: null,
      error: null,
      durationMs: 2000,
    });
    state = applyLive(state, cut.events);
    expect(find(state, "assistant").every((item) => !item.streaming)).toBe(true);
    expect(find(state, "tool")[0]?.state).toBe("interrupted");
    const note = find(state, "note")[0];
    expect(note).toMatchObject({ text: INTERRUPTED_NOTE, tone: "neutral", turnId: "t1" });
    expect(items(state).at(-1)?.kind).toBe("note");
    expect(state.sessions.s1?.lastTurn?.stopReason).toBe("interrupted");
  });

  it("places a permission that arrives before its call directly before the call", () => {
    const stream = createStream();
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    stream.emit("permission.requested", {
      turnId: "t1",
      request: {
        requestId: "p1",
        toolCallId: "c1",
        toolName: "Edit",
        input: { file_path: `${PROJECT}/a.py` },
        title: "Edit a file",
        reason: "Ask first",
        suggestions: [],
      },
    });
    stream.emit("question.asked", {
      turnId: "t1",
      requestId: "q1",
      toolCallId: "c9",
      questions: [{ question: "Which?", options: [{ label: "A" }], multiSelect: false }],
    });
    stream.emit("tool.started", {
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "Edit",
      input: { file_path: `${PROJECT}/a.py` },
    });
    const state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(items(state).map((item) => item.id)).toEqual([
      "user:t1",
      "permission:p1",
      "tool:c1",
      "question:q1",
    ]);
    expect(find(state, "tool")[0]?.permissionRequestId).toBe("p1");
    expect(state.pending.s1?.map((ref) => ref.requestId)).toEqual(["p1", "q1"]);
  });

  it("cancels requests the turn ended without", () => {
    const stream = createStream();
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Plan it" }], mentions: [] },
      command: null,
    });
    stream.emit("plan.proposed", {
      turnId: "t1",
      requestId: "r1",
      toolCallId: "c1",
      plan: "# Plan",
      planPath: null,
    });
    stream.emit("request.resolved", {
      kind: "plan",
      turnId: "t1",
      requestId: "r1",
      outcome: "cancelled",
      response: null,
    });
    const state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(find(state, "plan")[0]).toMatchObject({ state: "cancelled", response: null });
    expect(state.pending.s1).toEqual([]);
  });

  it("shows a hidden call that finished without its own item, and an unknown tool as is", () => {
    const stream = createStream();
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    stream.emit("tool.started", {
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "AskUserQuestion",
      input: { questions: "not a list" },
    });
    stream.emit("tool.finished", {
      turnId: "t1",
      toolCallId: "c1",
      toolName: "AskUserQuestion",
      outcome: "invalid",
      content: [{ type: "text", text: "questions must be a list" }],
      display: null,
      durationMs: null,
    });
    stream.emit("tool.started", {
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c2",
      toolName: "mcp__weather__forecast",
      input: { city: "Lisbon" },
    });
    stream.emit("tool.finished", {
      turnId: "t1",
      toolCallId: "c2",
      toolName: "mcp__weather__forecast",
      outcome: "success",
      content: [{ type: "text", text: "Sunny" }],
      display: null,
      durationMs: 300,
    });
    // A call whose start the stream lost.
    stream.emit("tool.finished", {
      turnId: "t1",
      toolCallId: "c3",
      toolName: "Grep",
      outcome: "success",
      content: [{ type: "text", text: "3 matches" }],
      display: { kind: "search", pattern: "split", resultCount: 3, truncated: false },
      durationMs: 40,
    });
    const state = applyLive(openSession(makeSummary("s1")), stream.events);
    const tools = find(state, "tool");
    expect(tools.map((tool) => [tool.toolName, tool.state])).toEqual([
      ["AskUserQuestion", "invalid"],
      ["mcp__weather__forecast", "success"],
      ["Grep", "success"],
    ]);
    expect(tools[0]?.input).toEqual({ questions: "not a list" });
    expect(tools[2]?.startedAt).toBe(stream.time - 40);
  });

  it("takes the plan card's return mode from the request, not from mode changes", () => {
    const stream = createStream();
    stream.emit("session.updated", {
      title: "Plan",
      mode: "plan",
      model: "qwen3.8-27b-q8",
      modelInfo: null,
      effort: null,
      archived: false,
      additionalDirectories: [],
      changed: ["mode"],
    });
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Plan" }], mentions: [] },
      command: null,
    });
    stream.emit("plan.proposed", {
      turnId: "t1",
      requestId: "r1",
      toolCallId: "c1",
      plan: "# Plan",
      planPath: "/Users/you/.dawg/plans/p.md",
      modeBeforePlan: "acceptEdits",
    });
    // A plan stored before engines reported the mode: no mode is guessed.
    stream.emit("plan.proposed", {
      turnId: "t1",
      requestId: "r2",
      toolCallId: "c2",
      plan: "# Plan",
      planPath: null,
    });
    const replayed = applyReplay(
      openSession(makeSummary("s1", { mode: "default" })),
      "s1",
      stream.events,
    );
    expect(find(replayed, "plan").map((item) => item.modeBeforePlan)).toEqual([
      "acceptEdits",
      null,
    ]);
    const live = applyLive(applyReplay(openSession(makeSummary("s1")), "s1", []), stream.events);
    expect(find(live, "plan").map((item) => item.modeBeforePlan)).toEqual(["acceptEdits", null]);
  });

  it("records compaction, errors and failed turns", () => {
    const stream = createStream();
    stream.emit("compaction.started", {
      compactionId: "k1",
      trigger: "manual",
      turnId: null,
      contextUsed: 140_000,
      contextWindow: 204_800,
      focus: null,
    });
    let state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(state.sessions.s1?.compactionId).toBe("k1");
    stream.emit("compaction.finished", {
      compactionId: "k1",
      outcome: "completed",
      summary: "We fixed the split.",
      contextBefore: 140_000,
      contextAfter: 21_600,
      error: null,
    });
    const modelDown = {
      kind: "model_unavailable" as const,
      message: "The model stopped responding.",
      detail: null,
      retryable: true,
    };
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    stream.emit("error", { turnId: "t1", error: modelDown });
    stream.emit("turn.finished", {
      turnId: "t1",
      stopReason: "error",
      finalText: null,
      error: modelDown,
      durationMs: 100,
    });
    stream.emit("turn.started", {
      turnId: "t2",
      prompt: { content: [{ type: "text", text: "Again" }], mentions: [] },
      command: { name: "init", args: "" },
    });
    stream.emit("turn.finished", {
      turnId: "t2",
      stopReason: "error",
      finalText: null,
      error: modelDown,
      durationMs: 100,
    });
    stream.emit("turn.started", {
      turnId: "t3",
      prompt: { content: [{ type: "text", text: "Go on" }], mentions: [] },
      command: null,
    });
    stream.emit("turn.finished", {
      turnId: "t3",
      stopReason: "turn_limit",
      finalText: null,
      error: null,
      durationMs: 100,
    });
    state = applyLive(state, stream.events.slice(1));
    expect(find(state, "compaction")[0]).toMatchObject({
      state: "completed",
      trigger: "manual",
      contextBefore: 140_000,
      contextAfter: 21_600,
      summary: "We fixed the split.",
    });
    expect(state.sessions.s1?.compactionId).toBeNull();
    expect(find(state, "error").map((item) => item.turnId)).toEqual(["t1", "t2"]);
    expect(find(state, "user")[1]?.command).toEqual({ name: "init", args: "" });
    expect(find(state, "turn-summary")[0]).toMatchObject({
      turnId: "t3",
      stopReason: "turn_limit",
    });
  });

  it("applies status, settings and usage events to the session", () => {
    const stream = createStream();
    stream.emit("session.status", {
      status: "working",
      waitingOn: null,
      message: "Waiting for the model",
      queuePosition: 2,
    });
    stream.emit("session.updated", {
      title: "Fix the split",
      mode: "acceptEdits",
      model: "gpt-oss-20b-q4",
      modelInfo: {
        id: "gpt-oss-20b-q4",
        contextWindow: 65_536,
        vision: false,
        reasoning: true,
        effortLevels: ["low"],
      },
      effort: "low",
      archived: false,
      additionalDirectories: ["/tmp/x"],
      changed: ["title", "model"],
    });
    stream.emit("usage.updated", {
      usage: makeUsage({ requests: 1, promptTokens: 10, cachedTokens: 5 }),
    });
    stream.emit("tasks.updated", { tasks: [{ content: "One", status: "pending" }] });
    const state = applyLive(openSession(makeSummary("s1")), stream.events);
    expect(state.sessions.s1).toMatchObject({
      status: "working",
      statusMessage: "Waiting for the model",
      queuePosition: 2,
      modelInfo: { id: "gpt-oss-20b-q4" },
      additionalDirectories: ["/tmp/x"],
      summary: {
        title: "Fix the split",
        mode: "acceptEdits",
        model: "gpt-oss-20b-q4",
        effort: "low",
      },
      tasks: [{ content: "One", status: "pending" }],
    });
    expect(state.sessions.s1?.usage?.totals.requests).toBe(1);
    // A task list outside a turn updates the session only.
    expect(find(state, "tasks")).toEqual([]);
    expect(state.sessions.s1?.summary.queuePosition).toBe(2);
    const started = createStream("s1", { seq: stream.seq });
    started.emit("session.status", { status: "working", waitingOn: null, message: "Working" });
    expect(applyLive(state, started.events).sessions.s1?.queuePosition).toBeNull();
  });

  it("takes the place in line from snapshots and list summaries", () => {
    const snapshot = openSession(makeSummary("s1", { status: "working", queuePosition: 1 }));
    expect(snapshot.sessions.s1?.queuePosition).toBe(1);
    const listed = reduce(emptyEngineSlice(), {
      type: "summaries",
      sessions: [makeSummary("s2", { status: "working", queuePosition: 2 })],
    });
    expect(listed.sessions.s2?.queuePosition).toBe(2);
    const moved = reduce(listed, {
      type: "summaries",
      sessions: [makeSummary("s2", { status: "working", queuePosition: 1 })],
    });
    expect(moved.sessions.s2?.queuePosition).toBe(1);
  });

  it("removes a deleted session with its transcript and pending requests", () => {
    const stream = createStream();
    stream.emit("session.status", { status: "working", waitingOn: null, message: null });
    stream.emit("turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    stream.emit("plan.proposed", {
      turnId: "t1",
      requestId: "r1",
      toolCallId: "c1",
      plan: "# Plan",
      planPath: null,
      modeBeforePlan: "default",
    });
    const other = openSession(makeSummary("other"));
    let state = applyLive(
      reduce(openSession(makeSummary("s1")), {
        type: "snapshot",
        snapshot: makeSnapshot(makeSummary("other")),
      }),
      stream.events,
    );
    expect(state.pending.s1).toHaveLength(1);
    const deleted = createStream("s1", { seq: stream.seq });
    deleted.emit("session.deleted", {});
    const before = state;
    state = applyLive(state, deleted.events);
    expect(state.sessions.s1).toBeUndefined();
    expect(state.transcripts.s1).toBeUndefined();
    expect(state.pending.s1).toBeUndefined();
    expect(state.sessions.other).toBe(before.sessions.other);
    // The same from the result of session.delete, and for a session not open here.
    const stored = reduce(other, { type: "summaries", sessions: [makeSummary("stored")] });
    expect(
      reduce(stored, { type: "deleted", sessionId: "stored" }).sessions.stored,
    ).toBeUndefined();
    const elsewhere = createStream("stored", { seq: 5 });
    elsewhere.emit("session.deleted", {});
    expect(applyLive(stored, elsewhere.events).sessions.stored).toBeUndefined();
    // Deleting what is not there changes nothing.
    expect(reduce(other, { type: "deleted", sessionId: "nope" })).toBe(other);
  });
});

describe("other inputs", () => {
  it("upserts summaries of sessions that are not open and leaves open ones alone", () => {
    let state = openSession(makeSummary("open", { title: "Live title" }));
    state = reduce(state, {
      type: "summaries",
      sessions: [
        makeSummary("open", { title: "Stale title" }),
        makeSummary("stored", {
          projectDir: "/Users/you/code/notes-cli",
          cwd: "/Users/you/code/notes-cli",
        }),
      ],
    });
    expect(state.sessions.open?.summary.title).toBe("Live title");
    expect(state.sessions.stored).toMatchObject({ open: false, loaded: false, highWaterSeq: 0 });
    expect(state.projects["/Users/you/code/notes-cli"]?.name).toBe("notes-cli");
    const same = reduce(state, {
      type: "summaries",
      sessions: [
        makeSummary("stored", {
          projectDir: "/Users/you/code/notes-cli",
          cwd: "/Users/you/code/notes-cli",
        }),
      ],
    });
    expect(same).toBe(state);
    const renamed = reduce(state, {
      type: "summaries",
      sessions: [
        makeSummary("stored", {
          title: "New",
          projectDir: "/Users/you/code/notes-cli",
          cwd: "/Users/you/code/notes-cli",
          status: "error",
        }),
      ],
    });
    expect(renamed.sessions.stored).toMatchObject({ status: "error", summary: { title: "New" } });
  });

  it("closes every session on disconnect", () => {
    let state = reduceAll(emptyEngineSlice(), [
      { type: "snapshot", snapshot: makeSnapshot(makeSummary("a")) },
      { type: "summaries", sessions: [makeSummary("b")] },
    ]);
    state = reduce(state, { type: "disconnected" });
    expect(state.sessions.a?.open).toBe(false);
    expect(state.sessions.b?.open).toBe(false);
  });

  it("adds command output at the end of the transcript", () => {
    const stream = createStream();
    fullTurn(stream);
    let state = applyLive(openSession(makeSummary("s1")), stream.events);
    state = reduce(state, {
      type: "command-output",
      sessionId: "s1",
      command: "/help",
      output: "# Help",
    });
    state = reduce(state, {
      type: "command-output",
      sessionId: "s1",
      command: "/help",
      output: "# Help",
    });
    const outputs = find(state, "command-output");
    expect(outputs).toHaveLength(2);
    expect(new Set(outputs.map((item) => item.id)).size).toBe(2);
    expect(items(state).at(-1)?.kind).toBe("command-output");
  });

  it("closes a turn the engine no longer runs when the session is resumed", () => {
    const stream = createStream();
    interruptedTurn(stream, "t1");
    let state = applyLive(openSession(makeSummary("s1")), stream.events);
    state = reduce(state, { type: "disconnected" });
    state = reduce(state, {
      type: "snapshot",
      snapshot: makeSnapshot(
        makeSummary("s1", { lastSeq: stream.seq, lastActivityAt: stream.time + 1000 }),
      ),
    });
    expect(state.sessions.s1).toMatchObject({
      open: true,
      activeTurnId: null,
      highWaterSeq: stream.seq,
    });
    expect(find(state, "tool")[0]?.state).toBe("interrupted");
    expect(find(state, "assistant").every((item) => !item.streaming)).toBe(true);
  });
});
