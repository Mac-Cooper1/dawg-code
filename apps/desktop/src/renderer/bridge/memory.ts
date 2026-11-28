/**
 * The bridge outside Electron (the Vite dev server in a plain browser, previews, tests):
 * settings and window state in memory, saved to localStorage when there is one, a fake model
 * manager (downloads that progress on timers), a pretend workspace and shell (fake-workspace.ts,
 * fake-terminal.ts), and an engine running in the page, reached over a real `MessageChannel`
 * exactly as the app reaches the engine host.
 */
import {
  createMessagePortTransport,
  createServer,
  ErrorCodes,
  RpcError,
  type Transport,
} from "@dawg/protocol";
import type { z } from "zod";
import {
  BadgeCountSchema,
  BRIDGE_VERSION,
  ChooseFolderOptionsSchema,
  ConfigFilePathSchema,
  type DawgBridge,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_STATE,
  type DesktopSettings,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  type EngineRestartInfo,
  ExternalUrlSchema,
  type MenuModel,
  MenuModelSchema,
  type ModelOption,
  type ModelsState,
  type NotifyInput,
  NotifyInputSchema,
  type PlatformInfo,
  type Unsubscribe,
  type WindowState,
  WindowStateSchema,
} from "../../shared/bridge.ts";
import { mockModelsState } from "../../shared/mock-models.ts";
import {
  createFakeModelManager,
  type FakeModelManager,
  type FakeModelManagerOptions,
} from "./fake-models.ts";
import {
  browserPermissionFiles,
  createFakePermissions,
  type FakePermissions,
  type FakeSettingsFile,
} from "./fake-permissions.ts";
import { createFakeTerminal, type FakeTerminal } from "./fake-terminal.ts";
import { createFakeWeb, type FakeWeb, type FakeWebOptions } from "./fake-web.ts";
import {
  createFakeWorkspace,
  type FakeWorkspace,
  type FakeWorkspaceOptions,
} from "./fake-workspace.ts";
import { createPortHub } from "./port-hub.ts";
import { validate } from "./validate.ts";

/** Anything that can serve the protocol on a transport, such as the mock engine. */
export interface EngineLike {
  connect(transport: Transport): unknown;
}

/** The part of `Storage` the bridge uses. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface MemoryBridgeOptions {
  platform?: Partial<PlatformInfo>;
  settings?: Partial<DesktopSettings>;
  windowState?: Partial<WindowState>;
  /** The installed models, in place of the mock ones (the rest of the models state stays). */
  models?: ModelOption[];
  /** Where the fake model manager starts. Default: every mock model installed. */
  modelsState?: ModelsState;
  /** Timing of the fake model manager's downloads and loads. */
  modelTiming?: Omit<FakeModelManagerOptions, "state">;
  /**
   * Serves each port `engine.connect()` hands out. Default: a mock engine with the built-in
   * scenarios, created on first connect.
   */
  engine?: EngineLike;
  /**
   * Where settings and window state persist. Default: `localStorage` when the page has one;
   * `null` keeps everything in memory. Values given in `settings` / `windowState` win over
   * saved ones.
   */
  storage?: StorageLike | null;
  /** The pretend workspace and worktrees (see fake-workspace.ts). */
  workspace?: FakeWorkspaceOptions;
  /**
   * Settings files for Settings → Permissions, by absolute path (see fake-permissions.ts).
   * Default: a few lived-in ones under the home folder and ~/code/tally.
   */
  permissionFiles?: Record<string, FakeSettingsFile>;
  /** Settings → Web's starting point (see fake-web.ts). Default: no search service. */
  web?: FakeWebOptions;
}

/** An in-memory bridge, also used by tests. */
export interface MemoryBridge extends DawgBridge {
  /** Test helper: simulates an engine host restart (onRestart, then a fresh port). */
  simulateEngineRestart(reason?: string): void;
  /** The fake model manager behind `models`, for tests to drive. */
  readonly modelManager: FakeModelManager;
  /** The in-memory disk behind `workspace` and `worktrees`, for tests to drive. */
  readonly fakeWorkspace: FakeWorkspace;
  /** The pretend shells behind `terminal`. */
  readonly fakeTerminal: FakeTerminal;
  /** The settings files behind `permissions`. */
  readonly fakePermissions: FakePermissions;
  /** The search settings behind `web`. */
  readonly fakeWeb: FakeWeb;
  /** Every notification shown (by main's rules: notifications on, the page not focused). */
  readonly notificationsShown: NotifyInput[];
  /** Every count given to the Dock badge, in order. */
  readonly badgeCounts: number[];
  /** Test helper: the person clicked a session's notification. */
  openSessionFromNotification(sessionId: string): void;
  /** The latest menu model the page sent (a page has no menu bar to show it in). */
  readonly menuModel: MenuModel | null;
  /** Test helper: the person chose a menu item meant for this page. */
  chooseMenuItem(actionId: string): void;
  /** Every agent, skill or command file the page asked to open, in order. */
  readonly openedConfigFiles: string[];
}

export const BROWSER_HOME_DIR = "/Users/you";
/** What "Choose folder" answers in the browser, so "New session" works there. */
export const BROWSER_CHOSEN_FOLDER = "/Users/you/code/scratch";
export const STORAGE_KEYS = {
  settings: "dawg:desktop:settings",
  windowState: "dawg:desktop:window-state",
} as const;

export function createMemoryBridge(options: MemoryBridgeOptions = {}): MemoryBridge {
  const platform: PlatformInfo = {
    os: "browser",
    arch: "unknown",
    homeDir: BROWSER_HOME_DIR,
    appVersion: "0.0.0",
    isDev: true,
    engine: "mock",
    ...options.platform,
  };
  const storage = options.storage === undefined ? defaultStorage() : options.storage;

  let settings: DesktopSettings = {
    ...restore(storage, STORAGE_KEYS.settings, DesktopSettingsSchema, DEFAULT_SETTINGS),
    ...options.settings,
  };
  let windowState: WindowState = {
    ...restore(storage, STORAGE_KEYS.windowState, WindowStateSchema, DEFAULT_WINDOW_STATE),
    ...options.windowState,
  };
  const settingsListeners = new Set<(value: DesktopSettings) => void>();
  const restartListeners = new Set<(info: EngineRestartInfo) => void>();
  const hub = createPortHub();
  const modelsState = options.modelsState ?? mockModelsState();
  const modelManager = createFakeModelManager({
    ...options.modelTiming,
    state: options.models ? { ...modelsState, installed: options.models } : modelsState,
  });

  const fakeWorkspace = createFakeWorkspace(options.workspace);
  const fakeTerminal = createFakeTerminal();
  const fakePermissions = createFakePermissions({
    homeDir: platform.homeDir,
    files: options.permissionFiles ?? browserPermissionFiles(platform.homeDir),
  });
  const fakeWeb = createFakeWeb(options.web);
  const notificationsShown: NotifyInput[] = [];
  const badgeCounts: number[] = [];
  const openSessionListeners = new Set<(sessionId: string) => void>();
  let menuModel: MenuModel | null = null;
  const openedConfigFiles: string[] = [];
  const menuActionListeners = new Set<(actionId: string) => void>();

  /** The engine sides of the ports handed out, closed on a simulated restart. */
  const engineEnds = new Set<Transport>();
  let defaultEngine: Promise<EngineLike & { dispose?(): void }> | null = null;

  function loadEngine(): Promise<EngineLike & { dispose?(): void }> {
    if (options.engine) return Promise.resolve(options.engine);
    // Loaded on demand so an Electron build never pulls the mock engine into the page.
    defaultEngine ??= import("../../mock-engine/index.ts").then(({ createMockEngine }) =>
      createMockEngine({ homeDir: platform.homeDir, speed: 1 }),
    );
    return defaultEngine;
  }

  async function openPort(): Promise<MessagePort> {
    const channel = new MessageChannel();
    const transport = createMessagePortTransport(channel.port1);
    engineEnds.add(transport);
    transport.onClose(() => engineEnds.delete(transport));
    try {
      const engine = await loadEngine();
      engine.connect(transport);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`dawg: the in-page engine could not start: ${reason}`);
      serveUnavailable(transport, reason);
    }
    return channel.port2;
  }

  function connect(): void {
    void openPort().then((port) => hub.deliver(port));
  }

  return {
    bridgeVersion: BRIDGE_VERSION,
    platform,
    settings: {
      get: async () => ({ ...settings }),
      update: async (patch) => {
        const valid = validate(DesktopSettingsPatchSchema, patch, "settings");
        const next: DesktopSettings = { ...settings };
        for (const [key, value] of Object.entries(valid)) {
          if (value !== undefined) Object.assign(next, { [key]: value });
        }
        settings = next;
        persist(storage, STORAGE_KEYS.settings, settings);
        for (const listener of [...settingsListeners]) listener({ ...settings });
        return { ...settings };
      },
      onChange: (listener) => subscribe(settingsListeners, listener),
    },
    windowState: {
      load: async () => structuredClone(windowState),
      save: async (state) => {
        windowState = validate(WindowStateSchema, state, "window state");
        persist(storage, STORAGE_KEYS.windowState, windowState);
      },
    },
    engine: {
      connect,
      onPort: (listener) => hub.onPort(listener),
      onRestart: (listener) => subscribe(restartListeners, listener),
    },
    models: modelManager.api,
    workspace: fakeWorkspace.workspace,
    worktrees: fakeWorkspace.worktrees,
    terminal: fakeTerminal.api,
    // Recorded, not shown: a page has no Dock, and browser notifications would need a prompt.
    notifications: {
      show: async (input) => {
        const valid = validate(NotifyInputSchema, input, "notification");
        if (!settings.notifications || globalThis.document?.hasFocus()) return false;
        notificationsShown.push(valid);
        return true;
      },
      setBadge: async (count) => {
        badgeCounts.push(validate(BadgeCountSchema, count, "badge count"));
      },
      onOpenSession: (listener) => subscribe(openSessionListeners, listener),
    },
    permissions: fakePermissions.api,
    web: fakeWeb.api,
    dialogs: {
      chooseFolder: async (folderOptions) => {
        validate(ChooseFolderOptionsSchema, folderOptions, "folder options");
        return BROWSER_CHOSEN_FOLDER;
      },
    },
    shell: {
      openExternal: async (url) => {
        const valid = validate(ExternalUrlSchema, url, "link");
        globalThis.window?.open(valid, "_blank", "noopener,noreferrer");
      },
      // A plain browser has no editor to hand a file to: the path is checked and kept.
      openConfigFile: async (file) => {
        openedConfigFiles.push(validate(ConfigFilePathSchema, file, "file"));
      },
    },
    menu: {
      update: (model) => {
        menuModel = validate(MenuModelSchema, model, "menu");
      },
      onAction: (listener) => subscribe(menuActionListeners, listener),
    },
    get menuModel() {
      return menuModel;
    },
    chooseMenuItem(actionId) {
      for (const listener of [...menuActionListeners]) listener(actionId);
    },
    openedConfigFiles,
    modelManager,
    fakeWorkspace,
    fakeTerminal,
    fakePermissions,
    fakeWeb,
    notificationsShown,
    badgeCounts,
    openSessionFromNotification(sessionId) {
      for (const listener of [...openSessionListeners]) listener(sessionId);
    },
    simulateEngineRestart(reason = "The engine host restarted (simulated)") {
      for (const transport of [...engineEnds]) transport.close();
      if (!options.engine && defaultEngine) {
        const old = defaultEngine;
        defaultEngine = null;
        void old.then((engine) => engine.dispose?.()).catch(() => {});
      }
      for (const listener of [...restartListeners]) listener({ reason });
      connect();
    },
  };
}

function subscribe<T>(set: Set<(value: T) => void>, listener: (value: T) => void): Unsubscribe {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Answers `initialize` with the reason the engine is missing; every other method is refused. */
function serveUnavailable(transport: Transport, reason: string): void {
  createServer(transport, {
    initialize: () => {
      throw new RpcError(ErrorCodes.InternalError, `The engine could not start: ${reason}`);
    },
  });
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some sandboxes throw on the mere access.
    return null;
  }
}

function restore<S extends z.ZodType>(
  storage: StorageLike | null,
  key: string,
  schema: S,
  fallback: z.output<S>,
): z.output<S> {
  if (!storage) return structuredClone(fallback);
  try {
    const text = storage.getItem(key);
    if (text === null) return structuredClone(fallback);
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function persist(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the value still lives in memory for this page.
  }
}
