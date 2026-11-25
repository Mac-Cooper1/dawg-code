/**
 * What main answers on each IPC channel, with every input validated. Kept free of Electron (the
 * sender is a type parameter) so the validation is unit-tested; `index.ts` registers these with
 * `ipcMain` behind the sender check.
 */
import {
  type AddedModelFile,
  type ChooseFolderOptions,
  ChooseFolderOptionsSchema,
  ConnectServerInputSchema,
  type DesktopSettings,
  ExternalUrlSchema,
  IdleUnloadSchema,
  IPC,
  ModelIdSchema,
  type ModelOption,
  type ModelStatus,
  type ModelsState,
  type ServerInfo,
  type WindowState,
} from "../shared/bridge.ts";
import type { ModelService } from "./models/service.ts";
import type { SettingsStore, WindowStateStore } from "./stores.ts";
import { validateInput } from "./validate.ts";

export interface MainServices<Sender> {
  settings: SettingsStore;
  windowState: WindowStateStore;
  models: ModelService;
  /** Which saved layout a sender uses. One window, "main", in this wave. */
  windowIdFor(sender: Sender): string;
  /** Called after every successful settings change, to apply the theme and tell every window. */
  settingsChanged(settings: DesktopSettings): void;
  chooseFolder(sender: Sender, options: ChooseFolderOptions): Promise<string | null>;
  /** The native picker for one `.gguf` file; null when cancelled. */
  chooseModelFile(sender: Sender): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}

export type InvokeHandler<Sender> = (sender: Sender, args: readonly unknown[]) => Promise<unknown>;

export function createInvokeHandlers<Sender>(
  services: MainServices<Sender>,
): Record<string, InvokeHandler<Sender>> {
  const { models } = services;
  const modelId = (value: unknown) => validateInput(ModelIdSchema, value, "model id");

  return {
    [IPC.settingsGet]: async (): Promise<DesktopSettings> => services.settings.get(),
    [IPC.settingsUpdate]: async (_sender, [patch]): Promise<DesktopSettings> => {
      const settings = await services.settings.update(patch);
      services.settingsChanged(settings);
      return settings;
    },
    [IPC.windowStateLoad]: async (sender): Promise<WindowState> =>
      services.windowState.load(services.windowIdFor(sender)),
    [IPC.windowStateSave]: async (sender, [state]): Promise<void> => {
      await services.windowState.save(services.windowIdFor(sender), state);
    },
    [IPC.modelsList]: async (): Promise<ModelOption[]> => models.list(),
    [IPC.modelsStatus]: async (): Promise<ModelStatus> => models.status(),
    [IPC.modelsState]: async (): Promise<ModelsState> => models.state(),
    [IPC.modelsDownload]: async (_sender, [id]): Promise<void> => models.download(modelId(id)),
    [IPC.modelsPauseDownload]: async (_sender, [id]): Promise<void> =>
      models.pauseDownload(modelId(id)),
    [IPC.modelsCancelDownload]: async (_sender, [id]): Promise<void> =>
      models.cancelDownload(modelId(id)),
    [IPC.modelsDismissDownload]: async (_sender, [id]): Promise<void> =>
      models.dismissDownload(modelId(id)),
    [IPC.modelsUseExisting]: async (_sender, [id]): Promise<void> =>
      models.useExisting(modelId(id)),
    [IPC.modelsRemove]: async (_sender, [id]): Promise<void> => models.remove(modelId(id)),
    [IPC.modelsStart]: async (_sender, [id]): Promise<void> => models.start(modelId(id)),
    [IPC.modelsStop]: async (): Promise<void> => models.stop(),
    [IPC.modelsSetDefault]: async (_sender, [id]): Promise<void> => models.setDefault(modelId(id)),
    [IPC.modelsSetIdleUnload]: async (_sender, [minutes]): Promise<void> =>
      models.setIdleUnload(validateInput(IdleUnloadSchema, minutes, "idle unload time")),
    [IPC.modelsAddFile]: async (sender): Promise<AddedModelFile | null> =>
      models.addModelFile(() => services.chooseModelFile(sender)),
    [IPC.modelsConnectServer]: async (_sender, [input]): Promise<ServerInfo> =>
      models.connectServer(validateInput(ConnectServerInputSchema, input, "server")),
    [IPC.modelsRemoveServer]: async (_sender, [id]): Promise<void> =>
      models.removeServer(validateInput(ModelIdSchema, id, "server id")),
    [IPC.modelsRefreshServers]: async (): Promise<void> => models.refreshServers(),
    [IPC.chooseFolder]: async (sender, [options]): Promise<string | null> =>
      services.chooseFolder(
        sender,
        validateInput(ChooseFolderOptionsSchema, options, "folder options"),
      ),
    [IPC.openExternal]: async (_sender, [url]): Promise<void> =>
      services.openExternal(validateInput(ExternalUrlSchema, url, "link")),
  };
}
