/**
 * A bridge for the store tests. Engine ports are real `MessageChannel` ports served by any
 * engine-like object (the fake engine or the mock engine); everything else is in memory and
 * recorded.
 */
import {
  type DawgBridge,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_STATE,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type EngineRestartInfo,
  type ModelOption,
  type ModelStatus,
  type WindowState,
  WindowStateSchema,
} from "../../../shared/bridge.ts";
import { MOCK_MODELS } from "../../../shared/mock-models.ts";
import { HOME } from "./streams.ts";

export interface PortServer {
  serve(port: MessagePort): void;
}

export interface FakeBridgeOptions {
  engine: PortServer;
  windowState?: Partial<WindowState>;
  settings?: Partial<DesktopSettings>;
  models?: ModelOption[];
  modelStatus?: ModelStatus;
  /** What the folder picker answers. */
  folder?: string | null;
}

export interface FakeBridge extends DawgBridge {
  readonly saved: WindowState[];
  readonly settingsUpdates: DesktopSettingsPatch[];
  /** Simulates the engine host dying: the restart notice, then a fresh port. */
  restartEngine(reason?: string, beforeNewPort?: () => void): void;
  /** Changes settings as another window would. */
  changeSettings(patch: DesktopSettingsPatch): void;
  setModelStatus(status: ModelStatus): void;
  /** Closes every port it handed out. */
  close(): void;
}

export function createFakeBridge(options: FakeBridgeOptions): FakeBridge {
  let settings: DesktopSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const windowState = WindowStateSchema.parse({ ...DEFAULT_WINDOW_STATE, ...options.windowState });
  const settingsListeners = new Set<(settings: DesktopSettings) => void>();
  const portListeners = new Set<(port: MessagePort) => void>();
  const restartListeners = new Set<(info: EngineRestartInfo) => void>();
  const statusListeners = new Set<(status: ModelStatus) => void>();
  const ports: MessagePort[] = [];
  const saved: WindowState[] = [];
  const settingsUpdates: DesktopSettingsPatch[] = [];
  let modelStatus: ModelStatus = options.modelStatus ?? {
    state: "ready",
    modelId: MOCK_MODELS[0]?.option.id ?? null,
    label: MOCK_MODELS[0]?.option.shortLabel ?? null,
    message: null,
  };

  function subscribe<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  function handOutPort(): void {
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    options.engine.serve(channel.port2);
    setTimeout(() => {
      for (const listener of [...portListeners]) listener(channel.port1);
    }, 0);
  }

  return {
    bridgeVersion: 1,
    platform: {
      os: "darwin",
      arch: "arm64",
      homeDir: HOME,
      appVersion: "0.1.0-test",
      isDev: true,
      engine: "mock",
    },
    settings: {
      get: async () => settings,
      update: async (patch) => {
        settingsUpdates.push(patch);
        settings = { ...settings, ...patch };
        for (const listener of [...settingsListeners]) listener(settings);
        return settings;
      },
      onChange: (listener) => subscribe(settingsListeners, listener),
    },
    windowState: {
      load: async () => windowState,
      save: async (state) => {
        saved.push(WindowStateSchema.parse(state));
      },
    },
    engine: {
      connect: () => handOutPort(),
      onPort: (listener) => subscribe(portListeners, listener),
      onRestart: (listener) => subscribe(restartListeners, listener),
    },
    models: {
      list: async () => options.models ?? MOCK_MODELS.map((model) => model.option),
      status: async () => modelStatus,
      onStatus: (listener) => subscribe(statusListeners, listener),
    },
    dialogs: {
      chooseFolder: async () => (options.folder === undefined ? null : options.folder),
    },
    shell: {
      openExternal: async () => {},
    },
    saved,
    settingsUpdates,
    restartEngine(reason = "The engine host exited (code 1)", beforeNewPort) {
      for (const listener of [...restartListeners]) listener({ reason });
      beforeNewPort?.();
      handOutPort();
    },
    changeSettings(patch) {
      settings = { ...settings, ...patch };
      for (const listener of [...settingsListeners]) listener(settings);
    },
    setModelStatus(status) {
      modelStatus = status;
      for (const listener of [...statusListeners]) listener(status);
    },
    close() {
      for (const port of ports.splice(0)) port.close();
    },
  };
}
