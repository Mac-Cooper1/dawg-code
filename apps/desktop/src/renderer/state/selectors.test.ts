import { describe, expect, it } from "vitest";
import { MOCK_MODELS } from "../../shared/mock-models.ts";
import { finishInterrupted, fullTurn, interruptedTurn } from "./__fixtures__/scenarios.ts";
import {
  applyLive,
  applyReplay,
  createStream,
  HOME,
  makeSnapshot,
  makeSummary,
  makeUsage,
  PROJECT,
  type Stream,
  T0,
} from "./__fixtures__/streams.ts";
import { emptyEngineSlice, reduceAll } from "./reducer.ts";
import {
  PLACEHOLDERS,
  selectChrome,
  selectComposer,
  selectModelFooter,
  selectSidebar,
  selectTitleBar,
  selectTranscript,
} from "./selectors.ts";
import { sentenceFragment } from "./session-marks.ts";
import { initialAppState } from "./store.ts";
import type { AppActions, AppStore, EngineSlice, SidebarRow, UiState } from "./types.ts";

const NOW = T0 + 10 * 60_000;
const SITE = "/Users/you/code/dawg-site";

function appState(slice: EngineSlice, patch: Partial<AppStore> = {}): AppStore {
  return {
    ...initialAppState(HOME),
    ...slice,
    resolvedTheme: "dark",
    actions: {} as AppActions,
    ...patch,
  };
}

function withUi(state: AppStore, patch: Partial<UiState>): AppStore {
  return { ...state, ui: { ...state.ui, ...patch } };
}

function withSelection(state: AppStore, id: string | null): AppStore {
  return { ...state, layout: { ...state.layout, selectedSessionId: id } };
}

function open(slice: EngineSlice, id: string, overrides: Parameters<typeof makeSummary>[1] = {}) {
  return reduceAll(slice, [
    { type: "snapshot", snapshot: makeSnapshot(makeSummary(id, overrides)) },
    { type: "replay", sessionId: id, events: [], done: true },
  ]);
}

function startTurn(stream: Stream, turnId = "t1"): void {
  stream.emit("session.status", { status: "working", waitingOn: null, message: null });
  stream.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
    command: null,
  });
}

/** One session per sidebar status, mirroring the approved mockup. */
function mockupSlice(): EngineSlice {
  let slice = emptyEngineSlice();
  // Working, editing a file.
  slice = open(slice, "fix", { title: "Fix the failing split test", lastActivityAt: NOW - 5000 });
  const fix = createStream("fix", { time: NOW - 10_000 });
  startTurn(fix);
  fix.emit("tool.started", {
    turnId: "t1",
    messageId: "m1",
    toolCallId: "c1",
    toolName: "Edit",
    input: { file_path: `${PROJECT}/src/tally/money.py` },
  });
  slice = applyLive(slice, fix.events);
  // Needs you: a command.
  slice = open(slice, "csv", { title: "Flaky CSV import test", lastActivityAt: NOW - 3 * 60_000 });
  const csv = createStream("csv", { time: NOW - 4 * 60_000 });
  startTurn(csv);
  csv.emit("permission.requested", {
    turnId: "t1",
    request: {
      requestId: "p1",
      toolCallId: "c1",
      toolName: "Bash",
      input: { command: "uv add --dev pytest-repeat" },
      title: "Run a shell command",
      reason: "No rule allows this command",
      suggestions: ["Bash(uv add --dev *)"],
    },
  });
  csv.emit("session.status", { status: "waiting", waitingOn: "permission", message: null });
  slice = applyLive(slice, csv.events);
  // Needs you: a question, and a plan.
  slice = open(slice, "tip", { title: "Add tip support", lastActivityAt: NOW - 9 * 60_000 });
  const tip = createStream("tip", { time: NOW - 10 * 60_000 });
  startTurn(tip);
  tip.emit("question.asked", {
    turnId: "t1",
    requestId: "q1",
    toolCallId: "c1",
    questions: [{ question: "How should tips split?", options: [], multiSelect: false }],
  });
  slice = applyLive(slice, tip.events);
  slice = open(slice, "fx", { title: "Multi-currency totals", lastActivityAt: NOW - 21 * 60_000 });
  const fx = createStream("fx", { time: NOW - 22 * 60_000 });
  startTurn(fx);
  fx.emit("plan.proposed", {
    turnId: "t1",
    requestId: "r1",
    toolCallId: "c1",
    plan: "# Plan",
    planPath: null,
  });
  slice = applyLive(slice, fx.events);
  // Done, unread: a turn finished at seq 3.
  slice = open(slice, "pdf", { title: "Receipt PDF layout", lastActivityAt: NOW - 60 * 60_000 });
  const pdf = createStream("pdf", { time: NOW - 61 * 60_000 });
  startTurn(pdf);
  pdf.emit("turn.finished", {
    turnId: "t1",
    stopReason: "completed",
    finalText: "Done.",
    error: null,
    durationMs: 1000,
  });
  pdf.emit("session.status", { status: "idle", waitingOn: null, message: null });
  slice = applyLive(slice, pdf.events);
  // Queued for the model, in another project.
  slice = open(slice, "docs", {
    title: "Docs search page",
    cwd: SITE,
    projectDir: SITE,
    lastActivityAt: NOW - 60_000,
  });
  const docs = createStream("docs", { time: NOW - 90_000 });
  docs.emit("session.status", {
    status: "working",
    waitingOn: null,
    message: "Waiting for the model",
    queuePosition: 1,
  });
  slice = applyLive(slice, docs.events);
  // Idle, in a worktree of that project.
  slice = open(slice, "links", {
    title: "Fix broken links in docs",
    cwd: `${SITE}/.dawg/worktrees/links`,
    projectDir: SITE,
    lastActivityAt: NOW - 26 * 60 * 60_000,
  });
  // Error.
  slice = open(slice, "py", {
    title: "Bump to Python 3.13",
    cwd: "/Users/you/code/notes-cli",
    projectDir: "/Users/you/code/notes-cli",
    lastActivityAt: NOW - 3 * 86_400_000,
  });
  const py = createStream("py", { time: NOW - 3 * 86_400_000 - 5000 });
  startTurn(py);
  py.emit("turn.finished", {
    turnId: "t1",
    stopReason: "error",
    finalText: null,
    error: {
      kind: "model_unavailable",
      message: "The model stopped responding.",
      detail: null,
      retryable: true,
    },
    durationMs: 100,
  });
  py.emit("session.status", { status: "error", waitingOn: null, message: null });
  slice = applyLive(slice, py.events);
  // Archived: never shown.
  slice = open(slice, "old", { title: "Old work", archived: true });
  return slice;
}

function mockupState(): AppStore {
  const state = appState(mockupSlice());
  // Everything was seen up to seq 1, before the turns above ran; "fix" is selected.
  const seenSeq = Object.fromEntries(Object.keys(state.sessions).map((id) => [id, 1]));
  return withSelection(withUi(state, { seenSeq }), "fix");
}

function rows(state: AppStore): Record<string, SidebarRow> {
  return Object.fromEntries(
    selectSidebar(state, NOW).flatMap((group) => group.rows.map((row) => [row.sessionId, row])),
  );
}

describe("selectSidebar", () => {
  it("marks and describes each session like the mockup", () => {
    const byId = rows(mockupState());
    const summary = (id: string) => {
      const row = byId[id];
      return row && [row.mark, row.markLabel, row.subtitle, row.timeLabel];
    };
    expect(summary("fix")).toEqual(["working", "Working", "Working: editing money.py", "now"]);
    expect(summary("csv")).toEqual(["needs-you", "Needs you", "Needs you: run a command", "3m"]);
    expect(summary("tip")).toEqual([
      "needs-you",
      "Needs you",
      "Needs you: answer a question",
      "9m",
    ]);
    expect(summary("fx")).toEqual(["needs-you", "Needs you", "Needs you: approve a plan", "21m"]);
    expect(summary("pdf")).toEqual(["unread", "Done, unread", "Done, not opened yet", "1h"]);
    expect(summary("docs")).toEqual(["queued", "Queued", "Queued: waits for the model", "1m"]);
    expect(summary("links")?.slice(0, 3)).toEqual(["idle", "Idle", null]);
    expect(summary("py")?.slice(0, 3)).toEqual([
      "error",
      "Error",
      "Error: the model stopped responding",
    ]);
    expect(byId.old).toBeUndefined();
    expect(byId.fix?.selected).toBe(true);
    expect(byId.links?.worktree).toBe(true);
    expect(byId.fix?.worktree).toBe(false);
  });

  it("groups by project, newest activity first", () => {
    const groups = selectSidebar(mockupState(), NOW);
    expect(groups.map((group) => [group.name, group.displayPath])).toEqual([
      ["tally", "~/code/tally"],
      ["dawg-site", "~/code/dawg-site"],
      ["notes-cli", "~/code/notes-cli"],
    ]);
    expect(groups[0]?.rows.map((row) => row.sessionId)).toEqual(["fix", "csv", "tip", "fx", "pdf"]);
    expect(groups[1]?.rows.map((row) => row.sessionId)).toEqual(["docs", "links"]);
  });

  it("filters by title, ignoring case", () => {
    const state = mockupState();
    const filtered = selectSidebar(
      { ...state, layout: { ...state.layout, search: "  FIX " } },
      NOW,
    );
    expect(filtered.flatMap((group) => group.rows.map((row) => row.title))).toEqual([
      "Fix the failing split test",
      "Fix broken links in docs",
    ]);
  });

  it("treats a session seen for the first time as read, and the selected one as read", () => {
    const state = mockupState();
    const firstSight = withUi(state, { seenSeq: {} });
    expect(rows(firstSight).pdf?.mark).toBe("idle");
    expect(rows(withSelection(state, "pdf")).pdf?.mark).toBe("idle");
    const seenAll = withUi(state, { seenSeq: { ...state.ui.seenSeq, pdf: 99 } });
    expect(rows(seenAll).pdf?.mark).toBe("idle");
  });

  it("shows hand-marked unread sessions and sessions stopped by the person", () => {
    const state = withUi(mockupState(), {
      markedUnread: { links: true },
      stoppedByUser: { py: true, csv: true },
    });
    const byId = rows(state);
    expect(byId.links?.mark).toBe("unread");
    // A session that is not idle keeps its own mark.
    expect(byId.csv?.mark).toBe("needs-you");
    let slice = open(emptyEngineSlice(), "stopped", { title: "Stopped" });
    const stream = createStream("stopped");
    interruptedTurn(stream, "t1");
    finishInterrupted(stream, "t1");
    slice = applyLive(slice, stream.events);
    const stopped = withUi(appState(slice), {
      stoppedByUser: { stopped: true },
      seenSeq: { stopped: 99 },
    });
    expect(rows(stopped).stopped).toMatchObject({ mark: "idle", subtitle: "Stopped by you" });
  });

  it("counts a stored session with newer events than seen as unread", () => {
    const slice = reduceAll(emptyEngineSlice(), [
      { type: "summaries", sessions: [makeSummary("stored", { lastSeq: 40 })] },
    ]);
    const state = withUi(appState(slice), { seenSeq: { stored: 30 } });
    expect(rows(state).stored?.mark).toBe("unread");
    expect(rows(withUi(state, { seenSeq: { stored: 40 } })).stored?.mark).toBe("idle");
  });

  it("marks a queued session by its place in line, whatever the engine's message says", () => {
    const queued = (id: string, position: number, message: string | null) => {
      const stream = createStream(id);
      stream.emit("session.status", {
        status: "working",
        waitingOn: null,
        message,
        queuePosition: position,
      });
      return stream.events;
    };
    let slice = open(emptyEngineSlice(), "a", { lastActivityAt: NOW - 1000 });
    slice = applyLive(slice, queued("a", 1, "Queued behind another session"));
    let byId = rows(appState(slice));
    expect(byId.a).toMatchObject({ mark: "queued", subtitle: "Queued: waits for the model" });

    slice = open(slice, "b", { lastActivityAt: NOW - 2000, projectDir: SITE, cwd: SITE });
    slice = applyLive(slice, queued("b", 2, null));
    byId = rows(appState(slice));
    expect(byId.a?.subtitle).toBe("Queued: next in line for the model");
    expect(byId.b).toMatchObject({ mark: "queued", subtitle: "Queued: 2nd in line for the model" });

    // A working status without a place in line is not queued, even if its text says so.
    const w = createStream("a", { seq: 1 });
    w.emit("session.status", {
      status: "working",
      waitingOn: null,
      message: "Queued: waits for the model",
    });
    expect(rows(appState(applyLive(slice, w.events))).a?.mark).toBe("working");

    // A stored session lists its place in line too.
    const listed = reduceAll(emptyEngineSlice(), [
      {
        type: "summaries",
        sessions: [makeSummary("stored", { status: "working", queuePosition: 3 })],
      },
    ]);
    expect(rows(appState(listed)).stored?.subtitle).toBe("Queued: 3rd in line for the model");
  });

  it("describes a working session by its status line when no call runs", () => {
    let slice = open(emptyEngineSlice(), "w");
    const stream = createStream("w");
    stream.emit("session.status", {
      status: "working",
      waitingOn: null,
      message: "Waiting for the model",
    });
    slice = applyLive(slice, stream.events);
    expect(rows(appState(slice)).w?.subtitle).toBe("Waiting for the model");
    const bare = createStream("w", { seq: stream.seq });
    bare.emit("session.status", { status: "working", waitingOn: null, message: null });
    expect(rows(appState(applyLive(slice, bare.events))).w?.subtitle).toBe("Working");
  });

  it("returns the same object for unchanged inputs, and reuses rows that did not change", () => {
    const state = mockupState();
    const first = selectSidebar(state, NOW);
    expect(selectSidebar(state, NOW)).toBe(first);
    // Another session streams text: nothing in the sidebar changes.
    const more = createStream("fix", {
      seq: state.sessions.fix?.highWaterSeq ?? 0,
      time: NOW,
    });
    more.emit("message.started", { turnId: "t1", messageId: "m9" });
    more.emit("message.delta", { turnId: "t1", messageId: "m9", text: "Still editing" });
    const streamed = { ...state, ...applyLive(state, more.events) };
    expect(streamed.transcripts).not.toBe(state.transcripts);
    expect(selectSidebar(streamed, NOW)).toBe(first);
    // A minute later only the relative times change.
    const later = selectSidebar(streamed, NOW + 60_000);
    expect(later).not.toBe(first);
    expect(later[2]).toBe(first[2]);
  });
});

describe("selectModelFooter", () => {
  it("names the running model and counts running and queued sessions", () => {
    const option = MOCK_MODELS[0]?.option;
    const state = appState(mockupSlice(), {
      models: MOCK_MODELS.map((model) => model.option),
      modelStatus: {
        state: "ready",
        modelId: option?.id ?? null,
        label: null,
        message: null,
        memoryBytes: null,
      },
    });
    const footer = selectModelFooter(state);
    expect(footer).toEqual({
      label: "Qwen3.8 27B · 8-bit",
      state: "ready",
      detail: "Ready · 1 running, 1 queued",
    });
    expect(selectModelFooter(state)).toBe(footer);
    expect(selectModelFooter({ ...state, sessions: {} }).detail).toBe("Ready");
    expect(
      selectModelFooter({
        ...state,
        modelStatus: {
          state: "loading",
          modelId: null,
          label: null,
          message: "Loading into memory",
          memoryBytes: null,
        },
      }),
    ).toMatchObject({ label: "No model", state: "loading", detail: "Loading into memory" });
  });
});

describe("selectTitleBar", () => {
  it("sums the session's diffs over distinct files and counts tasks", () => {
    let slice = open(emptyEngineSlice(), "s1", {
      title: null,
      cwd: `${PROJECT}/.dawg/worktrees/split-cents`,
    });
    const stream = createStream();
    startTurn(stream);
    const edit = (id: string, file: string, additions: number, deletions: number) => {
      stream.emit("tool.started", {
        turnId: "t1",
        messageId: "m1",
        toolCallId: id,
        toolName: "Edit",
        input: { file_path: file },
      });
      stream.emit("tool.finished", {
        turnId: "t1",
        toolCallId: id,
        toolName: "Edit",
        outcome: "success",
        content: [],
        display: { kind: "diff", filePath: file, created: false, hunks: [], additions, deletions },
        durationMs: 5,
      });
    };
    edit("c1", `${PROJECT}/money.py`, 6, 2);
    edit("c2", `${PROJECT}/test_money.py`, 5, 0);
    edit("c3", `${PROJECT}/money.py`, 1, 1);
    stream.emit("tasks.updated", {
      tasks: [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ],
    });
    slice = applyLive(slice, stream.events);
    const state = withSelection(appState(slice), "s1");
    const view = selectTitleBar(state);
    expect(view).toEqual({
      sessionId: "s1",
      title: "New session",
      projectName: "tally",
      worktreeLabel: "worktree · split-cents",
      worktreeTitle: "Runs in a worktree",
      changes: { files: 2, additions: 12, deletions: 3 },
      tasks: { done: 1, total: 3 },
    });
    expect(selectTitleBar(state)).toBe(view);
    expect(selectTitleBar(withSelection(state, null))).toMatchObject({
      sessionId: null,
      title: "dawg-code",
      changes: null,
    });
  });
});

describe("selectTranscript", () => {
  it("says who interrupted a turn and keeps unchanged views", () => {
    let slice = open(emptyEngineSlice(), "s1");
    const stream = createStream();
    fullTurn(stream);
    interruptedTurn(stream, "t2");
    finishInterrupted(stream, "t2");
    interruptedTurn(stream, "t3");
    finishInterrupted(stream, "t3");
    slice = applyLive(slice, stream.events);
    const base = appState(slice);
    const plain = selectTranscript(base, "s1");
    const notes = plain?.items.filter((item) => item.kind === "note");
    expect(notes?.map((note) => note.kind === "note" && note.text)).toEqual([
      "Interrupted · the transcript keeps every finished call",
      "Interrupted · the transcript keeps every finished call",
    ]);
    const byYou = { ...base, ui: { ...base.ui, interruptedTurns: { t3: true as const } } };
    const view = selectTranscript(byYou, "s1");
    expect(
      view?.items
        .filter((item) => item.kind === "note")
        .map((item) => item.kind === "note" && item.text),
    ).toEqual([
      "Interrupted · the transcript keeps every finished call",
      "Interrupted by you · the transcript keeps every finished call",
    ]);
    expect(selectTranscript(byYou, "s1")).toBe(view);
    expect(view).toMatchObject({
      loaded: true,
      working: false,
      activeTurnId: null,
      toolCallDisplay: "smart",
      cwd: PROJECT,
    });
    expect(selectTranscript(byYou, "missing")).toBeNull();
  });

  it("exposes the running turn, and recomputes only when it changes", () => {
    let slice = open(emptyEngineSlice(), "s1");
    const stream = createStream();
    startTurn(stream, "t7");
    slice = applyLive(slice, stream.events);
    const state = appState(slice);
    const view = selectTranscript(state, "s1");
    expect(view).toMatchObject({ activeTurnId: "t7", working: true });
    expect(selectTranscript(state, "s1")).toBe(view);
    const ended = createStream("s1", { seq: stream.seq, time: stream.time });
    ended.emit("turn.finished", {
      turnId: "t7",
      stopReason: "completed",
      finalText: null,
      error: null,
      durationMs: 10,
    });
    const after = selectTranscript(appState(applyLive(slice, ended.events)), "s1");
    expect(after).not.toBe(view);
    expect(after).toMatchObject({ activeTurnId: null, working: false });
  });

  it("exposes the turns sent from the queue", () => {
    const state = withUi(appState(open(emptyEngineSlice(), "s1")), {
      fromQueueTurns: { t9: true },
    });
    expect(selectTranscript(state, "s1")?.queuedTurnIds).toEqual({ t9: true });
  });
});

describe("selectComposer", () => {
  it("uses the waiting placeholders while a card is open", () => {
    const state = mockupState();
    expect(selectComposer(state, "csv")).toMatchObject({
      working: false,
      answering: { kind: "permission", requestId: "p1" },
      placeholder: PLACEHOLDERS.permission,
    });
    expect(selectComposer(state, "tip")?.placeholder).toBe(
      "Waiting on you. A message here answers the question.",
    );
    expect(selectComposer(state, "fx")?.placeholder).toBe(
      "Waiting on you. A message here keeps planning, with your feedback.",
    );
    expect(selectComposer(state, "fix")).toMatchObject({
      working: true,
      answering: null,
      placeholder: "Reply to dawg. / for commands, @ to mention a file",
    });
    expect(selectComposer(state, "missing")).toBeNull();
  });

  it("shows the model, effort, context meter, queue and draft", () => {
    let slice = reduceAll(emptyEngineSlice(), [
      {
        type: "snapshot",
        snapshot: makeSnapshot(makeSummary("s1", { effort: "xhigh", mode: "acceptEdits" }), {
          usage: makeUsage({ requests: 4, promptTokens: 80_000, cachedTokens: 70_000 }, 74_200),
        }),
      },
    ]);
    slice = applyReplay(slice, "s1", []);
    const state = withUi(appState(slice, { models: MOCK_MODELS.map((model) => model.option) }), {
      drafts: { s1: "half typed" },
      queues: { s1: [{ id: "q1", text: "then this", state: "queued" }] },
    });
    const view = selectComposer(state, "s1");
    expect(view).toMatchObject({
      mode: "acceptEdits",
      model: { id: "qwen3.8-27b-q8", label: "Qwen3.8 27B · 8-bit" },
      effort: { value: "xhigh", levels: ["low", "medium", "high", "xhigh"] },
      draft: "half typed",
      queue: [{ id: "q1", text: "then this", state: "queued" }],
      canAttachImages: true,
      context: {
        used: 74_200,
        window: 204_800,
        compactAt: 133_120,
        breakdown: { systemPrompt: 4_112, instructions: 1_186, tools: 10_992, messages: 57_910 },
        compacting: false,
        last: { promptTokens: 18_000, cachedTokens: 16_000 },
      },
    });
    expect(view?.context?.fraction).toBeCloseTo(0.3623, 3);
    expect(view?.commands.map((command) => command.name)).toEqual(["compact", "help"]);
    expect(selectComposer(state, "s1")).toBe(view);
    // An event that changes nothing the composer shows keeps the same view.
    const stream = createStream("s1");
    stream.emit("session.status", { status: "idle", waitingOn: null, message: null });
    const after = { ...state, ...applyLive(state, stream.events) };
    expect(after.sessions.s1).not.toBe(state.sessions.s1);
    expect(selectComposer(after, "s1")).toBe(view);
  });

  it("leaves the threshold and the split out for sessions stored before engines sent them", () => {
    const {
      compactAt: _compactAt,
      breakdown: _breakdown,
      ...old
    } = makeUsage({ requests: 1, promptTokens: 18_000, cachedTokens: 16_000 }, 20_000);
    const usage = { ...old, compactAt: null, breakdown: null };
    const slice = reduceAll(emptyEngineSlice(), [
      { type: "snapshot", snapshot: makeSnapshot(makeSummary("s1"), { usage }) },
    ]);
    expect(selectComposer(appState(slice), "s1")?.context).toMatchObject({
      used: 20_000,
      compactAt: null,
      breakdown: null,
    });
  });

  it("falls back to the model id and hides the meter before anything is known", () => {
    const slice = reduceAll(emptyEngineSlice(), [
      {
        type: "snapshot",
        snapshot: makeSnapshot(makeSummary("s1", { model: "custom-model" }), { modelInfo: null }),
      },
    ]);
    const view = selectComposer(appState(slice), "s1");
    expect(view?.model.label).toBe("custom-model");
    expect(view?.context).toBeNull();
    expect(view?.effort.levels).toEqual([]);
    expect(view?.canAttachImages).toBe(false);
  });
});

describe("selectChrome and helpers", () => {
  it("memoises the chrome view", () => {
    const state = appState(emptyEngineSlice());
    expect(selectChrome(state)).toBe(selectChrome(state));
    expect(selectChrome(state).connection).toEqual({ phase: "connecting" });
  });

  it("turns an error message into a sidebar fragment", () => {
    expect(sentenceFragment("The model stopped responding.")).toBe("the model stopped responding");
    expect(sentenceFragment("LM Studio is not running.")).toBe("LM Studio is not running");
    expect(sentenceFragment("Wait...")).toBe("wait...");
  });
});
