import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeBridge,
  type FakeBridge,
  type FakeBridgeOptions,
} from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { transcriptProblems } from "./__fixtures__/invariants.ts";
import { fullTurn, interruptedTurn } from "./__fixtures__/scenarios.ts";
import { createStream, PROJECT } from "./__fixtures__/streams.ts";
import { RESTART_NOTICE } from "./connection.ts";
import { selectComposer, selectSidebar, selectTranscript } from "./selectors.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

function setup(engine: FakeEngine, options: Omit<FakeBridgeOptions, "engine"> = {}): Harness {
  const bridge = createFakeBridge({ engine, ...options });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  return harness;
}

function state(harness: Harness) {
  return harness.store.getState();
}

function actions(harness: Harness) {
  return harness.store.getState().actions;
}

/** A session with one finished turn in its history. */
function withHistory(
  engine: FakeEngine,
  id: string,
  summary: Parameters<FakeEngine["addSession"]>[1] = {},
) {
  engine.addSession(id, summary);
  const stream = createStream(id);
  fullTurn(stream);
  engine.emitAll(id, stream.events);
}

/** A session whose turn is running (no answer pending). */
function running(engine: FakeEngine, id: string, turnId = "t1") {
  engine.addSession(id);
  engine.emit(id, "session.status", { status: "working", waitingOn: null, message: null });
  engine.emit(id, "turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text: "Work" }], mentions: [] },
    command: null,
  });
}

function finishTurn(
  engine: FakeEngine,
  id: string,
  turnId: string,
  stopReason: "completed" | "interrupted",
) {
  engine.emit(id, "turn.finished", {
    turnId,
    stopReason,
    finalText: null,
    error: null,
    durationMs: 1000,
  });
  engine.emit(id, "session.status", { status: "idle", waitingOn: null, message: null });
}

async function started(harness: Harness): Promise<Harness> {
  await actions(harness).start();
  return harness;
}

describe("start", () => {
  it("loads settings, layout and models, then opens what needs to be live", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "quiet");
    running(engine, "busy");
    engine.addSession("waiting");
    engine.emit("waiting", "turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    engine.emit("waiting", "permission.requested", {
      turnId: "t1",
      request: {
        requestId: "p1",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "ls" },
        title: "Run a shell command",
        reason: "Ask first",
        suggestions: [],
      },
    });
    engine.emit("waiting", "session.status", {
      status: "waiting",
      waitingOn: "permission",
      message: null,
    });
    engine.addSession("broken", { status: "error" });
    withHistory(engine, "recent", { title: "Most recent" });

    const harness = await started(
      setup(engine, {
        windowState: { selectedSessionId: "gone", sidebarWidth: 300, seenSeq: { quiet: 5 } },
        settings: { appearance: "light" },
      }),
    );
    const s = state(harness);
    expect(s.connection).toEqual({
      phase: "ready",
      engine: { name: "fake engine", version: "1.0.0" },
    });
    expect(s.settings.appearance).toBe("light");
    expect(s.layout.sidebarWidth).toBe(300);
    expect(s.models.length).toBeGreaterThan(0);
    expect(s.modelStatus?.state).toBe("ready");
    expect(Object.keys(s.sessions).sort()).toEqual([
      "broken",
      "busy",
      "quiet",
      "recent",
      "waiting",
    ]);
    // The saved selection is gone: the most recent session is selected instead.
    expect(s.layout.selectedSessionId).toBe("recent");
    const resumed = engine
      .callsOf("session.resume")
      .map((params) => params.sessionId)
      .sort();
    expect(resumed).toEqual(["broken", "busy", "recent", "waiting"]);
    expect(s.sessions.quiet?.open).toBe(false);
    for (const id of ["busy", "waiting", "broken", "recent"]) {
      expect(s.sessions[id]).toMatchObject({ open: true, loaded: true });
      expect(transcriptProblems(s, id)).toEqual([]);
    }
    expect(s.pending.waiting?.map((ref) => ref.requestId)).toEqual(["p1"]);
    expect(s.sessions.busy?.activeTurnId).toBe("t1");
    // Seen marks: loaded from disk, first sight for the rest, and the selection is seen.
    expect(s.ui.seenSeq.quiet).toBe(5);
    expect(s.ui.seenSeq.recent).toBe(engine.session("recent").summary.lastSeq);
    expect(
      selectSidebar(s, Date.now())
        .flatMap((group) => group.rows)
        .find((row) => row.sessionId === "waiting")?.subtitle,
    ).toBe("Needs you: run a command");
  });

  it("is idempotent", async () => {
    const harness = setup(new FakeEngine());
    const first = actions(harness).start();
    expect(actions(harness).start()).toBe(first);
    await first;
    expect(harness.engine.callsOf("session.list")).toHaveLength(1);
  });

  it("fails with a readable message when the engine speaks another protocol version", async () => {
    const harness = await started(setup(new FakeEngine({ supportedVersions: [99] })));
    const { connection } = state(harness);
    expect(connection.phase).toBe("failed");
    expect(connection.phase === "failed" && connection.message).toMatch(/out of step/);
  });
});

describe("sessions", () => {
  it("resumes and replays a session when it is selected, and keeps it seen", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "quiet");
    withHistory(engine, "recent");
    const harness = await started(setup(engine));
    expect(state(harness).sessions.quiet?.loaded).toBe(false);

    actions(harness).selectSession("quiet");
    await vi.waitFor(() => expect(state(harness).sessions.quiet?.loaded).toBe(true));
    const view = selectTranscript(state(harness), "quiet");
    expect(view?.items.map((item) => item.kind)).toContain("turn-summary");
    expect(state(harness).ui.seenSeq.quiet).toBe(engine.session("quiet").summary.lastSeq);

    // New events while selected stay seen.
    engine.emit("quiet", "session.status", { status: "idle", waitingOn: null, message: null });
    await vi.waitFor(() =>
      expect(state(harness).ui.seenSeq.quiet).toBe(engine.session("quiet").summary.lastSeq),
    );
  });

  it("batches streamed events into one store update per frame", async () => {
    const engine = new FakeEngine();
    running(engine, "busy");
    const harness = await started(setup(engine));
    let updates = 0;
    const stop = harness.store.subscribe(() => {
      updates += 1;
    });
    engine.emit("busy", "message.started", { turnId: "t1", messageId: "m1" });
    for (let index = 0; index < 60; index++) {
      engine.emit("busy", "message.delta", { turnId: "t1", messageId: "m1", text: `w${index} ` });
    }
    await vi.waitFor(() => {
      const text = state(harness).transcripts.busy?.find((item) => item.kind === "assistant");
      expect(text?.kind === "assistant" && text.text.endsWith("w59 ")).toBe(true);
    });
    stop();
    expect(updates).toBeLessThanOrEqual(3);
  });

  it("holds back events that arrive before a session's snapshot", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "quiet");
    withHistory(engine, "other");
    const harness = await started(setup(engine));
    // The engine sends live events before answering the resume.
    const original = engine.snapshotOf.bind(engine);
    engine.snapshotOf = (id: string) => {
      const snapshot = original(id);
      if (id === "quiet") {
        engine.emit(id, "session.status", { status: "working", waitingOn: null, message: null });
        engine.emit(id, "turn.started", {
          turnId: "late",
          prompt: { content: [{ type: "text", text: "Again" }], mentions: [] },
          command: null,
        });
      }
      return snapshot;
    };
    actions(harness).selectSession("quiet");
    await vi.waitFor(() => {
      const items = state(harness).transcripts.quiet ?? [];
      expect(items.filter((item) => item.id === "user:late")).toHaveLength(1);
    });
    expect(transcriptProblems(state(harness), "quiet")).toEqual([]);
    expect(state(harness).sessions.quiet?.highWaterSeq).toBe(
      engine.session("quiet").summary.lastSeq,
    );
  });

  it("creates, forks, renames and archives sessions", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "base", { title: "Base" });
    const harness = await started(setup(engine, { folder: "/Users/you/code/new-thing" }));

    const created = await actions(harness).newSession();
    expect(created).toMatch(/^created-/);
    expect(engine.callsOf("session.create")).toEqual([{ cwd: "/Users/you/code/new-thing" }]);
    expect(state(harness).layout.selectedSessionId).toBe(created);
    await vi.waitFor(() => expect(state(harness).sessions[created ?? ""]?.loaded).toBe(true));
    // The event the engine sent before its response was not lost or doubled.
    expect(state(harness).sessions[created ?? ""]?.highWaterSeq).toBe(1);
    expect(state(harness).projects["/Users/you/code/new-thing"]?.name).toBe("new-thing");

    const forked = await actions(harness).forkSession("base");
    expect(state(harness).layout.selectedSessionId).toBe(forked);
    await vi.waitFor(() => expect(state(harness).sessions[forked ?? ""]?.loaded).toBe(true));
    expect(
      selectTranscript(state(harness), forked ?? "")?.items.map((item) => item.kind),
    ).toContain("turn-summary");

    await actions(harness).renameSession(forked ?? "", "Forked work");
    await vi.waitFor(() =>
      expect(state(harness).sessions[forked ?? ""]?.summary.title).toBe("Forked work"),
    );
    // "base" was opened at startup (the only session, so selected): the change arrives as an event.
    await actions(harness).renameSession("base", "Renamed base");
    await vi.waitFor(() =>
      expect(state(harness).sessions.base?.summary.title).toBe("Renamed base"),
    );
    await actions(harness).archiveSession("base");
    await vi.waitFor(() => expect(state(harness).sessions.base?.summary.archived).toBe(true));
    expect(
      selectSidebar(state(harness), Date.now())
        .flatMap((group) => group.rows)
        .some((row) => row.sessionId === "base"),
    ).toBe(false);
  });

  it("applies rename and archive results to stored sessions that are not open", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "stored", { title: "Stored" });
    withHistory(engine, "recent", { title: "Recent" });
    const harness = await started(setup(engine));
    expect(state(harness).sessions.stored?.open).toBe(false);
    await actions(harness).renameSession("stored", "Renamed");
    expect(state(harness).sessions.stored?.summary.title).toBe("Renamed");
    await actions(harness).archiveSession("stored");
    expect(state(harness).sessions.stored?.summary.archived).toBe(true);
    await actions(harness).archiveSession("stored", false);
    expect(state(harness).sessions.stored?.summary.archived).toBe(false);
  });

  it("returns null when the folder picker is cancelled", async () => {
    const harness = await started(setup(new FakeEngine(), { folder: null }));
    expect(await actions(harness).newSession()).toBeNull();
    expect(harness.engine.callsOf("session.create")).toEqual([]);
    expect(await actions(harness).newSession({ projectDir: PROJECT })).not.toBeNull();
  });

  it("marks a session unread by hand until it is selected", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "a");
    withHistory(engine, "b");
    const harness = await started(setup(engine));
    const row = () =>
      selectSidebar(state(harness), Date.now())
        .flatMap((group) => group.rows)
        .find((candidate) => candidate.sessionId === "a");
    expect(row()?.mark).not.toBe("unread");
    actions(harness).markUnread("a");
    expect(row()?.mark).toBe(state(harness).layout.selectedSessionId === "a" ? "idle" : "unread");
    actions(harness).selectSession("a");
    expect(state(harness).ui.markedUnread.a).toBeUndefined();
  });
});

describe("submit", () => {
  async function waitingOn(kind: "permission" | "question" | "plan") {
    const engine = new FakeEngine();
    engine.addSession("s1");
    engine.emit("s1", "turn.started", {
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Go" }], mentions: [] },
      command: null,
    });
    if (kind === "permission") {
      engine.emit("s1", "permission.requested", {
        turnId: "t1",
        request: {
          requestId: "r1",
          toolCallId: "c1",
          toolName: "Bash",
          input: { command: "uv add --dev pytest-repeat" },
          title: "Run a shell command",
          reason: "Ask first",
          suggestions: [],
        },
      });
    } else if (kind === "question") {
      engine.emit("s1", "question.asked", {
        turnId: "t1",
        requestId: "r1",
        toolCallId: "c1",
        questions: [
          {
            question: "How should tips split?",
            options: [{ label: "Evenly" }],
            multiSelect: false,
          },
          { question: "Round up?", options: [], multiSelect: false },
        ],
      });
    } else {
      engine.emit("s1", "plan.proposed", {
        turnId: "t1",
        requestId: "r1",
        toolCallId: "c1",
        plan: "# Plan",
        planPath: null,
      });
    }
    engine.emit("s1", "session.status", { status: "waiting", waitingOn: kind, message: null });
    const harness = await started(setup(engine));
    return harness;
  }

  it("denies a pending command with the text as the note", async () => {
    const harness = await waitingOn("permission");
    actions(harness).setDraft("s1", "Don't add dependencies.");
    await actions(harness).submit("s1", "Don't add dependencies.");
    expect(harness.engine.callsOf("permission.respond")).toEqual([
      {
        sessionId: "s1",
        requestId: "r1",
        response: { behavior: "deny", message: "Don't add dependencies." },
      },
    ]);
    expect(state(harness).ui.drafts.s1).toBeUndefined();
    expect(harness.engine.callsOf("session.prompt")).toEqual([]);
  });

  it("answers a pending question with the text for each question", async () => {
    const harness = await waitingOn("question");
    await actions(harness).submit("s1", "Only among people who opt in");
    expect(harness.engine.callsOf("question.respond")[0]?.response).toEqual({
      outcome: "answered",
      answers: [
        { question: "How should tips split?", selected: [], text: "Only among people who opt in" },
        { question: "Round up?", selected: [], text: "Only among people who opt in" },
      ],
    });
  });

  it("keeps planning with the text as feedback", async () => {
    const harness = await waitingOn("plan");
    await actions(harness).submit("s1", "Use the ECB daily file instead.");
    expect(harness.engine.callsOf("plan.respond")[0]?.response).toEqual({
      decision: "reject",
      message: "Use the ECB daily file instead.",
    });
  });

  it("sends prompts and known commands, and keeps the draft when sending fails", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "s1");
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));

    actions(harness).setDraft("s1", "Fix it");
    await actions(harness).submit("s1", "Fix it");
    expect(engine.callsOf("session.prompt")).toEqual([
      { sessionId: "s1", prompt: { content: [{ type: "text", text: "Fix it" }], mentions: [] } },
    ]);
    expect(state(harness).ui.drafts.s1).toBeUndefined();

    await actions(harness).submit("s1", "/help me");
    expect(engine.callsOf("session.command")).toEqual([
      { sessionId: "s1", name: "help", args: "me" },
    ]);
    const output = state(harness).transcripts.s1?.at(-1);
    expect(output).toMatchObject({
      kind: "command-output",
      command: "/help me",
      output: "Output of /help",
    });

    // Not one of the session's commands: a prompt.
    await actions(harness).submit("s1", "/etc/hosts is broken");
    expect(engine.callsOf("session.prompt").at(-1)?.prompt).toEqual({
      content: [{ type: "text", text: "/etc/hosts is broken" }],
      mentions: [],
    });

    engine.overrides["session.prompt"] = () => {
      throw new Error("The model is loading");
    };
    actions(harness).setDraft("s1", "Try again");
    await actions(harness).submit("s1", "Try again");
    expect(state(harness).ui.drafts.s1).toBe("Try again");
    expect(state(harness).notices.at(-1)?.text).toBe(
      "Could not send your message: The model is loading.",
    );
  });

  it("opens a stored session before sending to it", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "stored");
    withHistory(engine, "recent");
    const harness = await started(setup(engine));
    expect(state(harness).sessions.stored?.open).toBe(false);
    await actions(harness).submit("stored", "/help");
    expect(engine.callsOf("session.resume").map((params) => params.sessionId)).toContain("stored");
    expect(engine.callsOf("session.command")).toEqual([
      { sessionId: "stored", name: "help", args: "" },
    ]);
    expect(state(harness).sessions.stored).toMatchObject({ open: true, loaded: true });
  });

  it("opens the session a command opened", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "s1");
    engine
      .session("s1")
      .snapshot.commands.push({ name: "clear", description: "", argumentHint: null });
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));
    await actions(harness).submit("s1", "/clear");
    const selected = state(harness).layout.selectedSessionId;
    expect(selected).toMatch(/^cleared-/);
    await vi.waitFor(() => expect(state(harness).sessions[selected ?? ""]?.loaded).toBe(true));
  });
});

describe("the message queue", () => {
  it("queues while a turn runs and sends the oldest message when it completes", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));

    actions(harness).setDraft("s1", "Then update the README");
    await actions(harness).submit("s1", "Then update the README");
    await actions(harness).submit("s1", "And bump the version");
    expect(engine.callsOf("session.prompt")).toEqual([]);
    expect(state(harness).ui.drafts.s1).toBeUndefined();
    expect(
      selectComposer(state(harness), "s1")?.queue.map((message) => [message.text, message.state]),
    ).toEqual([
      ["Then update the README", "queued"],
      ["And bump the version", "queued"],
    ]);

    finishTurn(engine, "s1", "t1", "completed");
    await vi.waitFor(() => expect(engine.callsOf("session.prompt")).toHaveLength(1));
    expect(engine.callsOf("session.prompt")[0]?.prompt).toEqual({
      content: [{ type: "text", text: "Then update the README" }],
      mentions: [],
    });
    await vi.waitFor(() =>
      expect(state(harness).ui.queues.s1?.map((message) => message.text)).toEqual([
        "And bump the version",
      ]),
    );
    const turnIds = Object.keys(state(harness).ui.fromQueueTurns);
    expect(turnIds).toHaveLength(1);
    expect(selectTranscript(state(harness), "s1")?.queuedTurnIds).toEqual({
      [turnIds[0] ?? ""]: true,
    });
  });

  it("holds queued messages when the person stops the turn", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    const stream = createStream("s1");
    interruptedTurn(stream, "t1");
    engine.emitAll("s1", stream.events);
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));

    await actions(harness).submit("s1", "Then run the linter");
    await actions(harness).interrupt("s1");
    expect(engine.callsOf("session.interrupt")).toEqual([{ sessionId: "s1" }]);
    expect(state(harness).ui.queues.s1?.[0]?.state).toBe("held");
    expect(state(harness).ui.stoppedByUser.s1).toBe(true);

    finishTurn(engine, "s1", "t1", "interrupted");
    await vi.waitFor(() => expect(state(harness).sessions.s1?.activeTurnId).toBeNull());
    expect(engine.callsOf("session.prompt")).toEqual([]);
    const note = selectTranscript(state(harness), "s1")?.items.find((item) => item.kind === "note");
    expect(note?.kind === "note" && note.text).toBe(
      "Interrupted by you · the transcript keeps every finished call",
    );
    const row = selectSidebar(state(harness), Date.now())
      .flatMap((group) => group.rows)
      .find((candidate) => candidate.sessionId === "s1");
    expect(row?.subtitle).toBe("Stopped by you");

    const held = state(harness).ui.queues.s1?.[0];
    await actions(harness).sendQueuedNow("s1", held?.id ?? "");
    expect(engine.callsOf("session.prompt")[0]?.prompt).toEqual({
      content: [{ type: "text", text: "Then run the linter" }],
      mentions: [],
    });
    expect(state(harness).ui.queues.s1).toBeUndefined();

    // The next turn clears "Stopped by you".
    engine.emit("s1", "turn.started", {
      turnId: "t2",
      prompt: { content: [{ type: "text", text: "Then run the linter" }], mentions: [] },
      command: null,
    });
    await vi.waitFor(() => expect(state(harness).ui.stoppedByUser.s1).toBeUndefined());
  });

  it("removes a held message", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));
    await actions(harness).submit("s1", "Later");
    await actions(harness).interrupt("s1");
    const id = state(harness).ui.queues.s1?.[0]?.id ?? "";
    actions(harness).removeQueued("s1", id);
    expect(state(harness).ui.queues.s1).toBeUndefined();
  });
});

describe("engine restarts", () => {
  it("resumes open sessions and catches up from the high-water mark", async () => {
    const engine = new FakeEngine();
    running(engine, "busy");
    withHistory(engine, "idle");
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.busy?.loaded).toBe(true));
    const before = state(harness).sessions.busy?.highWaterSeq ?? 0;

    engine.dropConnections();
    await vi.waitFor(() => expect(state(harness).connection.phase).toBe("restarting"));
    expect(state(harness).sessions.busy?.open).toBe(false);
    // The turn went on while the window was cut off.
    finishTurn(engine, "busy", "t1", "completed");
    harness.bridge.restartEngine("The engine host exited (code 1)");

    await vi.waitFor(() =>
      expect(state(harness).notices.map((notice) => notice.text)).toContain(RESTART_NOTICE),
    );
    const s = state(harness);
    expect(s.connection.phase).toBe("ready");
    expect(s.sessions.busy).toMatchObject({
      open: true,
      loaded: true,
      activeTurnId: null,
      status: "idle",
    });
    expect(s.sessions.busy?.highWaterSeq).toBe(before + 2);
    expect(s.transcripts.busy?.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(transcriptProblems(s, "busy")).toEqual([]);
    const replays = engine
      .callsOf("session.replay")
      .filter((params) => params.sessionId === "busy");
    expect(replays.at(-1)?.afterSeq).toBe(before);
  });

  it("rebuilds a session whose events went backwards after the restart", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "s1");
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));
    const fullLength = state(harness).transcripts.s1?.length ?? 0;

    engine.dropConnections();
    await vi.waitFor(() => expect(state(harness).connection.phase).toBe("restarting"));
    // The mock engine restarts from scratch: only the first few events exist again.
    engine.truncate("s1", 4);
    harness.bridge.restartEngine();
    await vi.waitFor(() =>
      expect(state(harness).notices.map((notice) => notice.text)).toContain(RESTART_NOTICE),
    );
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));
    const s = state(harness);
    expect(s.sessions.s1?.highWaterSeq).toBe(4);
    expect(s.transcripts.s1?.length).toBeLessThan(fullLength);
    expect(transcriptProblems(s, "s1")).toEqual([]);
    expect(engine.callsOf("session.replay").at(-1)?.afterSeq).toBe(0);
  });
});

describe("settings and window state", () => {
  it("saves settings through the bridge and follows changes from other windows", async () => {
    const harness = await started(setup(new FakeEngine()));
    await actions(harness).setAppearance("light");
    await actions(harness).setToolCallDisplay("open");
    expect(harness.bridge.settingsUpdates).toEqual([
      { appearance: "light" },
      { toolCalls: "open" },
    ]);
    expect(state(harness).settings).toEqual({ appearance: "light", toolCalls: "open" });
    harness.bridge.changeSettings({ appearance: "dark" });
    expect(state(harness).settings.appearance).toBe("dark");
    actions(harness).setResolvedTheme("light");
    expect(state(harness).resolvedTheme).toBe("light");
    harness.bridge.setModelStatus({
      state: "loading",
      modelId: null,
      label: null,
      message: "Loading into memory",
    });
    expect(state(harness).modelStatus?.message).toBe("Loading into memory");
  });

  it("debounces window-state saves and clamps widths", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "s1");
    const harness = await started(setup(engine));
    const savedBefore = harness.bridge.saved.length;
    vi.useFakeTimers();
    actions(harness).setSidebarWidth(250);
    actions(harness).setSidebarWidth(280.6);
    actions(harness).setDockWidth(10_000);
    actions(harness).openPane("terminal");
    vi.advanceTimersByTime(499);
    expect(harness.bridge.saved.length).toBe(savedBefore);
    vi.advanceTimersByTime(1);
    expect(harness.bridge.saved.length).toBe(savedBefore + 1);
    expect(harness.bridge.saved.at(-1)).toMatchObject({
      sidebarWidth: 281,
      dockWidth: 900,
      dockOpen: true,
      dockPane: "terminal",
      selectedSessionId: "s1",
    });
    // Search and view are not persisted, so they save nothing new.
    actions(harness).setSearch("tally");
    vi.advanceTimersByTime(600);
    expect(harness.bridge.saved.length).toBe(savedBefore + 1);
    actions(harness).closeDock();
    actions(harness).setSidebarOpen(false);
    vi.advanceTimersByTime(600);
    expect(harness.bridge.saved.at(-1)).toMatchObject({ dockOpen: false, sidebarOpen: false });
  });
});

describe("other actions", () => {
  it("changes mode, model and effort through the engine, and compacts", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "s1");
    const harness = await started(setup(engine));
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));
    await actions(harness).cycleMode("s1");
    expect(engine.callsOf("session.setMode")).toEqual([{ sessionId: "s1", mode: "acceptEdits" }]);
    await vi.waitFor(() => expect(state(harness).sessions.s1?.summary.mode).toBe("acceptEdits"));
    await actions(harness).cycleMode("s1");
    expect(engine.callsOf("session.setMode").at(-1)).toEqual({ sessionId: "s1", mode: "plan" });
    await actions(harness).setModel("s1", "gpt-oss-20b-q4");
    await actions(harness).setEffort("s1", null);
    expect(engine.callsOf("session.setModel")).toEqual([
      { sessionId: "s1", model: "gpt-oss-20b-q4" },
    ]);
    expect(engine.callsOf("session.setEffort")).toEqual([{ sessionId: "s1", effort: null }]);
    await actions(harness).compact("s1");
    expect(engine.callsOf("session.command").at(-1)).toEqual({
      sessionId: "s1",
      name: "compact",
      args: "",
    });
    expect(state(harness).transcripts.s1?.at(-1)).toMatchObject({
      kind: "command-output",
      command: "/compact",
    });
  });

  it("turns failed requests into notices instead of throwing", async () => {
    const harness = await started(setup(new FakeEngine({})));
    harness.engine.addSession("ghost");
    await expect(
      actions(harness).respondPermission("ghost", "nope", { behavior: "allow", scope: "once" }),
    ).resolves.toBeUndefined();
    expect(state(harness).notices.at(-1)?.text).toMatch(/^Could not send your answer: /);
    const id = state(harness).notices.at(-1)?.id ?? "";
    actions(harness).dismissNotice(id);
    expect(state(harness).notices).toEqual([]);
  });

  it("updates layout and transcript UI state", async () => {
    const engine = new FakeEngine();
    withHistory(engine, "s1");
    const harness = await started(setup(engine));
    actions(harness).setView("settings");
    actions(harness).setSettingsPage("models");
    expect(state(harness).layout).toMatchObject({ view: "settings", settingsPage: "models" });
    actions(harness).selectSession("s1");
    expect(state(harness).layout.view).toBe("sessions");
    actions(harness).setItemOpen("s1", "tool:t1-c1", true);
    actions(harness).setShownAgain("s1", "t1-p1", true);
    expect(selectTranscript(state(harness), "s1")).toMatchObject({
      openItems: { "tool:t1-c1": true },
      shownAgain: { "t1-p1": true },
    });
    actions(harness).setShownAgain("s1", "t1-p1", false);
    expect(state(harness).ui.shownAgain.s1).toEqual({});
  });
});
