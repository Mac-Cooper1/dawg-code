/**
 * The renderer's state contract. Shared by the state layer (this folder: reducer, store,
 * selectors, engine connection) and the UI folders (app, sidebar, composer, settings,
 * transcript, cards), which only ever see the view models and actions declared here.
 *
 * Rules every implementation follows:
 * - The renderer holds no source of truth. Sessions, transcripts and pending requests are derived
 *   from protocol events and snapshots, and can be rebuilt by replaying a session. Only UI state
 *   (selection, layout, drafts, open/closed cards, the client-side message queue, seen marks)
 *   lives here alone.
 * - One pure reducer turns events into state. The same reducer runs in tests against recorded
 *   event streams.
 * - Selectors are memoised: for unchanged inputs they return the same object, so components can
 *   call `useAppStore((s) => selectComposer(s, id))` without re-render loops.
 *
 * This file is a contract. Add fields freely; rename or remove only deliberately.
 */
import type {
  CommandInfo,
  ContentPart,
  EngineEvent,
  ErrorInfo,
  FileMention,
  ModelInfo,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  PlanResponse,
  Question,
  QuestionResponse,
  SessionId,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  StopReason,
  TaskItem,
  ToolDisplay,
  ToolOutcome,
  Usage,
} from "@dawg/protocol";
import type {
  Appearance,
  DesktopSettings,
  ModelOption,
  ModelStatus,
  Pane,
  ResolvedTheme,
  ToolCallDisplay,
  WindowState,
} from "../../shared/bridge.ts";
import type { SessionInternals } from "./internals.ts";

export type {
  Appearance,
  DesktopSettings,
  ModelOption,
  ModelStatus,
  Pane,
  ResolvedTheme,
  ToolCallDisplay,
  WindowState,
};

// =============================================================================================
// Transcript items: the store's representation of a session's transcript, in display order.
// =============================================================================================

interface ItemBase {
  /** Stable React key, unique within the session. */
  id: string;
  /** The turn it belongs to; null for items outside turns (between-turn compaction, errors). */
  turnId: string | null;
  /** `seq` of the event that created the item. */
  seq: number;
}

/** The person's message, from `turn.started`. */
export interface UserMessageItem extends ItemBase {
  kind: "user";
  /** The prompt's text parts joined with blank lines. */
  text: string;
  images: { mediaType: string; data: string }[];
  mentions: FileMention[];
  /** Set when a slash command started the turn. */
  command: { name: string; args: string } | null;
}

/** An assistant reply's text. Created at `message.started` or the first delta; `message.finished` replaces the text. */
export interface AssistantTextItem extends ItemBase {
  kind: "assistant";
  messageId: string;
  text: string;
  streaming: boolean;
}

/** An assistant reply's reasoning. Collapsed by default ("Thought for 5 s"). */
export interface ReasoningItem extends ItemBase {
  kind: "reasoning";
  messageId: string;
  text: string;
  streaming: boolean;
  /** Time of the first reasoning delta. */
  startedAt: number;
  /** From the first reasoning delta to the first text delta or `message.finished`. Null while streaming. */
  durationMs: number | null;
}

export interface ToolOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * A tool call. Not created for TodoWrite (the tasks item shows it), AskUserQuestion (the question
 * item) or ExitPlanMode (the plan item), unless such a call finishes without its own item
 * (invalid input, an error): then a tool item is added at `tool.finished` so nothing is hidden.
 */
export interface ToolCallItem extends ItemBase {
  kind: "tool";
  toolCallId: string;
  messageId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** "running" until `tool.finished`. */
  state: "running" | ToolOutcome;
  /** Live output from `tool.progress`. A replay may leave it out; finished calls render `content`. */
  output: ToolOutputChunk[];
  /** The latest `tool.progress` status line, such as "34 of 50 runs · 1 failure so far". */
  statusLine: string | null;
  /** What the model was given as the result. Null while running. */
  content: ContentPart[] | null;
  /** The structured view: the diff an edit made, the command's exit code. Null while running. */
  display: ToolDisplay | null;
  /** Time of `tool.started`. */
  startedAt: number;
  durationMs: number | null;
  /**
   * Set when the call asked for permission. The permission item sits directly before this item;
   * while it is pending the tool item is not drawn, and a call denied by the person is not drawn
   * either (the card's one-line record says it).
   */
  permissionRequestId: string | null;
}

/** The task list as of the latest `tasks.updated` in a turn. One per turn, updated in place. */
export interface TasksItem extends ItemBase {
  kind: "tasks";
  tasks: TaskItem[];
}

export type DecisionState = "pending" | "answered" | "cancelled";

export interface PermissionItem extends ItemBase {
  kind: "permission";
  requestId: string;
  request: PermissionRequest;
  state: DecisionState;
  /** The answer, once answered (from `request.resolved`). */
  response: PermissionResponse | null;
}

export interface QuestionItem extends ItemBase {
  kind: "question";
  requestId: string;
  toolCallId: string;
  questions: Question[];
  state: DecisionState;
  response: QuestionResponse | null;
}

export interface PlanItem extends ItemBase {
  kind: "plan";
  requestId: string;
  toolCallId: string;
  /** Markdown. */
  plan: string;
  planPath: string | null;
  state: DecisionState;
  response: PlanResponse | null;
  /** The mode before the session entered plan mode, for "Approve returns to Ask first". */
  modeBeforePlan: PermissionMode | null;
}

/** A thin divider line with a short label: "Interrupted by you · the transcript keeps every finished call". */
export interface NoteItem extends ItemBase {
  kind: "note";
  text: string;
  tone: "neutral" | "error";
}

export interface CompactionItem extends ItemBase {
  kind: "compaction";
  compactionId: string;
  trigger: "auto" | "manual";
  state: "running" | "completed" | "failed" | "interrupted";
  contextBefore: number;
  /** Null unless completed. */
  contextAfter: number | null;
  summary: string | null;
  error: ErrorInfo | null;
}

/** The line under a finished turn: "48 s · 6 model requests · 92% of the prompt read from cache". */
export interface TurnSummaryItem extends ItemBase {
  kind: "turn-summary";
  stopReason: StopReason;
  durationMs: number;
  /** Model requests in the turn, from `usage.updated` totals. Null when unknown. */
  modelRequests: number | null;
  /** 0–100: prompt tokens read from cache over the turn. Null when unknown. */
  cachedPercent: number | null;
}

/** A failed turn or an `error` event. */
export interface ErrorItem extends ItemBase {
  kind: "error";
  error: ErrorInfo;
}

/** The Markdown answer of a command that answers at once (`/help`, `/context`). */
export interface CommandOutputItem extends ItemBase {
  kind: "command-output";
  /** As typed, for example "/help". */
  command: string;
  output: string;
}

export type TranscriptItem =
  | UserMessageItem
  | AssistantTextItem
  | ReasoningItem
  | ToolCallItem
  | TasksItem
  | PermissionItem
  | QuestionItem
  | PlanItem
  | NoteItem
  | CompactionItem
  | TurnSummaryItem
  | ErrorItem
  | CommandOutputItem;

export type TranscriptItemKind = TranscriptItem["kind"];

// =============================================================================================
// Sessions and projects
// =============================================================================================

export interface PromptProgressView {
  turnId: string;
  /** Prompt tokens in the request. */
  total: number;
  /** Of those, reused from the cache. */
  cached: number;
  /** Of those, read so far (cached included). */
  processed: number;
  /** Read rate of the uncached part, from successive `prompt.progress` events. */
  tokensPerSecond: number | null;
  secondsLeft: number | null;
}

export interface LastTurnInfo {
  turnId: string;
  /** Null while the turn runs. */
  stopReason: StopReason | null;
  error: ErrorInfo | null;
  /** `seq` of `turn.finished`; null while running. */
  finishedSeq: number | null;
}

/** Everything known about one session. Kept current by snapshots and events. */
export interface SessionView {
  id: SessionId;
  /** As last reported, with `session.updated` applied (title, mode, model, effort, archived). */
  summary: SessionSummary;
  /** Created, resumed or forked on this connection: it receives live events. */
  open: boolean;
  /** True once its history has been replayed into `transcripts`. */
  loaded: boolean;
  status: SessionStatus;
  waitingOn: "permission" | "question" | "plan" | null;
  /** The engine's short sidebar line from `session.status`. */
  statusMessage: string | null;
  modelInfo: ModelInfo | null;
  additionalDirectories: string[];
  tasks: TaskItem[];
  usage: Usage | null;
  commands: CommandInfo[];
  activeTurnId: string | null;
  promptProgress: PromptProgressView | null;
  /** Running compaction, if any. */
  compactionId: string | null;
  lastTurn: LastTurnInfo | null;
  /** Highest `seq` applied. Events at or below it are ignored. */
  highWaterSeq: number;
  /**
   * The reducer's bookkeeping between events (message start, read-rate sample, usage totals at
   * turn start, the mode before plan mode, hidden tool calls). Not for display.
   */
  internals: SessionInternals;
}

export interface Project {
  /** Absolute path; the key. */
  dir: string;
  /** Folder name: "tally". */
  name: string;
}

// =============================================================================================
// UI state (lives only in the renderer)
// =============================================================================================

export interface QueuedMessage {
  id: string;
  text: string;
  /**
   * "queued" sends when the running turn completes. "held" stays unsent because the person
   * stopped the turn (or it failed): shown with Send now and Remove.
   */
  state: "queued" | "held";
}

export type SettingsPage = "general" | "models" | "permissions" | "shortcuts";

export interface Notice {
  id: string;
  /** One line: "The engine restarted. Sessions were resumed from their transcripts." */
  text: string;
  tone: "neutral" | "error";
}

export type ConnectionState =
  | { phase: "connecting" }
  | { phase: "ready"; engine: { name: string; version: string } }
  /** The engine host died; a new port is on its way. */
  | { phase: "restarting"; reason: string }
  /** Cannot continue, for example a protocol version mismatch. */
  | { phase: "failed"; message: string };

export interface Layout {
  view: "sessions" | "settings";
  settingsPage: SettingsPage;
  sidebarOpen: boolean;
  sidebarWidth: number;
  dockOpen: boolean;
  dockPane: Pane;
  dockWidth: number;
  selectedSessionId: SessionId | null;
  /** Sidebar search text. */
  search: string;
}

export interface UiState {
  /** Composer text per session. */
  drafts: Record<SessionId, string>;
  /** The client-side message queue per session. */
  queues: Record<SessionId, QueuedMessage[]>;
  /** Tool cards and reasoning blocks the person opened or closed by hand: itemId → open. */
  openItems: Record<SessionId, Record<string, boolean>>;
  /** Answered cards the person asked to see again: requestId → shown. */
  shownAgain: Record<SessionId, Record<string, boolean>>;
  /** Highest seq seen per session (persisted in window state). */
  seenSeq: Record<SessionId, number>;
  /** Sessions marked unread by hand. */
  markedUnread: Record<SessionId, boolean>;
  /** Turn ids the client sent from the queue. */
  fromQueueTurns: Record<string, true>;
  /** Sessions the person stopped, for the "Stopped by you" sidebar line. Cleared by the next turn. */
  stoppedByUser: Record<SessionId, boolean>;
  /** Turns this client interrupted, for "Interrupted by you". */
  interruptedTurns: Record<string, true>;
}

/** The whole renderer state. Matches "State model" in docs/specs/phase-3-desktop-app.md. */
export interface AppState {
  connection: ConnectionState;
  homeDir: string;
  projects: Record<string, Project>;
  sessions: Record<SessionId, SessionView>;
  transcripts: Record<SessionId, TranscriptItem[]>;
  /** Unanswered permission / question / plan requests, oldest first. */
  pending: Record<SessionId, PendingRef[]>;
  layout: Layout;
  ui: UiState;
  settings: DesktopSettings;
  models: ModelOption[];
  modelStatus: ModelStatus | null;
  notices: Notice[];
}

export interface PendingRef {
  kind: "permission" | "question" | "plan";
  requestId: string;
  turnId: string;
}

// =============================================================================================
// View models (what selectors return and components render)
// =============================================================================================

/** Status marks differ in shape as well as colour. */
export type SidebarMark = "working" | "needs-you" | "unread" | "queued" | "error" | "idle";

export interface SidebarRow {
  sessionId: SessionId;
  /** "New session" while the title is null. */
  title: string;
  mark: SidebarMark;
  /** For VoiceOver: "Working", "Needs you", "Done, unread", "Queued", "Error", "Idle". */
  markLabel: string;
  /**
   * "Working: editing money.py", "Needs you: run a command", "Done, not opened yet",
   * "Queued: waits for the model", "Error: the model stopped responding", "Stopped by you", or null.
   */
  subtitle: string | null;
  /** "now" while working; else "3m", "1h", "Yesterday", "Mon", "Nov 3". */
  timeLabel: string;
  selected: boolean;
  /** Runs in a worktree of its project. */
  worktree: boolean;
}

export interface SidebarGroup {
  projectDir: string;
  /** "tally" */
  name: string;
  /** "~/code/tally" */
  displayPath: string;
  /** Newest activity first. */
  rows: SidebarRow[];
}

/** The sidebar footer: the running model. */
export interface ModelFooterView {
  label: string;
  state: ModelStatus["state"];
  /** "Ready · 1 running, 1 queued" */
  detail: string;
}

export interface TitleBarView {
  sessionId: SessionId | null;
  /** Session title, "New session", or "dawg-code" when nothing is selected. */
  title: string;
  projectName: string | null;
  /** "worktree · split-cents" when the session runs in a worktree. */
  worktreeLabel: string | null;
  /** Totals of the diffs this session's edits made. Null when there are none. */
  changes: { files: number; additions: number; deletions: number } | null;
  /** Null when the session has no task list. */
  tasks: { done: number; total: number } | null;
}

export interface TranscriptView {
  sessionId: SessionId;
  items: readonly TranscriptItem[];
  /** False until the session's history has been replayed. */
  loaded: boolean;
  /** A turn is running (the last assistant item may be streaming). */
  working: boolean;
  /** The running turn, or null. Items of this turn are live (the tasks card shows its list). */
  activeTurnId: string | null;
  promptProgress: PromptProgressView | null;
  toolCallDisplay: ToolCallDisplay;
  /** itemId → open, for items the person toggled. Others use the default for `toolCallDisplay`. */
  openItems: Readonly<Record<string, boolean>>;
  /** requestId → shown again. */
  shownAgain: Readonly<Record<string, boolean>>;
  /**
   * Turns the client sent from the queue. A user message of such a turn is preceded by a
   * "Queued message sent" divider. (The prompt's response may arrive after `turn.started`, so
   * this lives beside the items, not in them.)
   */
  queuedTurnIds: Readonly<Record<string, true>>;
  /** The session's mode now, for the plan card's "Approve returns to …". */
  mode: PermissionMode;
  /** The session's working directory, to show paths relative to it. */
  cwd: string;
}

export interface ContextMeterView {
  used: number;
  window: number;
  /** used / window, 0–1. */
  fraction: number;
  /** The latest request. */
  last: {
    promptTokens: number | null;
    cachedTokens: number | null;
    completionTokens: number | null;
    promptTokensPerSecond: number | null;
    completionTokensPerSecond: number | null;
  } | null;
  /**
   * Fraction of the window at which compaction starts on its own. The protocol does not report
   * it yet; this is the engine's documented default, 0.65.
   */
  compactAt: number;
  compacting: boolean;
}

export interface EffortView {
  /** Null = the model's default. */
  value: string | null;
  /** From the model's `effortLevels`. Empty when the model has none (picker hidden). */
  levels: string[];
}

export interface ComposerView {
  sessionId: SessionId;
  status: SessionStatus;
  /** A turn runs and nothing waits on the person: Stop shows, and sent messages queue. */
  working: boolean;
  /** The oldest pending decision. A message sent now answers it instead of starting a turn. */
  answering: PendingRef | null;
  /**
   * "Reply to dawg. / for commands, @ to mention a file", or while a card is open:
   * "Waiting on you. A message here denies the command and tells dawg why." (permission),
   * "Waiting on you. A message here answers the question." (question),
   * "Waiting on you. A message here keeps planning, with your feedback." (plan).
   */
  placeholder: string;
  mode: PermissionMode;
  model: { id: string | null; label: string };
  effort: EffortView;
  context: ContextMeterView | null;
  queue: readonly QueuedMessage[];
  commands: readonly CommandInfo[];
  draft: string;
  canAttachImages: boolean;
}

export interface AppChromeView {
  theme: ResolvedTheme;
  appearance: Appearance;
  view: Layout["view"];
  settingsPage: SettingsPage;
  sidebarOpen: boolean;
  sidebarWidth: number;
  dockOpen: boolean;
  dockPane: Pane;
  dockWidth: number;
  connection: ConnectionState;
  notices: readonly Notice[];
}

// =============================================================================================
// Actions
// =============================================================================================

export interface AppActions {
  // --- Lifecycle -----------------------------------------------------------------------------
  /**
   * Loads settings, window state and models through the bridge, connects to the engine
   * (`initialize`), lists sessions, opens every session that is working, waiting or in error,
   * and replays the selected one. Idempotent. Reconnects by itself when a new engine port
   * arrives after an engine restart, resuming open sessions and catching up from each session's
   * high-water `seq`.
   */
  start(): Promise<void>;
  /** Closes the connection and stops listening. For tests and window teardown. */
  stop(): void;

  // --- Navigation and layout (persisted to window state, debounced) ---------------------------
  /** Selects a session: resumes and replays it if needed, and marks it seen. */
  selectSession(id: SessionId): void;
  setView(view: Layout["view"]): void;
  setSettingsPage(page: SettingsPage): void;
  setSidebarOpen(open: boolean): void;
  setSidebarWidth(px: number): void;
  openPane(pane: Pane): void;
  closeDock(): void;
  setDockWidth(px: number): void;
  setSearch(query: string): void;
  dismissNotice(id: string): void;

  // --- Settings (saved through the bridge) -----------------------------------------------------
  setAppearance(appearance: Appearance): Promise<void>;
  setToolCallDisplay(value: ToolCallDisplay): Promise<void>;
  /** Reports the theme the window resolved, so `selectChrome` can expose it. */
  setResolvedTheme(theme: ResolvedTheme): void;

  // --- Sessions --------------------------------------------------------------------------------
  /** Without a project, asks for a folder first. Selects the new session. Null when cancelled. */
  newSession(options?: { projectDir?: string }): Promise<SessionId | null>;
  renameSession(id: SessionId, title: string): Promise<void>;
  forkSession(id: SessionId): Promise<SessionId | null>;
  archiveSession(id: SessionId, archived?: boolean): Promise<void>;
  markUnread(id: SessionId): void;

  // --- Composer --------------------------------------------------------------------------------
  setDraft(sessionId: SessionId, text: string): void;
  /**
   * What Enter in the composer does, in this order:
   * 1. A pending decision: the text answers it (permission → deny with the text as the note;
   *    question → a free-text answer to each question; plan → keep planning with the text as
   *    feedback).
   * 2. A turn is running: the text is queued.
   * 3. Text starting with "/name" where `name` is one of the session's commands: `session.command`.
   * 4. Otherwise `session.prompt`.
   * Clears the draft once accepted.
   */
  submit(sessionId: SessionId, text: string): Promise<void>;
  /** Stop / Esc. Queued messages of the session become held. */
  interrupt(sessionId: SessionId): Promise<void>;
  /** Sends a held message now (as a new turn). */
  sendQueuedNow(sessionId: SessionId, queueId: string): Promise<void>;
  removeQueued(sessionId: SessionId, queueId: string): void;
  setMode(sessionId: SessionId, mode: PermissionMode): Promise<void>;
  /** Shift+Tab: default → acceptEdits → plan → default (see lib/modes.ts). */
  cycleMode(sessionId: SessionId): Promise<void>;
  setModel(sessionId: SessionId, modelId: string): Promise<void>;
  setEffort(sessionId: SessionId, effort: string | null): Promise<void>;
  /** Runs `/compact`. */
  compact(sessionId: SessionId): Promise<void>;

  // --- Decisions -------------------------------------------------------------------------------
  respondPermission(
    sessionId: SessionId,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void>;
  respondQuestion(
    sessionId: SessionId,
    requestId: string,
    response: QuestionResponse,
  ): Promise<void>;
  respondPlan(sessionId: SessionId, requestId: string, response: PlanResponse): Promise<void>;

  // --- Transcript UI ---------------------------------------------------------------------------
  setItemOpen(sessionId: SessionId, itemId: string, open: boolean): void;
  setShownAgain(sessionId: SessionId, requestId: string, shown: boolean): void;
}

export interface AppStore extends AppState {
  actions: AppActions;
  /** The theme the window shows (set by the app shell from appearance + macOS). */
  resolvedTheme: ResolvedTheme;
}

// =============================================================================================
// Reducer
// =============================================================================================

/** What the reducer accepts: protocol events, plus the results of requests. */
export type ReducerInput =
  | { type: "event"; event: EngineEvent }
  /** Result of session.create / resume / fork: the session is open from here on. */
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** A `session.list` page: summaries of stored sessions. */
  | { type: "summaries"; sessions: SessionSummary[] }
  /** A `session.replay` page, applied in order through the same event path. */
  | { type: "replay"; sessionId: SessionId; events: EngineEvent[]; done: boolean }
  /** The answer of a command that answered at once. */
  | {
      type: "command-output";
      sessionId: SessionId;
      command: string;
      output: string;
    }
  /** The connection went away: running sessions are no longer known to be running. */
  | { type: "disconnected" };

/**
 * The part of the state the reducer owns. UI state, settings and layout are changed by actions
 * directly.
 */
export type EngineSlice = Pick<AppState, "projects" | "sessions" | "transcripts" | "pending">;

export type Reducer = (state: EngineSlice, input: ReducerInput) => EngineSlice;
