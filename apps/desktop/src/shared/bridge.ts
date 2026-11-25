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
