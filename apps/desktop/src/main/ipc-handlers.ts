/**
 * What main answers on each IPC channel, with every input validated. Kept free of Electron (the
 * sender is a type parameter) so the validation is unit-tested; `ipc.ts` registers these with
 * `ipcMain` behind the sender check.
 */
import {
  type ChooseFolderOptions,
  ChooseFolderOptionsSchema,
  type DesktopSettings,
  ExternalUrlSchema,
  IPC,
  type ModelOption,
  type ModelStatus,
  type WindowState,
} from "../shared/bridge.ts";
import { MOCK_MODEL_STATUS, MOCK_MODELS } from "../shared/mock-models.ts";
import type { SettingsStore, WindowStateStore } from "./stores.ts";
import { validateInput } from "./validate.ts";

export interface MainServices<Sender> {
  settings: SettingsStore;
  windowState: WindowStateStore;
  /** Which saved layout a sender uses. One window, "main", in this wave. */
  windowIdFor(sender: Sender): string;
  /** Called after every successful settings change, to apply the theme and tell every window. */
  settingsChanged(settings: DesktopSettings): void;
  chooseFolder(sender: Sender, options: ChooseFolderOptions): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}

export type InvokeHandler<Sender> = (sender: Sender, args: readonly unknown[]) => Promise<unknown>;

export function createInvokeHandlers<Sender>(
  services: MainServices<Sender>,
): Record<string, InvokeHandler<Sender>> {
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
    [IPC.modelsList]: async (): Promise<ModelOption[]> => MOCK_MODELS.map((model) => model.option),
    [IPC.modelsStatus]: async (): Promise<ModelStatus> => ({ ...MOCK_MODEL_STATUS }),
    [IPC.chooseFolder]: async (sender, [options]): Promise<string | null> =>
      services.chooseFolder(
        sender,
        validateInput(ChooseFolderOptionsSchema, options, "folder options"),
      ),
    [IPC.openExternal]: async (_sender, [url]): Promise<void> =>
      services.openExternal(validateInput(ExternalUrlSchema, url, "link")),
  };
}
