/**
 * The contract between the renderer and the rest of the app.
 *
 * The preload script exposes these calls to the sandboxed renderer. Every input is validated
 * against the schemas below twice: in the preload before it goes over IPC, and in main before it
 * is used. The renderer never touches files, processes or the network itself.
 *
 * Renderer code reaches the bridge only through `getBridge()` in `src/renderer/bridge/`, which
 * adds the engine message port (ports cannot cross `contextBridge`, so the preload forwards them
 * with `window.postMessage`) and falls back to an in-memory bridge with an in-process mock engine
 * when the page runs in a plain browser.
 *
 * This file is a contract shared by several directories. Add to it freely; rename or remove only
 * deliberately.
 */
import { z } from "zod";

export const BRIDGE_VERSION = 1;

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------------------------
// Settings (persisted in `<data root>/settings.json` under the "desktop" key)
// ---------------------------------------------------------------------------------------------

/** Settings → General → Appearance. "system" follows macOS and is the default. */
export const AppearanceSchema = z.enum(["system", "dark", "light"]);
export type Appearance = z.infer<typeof AppearanceSchema>;

/** The theme actually shown, after "system" is resolved. */
export type ResolvedTheme = "dark" | "light";

/**
 * Settings → General → Tool calls in the transcript.
 * - smart: "Open what needs a look". Failed commands and edits open; reads, searches and passing
 *   commands stay closed.
 * - closed: one line per call.
 * - open: every output and diff in full.
 */
export const ToolCallDisplaySchema = z.enum(["smart", "closed", "open"]);
export type ToolCallDisplay = z.infer<typeof ToolCallDisplaySchema>;

export const DesktopSettingsSchema = z.object({
  appearance: AppearanceSchema.default("system"),
  toolCalls: ToolCallDisplaySchema.default("smart"),
});
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;

export const DesktopSettingsPatchSchema = z.strictObject({
  appearance: AppearanceSchema.optional(),
  toolCalls: ToolCallDisplaySchema.optional(),
});
export type DesktopSettingsPatch = z.infer<typeof DesktopSettingsPatchSchema>;

export const DEFAULT_SETTINGS: DesktopSettings = DesktopSettingsSchema.parse({});

// ---------------------------------------------------------------------------------------------
// Window state (persisted in `<data root>/state.json`, one entry per window)
// ---------------------------------------------------------------------------------------------

export const PaneSchema = z.enum(["changes", "files", "terminal", "plan", "tasks"]);
export type Pane = z.infer<typeof PaneSchema>;

export const SIDEBAR_WIDTH = { min: 200, max: 420, default: 264 } as const;
export const DOCK_WIDTH = { min: 360, max: 900, default: 560 } as const;

/** What a window remembers between launches. Saved by the renderer, debounced. */
export const WindowStateSchema = z.object({
  sidebarOpen: z.boolean().default(true),
  sidebarWidth: z
    .number()
    .int()
    .min(SIDEBAR_WIDTH.min)
    .max(SIDEBAR_WIDTH.max)
    .default(SIDEBAR_WIDTH.default),
  dockOpen: z.boolean().default(false),
  dockPane: PaneSchema.default("changes"),
  dockWidth: z.number().int().min(DOCK_WIDTH.min).max(DOCK_WIDTH.max).default(DOCK_WIDTH.default),
  selectedSessionId: z.string().min(1).nullable().default(null),
  /**
   * The highest event `seq` the person has seen, per session. A session whose turn finished
   * after this shows "Done, unread".
   */
  seenSeq: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

export const DEFAULT_WINDOW_STATE: WindowState = WindowStateSchema.parse({});

// ---------------------------------------------------------------------------------------------
// Models (from the model manager in main: `@dawg/models` under it; with DAWG_ENGINE=mock, the
// mock data in shared/mock-models.ts)
//
// Model ids are stable, because sessions store them: a catalog entry's id ("qwen3.8-27b-q8"),
// "file:<sha256 of the path>" for a model file added by hand, and "<server id>/<model>" for a
// server's model ("ollama/qwen3:32b", "remote:1f3a9c/gpt-oss-120b").
// ---------------------------------------------------------------------------------------------

/** A model that can run now: something the composer's model picker offers. */
export const ModelOptionSchema = z.object({
  /** The id sessions use, passed to `session.setModel`. */
  id: z.string().min(1),
  /** Full name, for menus: "Qwen3.8 27B (8-bit)". */
  label: z.string(),
  /** Compact name, for pills and the sidebar footer: "Qwen3.8 27B · 8-bit". */
  shortLabel: z.string(),
  /** One line under the name: "Bundled runtime · 204.8K context · loaded". */
  description: z.string(),
  /** "bundled" lists under "On this Mac", "server" under "Servers". */
  source: z.enum(["bundled", "server"]),
  contextWindow: z.number().int().positive(),
  /**
   * Where it comes from: a catalog download, a model file added by hand, or a server (Ollama,
   * LM Studio, or a remote URL).
   */
  origin: z.enum(["catalog", "file", "ollama", "lmstudio", "remote"]).default("catalog"),
  /** True when Settings → Models can delete its files (a catalog model dawg downloaded). */
  removable: z.boolean().default(false),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ModelStatusSchema = z.object({
  /** The bundled runtime: a model loaded and answering, loading, nothing loaded, or failed. */
  state: z.enum(["ready", "loading", "stopped", "error"]),
  /** The loaded model, or null when nothing runs. */
  modelId: z.string().nullable(),
  /** Short label of the loaded model: "Qwen3.8 27B · 8-bit". */
  label: z.string().nullable(),
  /** A short line when not ready: "Loading into memory", "Stopped", or what failed. */
  message: z.string().nullable(),
  /** Memory the runtime uses, while a model is loaded; null when unknown. */
  memoryBytes: z.number().int().nonnegative().nullable().default(null),
});
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

/** What the app knows about this Mac: shown on the welcome screen, used for the memory checks. */
export const MachineInfoSchema = z.object({
  /** "Apple M4 Max". */
  chip: z.string(),
  arch: z.enum(["arm64", "x64"]),
  memoryBytes: z.number().int().nonnegative(),
  /** Free space where models are stored. */
  freeDiskBytes: z.number().int().nonnegative(),
  macosVersion: z.string(),
});
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

/** One catalog entry: a model dawg can download and run on the bundled runtime. */
export const CatalogModelSchema = z.object({
  /** The catalog entry's id, which is also the model id once installed. */
  id: z.string().min(1),
  /** "Qwen3.8 27B (8-bit)". */
  displayName: z.string(),
  /** "Qwen3.8 27B · 8-bit". */
  shortLabel: z.string(),
  licence: z.object({ spdx: z.string(), url: z.string() }),
  /** Download size: the weights, plus the vision projector when the entry has one. */
  sizeBytes: z.number().int().nonnegative(),
  /** Memory it needs at its default context. */
  memoryBytes: z.number().int().nonnegative(),
  context: z.object({ default: z.number().int().positive(), max: z.number().int().positive() }),
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), reasoning: z.boolean() }),
  /** The catalog's pick for this Mac. At most one entry is recommended. */
  recommended: z.boolean(),
  /** Whether it fits this Mac's memory and free disk space. */
  fits: z.boolean(),
  /** Why it does not fit, as a sentence ("Needs 48 GB of memory; this Mac has 24 GB."); else null. */
  fitNote: z.string().nullable(),
  /** Where it stands on this Mac. */
  state: z.enum(["available", "downloading", "paused", "failed", "installed"]),
  /**
   * Set when another app already has its files (found by the scanner), so `useExisting` can
   * adopt them instead of downloading.
   */
  foundIn: z.enum(["lmstudio", "ollama", "huggingface"]).nullable(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/** A download, by the catalog entry it fetches. Sent whole on every change (about 4 a second). */
export const DownloadStateSchema = z.object({
  modelId: z.string().min(1),
  phase: z.enum([
    "queued",
    "checking",
    "downloading",
    "verifying",
    "paused",
    "done",
    "failed",
    "cancelled",
  ]),
  /** Bytes on disk so far, across the entry's files. */
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  /** Recent speed; 0 until known. */
  bytesPerSecond: z.number().nonnegative(),
  /** Null when unknown. */
  secondsLeft: z.number().nonnegative().nullable(),
  /** A sentence when `phase` is "failed"; else null. */
  error: z.string().nullable(),
});
export type DownloadState = z.infer<typeof DownloadStateSchema>;

/** A model server dawg can use: Ollama or LM Studio found on this Mac, or a remote URL. */
export const ServerInfoSchema = z.object({
  /** "ollama", "lmstudio", or "remote:<short hash of the URL>". The prefix of its models' ids. */
  id: z.string().min(1),
  kind: z.enum(["ollama", "lmstudio", "remote"]),
  /** For display, without credentials: "http://localhost:11434". */
  url: z.string(),
  /** Whether it answered the last check. */
  reachable: z.boolean(),
  /** The ids of its models, which are also in `ModelsState.installed`. */
  modelIds: z.array(z.string()),
  /** True when a key is stored for it. The key itself never leaves main (it is in the Keychain). */
  hasKey: z.boolean(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/**
 * Everything Settings → Models and the welcome screen show, sent whole on every change. The
 * welcome screen shows while `installed` is empty.
 */
export const ModelsStateSchema = z.object({
  machine: MachineInfoSchema,
  /** Models that can run now, the default first: installed catalog models, model files, servers'. */
  installed: z.array(ModelOptionSchema),
  /** The catalog, the recommended entry first, then best for this Mac first. */
  catalog: z.array(CatalogModelSchema),
  /** Unfinished downloads, plus finished or failed ones until the person dismisses them. */
  downloads: z.array(DownloadStateSchema),
  servers: z.array(ServerInfoSchema),
  status: ModelStatusSchema,
  /** The model new sessions use; null while nothing is installed. */
  defaultModelId: z.string().nullable(),
  /** Unload the bundled runtime's model after this many idle minutes; null never. */
  idleUnloadMinutes: z.number().int().positive().nullable(),
});
export type ModelsState = z.infer<typeof ModelsStateSchema>;

export const ModelIdSchema = z.string().min(1).max(512);

/** A server's address: an OpenAI-compatible root, http or https ("https://example.com/v1"). */
export const ServerUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "A server address must be an http or https URL");

export const ConnectServerInputSchema = z.strictObject({
  url: ServerUrlSchema,
  /** Stored in the Keychain, never on disk in the clear and never sent back to the renderer. */
  apiKey: z.string().min(1).max(4096).optional(),
});
export type ConnectServerInput = z.infer<typeof ConnectServerInputSchema>;

export const IdleUnloadSchema = z
  .number()
  .int()
  .positive()
  .max(24 * 60)
  .nullable();

/** The result of adding a model file: the new option, and a warning when it may not fit. */
export interface AddedModelFile {
  option: ModelOption;
  /** "This model may need more memory than this Mac has (…)." Null when it fits. */
  memoryWarning: string | null;
}

// ---------------------------------------------------------------------------------------------
// Workspace: a session's files and what changed (the Changes and Files panes)
//
// A window registers each session it shows with `workspace.track`; main then answers for that
// session id and allows paths only inside the session's directories (its working directory and
// additional directories), after resolving symlinks. Paths cross the bridge absolute.
// ---------------------------------------------------------------------------------------------

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/"), "Must be an absolute path");

export const SessionRefSchema = z.string().min(1).max(200);

export const TrackSessionInputSchema = z.strictObject({
  sessionId: SessionRefSchema,
  /** The session's working directory: its worktree for a worktree session. */
  cwd: AbsolutePathSchema,
  /** The project the session belongs to (equals `cwd` unless it runs in a worktree). */
  projectDir: AbsolutePathSchema,
  additionalDirectories: z.array(AbsolutePathSchema).max(64).default([]),
});
export type TrackSessionInput = z.input<typeof TrackSessionInputSchema>;

/** A git worktree a session runs in (see "Worktree per session" in the Phase 3 spec). */
export const WorktreeInfoSchema = z.object({
  /** `<project>/.dawg/worktrees/<name>`. */
  path: z.string(),
  /** `dawg/<name>`. */
  branch: z.string(),
  /** The ref it was made from, as chosen ("main"). */
  base: z.string(),
  /** The commit `base` pointed at then. */
  baseCommit: z.string(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

export const WorkspaceInfoSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  /** Null when the working directory is not in a git repository. */
  git: z
    .object({
      /** The repository's top level (absolute). */
      root: z.string(),
      /** Null when HEAD is detached. */
      branch: z.string().nullable(),
      /**
       * What the Changes pane compares with: for a worktree session, where its branch left its
       * base; otherwise the commit HEAD was on when the session was first tracked, so commits the
       * agent made during the session still show.
       */
      baseCommit: z.string(),
      /** For people: "main" or "where the session started (a1b2c3d)". */
      baseLabel: z.string(),
      worktree: WorktreeInfoSchema.nullable(),
    })
    .nullable(),
});
export type WorkspaceInfo = z.infer<typeof WorkspaceInfoSchema>;

/** One file that differs from the base. */
export const ChangedFileSchema = z.object({
  /** Absolute. */
  path: z.string(),
  /** The path before a rename (absolute); else null. */
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

export const ChangeSetSchema = z.object({
  /** Null when the session is not in a git repository: the pane then shows the session's edits. */
  baseCommit: z.string().nullable(),
  files: z.array(ChangedFileSchema),
  /** True when there were more changed files than main lists (it lists the first 2,000). */
  truncated: z.boolean(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/** A unified-diff hunk: the same shape as the protocol's `DiffHunk`. */
export const HunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Each starts with " ", "+" or "-". */
  lines: z.array(z.string()),
});
export type Hunk = z.infer<typeof HunkSchema>;

/** Both sides of one changed file, for a diff view. */
export const FileDiffSchema = z.object({
  path: z.string(),
  /** The base version; null when the file is new. */
  original: z.string().nullable(),
  /** The working-tree version; null when the file was deleted. */
  modified: z.string().nullable(),
  /** Set (and both sides null) when either side is binary. */
  binary: z.boolean(),
  /** Set (and both sides null) when either side is over 5 MB. */
  tooLarge: z.boolean(),
  /** The changes, for reverting one hunk at a time. */
  hunks: z.array(HunkSchema),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const FileRefSchema = z.strictObject({
  sessionId: SessionRefSchema,
  path: AbsolutePathSchema,
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const RevertInputSchema = z.strictObject({
  sessionId: SessionRefSchema,
  path: AbsolutePathSchema,
  /**
   * One hunk, as `fileDiff` gave it; omitted reverts the whole file to its base version (a new
   * file is deleted). Main refuses a hunk that no longer matches the file.
   */
  hunk: HunkSchema.optional(),
});
export type RevertInput = z.infer<typeof RevertInputSchema>;

export const DirEntrySchema = z.object({
  name: z.string(),
  /** Absolute. */
  path: z.string(),
  kind: z.enum(["file", "directory", "symlink"]),
  /** Ignored by git (shown dimmed, listed last). */
  ignored: z.boolean(),
  /** Bytes, for files. */
  size: z.number().int().nonnegative().nullable(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  /** UTF-8 text; null when the file is binary or over 5 MB. */
  content: z.string().nullable(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  size: z.number().int().nonnegative(),
  /** For saving without overwriting someone else's change. */
  mtimeMs: z.number().nonnegative(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const WriteFileInputSchema = z.strictObject({
  sessionId: SessionRefSchema,
  path: AbsolutePathSchema,
  content: z.string().max(5 * 1024 * 1024),
  /** The `mtimeMs` the editor loaded. Main refuses the save when the file changed since. */
  expectedMtimeMs: z.number().nonnegative().optional(),
});
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

/** Files changed on disk under a tracked session's directories (debounced). */
export interface WorkspaceChangedEvent {
  sessionId: string;
  /** Absolute paths; empty when main only knows that something changed. */
  paths: string[];
}

// ---------------------------------------------------------------------------------------------
// Worktrees (a git worktree per session, chosen when the session is created)
// ---------------------------------------------------------------------------------------------

export const ProjectRefSchema = z.strictObject({ projectDir: AbsolutePathSchema });

export interface BranchList {
  /** False when the folder is not in a git repository (no worktree can be made). */
  isRepo: boolean;
  /** The checked-out branch, or null when detached. */
  current: string | null;
  /** Local branches, the current one first. */
  branches: string[];
}

/** A worktree name: lowercase letters, digits and dashes. */
export const WorktreeNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and dashes");

export const CreateWorktreeInputSchema = z.strictObject({
  projectDir: AbsolutePathSchema,
  name: WorktreeNameSchema,
  /** A local branch (or any ref) to start from. */
  base: z.string().min(1).max(200),
});
export type CreateWorktreeInput = z.infer<typeof CreateWorktreeInputSchema>;

export interface WorktreeCleanup {
  removed: boolean;
  /** Why it was kept, as a sentence ("It has changes that are not committed."); null if removed. */
  reason: string | null;
}

// ---------------------------------------------------------------------------------------------
// Terminal (the person's own shells; the agent never types here)
// ---------------------------------------------------------------------------------------------

export const TerminalSizeSchema = z.strictObject({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
});

export const OpenTerminalInputSchema = z.strictObject({
  sessionId: SessionRefSchema,
  /** Where the shell starts: the session's directory (main checks it is one of them). */
  cwd: AbsolutePathSchema,
  cols: TerminalSizeSchema.shape.cols,
  rows: TerminalSizeSchema.shape.rows,
});
export type OpenTerminalInput = z.infer<typeof OpenTerminalInputSchema>;

export const TerminalIdSchema = z.string().min(1).max(100);

/** What `terminal.write` sends: keystrokes or a paste, up to 1 MB at a time. */
export const TerminalInputSchema = z.string().max(1024 * 1024);

export interface TerminalInfo {
  terminalId: string;
  sessionId: string;
  cwd: string;
  /** The shell's name for a tab ("zsh"). */
  title: string;
  /** Still running. */
  alive: boolean;
}

/** A terminal still open in main, with its recent output so a reloaded window can redraw it. */
export interface TerminalReattach extends TerminalInfo {
  /** The last output (up to about 256 KB), with escape sequences, as the shell wrote it. */
  backlog: string;
}

export interface TerminalDataEvent {
  terminalId: string;
  /** Output, with escape sequences, as the shell wrote it. */
  data: string;
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number | null;
  signal: number | null;
}

// ---------------------------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------------------------

export const PlatformInfoSchema = z.object({
  /** "browser" when the renderer runs outside Electron (Vite dev server in a plain browser). */
  os: z.enum(["darwin", "win32", "linux", "browser"]),
  arch: z.string(),
  /** Absolute home directory, for showing paths as "~/code/tally". */
  homeDir: z.string(),
  appVersion: z.string(),
  /** True in `electron-vite dev` and in the browser fallback. */
  isDev: z.boolean(),
  /** Which engine the engine host runs: "real" unless DAWG_ENGINE=mock. */
  engine: z.enum(["mock", "real"]),
});
export type PlatformInfo = z.infer<typeof PlatformInfoSchema>;

// ---------------------------------------------------------------------------------------------
// Input schemas for calls that take arguments
// ---------------------------------------------------------------------------------------------

export const ChooseFolderOptionsSchema = z
  .strictObject({
    title: z.string().max(200).optional(),
    defaultPath: z.string().max(4096).optional(),
  })
  .optional();
export type ChooseFolderOptions = z.infer<typeof ChooseFolderOptionsSchema>;

/** Only http and https links leave the app, and only to the system browser. */
export const ExternalUrlSchema = z
  .string()
  .max(8192)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "Only http and https links can be opened");

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

export interface EngineRestartInfo {
  /** A short reason, for logs and the one-line notice: "The engine host exited (code 1)". */
  reason: string;
}

/**
 * What renderer code gets from `getBridge()`. Every method validates its input; a call with
 * invalid input rejects with an Error and never reaches main.
 */
export interface DawgBridge {
  readonly bridgeVersion: typeof BRIDGE_VERSION;
  /** Fixed for the window's life. */
  readonly platform: PlatformInfo;

  readonly settings: {
    get(): Promise<DesktopSettings>;
    /** Saves the given fields, returns the whole result, and notifies every window. */
    update(patch: DesktopSettingsPatch): Promise<DesktopSettings>;
    /** Called after any window (or the title-bar theme switch) changes a setting. */
    onChange(listener: (settings: DesktopSettings) => void): Unsubscribe;
  };

  readonly windowState: {
    load(): Promise<WindowState>;
    /** Replaces this window's saved state. Callers debounce. */
    save(state: WindowState): Promise<void>;
  };

  readonly engine: {
    /**
     * Asks for a message port to the engine host. The port arrives through `onPort`; call this
     * once at startup. After the engine host restarts, a new port arrives without asking.
     */
    connect(): void;
    /** Each new port speaks JSON-RPC (`createMessagePortTransport` from @dawg/protocol). */
    onPort(listener: (port: MessagePort) => void): Unsubscribe;
    /** The engine host exited unexpectedly; a new port follows once it has restarted. */
    onRestart(listener: (info: EngineRestartInfo) => void): Unsubscribe;
  };

  readonly models: {
    /** Models that can run now: the same as `state().installed`. */
    list(): Promise<ModelOption[]>;
    status(): Promise<ModelStatus>;
    onStatus(listener: (status: ModelStatus) => void): Unsubscribe;
    /** Everything at once, for the welcome screen and Settings → Models. */
    state(): Promise<ModelsState>;
    /** The whole state after every change, a running download's progress included. */
    onState(listener: (state: ModelsState) => void): Unsubscribe;
    /** Starts or resumes downloading a catalog model. Progress arrives through `onState`. */
    download(modelId: string): Promise<void>;
    pauseDownload(modelId: string): Promise<void>;
    /** Stops a download and removes its partial files. */
    cancelDownload(modelId: string): Promise<void>;
    /** Drops a finished, failed or cancelled download from `downloads`. */
    dismissDownload(modelId: string): Promise<void>;
    /** Uses the copy another app already has (`CatalogModel.foundIn`) instead of downloading. */
    useExisting(modelId: string): Promise<void>;
    /** Deletes a downloaded catalog model's files, unloading it first when it is loaded. */
    remove(modelId: string): Promise<void>;
    /**
     * Loads a model into the bundled runtime, replacing the loaded one; for a server's model,
     * checks the server answers. Resolves once it is ready, rejects with a readable reason.
     */
    start(modelId: string): Promise<void>;
    /** Unloads the bundled runtime's model. */
    stop(): Promise<void>;
    /** The model new sessions use. */
    setDefault(modelId: string): Promise<void>;
    setIdleUnload(minutes: number | null): Promise<void>;
    /** Asks for a GGUF model file with the native picker and adds it. Null when cancelled. */
    addModelFile(): Promise<AddedModelFile | null>;
    /** Adds a remote server, after checking it answers, or replaces its key. */
    connectServer(input: ConnectServerInput): Promise<ServerInfo>;
    /** Forgets a remote server and its key. */
    removeServer(serverId: string): Promise<void>;
    /** Looks for Ollama and LM Studio again, and asks every server for its models. */
    refreshServers(): Promise<void>;
  };

  /** A session's files and changes. Every call but `track` needs the session tracked first. */
  readonly workspace: {
    /**
     * Registers a session's directories, records its base commit the first time, and watches
     * its files. Call whenever a window shows a session; calling again is harmless.
     */
    track(input: TrackSessionInput): Promise<WorkspaceInfo>;
    /** Stops watching a session's files (no window shows it any more). */
    untrack(sessionId: string): Promise<void>;
    /** Every file that differs from the base: committed since, staged, unstaged or untracked. */
    changes(sessionId: string): Promise<ChangeSet>;
    fileDiff(ref: FileRef): Promise<FileDiff>;
    /** Reverts a file, or one hunk of it, to the base version. */
    revert(input: RevertInput): Promise<void>;
    /** One directory's entries: directories first, then files, git-ignored ones last. */
    listDirectory(ref: FileRef): Promise<DirEntry[]>;
    readFile(ref: FileRef): Promise<FileContent>;
    /** Saves a file. Rejects, naming the reason, when it changed on disk since it was read. */
    writeFile(input: WriteFileInput): Promise<{ mtimeMs: number }>;
    /** Files changed on disk under a tracked session's directories. */
    onChanged(listener: (event: WorkspaceChangedEvent) => void): Unsubscribe;
  };

  readonly worktrees: {
    branches(projectDir: string): Promise<BranchList>;
    /**
     * Makes `<project>/.dawg/worktrees/<name>` on a new branch `dawg/<name>` from `base`, copies
     * the files `.worktreeinclude` lists, and keeps `.dawg/` out of git. Rejects with a sentence
     * when it cannot (not a repository, the name or branch is taken).
     */
    create(input: CreateWorktreeInput): Promise<WorktreeInfo>;
    /**
     * For an archived session: removes its worktree (and branch) when it is clean and merged into
     * its base; otherwise keeps it and says why.
     */
    cleanup(worktreePath: string): Promise<WorktreeCleanup>;
  };

  /** The person's own shells. Opened only by an explicit action; the agent never types here. */
  readonly terminal: {
    open(input: OpenTerminalInput): Promise<TerminalInfo>;
    /** Keystrokes and pastes. */
    write(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    /** Ends the shell and forgets the terminal. */
    close(terminalId: string): Promise<void>;
    /** Terminals still open for a session, with recent output, to redraw after a reload. */
    list(sessionId: string): Promise<TerminalReattach[]>;
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
  };

  readonly dialogs: {
    /** The native folder picker. Resolves to an absolute path, or null when cancelled. */
    chooseFolder(options?: ChooseFolderOptions): Promise<string | null>;
  };

  readonly shell: {
    /** Opens an http(s) URL in the system browser. Other schemes reject. */
    openExternal(url: string): Promise<void>;
  };
}

// ---------------------------------------------------------------------------------------------
// Wire names (main ⇄ preload). Renderer code never uses these directly.
// ---------------------------------------------------------------------------------------------

export const IPC = {
  settingsGet: "dawg:settings:get",
  settingsUpdate: "dawg:settings:update",
  settingsChanged: "dawg:settings:changed",
  windowStateLoad: "dawg:window-state:load",
  windowStateSave: "dawg:window-state:save",
  engineConnect: "dawg:engine:connect",
  enginePort: "dawg:engine:port",
  engineRestart: "dawg:engine:restart",
  modelsList: "dawg:models:list",
  modelsStatus: "dawg:models:status",
  modelsStatusChanged: "dawg:models:status-changed",
  modelsState: "dawg:models:state",
  modelsStateChanged: "dawg:models:state-changed",
  modelsDownload: "dawg:models:download",
  modelsPauseDownload: "dawg:models:pause-download",
  modelsCancelDownload: "dawg:models:cancel-download",
  modelsDismissDownload: "dawg:models:dismiss-download",
  modelsUseExisting: "dawg:models:use-existing",
  modelsRemove: "dawg:models:remove",
  modelsStart: "dawg:models:start",
  modelsStop: "dawg:models:stop",
  modelsSetDefault: "dawg:models:set-default",
  modelsSetIdleUnload: "dawg:models:set-idle-unload",
  modelsAddFile: "dawg:models:add-file",
  modelsConnectServer: "dawg:models:connect-server",
  modelsRemoveServer: "dawg:models:remove-server",
  modelsRefreshServers: "dawg:models:refresh-servers",
  workspaceTrack: "dawg:workspace:track",
  workspaceUntrack: "dawg:workspace:untrack",
  workspaceChanges: "dawg:workspace:changes",
  workspaceFileDiff: "dawg:workspace:file-diff",
  workspaceRevert: "dawg:workspace:revert",
  workspaceListDirectory: "dawg:workspace:list-directory",
  workspaceReadFile: "dawg:workspace:read-file",
  workspaceWriteFile: "dawg:workspace:write-file",
  workspaceChanged: "dawg:workspace:changed",
  worktreesBranches: "dawg:worktrees:branches",
  worktreesCreate: "dawg:worktrees:create",
  worktreesCleanup: "dawg:worktrees:cleanup",
  terminalOpen: "dawg:terminal:open",
  terminalWrite: "dawg:terminal:write",
  terminalResize: "dawg:terminal:resize",
  terminalClose: "dawg:terminal:close",
  terminalList: "dawg:terminal:list",
  terminalData: "dawg:terminal:data",
  terminalExit: "dawg:terminal:exit",
  chooseFolder: "dawg:dialogs:choose-folder",
  openExternal: "dawg:shell:open-external",
  platform: "dawg:platform",
} as const;

/**
 * The `data` of the `window.postMessage` the preload uses to hand an engine port to the page.
 * The port itself is in `event.ports[0]`.
 */
export const ENGINE_PORT_MESSAGE = "dawg:engine-port";

/** The key the preload exposes its half of the bridge under: `window.dawgPreload`. */
export const PRELOAD_GLOBAL = "dawgPreload";

/** What the preload exposes through `contextBridge` (everything but the port listener). */
export type PreloadApi = Omit<DawgBridge, "engine"> & {
  readonly engine: Omit<DawgBridge["engine"], "onPort">;
};
