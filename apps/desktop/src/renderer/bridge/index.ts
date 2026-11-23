/**
 * The renderer's only way out of the sandbox. Contract: keep these exports and signatures.
 *
 * `getBridge()` returns the Electron bridge (the preload's `window.dawgPreload`, plus engine
 * ports received through `window.postMessage`), or, when the page runs in a plain browser
 * (Vite dev server, previews), an in-memory bridge whose engine is the mock engine running in
 * the page.
 */
import { type DawgBridge, PRELOAD_GLOBAL, type PreloadApi } from "../../shared/bridge.ts";
import { createElectronBridge } from "./electron.ts";
import { createMemoryBridge } from "./memory.ts";

export {
  BROWSER_CHOSEN_FOLDER,
  BROWSER_HOME_DIR,
  createMemoryBridge,
  type EngineLike,
  type MemoryBridge,
  type MemoryBridgeOptions,
  type StorageLike,
} from "./memory.ts";

let override: DawgBridge | null = null;
let memo: DawgBridge | null = null;

/** The bridge for this page. Memoised. */
export function getBridge(): DawgBridge {
  if (override) return override;
  memo ??= createPageBridge();
  return memo;
}

/** Tests only: makes `getBridge()` return the given bridge (null restores the default). */
export function setBridgeForTests(bridge: DawgBridge | null): void {
  override = bridge;
}

function createPageBridge(): DawgBridge {
  const page = globalThis.window as (Window & { [PRELOAD_GLOBAL]?: PreloadApi }) | undefined;
  const preload = page?.[PRELOAD_GLOBAL];
  if (page && preload) return createElectronBridge(preload, page);
  return createMemoryBridge();
}
