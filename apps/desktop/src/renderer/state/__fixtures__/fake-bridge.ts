/**
 * A bridge for the store tests. Engine ports are real `MessageChannel` ports served by any
 * engine-like object (the fake engine or the mock engine); models come from the fake model
 * manager, driven by hand (`modelManager`); everything else is in memory and recorded.
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
  type ModelsState,
  type WindowState,
  WindowStateSchema,
} from "../../../shared/bridge.ts";
import { mockModelsState } from "../../../shared/mock-models.ts";
import {
  createFakeModelManager,
  type FakeModelManager,
  type FakeModelManagerOptions,
} from "../../bridge/fake-models.ts";
import { HOME } from "./streams.ts";

export interface PortServer {
  serve(port: MessagePort): void;
}

export interface FakeBridgeOptions {
  engine: PortServer;
  windowState?: Partial<WindowState>;
  settings?: Partial<DesktopSettings>;
  /** The installed models; the rest of the models state is `modelsState`'s. */
  models?: ModelOption[];
  modelStatus?: ModelStatus;
  /** Where the model manager starts. Default: every mock model installed, the default loaded. */
  modelsState?: ModelsState;
  /** The model manager runs by hand unless `auto` is set here. */
  modelManager?: Omit<FakeModelManagerOptions, "state">;
  /** Makes `models.state()` fail, as an older main would. */
  modelsStateFails?: boolean;
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
  /** The model manager behind `models`. */
  readonly modelManager: FakeModelManager;
  /** Closes every port it handed out. */
  close(): void;
}

export function createFakeBridge(options: FakeBridgeOptions): FakeBridge {
  let settings: DesktopSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const windowState = WindowStateSchema.parse({ ...DEFAULT_WINDOW_STATE, ...options.windowState });
  const settingsListeners = new Set<(settings: DesktopSettings) => void>();
  const portListeners = new Set<(port: MessagePort) => void>();
  const restartListeners = new Set<(info: EngineRestartInfo) => void>();
  const ports: MessagePort[] = [];
  const saved: WindowState[] = [];
  const settingsUpdates: DesktopSettingsPatch[] = [];
  const initialModels = options.modelsState ?? mockModelsState();
  const modelManager = createFakeModelManager({
    auto: false,
    ...options.modelManager,
    state: {
      ...initialModels,
      ...(options.models ? { installed: options.models } : {}),
      ...(options.modelStatus ? { status: options.modelStatus } : {}),
    },
  });

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
      ...modelManager.api,
      state: options.modelsStateFails
        ? async () => {
            throw new Error("No such method: models.state");
          }
        : modelManager.api.state,
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
      modelManager.setStatus(status);
    },
    modelManager,
    close() {
      modelManager.dispose();
      for (const port of ports.splice(0)) port.close();
    },
  };
}
