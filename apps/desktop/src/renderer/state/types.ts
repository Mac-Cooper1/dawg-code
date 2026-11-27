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
  BackgroundTask,
  CommandInfo,
  ContentPart,
  ContextBreakdown,
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
  AddedModelFile,
  Appearance,
  ConnectServerInput,
  DesktopSettings,
  ModelOption,
  ModelStatus,
  ModelsState,
  NewSessionWorktree,
  Pane,
  ResolvedTheme,
  ServerInfo,
  ToolCallDisplay,
  WindowState,
  WorkspaceInfo,
} from "../../shared/bridge.ts";
import type { SessionInternals } from "./internals.ts";

export type {
  AddedModelFile,
  Appearance,
  ConnectServerInput,
  DesktopSettings,
  ModelOption,
  ModelStatus,
  ModelsState,
  NewSessionWorktree,
  Pane,
  ResolvedTheme,
  ServerInfo,
  ToolCallDisplay,
  WindowState,
  WorkspaceInfo,
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
  /**
   * From the request: the mode approving returns to unless the answer names one, for "Approve
   * returns to Ask first". Null in plans stored before engines reported it.
   */
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
  /** The engine's short sidebar line from `session.status`. Shown as is, never parsed. */
  statusMessage: string | null;
  /**
   * Set while the session's turn waits for a model busy with other sessions (1 = next), from
   * `session.status`, snapshots and list summaries. `status` is then "working".
   */
  queuePosition: number | null;
  modelInfo: ModelInfo | null;
  additionalDirectories: string[];
  tasks: TaskItem[];
  /**
   * The session's background commands, oldest first, each as its latest `background.updated`
   * (or the snapshot) says.
   */
  background: BackgroundTask[];
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
   * turn start, hidden tool calls). Not for display.
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
  /** Images attached when it was queued. */
  images?: ImageAttachment[];
  /** Files its text mentions (`@path`). */
  mentions?: FileMention[];
  /**
   * Set on a message brought back after dawg-code quit with it unsent: it comes back held, and
   * says why.
   */
  restored?: true;
  /** How many of its images were not kept across the relaunch (images are not saved). */
  imagesNotKept?: number;
}

/** An image attached in the composer, ready to send (downscaled and encoded by the composer). */
export interface ImageAttachment {
  id: string;
  /** The file's name, or "Pasted image". */
  name: string;
  /** "image/png", "image/jpeg" or "image/gif". */
  mediaType: string;
  /** Base64, without a data-URL prefix. */
  data: string;
  width: number;
  height: number;
}

export type SettingsPage = "general" | "models" | "permissions" | "shortcuts";

export interface Notice {
  id: string;
  /** One line: "The engine restarted. Sessions were resumed from their transcripts." */
  text: string;
  tone: "neutral" | "error";
}

/** Where a new session in a git project runs: a new worktree from `base`, named `name`. */
export interface WorktreeChoice {
  /** Lowercase letters, digits and dashes: the worktree is `.dawg/worktrees/<name>`. */
  name: string;
  /** The branch (or ref) it starts from. */
  base: string;
}

/**
 * The new-session dialog, shown while a new session in a git project waits for the person to
 * say where it runs: in the project folder, or in a new worktree.
 */
export interface NewSessionOffer {
  projectDir: string;
  /** Folder name: "tally". */
  projectName: string;
  /** Local branches, the current one first. */
  branches: string[];
  /** The checked-out branch; null when HEAD is detached. */
  current: string | null;
  /** A worktree name no branch uses yet. */
  suggestedName: string;
  /** "Run in a worktree" starts checked: the last session started in one. */
  worktree: boolean;
  /** The worktree or the session is being made. */
  busy: boolean;
  /** Why the last try failed, as a sentence; null otherwise. */
  error: string | null;
}

export type ConnectionState =
  | { phase: "connecting" }
  | { phase: "ready"; engine: { name: string; version: string } }
  /** The engine host died; a new port is on its way. */
  | { phase: "restarting"; reason: string }
  /** Cannot continue, for example a protocol version mismatch. */
  | { phase: "failed"; message: string };

/**
 * The first-run screens, shown in place of the sessions view until a model runs: Welcome, then
 * Downloading the chosen model, then Starting it. `error` is a sentence when that step failed.
 */
export type OnboardingState =
  | { step: "welcome" }
  | { step: "download"; modelId: string; error: string | null }
  | { step: "start"; modelId: string; error: string | null };

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
  /** Images attached in the composer per session, until sent. */
  attachments: Record<SessionId, ImageAttachment[]>;
  /**
   * Paths the composer's `@` menu inserted per session ("src/a.ts", a folder ending with "/"),
   * until the draft is sent: an `@path` in the text that names one becomes a mention.
   */
  mentionPaths: Record<SessionId, string[]>;
  /** The client-side message queue per session. */
  queues: Record<SessionId, QueuedMessage[]>;
  /**
   * Per session, how many images attached to the draft were not kept when dawg-code quit (the
   * draft's text was). Cleared once the draft is sent or emptied.
   */
  draftImagesNotKept: Record<SessionId, number>;
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
  /** Models that can run now, the default first: `modelsState.installed`. */
  models: ModelOption[];
  /** The bundled runtime's status: `modelsState.status`. */
  modelStatus: ModelStatus | null;
  /** Everything the model manager reports, for Settings → Models and first run. Null until loaded. */
  modelsState: ModelsState | null;
  /**
   * The first-run screens, when they show. They start while nothing is installed (or no model is
   * the default yet) and end once the chosen model runs.
   */
  onboarding: OnboardingState | null;
  notices: Notice[];
  /**
   * What `workspace.track` answered for the sessions this window tracked: their git state and
   * worktree. A session is tracked when it is created and whenever the window shows it.
   */
  workspaces: Record<SessionId, WorkspaceInfo>;
  /** The new-session dialog, while it is open. */
  newSessionOffer: NewSessionOffer | null;
  /**
   * Per session, how many batches of live events have changed it in this window. Snapshots,
   * replays and session lists leave it alone, so a watcher can tell what happened just now from
   * what the window caught up on: notifications (attention.ts) fire only for the former.
   */
  liveBatches: Record<SessionId, number>;
}

/** One read of a background command's output (`background.output`). */
export interface BackgroundOutput {
  /** Plain text from the offset asked for. */
  text: string;
  /** Where the next read starts. */
  nextOffset: number;
  /** Output written so far, in bytes. */
  totalBytes: number;
  /** The command has ended and everything was read. */
  done: boolean;
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
   * "Queued: waits for the model" (or "Queued: 2nd in line for the model" when several wait),
   * "Error: the model stopped responding", "Stopped by you", or null.
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
  /** The label's tooltip: "Runs in a worktree on dawg/split-cents, made from main". */
  worktreeTitle?: string | null;
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
   * The context size, in tokens, above which the engine compacts on its own before a turn. Null
   * when it never does, and in sessions stored before engines reported it.
   */
  compactAt: number | null;
  /**
   * What fills `used`: system prompt, instructions, tools and messages, adding up to `used`.
   * Null in sessions stored before engines reported it.
   */
  breakdown: ContextBreakdown | null;
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
  /** Images attached to the draft that were not kept when dawg-code quit; 0 when none. */
  draftImagesNotKept: number;
  canAttachImages: boolean;
}

/** The Tasks pane: the agent's task list and its background commands. */
export interface TasksPaneView {
  sessionId: SessionId;
  /** False until the session has been opened here (its background commands are not known yet). */
  open: boolean;
  tasks: readonly TaskItem[];
  /** Oldest first. */
  background: readonly BackgroundTask[];
}

/** The Plan pane: the session's latest plan, if it has one. */
export interface PlanPaneView {
  sessionId: SessionId;
  /** False until the session's history has been replayed. */
  loaded: boolean;
  /** The latest plan item; null when the session has no plan. */
  plan: PlanItem | null;
  /** How many plans the session has proposed. */
  planCount: number;
  /** The session's working directory, to show the plan file's path relative to it. */
  cwd: string;
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
  /** Settings → General → Notifications: a notification when a session needs the person or ends. */
  setNotifications(on: boolean): Promise<void>;
  /** Settings → General → Notifications: the count of sessions that need the person on the Dock. */
  setDockBadge(on: boolean): Promise<void>;
  /** Settings → General → New sessions: where a new session in a git project runs. */
  setNewSessionWorktree(value: NewSessionWorktree): Promise<void>;
  /** Reports the theme the window resolved, so `selectChrome` can expose it. */
  setResolvedTheme(theme: ResolvedTheme): void;

  // --- Sessions --------------------------------------------------------------------------------
  /**
   * Without a project, asks for a folder first. Selects the new session. Null when cancelled.
   *
   * `worktree` says where it runs: a new worktree of the project (`worktrees.create`, then the
   * session with the worktree as `cwd` and the project as `projectDir`), or `false` for the
   * project folder. Left out, a git project follows Settings → General → New sessions
   * (`settings.newSessionWorktree`):
   * - "ask" opens the new-session dialog (`newSessionOffer`); the promise settles once the person
   *   has answered it.
   * - "folder" starts in the project folder.
   * - "worktree" makes a worktree with the name the dialog would suggest, from the current
   *   branch. When it cannot (the name is taken, HEAD is detached), the dialog opens saying why.
   * `ask` opens the dialog whatever the setting says ("New session in a worktree…" in the command
   * palette); `ask: "worktree"` opens it with "Run in a worktree" checked. Any other folder starts
   * at once in the folder.
   * The new session is tracked (`workspace.track`) right after it is created.
   */
  newSession(options?: {
    projectDir?: string;
    worktree?: WorktreeChoice | false;
    ask?: boolean | "worktree";
  }): Promise<SessionId | null>;
  /**
   * Answers the new-session dialog: `{ worktree }` starts the session there (null: the project
   * folder), null cancels. When the worktree cannot be made, the dialog stays open with `error`.
   */
  answerNewSessionOffer(answer: { worktree: WorktreeChoice | null } | null): Promise<void>;
  /**
   * Registers the session's directories with main (`workspace.track`) and keeps the answer in
   * `workspaces`. Repeated calls with unchanged directories share one request. Null when main
   * could not track it.
   */
  trackSession(id: SessionId): Promise<WorkspaceInfo | null>;
  renameSession(id: SessionId, title: string): Promise<void>;
  forkSession(id: SessionId): Promise<SessionId | null>;
  /**
   * Archiving also closes the session's terminals and, for a worktree session, asks main to
   * remove the worktree (`worktrees.cleanup`), with a notice saying whether it was removed.
   */
  archiveSession(id: SessionId, archived?: boolean): Promise<void>;
  /**
   * Deletes the session for good (`session.delete`; the engine stops a running turn first). The
   * session leaves the store, its queued messages are dropped, and when it was selected a
   * neighbour in the sidebar is selected instead (or nothing). The same happens when
   * `session.deleted` arrives because another window deleted it.
   */
  deleteSession(id: SessionId): Promise<void>;
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
   * 4. Otherwise `session.prompt`, with the session's attached images and `mentions` (the files
   *    the text mentions, found by the composer). Images alone, without text, are sent too.
   * Clears the draft once accepted, and the attached images once they went with a prompt (queued
   * or sent); an answer or a command leaves them attached.
   */
  submit(sessionId: SessionId, text: string, mentions?: FileMention[]): Promise<void>;
  /** Attaches images to the session's composer (the composer keeps a message to ten). */
  addAttachments(sessionId: SessionId, images: ImageAttachment[]): void;
  removeAttachment(sessionId: SessionId, imageId: string): void;
  /** The `@` menu inserted this path into the session's draft. */
  rememberMention(sessionId: SessionId, relativePath: string): void;
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

  // --- Models (Settings → Models and the first-run screens) ------------------------------------
  // Failures become notices; progress and results arrive with the next models state.
  downloadModel(modelId: string): Promise<void>;
  pauseDownload(modelId: string): Promise<void>;
  /** Stops a download, deletes what it fetched, and drops it from the list. */
  cancelDownload(modelId: string): Promise<void>;
  /** Drops a finished or failed download from the list. */
  dismissDownload(modelId: string): Promise<void>;
  /** Adopts the copy another app has (`CatalogModel.foundIn`) instead of downloading. */
  adoptExistingModel(modelId: string): Promise<void>;
  /** Deletes a downloaded model's files. */
  removeModel(modelId: string): Promise<void>;
  /** Loads a model into the bundled runtime (or checks its server answers). */
  startModel(modelId: string): Promise<void>;
  stopModel(): Promise<void>;
  /** The model new sessions use. */
  setDefaultModel(modelId: string): Promise<void>;
  setIdleUnload(minutes: number | null): Promise<void>;
  /** The native file picker. The added model, or null when cancelled (or it failed). */
  addModelFile(): Promise<AddedModelFile | null>;
  /** Adds a remote server: the server, or the sentence saying why it could not be added. */
  connectServer(input: ConnectServerInput): Promise<{ server: ServerInfo } | { error: string }>;
  removeServer(serverId: string): Promise<void>;
  refreshServers(): Promise<void>;
  /** Opens an http(s) link (a model's licence) in the system browser. */
  openExternal(url: string): Promise<void>;

  // --- First run -------------------------------------------------------------------------------
  /**
   * Sets the chosen model up and makes it the default: downloads it unless it is on this Mac
   * already (`useExisting` adopts another app's copy instead), then starts it. The first-run
   * screens follow each step and give way to the sessions view once it runs.
   */
  setUpModel(modelId: string, options?: { useExisting?: boolean }): Promise<void>;
  /** Back to the welcome screen, to choose another model. */
  showWelcome(): void;

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

  // --- Background commands (the Tasks pane) ----------------------------------------------------
  /**
   * Reads a background command's output from `offset` (`background.output`). Never throws: a
   * failure comes back as `{ error }`, a sentence, for the pane to show.
   */
  readBackgroundOutput(
    sessionId: SessionId,
    taskId: string,
    offset: number,
  ): Promise<BackgroundOutput | { error: string }>;
  /** Stops a running background command (`background.stop`). False when it failed. */
  stopBackground(sessionId: SessionId, taskId: string): Promise<boolean>;

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
  /** The session was deleted (`session.delete` succeeded): it leaves the state. */
  | { type: "deleted"; sessionId: SessionId }
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
