/**
 * The bridge inside Electron: the preload's `window.dawgPreload`, plus the engine ports the
 * preload forwards with `window.postMessage` (ports cannot cross `contextBridge`).
 */
import { type DawgBridge, ENGINE_PORT_MESSAGE, type PreloadApi } from "../../shared/bridge.ts";
import { createPortHub } from "./port-hub.ts";

/** The part of `window` this needs, so tests can pass a stand-in. */
export interface PortWindow {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export function createElectronBridge(preload: PreloadApi, target: PortWindow): DawgBridge {
  const hub = createPortHub();

  target.addEventListener("message", (event) => {
    // Only the preload posts to this window itself; frames and other windows are ignored.
    if (event.source !== target) return;
    if (event.data !== ENGINE_PORT_MESSAGE) return;
    const port = event.ports[0];
    if (!port) return;
    hub.deliver(port);
  });

  return {
    bridgeVersion: preload.bridgeVersion,
    platform: preload.platform,
    settings: preload.settings,
    windowState: preload.windowState,
    engine: {
      connect: () => preload.engine.connect(),
      onPort: (listener) => hub.onPort(listener),
      onRestart: (listener) => preload.engine.onRestart(listener),
    },
    models: preload.models,
    dialogs: preload.dialogs,
    shell: preload.shell,
  };
}
