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
  BRIDGE_VERSION,
  ChooseFolderOptionsSchema,
  type DawgBridge,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_STATE,
  type DesktopSettings,
  DesktopSettingsPatchSchema,
  DesktopSettingsSchema,
  type EngineRestartInfo,
  ExternalUrlSchema,
  type ModelOption,
  type ModelsState,
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
import { createFakeTerminal, type FakeTerminal } from "./fake-terminal.ts";
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
        if (valid.appearance !== undefined) next.appearance = valid.appearance;
        if (valid.toolCalls !== undefined) next.toolCalls = valid.toolCalls;
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
    },
    modelManager,
    fakeWorkspace,
    fakeTerminal,
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
