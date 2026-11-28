/** Settings → Web's IPC channels, with every input validated. Registered by `index.ts`. */
import {
  IPC,
  KeyedSearchProviderSchema,
  WebCheckInputSchema,
  type WebCheckResult,
  WebSettingsInputSchema,
  type WebSettingsState,
} from "../../shared/bridge.ts";
import type { InvokeHandler } from "../ipc-handlers.ts";
import { validateInput } from "../validate.ts";
import type { WebSettingsService } from "./service.ts";

export function createWebInvokeHandlers<Sender>(
  web: WebSettingsService,
): Record<string, InvokeHandler<Sender>> {
  return {
    [IPC.webRead]: async (): Promise<WebSettingsState> => web.state(),
    [IPC.webWrite]: async (_sender, [input]): Promise<WebSettingsState> =>
      web.write(validateInput(WebSettingsInputSchema, input, "web settings")),
    [IPC.webRemoveKey]: async (_sender, [provider]): Promise<WebSettingsState> =>
      web.removeKey(validateInput(KeyedSearchProviderSchema, provider, "search service")),
    [IPC.webCheck]: async (_sender, [input]): Promise<WebCheckResult> =>
      web.check(validateInput(WebCheckInputSchema, input, "web settings")),
  };
}
