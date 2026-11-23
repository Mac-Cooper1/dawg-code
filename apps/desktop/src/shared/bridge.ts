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
// Models (from the model manager in main; mock data in this wave, see shared/mock-models.ts)
// ---------------------------------------------------------------------------------------------

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
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ModelStatusSchema = z.object({
  state: z.enum(["ready", "loading", "stopped", "error"]),
  /** The loaded model, or null when nothing runs. */
  modelId: z.string().nullable(),
  /** Short label of the loaded model: "Qwen3.8 27B · 8-bit". */
  label: z.string().nullable(),
  /** A short line when not ready: "Loading into memory", "Stopped". */
  message: z.string().nullable(),
});
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

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
  /** Which engine the engine host runs. Only "mock" exists in this wave. */
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
    list(): Promise<ModelOption[]>;
    status(): Promise<ModelStatus>;
    onStatus(listener: (status: ModelStatus) => void): Unsubscribe;
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
