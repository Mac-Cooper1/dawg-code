/**
 * The store's actions and the glue between the engine connection, the reducer and UI state.
 *
 * Nothing here throws into React: a failed request becomes a one-line notice, and state changes
 * that depend on the engine (titles, modes, answers) arrive as events rather than being guessed.
 */
import {
  type CommandInfo,
  type ContentPart,
  type EngineEvent,
  ErrorCodes,
  type MethodResult,
  type PermissionMode,
  type QuestionResponse,
  RpcError,
  type SessionId,
  type SessionSnapshot,
  type SessionSummary,
  type SubagentInfo,
} from "@dawg/protocol";
import type { StoreApi } from "zustand";
import type {
  BranchList,
  DawgBridge,
  DesktopSettingsPatch,
  ModelStatus,
  ModelsState,
  TrackSessionInput,
  WorkspaceInfo,
  WorktreeInfo,
} from "../../shared/bridge.ts";
import { basename } from "../lib/format.ts";
import { nextMode } from "../lib/modes.ts";
import type { FrameScheduler } from "./batcher.ts";
import { createEngineConnection, type EngineConnection, type SyncInfo } from "./connection.ts";
import { followUps } from "./follow-ups.ts";
import { shallowEqual } from "./memo.ts";
import {
  findDownload,
  findInstalled,
  firstRunStep,
  helperToSetUp,
  modelName,
  needsSetup,
  sameOptions,
} from "./models.ts";
import { requestPaneFile } from "./pane-requests.ts";
import { watchProjectSetup } from "./project-setup.ts";
import * as queue from "./queue.ts";
import { emptyEngineSlice, reduceAll } from "./reducer.ts";
import { neighbourOf, sidebarOrder } from "./sidebar-order.ts";
import type {
  AppActions,
  AppStore,
  EngineSlice,
  ImageAttachment,
  Layout,
  NewSessionOffer,
  Notice,
  OnboardingState,
  QueuedMessage,
  ReducerInput,
  RewindDialog,
  SessionView,
  SubagentTranscript,
  TrustReview,
  UiState,
} from "./types.ts";
import {
  applyWindowState,
  clampDockWidth,
  clampSidebarWidth,
  createWindowStateSaver,
  forgetComposersExcept,
  windowStateOf,
} from "./window-state.ts";
import { orderBranches, suggestWorktreeName } from "./worktree-names.ts";

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

/** Replay page size for a subagent's transcript. */
const CHILD_PAGE = 2000;

/** The notice shown while a request waits for a model to load. */
export const MODEL_LOADING_NOTICE_ID = "model-loading";

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\.$/, "");
}

/** "1 file", "3 files". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** An error as a sentence, for showing on its own: "Not enough free space." */
function sentence(error: unknown): string {
  const text = errorText(error);
  return text === "" ? "Something went wrong." : `${text}.`;
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

/**
 * What `workspace.track` is told about a session: its directories, and whether to show its
 * project's memory folder too (after `/memory`).
 */
function trackInputOf(
  session: Pick<SessionView, "id" | "summary" | "additionalDirectories">,
  memory = false,
): TrackSessionInput {
  return {
    sessionId: session.id,
    cwd: session.summary.cwd,
    projectDir: session.summary.projectDir,
    additionalDirectories: session.additionalDirectories,
    ...(memory ? { memory: true } : {}),
  };
}

/** Tracking again is needed only when the directories change. */
function trackKeyOf(input: TrackSessionInput): string {
  return [
    input.cwd,
    input.projectDir,
    ...(input.additionalDirectories ?? []),
    input.memory === true ? "+memory" : "",
  ].join("\n");
}

/**
 * `liveBatches` after a batch: bumped for each session that live events (not a snapshot, replay
 * or list) changed, and without the sessions that left. Unchanged when neither happened.
 */
function countLiveBatches(
  counts: Record<SessionId, number>,
  inputs: readonly ReducerInput[],
  before: EngineSlice,
  after: EngineSlice,
  removed: readonly SessionId[],
): Record<SessionId, number> {
  let next = counts;
  for (const input of inputs) {
    if (input.type !== "event") continue;
    const id = input.event.payload.sessionId;
    const session = after.sessions[id];
    // A duplicate event changes nothing, and one batch counts once.
    if (!session || session === before.sessions[id] || next[id] !== counts[id]) continue;
    next = { ...next, [id]: (counts[id] ?? 0) + 1 };
  }
  for (const id of removed) next = withoutKey(next, id);
  return next;
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
  /** False until the first models state arrives: first run may start then. */
  let modelsSeen = false;
  /** The model first run is starting, so a burst of models states starts it once. */
  let startingModel: string | null = null;
  /** Requests waiting on the engine while it may be loading a model (see connection.ts). */
  let modelWaits = 0;
  let loadingNoticeShown = false;
  /** Settles the `newSession` call waiting on the new-session dialog. */
  let offerResolve: ((id: SessionId | null) => void) | null = null;
  /** The last session started from the dialog went into a worktree: the box starts checked. */
  let lastChoseWorktree = false;
  /** Set once the saved drafts and queues have been checked against the listed sessions. */
  let composersChecked = false;
  /** The latest `workspace.track` per session, with the directories it sent. */
  const tracking = new Map<SessionId, { key: string; promise: Promise<WorkspaceInfo | null> }>();
  /** Projects checked in this app run for code waiting for consent (the project trust dialog). */
  const trustChecked = new Set<string>();
  /** "Not now" per project: the approval hash it was said to. A changed hash asks again. */
  const trustPutOff = new Map<string, string>();

  // --- State helpers -------------------------------------------------------------------------

  function setUi(update: (ui: UiState) => UiState): void {
    const ui = get().ui;
    const next = update(ui);
    if (next !== ui) store.setState({ ui: next });
  }

  function setLayout(patch: Partial<Layout>): void {
    store.setState({ layout: { ...get().layout, ...patch } });
  }

  function notice(text: string, tone: Notice["tone"] = "error", action?: Notice["action"]): void {
    const notices = get().notices.filter((existing) => existing.text !== text);
    const next: Notice = { id: nextId("notice"), text, tone, ...(action ? { action } : {}) };
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
    const liveBatches = countLiveBatches(prev.liveBatches, inputs, before, slice, removed);
    store.setState({ ...slice, ui, liveBatches });
    for (const id of removed) void forgetWorkspace(id);
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
    followHookSkips(inputs);
    followSubagents(inputs, removed);
  }

  // --- Project trust ---------------------------------------------------------------------------

  /**
   * Hooks were held back for want of consent (`hook.skipped`, live only): the project's code may
   * have changed since it was checked, so look again.
   */
  function followHookSkips(inputs: readonly ReducerInput[]): void {
    for (const input of inputs) {
      if (input.type !== "event" || input.event.event !== "hook.skipped") continue;
      const { payload } = input.event;
      const projectDir =
        payload.projectDir ?? get().sessions[payload.sessionId]?.summary.projectDir ?? null;
      if (projectDir !== null) void inspectTrust(projectDir, true);
    }
  }

  // --- Subagents ------------------------------------------------------------------------------

  /** Agents' sessions being read now; a read asked for meanwhile runs once that one ends. */
  const childReads = new Map<SessionId, Promise<void>>();
  const childAgain = new Set<SessionId>();

  function agentOf(sessionId: SessionId, agentId: string): SubagentInfo | undefined {
    return get().sessions[sessionId]?.subagents?.find((agent) => agent.agentId === agentId);
  }

  /**
   * The agent's transcript, shown, moved on (`subagent.updated`, live or replayed): read what is
   * new in it. The parent left: the transcript closes.
   */
  function followSubagents(inputs: readonly ReducerInput[], removed: readonly SessionId[]): void {
    const open = get().ui.openSubagent;
    if (open === null) return;
    if (removed.includes(open.sessionId)) {
      setUi((ui) => ({ ...ui, openSubagent: null }));
      return;
    }
    const moved = inputs.some((input) => {
      if (input.type === "event") return isUpdateOf(input.event, open);
      if (input.type === "replay") return input.events.some((event) => isUpdateOf(event, open));
      return false;
    });
    if (moved) void readChild(open.sessionId, open.agentId);
  }

  function isUpdateOf(
    event: EngineEvent,
    open: { sessionId: SessionId; agentId: string },
  ): boolean {
    return (
      event.event === "subagent.updated" &&
      event.payload.sessionId === open.sessionId &&
      event.payload.agent.agentId === open.agentId
    );
  }

  /** The agent's session as the reducer takes it: a stored session that stands for the agent. */
  function childSummary(parent: SessionView, agent: SubagentInfo): SessionSummary {
    return {
      id: agent.sessionId,
      title: agent.description === "" ? null : agent.description,
      cwd: agent.worktree?.path ?? parent.summary.cwd,
      projectDir: parent.summary.projectDir,
      createdAt: agent.startedAt,
      lastActivityAt: agent.startedAt,
      status: "idle",
      queuePosition: null,
      mode: parent.summary.mode,
      model: parent.summary.model,
      effort: parent.summary.effort,
      archived: false,
      forkedFrom: null,
      lastSeq: 0,
    };
  }

  function putChild(childId: SessionId, entry: SubagentTranscript): void {
    const all = get().subagentTranscripts;
    if (all[childId] === entry) return;
    store.setState({ subagentTranscripts: { ...all, [childId]: entry } });
  }

  /**
   * Reads the agent's session (`session.replay`) from where the last read stopped, the whole of
   * it the first time, through the same reducer as any session. One read per agent at a time; a
   * read asked for while one runs follows it.
   */
  function readChild(sessionId: SessionId, agentId: string): Promise<void> {
    const agent = agentOf(sessionId, agentId);
    if (!agent) return Promise.resolve();
    const childId = agent.sessionId;
    const running = childReads.get(childId);
    if (running) {
      childAgain.add(childId);
      return running;
    }
    const read = (async () => {
      do {
        childAgain.delete(childId);
        await readChildOnce(sessionId, agentId);
      } while (childAgain.has(childId) && !stopped);
    })().finally(() => childReads.delete(childId));
    childReads.set(childId, read);
    return read;
  }

  async function readChildOnce(sessionId: SessionId, agentId: string): Promise<void> {
    const parent = get().sessions[sessionId];
    const agent = agentOf(sessionId, agentId);
    if (!parent || !agent) return;
    const childId = agent.sessionId;
    const first: SubagentTranscript = get().subagentTranscripts[childId] ?? {
      parentSessionId: sessionId,
      agentId,
      slice: reduceAll(emptyEngineSlice(), [
        { type: "summaries", sessions: [childSummary(parent, agent)] },
      ]),
      error: null,
    };
    putChild(childId, first);
    let afterSeq = first.slice.sessions[childId]?.highWaterSeq ?? 0;
    try {
      for (;;) {
        const page = await connection.request("session.replay", {
          sessionId: childId,
          afterSeq,
          limit: CHILD_PAGE,
        });
        const last = page.events.at(-1);
        const done = !page.hasMore || last === undefined;
        const current = get().subagentTranscripts[childId] ?? first;
        const slice = reduceAll(current.slice, [
          { type: "replay", sessionId: childId, events: page.events, done },
        ]);
        if (slice !== current.slice || current.error !== null) {
          putChild(childId, { ...current, slice, error: null });
        }
        if (done) return;
        afterSeq = last.payload.seq;
      }
    } catch (error) {
      const current = get().subagentTranscripts[childId] ?? first;
      putChild(childId, {
        ...current,
        error: `Could not read the agent's transcript: ${errorText(error)}.`,
      });
    }
  }

  function setTrustReview(next: TrustReview | null): void {
    if (get().trustReview !== next) store.setState({ trustReview: next });
  }

  function projectNameOf(projectDir: string): string {
    return get().projects[projectDir]?.name ?? basename(projectDir);
  }

  /**
   * Asks the engine what in a project needs the person's consent (`project.inspect`). On its own
   * (`auto`: a session's project shown for the first time, or hooks held back) the dialog opens
   * only when something waits that the person has not put off, and a failure stays quiet: an
   * engine without the method has nothing to ask. Asked for, the dialog opens at once and says
   * what it found.
   */
  async function inspectTrust(projectDir: string, auto: boolean): Promise<void> {
    if (auto && get().trustReview !== null) return;
    if (!auto) {
      setTrustReview({
        projectDir,
        projectName: projectNameOf(projectDir),
        phase: "loading",
        approval: null,
        message: null,
      });
    }
    let approval: TrustReview["approval"];
    try {
      approval = (await connection.request("project.inspect", { projectDir })).approval;
    } catch (error) {
      const current = get().trustReview;
      if (!auto && current?.projectDir === projectDir) {
        setTrustReview({
          ...current,
          phase: "ready",
          message: `Could not read the project’s setup: ${errorText(error)}.`,
        });
      }
      return;
    }
    if (auto) {
      if (approval === null || approval.approved) return;
      if (trustPutOff.get(projectDir) === approval.hash || get().trustReview !== null) return;
      setTrustReview({
        projectDir,
        projectName: projectNameOf(projectDir),
        phase: "ready",
        approval,
        message: null,
      });
      return;
    }
    const current = get().trustReview;
    // Closed, or another project's review took its place, while the answer was on its way.
    if (current?.projectDir !== projectDir || current.phase !== "loading") return;
    setTrustReview({ ...current, phase: "ready", approval, message: null });
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
    onModelWaits(count) {
      modelWaits = count;
      followModelLoading();
    },
    ...(deps.scheduleFrame ? { scheduleFrame: deps.scheduleFrame } : {}),
  });

  /** After each (re)connect: fix the selection, then open what needs to be live. */
  async function onSynced(info: SyncInfo): Promise<void> {
    if (!composersChecked) {
      // Unsent words were saved for sessions that may have gone since (deleted, archived).
      composersChecked = true;
      const known = new Set(Object.keys(get().sessions));
      setUi((ui) => forgetComposersExcept(ui, known));
    }
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

  // --- Workspaces, worktrees and terminals -------------------------------------------------------

  /**
   * Registers a session's directories with main (see `trackSession`). `input` is for a session
   * the store does not hold yet (one just created).
   */
  function track(sessionId: SessionId, input?: TrackSessionInput): Promise<WorkspaceInfo | null> {
    const session = get().sessions[sessionId];
    const memory = get().ui.memoryShown[sessionId] === true;
    const request = input ?? (session ? trackInputOf(session, memory) : null);
    if (request === null) return Promise.resolve(null);
    const key = trackKeyOf(request);
    const current = tracking.get(sessionId);
    if (current?.key === key) return current.promise;
    const promise: Promise<WorkspaceInfo | null> = Promise.resolve()
      .then(() => bridge.workspace.track(request))
      .then(
        (info) => {
          if (tracking.get(sessionId)?.promise === promise) {
            store.setState({ workspaces: { ...get().workspaces, [sessionId]: info } });
          }
          return info;
        },
        () => {
          // Main could not track it (a folder that is gone): the panes say so when asked.
          if (tracking.get(sessionId)?.promise === promise) tracking.delete(sessionId);
          return null;
        },
      );
    tracking.set(sessionId, { key, promise });
    return promise;
  }

  /** The session is gone from this window: main stops watching its files. */
  async function forgetWorkspace(sessionId: SessionId): Promise<void> {
    const known = tracking.delete(sessionId);
    const workspaces = withoutKey(get().workspaces, sessionId);
    if (workspaces !== get().workspaces) store.setState({ workspaces });
    if (!known) return;
    try {
      await bridge.workspace.untrack(sessionId);
    } catch {
      // Nothing to undo: main forgets sessions with the window anyway.
    }
  }

  /** Ends the session's terminals: they live only while the session is open. */
  async function closeTerminals(sessionId: SessionId): Promise<void> {
    try {
      const open = await bridge.terminal.list(sessionId);
      await Promise.all(
        open.map((terminal) => bridge.terminal.close(terminal.terminalId).catch(() => {})),
      );
    } catch {
      // No terminals, or main has already closed them.
    }
  }

  /** The worktree a session runs in, if it does. */
  function worktreePathOf(sessionId: SessionId): string | null {
    const worktree = get().workspaces[sessionId]?.git?.worktree;
    if (worktree) return worktree.path;
    const summary = get().sessions[sessionId]?.summary;
    return summary && summary.cwd !== summary.projectDir ? summary.cwd : null;
  }

  /** Removes a finished session's worktree if it is clean and merged, saying what happened. */
  async function cleanUpWorktree(worktreePath: string): Promise<void> {
    try {
      const outcome = await bridge.worktrees.cleanup(worktreePath);
      notice(
        outcome.removed
          ? "Removed the worktree."
          : `Kept the worktree: ${outcome.reason ?? "it could not be removed."}`,
        "neutral",
      );
    } catch (error) {
      notice(`Could not clean up the worktree: ${errorText(error)}.`);
    }
  }

  async function branchesOf(projectDir: string): Promise<BranchList | null> {
    try {
      return await bridge.worktrees.branches(projectDir);
    } catch {
      // Without an answer the session starts in the folder, as for any other folder.
      return null;
    }
  }

  function patchOffer(patch: Partial<NewSessionOffer>): void {
    const offer = get().newSessionOffer;
    if (offer) store.setState({ newSessionOffer: { ...offer, ...patch } });
  }

  /**
   * Opens the new-session dialog; settles once the person has answered it. `start` overrides
   * where it starts: "Run in a worktree" checked, the name, and an error to show.
   */
  function offerNewSession(
    projectDir: string,
    list: BranchList,
    start: Partial<Pick<NewSessionOffer, "worktree" | "suggestedName" | "error">> = {},
  ): Promise<SessionId | null> {
    // A dialog already open gives way to the new one.
    offerResolve?.(null);
    const branches = orderBranches(list.current, list.branches);
    const offer: NewSessionOffer = {
      projectDir,
      projectName: get().projects[projectDir]?.name ?? basename(projectDir),
      branches,
      current: list.current,
      suggestedName: start.suggestedName ?? suggestWorktreeName(branches),
      worktree: start.worktree ?? lastChoseWorktree,
      busy: false,
      error: start.error ?? null,
    };
    store.setState({ newSessionOffer: offer });
    return new Promise((resolve) => {
      offerResolve = resolve;
    });
  }

  /** Closes the dialog and hands its answer to the waiting `newSession`. */
  function settleOffer(id: SessionId | null): void {
    const resolve = offerResolve;
    offerResolve = null;
    if (get().newSessionOffer !== null) store.setState({ newSessionOffer: null });
    resolve?.(id);
  }

  /**
   * A new session where no choice was given: Settings → General → New sessions decides for a git
   * project, unless `ask` opens the dialog anyway. Other folders start in the folder.
   */
  async function startAsPreferred(
    projectDir: string,
    ask: boolean | "worktree",
  ): Promise<SessionId | null> {
    const preference = ask === false ? get().settings.newSessionWorktree : "ask";
    // Whether it is a repository does not matter: the folder it is.
    if (preference === "folder") return createSession(projectDir, null);
    const list = await branchesOf(projectDir);
    if (!list?.isRepo) {
      if (ask === "worktree") {
        notice(
          `“${basename(projectDir)}” is not a git repository, so the session runs in the folder.`,
          "neutral",
        );
      }
      return createSession(projectDir, null);
    }
    if (preference === "ask") {
      return offerNewSession(projectDir, list, ask === "worktree" ? { worktree: true } : {});
    }
    // "worktree": what the dialog would suggest, from the current branch, without asking.
    const suggestedName = suggestWorktreeName(orderBranches(list.current, list.branches));
    if (list.current === null) {
      return offerNewSession(projectDir, list, {
        worktree: true,
        suggestedName,
        error: "The project has no current branch. Choose one to start from.",
      });
    }
    let made: WorktreeInfo;
    try {
      made = await bridge.worktrees.create({ projectDir, name: suggestedName, base: list.current });
    } catch (error) {
      // The dialog says why, so another name or base can be tried.
      return offerNewSession(projectDir, list, {
        worktree: true,
        suggestedName,
        error: sentence(error),
      });
    }
    return createSession(projectDir, made);
  }

  /**
   * `session.create` in the project folder, or in a worktree made for it. The session is
   * tracked at once, so the commit its changes are compared with is where it started.
   */
  async function createSession(
    projectDir: string,
    worktree: WorktreeInfo | null,
  ): Promise<SessionId | null> {
    const cwd = worktree?.path ?? projectDir;
    // Sessions store the model they use, so it is always one the picker knows.
    const model = get().modelsState?.defaultModelId ?? null;
    const snapshot = await request("Could not start a session", () =>
      connection.request("session.create", {
        cwd,
        ...(worktree ? { projectDir } : {}),
        ...(model === null ? {} : { model }),
      }),
    );
    if (!snapshot) {
      // The worktree was made for this session only.
      if (worktree) void bridge.worktrees.cleanup(worktree.path).catch(() => {});
      return null;
    }
    void track(
      snapshot.session.id,
      trackInputOf({
        id: snapshot.session.id,
        summary: snapshot.session,
        additionalDirectories: snapshot.additionalDirectories,
      }),
    );
    await adoptAndSelect(snapshot);
    return snapshot.session.id;
  }

  // --- Sending ---------------------------------------------------------------------------------

  /**
   * Sends a message as a new turn: a known "/command", or a prompt with its images and mentioned
   * files. Returns the turn id, if any.
   */
  async function send(
    sessionId: SessionId,
    message: Pick<QueuedMessage, "text" | "images" | "mentions">,
  ): Promise<string | null> {
    const { text } = message;
    const session = get().sessions[sessionId];
    const command = queue.parseCommand(text, commandsOf(sessionId, session?.commands ?? []));
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
    // Images first, then the words about them.
    const content: ContentPart[] = (message.images ?? []).map((image) => ({
      type: "image",
      mediaType: image.mediaType,
      data: image.data,
    }));
    if (text !== "") content.push({ type: "text", text });
    const result = await connection.request("session.prompt", {
      sessionId,
      prompt: { content, mentions: message.mentions ?? [] },
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
      const turnId = await send(sessionId, message);
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

  /** Clears the draft (and the paths its `@` menu inserted) unless it changed since sending. */
  function clearDraftIf(sessionId: SessionId, text: string): void {
    setUi((ui) =>
      ui.drafts[sessionId] === text
        ? {
            ...ui,
            drafts: withoutKey(ui.drafts, sessionId),
            mentionPaths: withoutKey(ui.mentionPaths, sessionId),
            draftImagesNotKept: withoutKey(ui.draftImagesNotKept, sessionId),
          }
        : ui,
    );
  }

  /** Detaches images that went with a message, keeping any attached since. */
  function detachSent(sessionId: SessionId, sent: readonly ImageAttachment[]): void {
    if (sent.length === 0) return;
    const ids = new Set(sent.map((image) => image.id));
    setUi((ui) => {
      const current = ui.attachments[sessionId];
      if (!current) return ui;
      const kept = current.filter((image) => !ids.has(image.id));
      const attachments =
        kept.length === 0
          ? withoutKey(ui.attachments, sessionId)
          : { ...ui.attachments, [sessionId]: kept };
      return { ...ui, attachments };
    });
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

  /**
   * Prompts of a session's MCP servers, as the composer last saw them (`mcp.session`): servers
   * connect after the snapshot's commands were listed, so their `/mcp__server__prompt` commands
   * are known from here.
   */
  const mcpPrompts = new Map<SessionId, readonly CommandInfo[]>();
  function commandsOf(sessionId: SessionId, listed: readonly CommandInfo[]): CommandInfo[] {
    const extra = mcpPrompts.get(sessionId) ?? [];
    return extra.length === 0 ? [...listed] : [...listed, ...extra];
  }

  async function request<T>(failure: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      notice(`${failure}: ${errorText(error)}.`);
      return null;
    }
  }

  /** Runs a bridge call; a failure becomes a notice. True when it succeeded. */
  async function attempt(failure: string, run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      notice(`${failure}: ${errorText(error)}.`);
      return false;
    }
  }

  // --- Models and first run ------------------------------------------------------------------

  function setOnboarding(onboarding: OnboardingState | null): void {
    if (!shallowEqual(get().onboarding, onboarding)) store.setState({ onboarding });
  }

  function nameOf(modelId: string): string {
    return modelName(get().modelsState, modelId);
  }

  /** Takes a models state from main, keeping unchanged parts identical for the selectors. */
  function applyModelsState(next: ModelsState): void {
    const prev = get();
    const models = sameOptions(prev.models, next.installed) ? prev.models : next.installed;
    const modelStatus =
      prev.modelStatus && shallowEqual(prev.modelStatus, next.status)
        ? prev.modelStatus
        : next.status;
    store.setState({ modelsState: next, models, modelStatus });
    followModelLoading();
    const first = !modelsSeen;
    modelsSeen = true;
    if (get().onboarding === null) {
      // At launch a missing default also starts first run; later only an empty list does.
      if (first ? needsSetup(next) : next.installed.length === 0) {
        setOnboarding(firstRunStep(next));
      }
    }
    followDownload(next);
  }

  function applyModelStatus(status: ModelStatus): void {
    const { modelStatus, modelsState } = get();
    if (modelStatus && shallowEqual(modelStatus, status)) return;
    store.setState({
      modelStatus: status,
      modelsState: modelsState ? { ...modelsState, status } : modelsState,
    });
    followModelLoading();
  }

  /**
   * While a request waits on the engine and the runtime is loading a model, say so: a large
   * model takes minutes, and the session carries on once it is in.
   */
  function followModelLoading(): void {
    const status = get().modelStatus;
    const loading = modelWaits > 0 && status?.state === "loading";
    if (loading === loadingNoticeShown) return;
    loadingNoticeShown = loading;
    const others = get().notices.filter((existing) => existing.id !== MODEL_LOADING_NOTICE_ID);
    if (!loading) {
      if (others.length !== get().notices.length) store.setState({ notices: others });
      return;
    }
    const loadingNotice: Notice = {
      id: MODEL_LOADING_NOTICE_ID,
      text: `Loading ${status?.label ?? "the model"} into memory. This can take a few minutes.`,
      tone: "neutral",
    };
    store.setState({ notices: [...others, loadingNotice].slice(-MAX_NOTICES) });
  }

  /** First run's download step: on to starting once the model is in, back when cancelled. */
  function followDownload(state: ModelsState): void {
    const onboarding = get().onboarding;
    if (onboarding?.step !== "download") return;
    const { modelId } = onboarding;
    const download = findDownload(state, modelId);
    if (findInstalled(state, modelId) || download?.phase === "done") {
      if (download) void bridge.models.dismissDownload(modelId).catch(() => {});
      void startFirstModel(modelId);
    } else if (download?.phase === "cancelled") {
      setOnboarding({ step: "welcome" });
    } else if (download?.phase === "failed" && onboarding.error !== download.error) {
      setOnboarding({ step: "download", modelId, error: download.error });
    }
  }

  /** First run's last step: load the model, make it the default, then the sessions view. */
  async function startFirstModel(modelId: string): Promise<void> {
    if (startingModel === modelId) return;
    startingModel = modelId;
    setOnboarding({ step: "start", modelId, error: null });
    const stillStarting = () => {
      const onboarding = get().onboarding;
      return onboarding?.step === "start" && onboarding.modelId === modelId;
    };
    try {
      await bridge.models.start(modelId);
      await bridge.models.setDefault(modelId);
      if (stillStarting()) setOnboarding(null);
    } catch (error) {
      if (stillStarting()) setOnboarding({ step: "start", modelId, error: sentence(error) });
    } finally {
      if (startingModel === modelId) startingModel = null;
    }
  }

  async function loadModels(): Promise<void> {
    try {
      const state = await bridge.models.state();
      if (!stopped && !modelsSeen) applyModelsState(state);
      return;
    } catch {
      // An older main without the models state: the picker and the footer still work.
    }
    const [models, modelStatus] = await Promise.allSettled([
      bridge.models.list(),
      bridge.models.status(),
    ]);
    if (stopped) return;
    if (models.status === "fulfilled") store.setState({ models: models.value });
    if (modelStatus.status === "fulfilled" && get().modelStatus === null) {
      store.setState({ modelStatus: modelStatus.value });
    }
  }

  // --- Startup -------------------------------------------------------------------------------

  async function startUp(): Promise<void> {
    unsubscribe.push(bridge.settings.onChange((settings) => store.setState({ settings })));
    unsubscribe.push(bridge.models.onState((state) => applyModelsState(state)));
    unsubscribe.push(bridge.models.onStatus((status) => applyModelStatus(status)));
    const [settings, windowState] = await Promise.allSettled([
      bridge.settings.get(),
      bridge.windowState.load(),
      loadModels(),
    ]);
    if (stopped) return;
    if (settings.status === "fulfilled") store.setState({ settings: settings.value });
    if (windowState.status === "fulfilled") {
      store.setState(applyWindowState(get(), windowState.value));
    } else {
      notice(`Could not restore the window layout: ${errorText(windowState.reason)}.`);
    }

    // Save layout and seen marks from here on.
    const saver = createWindowStateSaver(bridge, (error) =>
      notice(`Could not save the window layout: ${errorText(error)}.`),
    );
    unsubscribe.push(
      store.subscribe((state, prev) => {
        const { ui } = state;
        if (
          state.layout !== prev.layout ||
          ui.seenSeq !== prev.ui.seenSeq ||
          // What the person typed and has not sent (see window-state.ts).
          ui.drafts !== prev.ui.drafts ||
          ui.queues !== prev.ui.queues ||
          ui.mentionPaths !== prev.ui.mentionPaths ||
          ui.attachments !== prev.ui.attachments ||
          ui.draftImagesNotKept !== prev.ui.draftImagesNotKept
        ) {
          saver.schedule(windowStateOf(state));
        }
      }),
    );
    unsubscribe.push(() => saver.flush());
    // The first time a project with a Claude Code setup is shown, say what dawg found there.
    unsubscribe.push(
      watchProjectSetup({
        store,
        inspect: (projectDir) => actions.inspectProject(projectDir),
        show: (text, action) => notice(text, "neutral", action),
        remember: (projectSetupNoticed) => updateSettings({ projectSetupNoticed }),
      }),
    );
    // The window is going (quit, or closed): the last keystrokes are saved now, not after the delay.
    const flushOnHide = () => saver.flush();
    globalThis.addEventListener?.("pagehide", flushOnHide);
    unsubscribe.push(() => globalThis.removeEventListener?.("pagehide", flushOnHide));

    // The first time the window shows a session of a project, it asks whether the project has
    // code waiting for consent (hooks, later MCP servers); the trust dialog opens if so.
    unsubscribe.push(
      store.subscribe((state) => {
        if (state.connection.phase !== "ready") return;
        const id = state.layout.selectedSessionId;
        const projectDir = id === null ? null : (state.sessions[id]?.summary.projectDir ?? null);
        if (projectDir === null || trustChecked.has(projectDir)) return;
        trustChecked.add(projectDir);
        void inspectTrust(projectDir, true);
      }),
    );

    // The session the window shows is tracked, and tracked again when its directories change.
    let shownKey = "";
    unsubscribe.push(
      store.subscribe((state) => {
        const id = state.layout.selectedSessionId;
        const session = id === null ? undefined : state.sessions[id];
        const key =
          session && !session.summary.archived
            ? `${session.id}\n${trackKeyOf(trackInputOf(session, state.ui.memoryShown[session.id] === true))}`
            : "";
        if (key === shownKey) return;
        shownKey = key;
        if (session && key !== "") void track(session.id);
      }),
    );

    await connection.start();
  }

  /**
   * Selects a session (or nothing): marks it seen, and resumes and replays it if needed. With
   * `toSessions`, Settings gives way to the session view.
   */
  function show(id: SessionId | null, toSessions: boolean): void {
    const layout = get().layout;
    // An agent's transcript belongs to its session: showing another one closes it.
    if (get().ui.openSubagent !== null && get().ui.openSubagent?.sessionId !== id) {
      setUi((ui) => ({ ...ui, openSubagent: null }));
    }
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
      settleOffer(null);
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
    setNotifications: (notifications) => updateSettings({ notifications }),
    setDockBadge: (dockBadge) => updateSettings({ dockBadge }),
    setNewSessionWorktree: (newSessionWorktree) => updateSettings({ newSessionWorktree }),
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
      const projectDir = dir;
      const choice = options?.worktree;
      if (choice === undefined) return startAsPreferred(projectDir, options?.ask ?? false);
      if (choice === false) return createSession(projectDir, null);
      const made = await request("Could not make the worktree", () =>
        bridge.worktrees.create({ projectDir, name: choice.name, base: choice.base }),
      );
      return made ? createSession(projectDir, made) : null;
    },
    async answerNewSessionOffer(answer) {
      const offer = get().newSessionOffer;
      if (!offer || offer.busy) return;
      if (answer === null) {
        settleOffer(null);
        return;
      }
      lastChoseWorktree = answer.worktree !== null;
      let made: WorktreeInfo | null = null;
      if (answer.worktree !== null) {
        patchOffer({ busy: true, error: null });
        try {
          made = await bridge.worktrees.create({
            projectDir: offer.projectDir,
            name: answer.worktree.name,
            base: answer.worktree.base,
          });
        } catch (error) {
          // The dialog stays open, so another name or base can be tried.
          patchOffer({ busy: false, error: sentence(error) });
          return;
        }
      }
      const resolve = offerResolve;
      offerResolve = null;
      store.setState({ newSessionOffer: null });
      const id = await createSession(offer.projectDir, made);
      resolve?.(id);
    },
    trackSession: (id) => track(id),
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
      const worktree = worktreePathOf(id);
      const result = await request(
        archived ? "Could not archive the session" : "Could not unarchive the session",
        () => connection.request("session.archive", { sessionId: id, archived }),
      );
      if (!result) return;
      applyResult([{ type: "summaries", sessions: [result.session] }]);
      if (!archived) return;
      await closeTerminals(id);
      await forgetWorkspace(id);
      if (worktree !== null) await cleanUpWorktree(worktree);
    },
    async deleteSession(id) {
      const worktree = worktreePathOf(id);
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
      await closeTerminals(id);
      await forgetWorkspace(id);
      if (worktree !== null) await cleanUpWorktree(worktree);
    },
    markUnread(id) {
      setUi((ui) =>
        ui.markedUnread[id] ? ui : { ...ui, markedUnread: { ...ui.markedUnread, [id]: true } },
      );
    },
    reviewProjectCode(projectDir) {
      trustChecked.add(projectDir);
      void inspectTrust(projectDir, false);
    },
    async answerTrustReview(approve) {
      const review = get().trustReview;
      if (!review || review.phase === "saving") return;
      const approval = review.approval;
      if (!approve || approval === null || approval.approved || review.phase !== "ready") {
        // "Not now": asked again on the next launch, or once the definitions change.
        if (!approve && approval !== null && !approval.approved) {
          trustPutOff.set(review.projectDir, approval.hash);
        }
        setTrustReview(null);
        return;
      }
      const { projectDir } = review;
      setTrustReview({ ...review, phase: "saving", message: null });
      try {
        await connection.request("project.trust", {
          projectDir,
          hash: approval.hash,
          approved: true,
        });
        trustPutOff.delete(projectDir);
        if (get().trustReview?.projectDir === projectDir) setTrustReview(null);
        notice(`Approved. The code ${review.projectName} supplies may run from now on.`, "neutral");
      } catch (error) {
        // The definitions changed after the list was shown (the engine refuses a stale hash):
        // show what is there now, and say so. Consent never covers code nobody saw.
        const changed = error instanceof RpcError && error.code === ErrorCodes.InvalidState;
        let next: TrustReview["approval"] = approval;
        try {
          next = (await connection.request("project.inspect", { projectDir })).approval;
        } catch {
          // Keep the list shown; the sentence says approving failed.
        }
        const current = get().trustReview;
        if (current?.projectDir !== projectDir) return;
        setTrustReview({
          ...current,
          phase: "ready",
          approval: next,
          message: changed
            ? "The project’s code changed since this list was shown. This is what it holds now."
            : `Could not approve it: ${errorText(error)}.`,
        });
      }
    },
    async listHooks(projectDir) {
      try {
        return await connection.request("hooks.list", { projectDir });
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async listSkills(projectDir) {
      try {
        return await connection.request("project.skills", { projectDir });
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async listMcpServers(projectDir) {
      try {
        return await connection.request("mcp.list", { projectDir });
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async restartMcpServer(projectDir, name) {
      const result = await request(`Could not restart ${name}`, () =>
        connection.request("mcp.restart", { projectDir, name }),
      );
      return result?.server ?? null;
    },
    async setMcpServerEnabled(projectDir, name, enabled) {
      const result = await request(
        enabled ? `Could not turn ${name} on` : `Could not turn ${name} off`,
        () => connection.request("mcp.setEnabled", { projectDir, name, enabled }),
      );
      return result !== null;
    },
    async previewMcpImport() {
      try {
        return await connection.request("mcp.importPreview", {});
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async importMcpServers(hash) {
      try {
        return await connection.request("mcp.import", { hash });
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async mcpOffer(sessionId) {
      const session = get().sessions[sessionId];
      if (session === undefined || !session.open) return { resources: [], prompts: [] };
      try {
        const offer = await connection.request("mcp.session", { sessionId });
        mcpPrompts.set(sessionId, offer.prompts);
        return offer;
      } catch {
        return { resources: [], prompts: [] };
      }
    },
    async setHookEnabled(projectDir, id, enabled) {
      const result = await request(
        enabled ? "Could not turn the hook on" : "Could not turn the hook off",
        () => connection.request("hooks.setEnabled", { projectDir, id, enabled }),
      );
      return result !== null;
    },

    setDraft(sessionId, text) {
      setUi((ui) => {
        if ((ui.drafts[sessionId] ?? "") === text) return ui;
        if (text === "") {
          // An emptied draft no longer needs the line about images that were not kept.
          return {
            ...ui,
            drafts: withoutKey(ui.drafts, sessionId),
            draftImagesNotKept: withoutKey(ui.draftImagesNotKept, sessionId),
          };
        }
        return { ...ui, drafts: { ...ui.drafts, [sessionId]: text } };
      });
    },
    async submit(sessionId, text, mentions = []) {
      const trimmed = text.trim();
      const session = get().sessions[sessionId];
      const hasImages = (get().ui.attachments[sessionId]?.length ?? 0) > 0;
      if ((trimmed === "" && !hasImages) || !session) return;
      try {
        // A stored session must be open before the engine takes a prompt (and its commands known).
        if (!session.open || !session.loaded) await connection.openSession(sessionId);
        // A card takes words; attached images wait for the next message.
        if (trimmed !== "" && (await answerWithText(sessionId, trimmed))) {
          clearDraftIf(sessionId, text);
          return;
        }
        // A command takes neither images nor mentions: they stay for the next message.
        const commands = commandsOf(sessionId, get().sessions[sessionId]?.commands ?? []);
        const parsed = queue.parseCommand(trimmed, commands);
        // `/rewind` and `/memory` open the window's own views (the engine's commands only list).
        if (parsed !== null && parsed.args.trim() === "" && parsed.name === "rewind") {
          clearDraftIf(sessionId, text);
          await actions.openRewind(sessionId);
          return;
        }
        if (parsed !== null && parsed.args.trim() === "" && parsed.name === "memory") {
          clearDraftIf(sessionId, text);
          await actions.openMemory(sessionId);
          return;
        }
        const isCommand = parsed !== null;
        const images = isCommand ? [] : (get().ui.attachments[sessionId] ?? []);
        const message = {
          text: trimmed,
          ...(images.length > 0 ? { images } : {}),
          ...(!isCommand && mentions.length > 0 ? { mentions } : {}),
        };
        if (message.text === "" && images.length === 0) return;
        if (isRunning(sessionId)) {
          setUi((ui) => ({
            ...ui,
            queues: queue.enqueue(ui.queues, sessionId, {
              id: nextId("queued"),
              state: "queued",
              ...message,
            }),
          }));
          clearDraftIf(sessionId, text);
          detachSent(sessionId, images);
          return;
        }
        await send(sessionId, message);
        clearDraftIf(sessionId, text);
        detachSent(sessionId, images);
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
        const turnId = await send(sessionId, message);
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
    addAttachments(sessionId, images) {
      if (images.length === 0) return;
      setUi((ui) => ({
        ...ui,
        attachments: {
          ...ui.attachments,
          [sessionId]: [...(ui.attachments[sessionId] ?? []), ...images],
        },
      }));
    },
    removeAttachment(sessionId, imageId) {
      const image = get().ui.attachments[sessionId]?.find((candidate) => candidate.id === imageId);
      if (image) detachSent(sessionId, [image]);
    },
    rememberMention(sessionId, relativePath) {
      setUi((ui) => {
        const known = ui.mentionPaths[sessionId] ?? [];
        if (known.includes(relativePath)) return ui;
        return {
          ...ui,
          mentionPaths: { ...ui.mentionPaths, [sessionId]: [...known, relativePath] },
        };
      });
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

    async downloadModel(modelId) {
      await attempt(`Could not download ${nameOf(modelId)}`, () => bridge.models.download(modelId));
    },
    async pauseDownload(modelId) {
      await attempt("Could not pause the download", () => bridge.models.pauseDownload(modelId));
    },
    async cancelDownload(modelId) {
      const cancelled = await attempt("Could not cancel the download", () =>
        bridge.models.cancelDownload(modelId),
      );
      if (!cancelled) return;
      const onboarding = get().onboarding;
      if (onboarding?.step === "download" && onboarding.modelId === modelId) {
        setOnboarding({ step: "welcome" });
      }
      await bridge.models.dismissDownload(modelId).catch(() => {});
    },
    async dismissDownload(modelId) {
      await attempt("Could not clear the download", () => bridge.models.dismissDownload(modelId));
    },
    async adoptExistingModel(modelId) {
      await attempt(`Could not use the copy of ${nameOf(modelId)}`, () =>
        bridge.models.useExisting(modelId),
      );
    },
    async removeModel(modelId) {
      await attempt(`Could not delete ${nameOf(modelId)}`, () => bridge.models.remove(modelId));
    },
    async startModel(modelId) {
      await attempt(`Could not start ${nameOf(modelId)}`, () => bridge.models.start(modelId));
    },
    async stopModel() {
      await attempt("Could not stop the model", () => bridge.models.stop());
    },
    async setDefaultModel(modelId) {
      await attempt("Could not change the default model", () => bridge.models.setDefault(modelId));
    },
    async setIdleUnload(minutes) {
      await attempt("Could not save the setting", () => bridge.models.setIdleUnload(minutes));
    },
    async setHelperEnabled(enabled) {
      await attempt("Could not save the setting", () => bridge.models.setHelperEnabled(enabled));
    },
    async addModelFile() {
      return request("Could not add the model file", () => bridge.models.addModelFile());
    },
    async connectServer(input) {
      try {
        return { server: await bridge.models.connectServer(input) };
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async removeServer(serverId) {
      await attempt("Could not remove the server", () => bridge.models.removeServer(serverId));
    },
    async refreshServers() {
      await attempt("Could not look for servers", () => bridge.models.refreshServers());
    },
    async openExternal(url) {
      await attempt("Could not open the link", () => bridge.shell.openExternal(url));
    },

    async setUpModel(modelId, options) {
      const state = get().modelsState;
      if (state === null) return;
      // The helper comes in the same click, queued after the model so the model is in first;
      // the first model starts without waiting for it, and main starts the helper once it is in.
      const helper = options?.withHelper ? helperToSetUp(state) : null;
      const queueHelper = async () => {
        if (!helper) return;
        await attempt(`Could not download ${helper.displayName}`, () =>
          bridge.models.download(helper.id),
        );
      };
      if (options?.useExisting) {
        setOnboarding({ step: "start", modelId, error: null });
        try {
          // biome-ignore lint/correctness/useHookAtTopLevel: a bridge call named like a hook
          await bridge.models.useExisting(modelId);
        } catch (error) {
          setOnboarding({ step: "start", modelId, error: sentence(error) });
          return;
        }
        await queueHelper();
        await startFirstModel(modelId);
        return;
      }
      if (findInstalled(state, modelId)) {
        await queueHelper();
        await startFirstModel(modelId);
        return;
      }
      setOnboarding({ step: "download", modelId, error: null });
      try {
        await bridge.models.download(modelId);
      } catch (error) {
        const onboarding = get().onboarding;
        if (onboarding?.step === "download" && onboarding.modelId === modelId) {
          setOnboarding({ step: "download", modelId, error: sentence(error) });
        }
        return;
      }
      await queueHelper();
      // It may be in already (a finished download, or a state that arrived first).
      const latest = get().modelsState;
      if (latest) followDownload(latest);
    },
    showWelcome() {
      setOnboarding({ step: "welcome" });
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

    async inspectProject(projectDir) {
      try {
        return await connection.request("project.inspect", { projectDir });
      } catch (error) {
        return { error: sentence(error) };
      }
    },

    async readBackgroundOutput(sessionId, taskId, offset) {
      try {
        return await connection.request("background.output", { sessionId, taskId, offset });
      } catch (error) {
        return { error: sentence(error) };
      }
    },
    async stopBackground(sessionId, taskId) {
      const result = await request("Could not stop the command", () =>
        connection.request("background.stop", { sessionId, taskId }),
      );
      return result !== null;
    },

    openSubagent(sessionId, agentId) {
      if (get().layout.selectedSessionId !== sessionId || get().layout.view !== "sessions") {
        show(sessionId, true);
      }
      setUi((ui) => {
        const open = ui.openSubagent;
        if (open?.sessionId === sessionId && open.agentId === agentId) return ui;
        return { ...ui, openSubagent: { sessionId, agentId } };
      });
      void readChild(sessionId, agentId);
    },
    closeSubagent() {
      setUi((ui) => (ui.openSubagent === null ? ui : { ...ui, openSubagent: null }));
    },
    async stopSubagent(sessionId, agentId) {
      const result = await request("Could not stop the agent", () =>
        connection.request("subagent.stop", { sessionId, agentId }),
      );
      return result !== null;
    },

    async openRewind(sessionId) {
      const session = get().sessions[sessionId];
      if (!session) return;
      if (isRunning(sessionId) || session.status === "waiting") {
        notice("Rewinding has to wait until the current turn ends.", "neutral");
        return;
      }
      const dialog: RewindDialog = {
        sessionId,
        phase: "loading",
        checkpoints: [],
        retention: 0,
        error: null,
        conflict: null,
      };
      store.setState({ rewind: dialog });
      const current = () => get().rewind?.sessionId === sessionId;
      try {
        if (!session.open || !session.loaded) await connection.openSession(sessionId);
        const listed = await connection.request("session.checkpoints", { sessionId });
        if (!current()) return;
        store.setState({
          rewind: {
            ...dialog,
            phase: "ready",
            checkpoints: [...listed.checkpoints].reverse(),
            retention: listed.retention,
          },
        });
      } catch (error) {
        if (!current()) return;
        store.setState({ rewind: { ...dialog, phase: "failed", error: sentence(error) } });
      }
    },
    closeRewind() {
      if (get().rewind?.phase === "working") return;
      store.setState({ rewind: null });
    },
    dismissRewindConflict() {
      const dialog = get().rewind;
      if (dialog?.phase !== "conflicts") return;
      store.setState({ rewind: { ...dialog, phase: "ready", conflict: null } });
    },
    async rewind(checkpointId, action, options = {}) {
      const dialog = get().rewind;
      if (dialog === null || dialog.phase === "working") return;
      const { sessionId } = dialog;
      const instructions = options.instructions?.trim() ?? "";
      store.setState({ rewind: { ...dialog, phase: "working", error: null } });
      let result: MethodResult<"session.rewind">;
      try {
        result = await connection.request("session.rewind", {
          sessionId,
          checkpointId,
          action,
          ...(options.overwrite ? { overwrite: true } : {}),
          ...(instructions === "" ? {} : { instructions }),
        });
      } catch (error) {
        const open = get().rewind;
        if (open?.sessionId === sessionId) {
          store.setState({ rewind: { ...open, phase: "ready", error: sentence(error) } });
        }
        return;
      }
      if (result.outcome === "conflicts") {
        const open = get().rewind;
        if (open?.sessionId !== sessionId) return;
        store.setState({
          rewind: {
            ...open,
            phase: "conflicts",
            conflict: {
              checkpointId,
              action,
              instructions: instructions === "" ? null : instructions,
              files: result.conflicts,
            },
          },
        });
        return;
      }
      store.setState({ rewind: null });
      const files = result.files;
      if (files !== null && files.skipped.length > 0) {
        notice(
          `Some files were left as they are: ${files.skipped
            .map((skip) => `${basename(skip.path)} (${skip.reason})`)
            .join(", ")}.`,
          "neutral",
        );
      }
      if (result.session !== null) {
        // The conversation goes on in the fork; the original stays in the sidebar as it was.
        const fork = result.session;
        await adoptAndSelect(fork);
        if (result.prompt !== null) actions.setDraft(fork.session.id, result.prompt);
        return;
      }
      if (result.prompt !== null) {
        // Summarised from there: the prompt comes back to be sent again or changed.
        actions.setDraft(sessionId, result.prompt);
        return;
      }
      if (files !== null) {
        const changed = files.restored.length + files.deleted.length;
        notice(
          changed === 0
            ? "The files were already as they were at that point."
            : `Put back ${plural(files.restored.length, "file")}${
                files.deleted.length > 0
                  ? ` and removed ${plural(files.deleted.length, "file")} made since`
                  : ""
              }.`,
          "neutral",
        );
      }
    },
    async openMemory(sessionId) {
      const session = get().sessions[sessionId];
      if (!session) return;
      try {
        if (!session.open || !session.loaded) await connection.openSession(sessionId);
        // The engine's command lists the files and makes the folder and MEMORY.md.
        const result = await connection.request("session.command", {
          sessionId,
          name: "memory",
          args: "",
        });
        if (result.output !== null) {
          applyResult([
            { type: "command-output", sessionId, command: "/memory", output: result.output },
          ]);
        }
      } catch (error) {
        notice(`Could not open the memory: ${errorText(error)}.`);
        return;
      }
      setUi((ui) =>
        ui.memoryShown[sessionId]
          ? ui
          : { ...ui, memoryShown: { ...ui.memoryShown, [sessionId]: true } },
      );
      const info = await track(sessionId);
      const directory = info?.memoryDirectory ?? null;
      if (directory === null) {
        notice("The memory folder could not be shown in the Files pane.");
        return;
      }
      requestPaneFile(sessionId, `${directory}/MEMORY.md`);
      actions.openPane("files");
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
