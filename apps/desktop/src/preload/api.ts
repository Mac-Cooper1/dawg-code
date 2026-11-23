/**
 * The object the preload exposes as `window.dawgPreload`. Built from an injected `ipcRenderer`
 * so it is unit-tested without Electron.
 *
 * Every input is validated here before it goes over IPC (main validates again): a call with bad
 * input rejects with an Error and never reaches main.
 */
import type { z } from "zod";
import {
  BRIDGE_VERSION,
  ChooseFolderOptionsSchema,
  type DesktopSettings,
  DesktopSettingsPatchSchema,
  type EngineRestartInfo,
  ExternalUrlSchema,
  IPC,
  type ModelOption,
  type ModelStatus,
  type PlatformInfo,
  type PreloadApi,
  type Unsubscribe,
  type WindowState,
  WindowStateSchema,
} from "../shared/bridge.ts";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The slice of Electron's `ipcRenderer` the API uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

export function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
  throw new Error(`Invalid ${what}: ${issues}`);
}

export function createPreloadApi(ipc: IpcRendererLike, platform: PlatformInfo): PreloadApi {
  function subscribe<T>(channel: string, listener: (value: T) => void): Unsubscribe {
    const wrapped: IpcListener = (_event, value) => listener(value as T);
    ipc.on(channel, wrapped);
    return () => {
      ipc.removeListener(channel, wrapped);
    };
  }

  return {
    bridgeVersion: BRIDGE_VERSION,
    platform,
    settings: {
      get: async () => (await ipc.invoke(IPC.settingsGet)) as DesktopSettings,
      update: async (patch) => {
        const valid = validate(DesktopSettingsPatchSchema, patch, "settings");
        return (await ipc.invoke(IPC.settingsUpdate, valid)) as DesktopSettings;
      },
      onChange: (listener) => subscribe<DesktopSettings>(IPC.settingsChanged, listener),
    },
    windowState: {
      load: async () => (await ipc.invoke(IPC.windowStateLoad)) as WindowState,
      save: async (state) => {
        const valid = validate(WindowStateSchema, state, "window state");
        await ipc.invoke(IPC.windowStateSave, valid);
      },
    },
    engine: {
      connect: () => ipc.send(IPC.engineConnect),
      onRestart: (listener) => subscribe<EngineRestartInfo>(IPC.engineRestart, listener),
    },
    models: {
      list: async () => (await ipc.invoke(IPC.modelsList)) as ModelOption[],
      status: async () => (await ipc.invoke(IPC.modelsStatus)) as ModelStatus,
      onStatus: (listener) => subscribe<ModelStatus>(IPC.modelsStatusChanged, listener),
    },
    dialogs: {
      chooseFolder: async (options) => {
        const valid = validate(ChooseFolderOptionsSchema, options, "folder options");
        return (await ipc.invoke(IPC.chooseFolder, valid)) as string | null;
      },
    },
    shell: {
      openExternal: async (url) => {
        const valid = validate(ExternalUrlSchema, url, "link");
        await ipc.invoke(IPC.openExternal, valid);
      },
    },
  };
}
