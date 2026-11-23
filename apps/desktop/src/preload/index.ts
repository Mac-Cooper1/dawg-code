/**
 * The preload script. Runs sandboxed (built as one CommonJS file) in an isolated world, and
 * exposes `window.dawgPreload` (`PreloadApi`) to the page through `contextBridge`.
 *
 * Engine ports cannot cross `contextBridge`, so each port main sends is forwarded to the page
 * with `window.postMessage(ENGINE_PORT_MESSAGE, …, [port])`; `getBridge()` in the renderer picks
 * it up and hands it to `engine.onPort` listeners.
 */
import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  ENGINE_PORT_MESSAGE,
  IPC,
  type PlatformInfo,
  PlatformInfoSchema,
  PRELOAD_GLOBAL,
} from "../shared/bridge.ts";
import { createPreloadApi } from "./api.ts";

// The page's CSP forbids eval; without this zod would try `new Function` and log a violation.
z.config({ jitless: true });

/** Fixed for the window's life, so it is fetched once, synchronously, before the page runs. */
function loadPlatform(): PlatformInfo {
  const parsed = PlatformInfoSchema.safeParse(ipcRenderer.sendSync(IPC.platform));
  if (parsed.success) return parsed.data;
  console.error("dawg: main did not send valid platform info", parsed.error.issues);
  return {
    os: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
    arch: process.arch,
    homeDir: "",
    appVersion: "0.0.0",
    isDev: false,
    engine: "mock",
  };
}

/**
 * The preload can also run in a window's initial about:blank document, before the app page
 * commits (it happens when a debugger attaches early, as Playwright's does). That document is
 * replaced at once, gets nothing from main (the sender check refuses a frame with no URL), and
 * so gets no bridge here either.
 */
const isInitialBlankDocument = window.location.href === "about:blank";

if (!isInitialBlankDocument) {
  contextBridge.exposeInMainWorld(PRELOAD_GLOBAL, createPreloadApi(ipcRenderer, loadPlatform()));
}

ipcRenderer.on(IPC.enginePort, (event) => {
  if (isInitialBlankDocument) return;
  const [port] = event.ports;
  if (!port) return;
  // A file:// page has an opaque origin, which postMessage cannot name; the target is this very
  // window either way.
  const origin = window.location.origin.startsWith("http") ? window.location.origin : "*";
  window.postMessage(ENGINE_PORT_MESSAGE, origin, [port]);
});
