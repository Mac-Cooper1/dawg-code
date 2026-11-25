/**
 * The store's actions and the glue between the engine connection, the reducer and UI state.
 *
 * Nothing here throws into React: a failed request becomes a one-line notice, and state changes
 * that depend on the engine (titles, modes, answers) arrive as events rather than being guessed.
 */
import {
  ErrorCodes,
  type PermissionMode,
  type QuestionResponse,
  RpcError,
  type SessionId,
  type SessionSnapshot,
} from "@dawg/protocol";
import type { StoreApi } from "zustand";
import type { DawgBridge, DesktopSettingsPatch } from "../../shared/bridge.ts";
import { nextMode } from "../lib/modes.ts";
import type { FrameScheduler } from "./batcher.ts";
import { createEngineConnection, type EngineConnection, type SyncInfo } from "./connection.ts";
import { followUps } from "./follow-ups.ts";
import * as queue from "./queue.ts";
import { reduceAll } from "./reducer.ts";
import { neighbourOf, sidebarOrder } from "./sidebar-order.ts";
import type {
  AppActions,
  AppStore,
  EngineSlice,
  Layout,
  Notice,
  ReducerInput,
  UiState,
} from "./types.ts";
import {
  applyWindowState,
  clampDockWidth,
  clampSidebarWidth,
  createWindowStateSaver,
  windowStateOf,
} from "./window-state.ts";

export interface RuntimeDeps {
  bridge: DawgBridge;
  now: () => number;
  /** Overrides the frame scheduling of event batches (tests). */
  scheduleFrame?: FrameScheduler;
}

export interface Runtime {
  actions: AppActions;
  connection: EngineConnection;
}

const MAX_NOTICES = 4;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\.$/, "");
}

function sliceOf(state: AppStore): EngineSlice {
  return {
    projects: state.projects,
    sessions: state.sessions,
    transcripts: state.transcripts,
    pending: state.pending,
  };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function createRuntime(store: StoreApi<AppStore>, deps: RuntimeDeps): Runtime {
  const { bridge } = deps;
  const get = store.getState;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${deps.now().toString(36)}-${++counter}`;
  /** Queued messages being sent, so a burst of events cannot send one twice. */
  const sending = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  let started: Promise<void> | null = null;
  let stopped = false;

  // --- State helpers -------------------------------------------------------------------------

  function setUi(update: (ui: UiState) => UiState): void {
    const ui = get().ui;
    const next = update(ui);
    if (next !== ui) store.setState({ ui: next });
  }

  function setLayout(patch: Partial<Layout>): void {
    store.setState({ layout: { ...get().layout, ...patch } });
  }

  function notice(text: string, tone: Notice["tone"] = "error"): void {
    const notices = get().notices.filter((existing) => existing.text !== text);
    const next: Notice = { id: nextId("notice"), text, tone };
    store.setState({ notices: [...notices, next].slice(-MAX_NOTICES) });
  }

  function sessionTitle(sessionId: SessionId): string {
    return get().sessions[sessionId]?.summary.title ?? "the session";
  }

  function markSeen(ui: UiState, sessionId: SessionId): UiState {
    const session = get().sessions[sessionId];
    const latest = session ? Math.max(session.highWaterSeq, session.summary.lastSeq) : 0;
    const seen = ui.seenSeq[sessionId];
    const seenSeq =
      seen !== undefined && seen >= latest ? ui.seenSeq : { ...ui.seenSeq, [sessionId]: latest };
    const markedUnread = withoutKey(ui.markedUnread, sessionId);
    if (seenSeq === ui.seenSeq && markedUnread === ui.markedUnread) return ui;
    return { ...ui, seenSeq, markedUnread };
  }

  // --- Reducer and follow-ups ----------------------------------------------------------------

  function applyInputs(inputs: ReducerInput[]): void {
    const prev = get();
    const before = sliceOf(prev);
    const slice = reduceAll(before, inputs);
    if (slice === before) return;
    const { ui, ended, removed } = followUps(prev, slice);
    store.setState({ ...slice, ui });
    const selected = prev.layout.selectedSessionId;
    if (selected !== null && removed.includes(selected)) {
      // Its neighbour in the sidebar as it was, among the sessions that are still there.
      const gone = new Set(removed.filter((id) => id !== selected));
      const groups = sidebarOrder(prev.sessions, prev.layout.search).map((group) =>
        group.sessions.map((session) => session.id).filter((id) => !gone.has(id)),
      );
      show(neighbourOf(groups, selected), false);
    }
    for (const turn of ended) {
      if (turn.stopReason === "completed") void sendNextQueued(turn.sessionId);
      else
        setUi((current) => ({ ...current, queues: queue.holdAll(current.queues, turn.sessionId) }));
    }
  }

  /**
   * Applies a request's result now, after any events already waiting for the next frame, so the
   * transcript keeps arrival order (a command's events reach the client before its response).
   */
  function applyResult(inputs: ReducerInput[]): void {
    connection.flush();
    applyInputs(inputs);
  }

  const connection = createEngineConnection({
    bridge,
    dispatch: applyInputs,
    getSlice: () => sliceOf(get()),
    setConnection: (state) => store.setState({ connection: state }),
    onSynced,
    notice,
    ...(deps.scheduleFrame ? { scheduleFrame: deps.scheduleFrame } : {}),
  });

  /** After each (re)connect: fix the selection, then open what needs to be live. */
  async function onSynced(info: SyncInfo): Promise<void> {
    const state = get();
    const selected = state.layout.selectedSessionId;
    const current = selected ? state.sessions[selected] : undefined;
    if (!current) {
      const newest = Object.values(state.sessions)
        .filter((session) => !session.summary.archived)
        .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt)[0];
      setLayout({ selectedSessionId: newest?.id ?? null });
      if (newest) setUi((ui) => markSeen(ui, newest.id));
    }
    const toOpen = new Set<SessionId>(info.wasOpen);
    for (const session of Object.values(get().sessions)) {
      if (
        session.status === "working" ||
        session.status === "waiting" ||
        session.status === "error"
      ) {
        toOpen.add(session.id);
      }
    }
    const selection = get().layout.selectedSessionId;
    if (selection && get().sessions[selection]) toOpen.add(selection);
    await Promise.all([...toOpen].filter((id) => get().sessions[id]).map((id) => open(id)));
  }

  async function open(sessionId: SessionId): Promise<void> {
    try {
      await connection.openSession(sessionId);
    } catch (error) {
      notice(`Could not open “${sessionTitle(sessionId)}”: ${errorText(error)}.`);
    }
  }

  /** Applies a snapshot from create, fork or a command and selects the session. */
  async function adoptAndSelect(snapshot: SessionSnapshot): Promise<void> {
    const adopted = connection.adoptSnapshot(snapshot);
    actions.selectSession(snapshot.session.id);
    try {
      await adopted;
    } catch (error) {
      notice(`Could not load “${snapshot.session.title ?? "New session"}”: ${errorText(error)}.`);
    }
  }

  // --- Sending ---------------------------------------------------------------------------------

  /** Sends text as a new turn: a known "/command", or a prompt. Returns the turn id, if any. */
  async function send(sessionId: SessionId, text: string): Promise<string | null> {
    const session = get().sessions[sessionId];
    const command = queue.parseCommand(text, session?.commands ?? []);
    if (command) {
      const result = await connection.request("session.command", {
        sessionId,
        name: command.name,
        args: command.args,
      });
      if (result.output !== null) {
        applyResult([
          { type: "command-output", sessionId, command: text.trim(), output: result.output },
        ]);
      }
      if (result.openedSession) void adoptAndSelect(result.openedSession);
      return result.turnId;
    }
    const result = await connection.request("session.prompt", {
      sessionId,
      prompt: { content: [{ type: "text", text }] },
    });
    return result.turnId;
  }

  function rememberQueuedTurn(turnId: string | null): void {
    if (turnId === null) return;
    setUi((ui) => ({ ...ui, fromQueueTurns: { ...ui.fromQueueTurns, [turnId]: true } }));
  }

  async function sendNextQueued(sessionId: SessionId): Promise<void> {
    const message = queue.nextQueued(get().ui.queues[sessionId]);
    if (!message || sending.has(message.id)) return;
    sending.add(message.id);
    try {
      const turnId = await send(sessionId, message.text);
      setUi((ui) => ({ ...ui, queues: queue.removeQueued(ui.queues, sessionId, message.id) }));
      rememberQueuedTurn(turnId);
    } catch (error) {
      setUi((ui) => ({
        ...ui,
        queues: queue.setQueuedState(ui.queues, sessionId, message.id, "held"),
      }));
      notice(`Could not send your queued message: ${errorText(error)}.`);
    } finally {
      sending.delete(message.id);
    }
  }

  function isRunning(sessionId: SessionId): boolean {
    const session = get().sessions[sessionId];
    if (!session) return false;
    return session.activeTurnId !== null || session.status === "working";
  }

  function clearDraftIf(sessionId: SessionId, text: string): void {
    setUi((ui) =>
      ui.drafts[sessionId] === text ? { ...ui, drafts: withoutKey(ui.drafts, sessionId) } : ui,
    );
  }

  async function answerWithText(sessionId: SessionId, text: string): Promise<boolean> {
    const ref = get().pending[sessionId]?.[0];
    if (!ref) return false;
    switch (ref.kind) {
      case "permission":
        await connection.request("permission.respond", {
          sessionId,
          requestId: ref.requestId,
          response: { behavior: "deny", message: text },
        });
        return true;
      case "question": {
        const item = get().transcripts[sessionId]?.find(
          (candidate) => candidate.kind === "question" && candidate.requestId === ref.requestId,
        );
        const questions = item?.kind === "question" ? item.questions : [];
        const response: QuestionResponse = {
          outcome: "answered",
          answers: questions.map((question) => ({
            question: question.question,
            selected: [],
            text,
          })),
        };
        await connection.request("question.respond", {
          sessionId,
          requestId: ref.requestId,
          response,
        });
        return true;
      }
      case "plan":
        await connection.request("plan.respond", {
          sessionId,
          requestId: ref.requestId,
          response: { decision: "reject", message: text },
        });
        return true;
    }
  }

  // --- Settings --------------------------------------------------------------------------------

  async function updateSettings(patch: DesktopSettingsPatch): Promise<void> {
    try {
      const settings = await bridge.settings.update(patch);
      store.setState({ settings });
    } catch (error) {
      notice(`Could not save the setting: ${errorText(error)}.`);
    }
  }

  async function request<T>(failure: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      notice(`${failure}: ${errorText(error)}.`);
      return null;
    }
  }

  // --- Startup -------------------------------------------------------------------------------

  async function startUp(): Promise<void> {
    unsubscribe.push(bridge.settings.onChange((settings) => store.setState({ settings })));
    unsubscribe.push(bridge.models.onStatus((modelStatus) => store.setState({ modelStatus })));
    const [settings, windowState, models, modelStatus] = await Promise.allSettled([
      bridge.settings.get(),
      bridge.windowState.load(),
      bridge.models.list(),
      bridge.models.status(),
    ]);
    if (stopped) return;
    if (settings.status === "fulfilled") store.setState({ settings: settings.value });
    if (windowState.status === "fulfilled") {
      store.setState(applyWindowState(get(), windowState.value));
    } else {
      notice(`Could not restore the window layout: ${errorText(windowState.reason)}.`);
    }
    if (models.status === "fulfilled") store.setState({ models: models.value });
    if (modelStatus.status === "fulfilled" && get().modelStatus === null) {
      store.setState({ modelStatus: modelStatus.value });
    }

    // Save layout and seen marks from here on.
    const saver = createWindowStateSaver(bridge, (error) =>
      notice(`Could not save the window layout: ${errorText(error)}.`),
    );
    unsubscribe.push(
      store.subscribe((state, prev) => {
        if (state.layout !== prev.layout || state.ui.seenSeq !== prev.ui.seenSeq) {
          saver.schedule(windowStateOf(state));
        }
      }),
    );
    unsubscribe.push(() => saver.flush());

    await connection.start();
  }

  /**
   * Selects a session (or nothing): marks it seen, and resumes and replays it if needed. With
   * `toSessions`, Settings gives way to the session view.
   */
  function show(id: SessionId | null, toSessions: boolean): void {
    const layout = get().layout;
    store.setState({
      layout: { ...layout, selectedSessionId: id, view: toSessions ? "sessions" : layout.view },
    });
    if (id === null) return;
    setUi((ui) => markSeen(ui, id));
    const session = get().sessions[id];
    if (session && (!session.open || !session.loaded) && connection.ready) {
      if (!connection.isSyncing(id)) void open(id);
    }
  }

  // --- Actions ---------------------------------------------------------------------------------

  const actions: AppActions = {
    start() {
      started ??= startUp().catch((error: unknown) => {
        notice(`dawg-code could not start: ${errorText(error)}.`);
      });
      return started;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      connection.stop();
      for (const stop of unsubscribe.splice(0)) stop();
    },

    selectSession(id) {
      show(id, true);
    },
    setView: (view) => setLayout({ view }),
    setSettingsPage: (settingsPage) => setLayout({ settingsPage, view: "settings" }),
    setSidebarOpen: (sidebarOpen) => setLayout({ sidebarOpen }),
    setSidebarWidth: (px) => setLayout({ sidebarWidth: clampSidebarWidth(px) }),
    openPane: (dockPane) => setLayout({ dockOpen: true, dockPane }),
    closeDock: () => setLayout({ dockOpen: false }),
    setDockWidth: (px) => setLayout({ dockWidth: clampDockWidth(px) }),
    setSearch: (search) => setLayout({ search }),
    dismissNotice(id) {
      store.setState({ notices: get().notices.filter((notice) => notice.id !== id) });
    },

    setAppearance: (appearance) => updateSettings({ appearance }),
    setToolCallDisplay: (toolCalls) => updateSettings({ toolCalls }),
    setResolvedTheme(theme) {
      if (get().resolvedTheme !== theme) store.setState({ resolvedTheme: theme });
    },

    async newSession(options) {
      let dir = options?.projectDir ?? null;
      if (dir === null) {
        try {
          dir = await bridge.dialogs.chooseFolder({ title: "Choose a project folder" });
        } catch (error) {
          notice(`Could not open the folder picker: ${errorText(error)}.`);
          return null;
        }
      }
      if (dir === null) return null;
      const cwd = dir;
      const snapshot = await request("Could not start a session", () =>
        connection.request("session.create", { cwd }),
      );
      if (!snapshot) return null;
      await adoptAndSelect(snapshot);
      return snapshot.session.id;
    },
    async renameSession(id, title) {
      const trimmed = title.trim();
      if (trimmed === "") return;
      const result = await request("Could not rename the session", () =>
        connection.request("session.rename", { sessionId: id, title: trimmed }),
      );
      if (result) applyResult([{ type: "summaries", sessions: [result.session] }]);
    },
    async forkSession(id) {
      const snapshot = await request("Could not fork the session", () =>
        connection.request("session.fork", { sessionId: id }),
      );
      if (!snapshot) return null;
      await adoptAndSelect(snapshot);
      return snapshot.session.id;
    },
    async archiveSession(id, archived = true) {
      const result = await request(
        archived ? "Could not archive the session" : "Could not unarchive the session",
        () => connection.request("session.archive", { sessionId: id, archived }),
      );
      if (result) applyResult([{ type: "summaries", sessions: [result.session] }]);
    },
    async deleteSession(id) {
      try {
        await connection.request("session.delete", { sessionId: id });
      } catch (error) {
        // Already gone (another window deleted it): it leaves this window too.
        if (!(error instanceof RpcError && error.code === ErrorCodes.SessionNotFound)) {
          notice(`Could not delete “${sessionTitle(id)}”: ${errorText(error)}.`);
          return;
        }
      }
      connection.forgetSession(id);
      applyResult([{ type: "deleted", sessionId: id }]);
    },
    markUnread(id) {
      setUi((ui) =>
        ui.markedUnread[id] ? ui : { ...ui, markedUnread: { ...ui.markedUnread, [id]: true } },
      );
    },

    setDraft(sessionId, text) {
      setUi((ui) => {
        if ((ui.drafts[sessionId] ?? "") === text) return ui;
        const drafts =
          text === "" ? withoutKey(ui.drafts, sessionId) : { ...ui.drafts, [sessionId]: text };
        return { ...ui, drafts };
      });
    },
    async submit(sessionId, text) {
      const trimmed = text.trim();
      const session = get().sessions[sessionId];
      if (trimmed === "" || !session) return;
      try {
        // A stored session must be open before the engine takes a prompt (and its commands known).
        if (!session.open || !session.loaded) await connection.openSession(sessionId);
        if (await answerWithText(sessionId, trimmed)) {
          clearDraftIf(sessionId, text);
          return;
        }
        if (isRunning(sessionId)) {
          setUi((ui) => ({
            ...ui,
            queues: queue.enqueue(ui.queues, sessionId, {
              id: nextId("queued"),
              text: trimmed,
              state: "queued",
            }),
          }));
          clearDraftIf(sessionId, text);
          return;
        }
        await send(sessionId, trimmed);
        clearDraftIf(sessionId, text);
      } catch (error) {
        notice(`Could not send your message: ${errorText(error)}.`);
      }
    },
    async interrupt(sessionId) {
      const session = get().sessions[sessionId];
      if (!session) return;
      const turnId = session.activeTurnId;
      setUi((ui) => ({
        ...ui,
        stoppedByUser: { ...ui.stoppedByUser, [sessionId]: true },
        queues: queue.holdAll(ui.queues, sessionId),
        interruptedTurns:
          turnId === null ? ui.interruptedTurns : { ...ui.interruptedTurns, [turnId]: true },
      }));
      await request("Could not stop the turn", () =>
        connection.request("session.interrupt", { sessionId }),
      );
    },
    async sendQueuedNow(sessionId, queueId) {
      const message = get().ui.queues[sessionId]?.find((candidate) => candidate.id === queueId);
      if (!message || sending.has(queueId)) return;
      if (isRunning(sessionId)) {
        // A turn started meanwhile: send it when that one completes.
        setUi((ui) => ({
          ...ui,
          queues: queue.setQueuedState(ui.queues, sessionId, queueId, "queued"),
        }));
        return;
      }
      sending.add(queueId);
      try {
        const turnId = await send(sessionId, message.text);
        setUi((ui) => ({ ...ui, queues: queue.removeQueued(ui.queues, sessionId, queueId) }));
        rememberQueuedTurn(turnId);
      } catch (error) {
        notice(`Could not send the held message: ${errorText(error)}.`);
      } finally {
        sending.delete(queueId);
      }
    },
    removeQueued(sessionId, queueId) {
      setUi((ui) => ({ ...ui, queues: queue.removeQueued(ui.queues, sessionId, queueId) }));
    },
    async setMode(sessionId, mode: PermissionMode) {
      await request("Could not change the mode", () =>
        connection.request("session.setMode", { sessionId, mode }),
      );
    },
    async cycleMode(sessionId) {
      const session = get().sessions[sessionId];
      if (!session) return;
      await actions.setMode(sessionId, nextMode(session.summary.mode));
    },
    async setModel(sessionId, modelId) {
      await request("Could not change the model", () =>
        connection.request("session.setModel", { sessionId, model: modelId }),
      );
    },
    async setEffort(sessionId, effort) {
      await request("Could not change the effort", () =>
        connection.request("session.setEffort", { sessionId, effort }),
      );
    },
    async compact(sessionId) {
      const result = await request("Could not compact the conversation", () =>
        connection.request("session.command", { sessionId, name: "compact", args: "" }),
      );
      if (result?.output) {
        applyResult([
          { type: "command-output", sessionId, command: "/compact", output: result.output },
        ]);
      }
    },

    async respondPermission(sessionId, requestId, response) {
      await request("Could not send your answer", () =>
        connection.request("permission.respond", { sessionId, requestId, response }),
      );
    },
    async respondQuestion(sessionId, requestId, response) {
      await request("Could not send your answer", () =>
        connection.request("question.respond", { sessionId, requestId, response }),
      );
    },
    async respondPlan(sessionId, requestId, response) {
      await request("Could not send your answer", () =>
        connection.request("plan.respond", { sessionId, requestId, response }),
      );
    },

    setItemOpen(sessionId, itemId, open) {
      setUi((ui) => {
        const current = ui.openItems[sessionId] ?? {};
        if (current[itemId] === open) return ui;
        return {
          ...ui,
          openItems: { ...ui.openItems, [sessionId]: { ...current, [itemId]: open } },
        };
      });
    },
    setShownAgain(sessionId, requestId, shown) {
      setUi((ui) => {
        const current = ui.shownAgain[sessionId] ?? {};
        if ((current[requestId] ?? false) === shown) return ui;
        const next = shown ? { ...current, [requestId]: true } : withoutKey(current, requestId);
        return { ...ui, shownAgain: { ...ui.shownAgain, [sessionId]: next } };
      });
    },
  };

  return { actions, connection };
}
