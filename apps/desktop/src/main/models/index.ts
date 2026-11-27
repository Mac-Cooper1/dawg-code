/**
 * Builds the model service for main: the real manager on @dawg/models, or the mock with
 * DAWG_ENGINE=mock. The only file here that touches Electron (`safeStorage` for server keys).
 *
 * Environment:
 * - DAWG_ENGINE: "mock" serves shared/mock-models.ts; anything else (the default) is "real".
 * - DAWG_CATALOG: a catalog file to use instead of the bundled one (tests).
 * - DAWG_TEST_SERVER_URL: an OpenAI-compatible server added without a key, its first model the
 *   default; the scan and the Ollama / LM Studio probes are skipped (end-to-end tests).
 * - DAWG_TEST_SERVER_SLOTS: "1" makes sessions share that server's slots as they share the
 *   bundled runtime's, so they queue for one conversation slot (end-to-end tests).
 * - DAWG_RUNTIME_BIN: another llama-server binary (read by `resolveRuntimeBinary`).
 */
import path from "node:path";
import {
  connectRemote,
  defaultFreeSpace,
  defaultLmStudioDir,
  defaultOllamaDir,
  detectLocalServers,
  discardPartialDownload,
  downloadEntry,
  loadCatalog,
  probeHardware,
  probeLmStudio,
  probeOllama,
  readHelperEnabled,
  resolveHubCacheDir,
  scanExistingModels,
  writeHelperEnabled,
} from "@dawg/models";
import { safeStorage } from "electron";
import type { Logger } from "../json-file.ts";
import { createKeyStore } from "./keys.ts";
import { type ModelBackend, ModelManager } from "./manager.ts";
import { createMockModelService } from "./mock.ts";
import { bundledRuntimeFactory, residentBytes, type WatchdogLaunch } from "./runtime.ts";
import type { ModelService } from "./service.ts";
import { createModelsStore, modelsFilePath } from "./store.ts";

export type EngineMode = "mock" | "real";

export function engineMode(env: NodeJS.ProcessEnv): EngineMode {
  return env.DAWG_ENGINE?.trim() === "mock" ? "mock" : "real";
}

/**
 * The app's resources folder: `<app>/Contents/Resources` when packaged, `apps/desktop/resources`
 * in a checkout (main runs from `out/main`). Holds the runtime, the icon and, when packaged, the
 * catalog.
 */
export function resolveResourcesDir(isPackaged: boolean, mainDir: string): string {
  return isPackaged ? process.resourcesPath : path.resolve(mainDir, "../../resources");
}

/** DAWG_CATALOG, else the catalog shipped with the app (the repo's copy in a checkout). */
export function catalogPath(
  env: NodeJS.ProcessEnv,
  resourcesDir: string,
  isPackaged: boolean,
): string {
  const override = env.DAWG_CATALOG?.trim();
  if (override) return path.resolve(override);
  return isPackaged
    ? path.join(resourcesDir, "catalog.json")
    : path.resolve(resourcesDir, "../../../catalog/catalog.json");
}

export interface ModelServiceOptions {
  env: NodeJS.ProcessEnv;
  dataRoot: string;
  homeDir: string;
  resourcesDir: string;
  isPackaged: boolean;
  /** Where main's bundle is (`out/main`): the runtime's watchdog is built beside it. */
  mainDir: string;
  log: Logger;
}

/**
 * The runtime's watchdog in the app: `watchdog.js`, built beside main from the package's script
 * (a second entry of the main build), run by Electron itself as plain Node.
 */
export function appWatchdog(mainDir: string): WatchdogLaunch {
  return {
    path: path.join(mainDir, "watchdog.js"),
    nodePath: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function createModelService(options: ModelServiceOptions): ModelService {
  if (engineMode(options.env) === "mock") return createMockModelService();
  const { env, dataRoot, homeDir, log } = options;
  const hubDir = resolveHubCacheDir(env, homeDir);
  const bundledPath = catalogPath(env, options.resourcesDir, options.isPackaged);

  const backend: ModelBackend = {
    probeHardware: () => probeHardware({ modelCacheDir: hubDir }),
    freeSpace: defaultFreeSpace,
    loadCatalog: async () => (await loadCatalog({ bundledPath })).catalog.entries,
    download: (entry, download) => downloadEntry(entry, download),
    discardPartial: (entry, dir) => discardPartialDownload(entry, { hubDir: dir }),
    scan: ({ catalog, hubDir: dir, signal }) =>
      scanExistingModels({
        catalog,
        hubDir: dir,
        lmStudioDir: defaultLmStudioDir(homeDir),
        ollamaDir: defaultOllamaDir(env, homeDir),
        hashCacheFile: path.join(dataRoot, "cache", "file-hashes.json"),
        signal,
      }),
    detectLocalServers: () => detectLocalServers(),
    probeLocalServer: (kind, baseUrl) => {
      const url = new URL(baseUrl);
      const probe = { host: url.hostname, port: Number(url.port), timeoutMs: 1500 };
      return kind === "ollama" ? probeOllama(probe) : probeLmStudio(probe);
    },
    connectRemote: (remote) => connectRemote(remote),
    createRuntime: bundledRuntimeFactory({
      dataRoot,
      runtimeDir: path.join(options.resourcesDir, "runtime"),
      env,
      watchdog: appWatchdog(options.mainDir),
    }),
    residentBytes,
  };

  const testServerUrl = env.DAWG_TEST_SERVER_URL?.trim();
  return new ModelManager({
    backend,
    store: createModelsStore(modelsFilePath(dataRoot), log),
    keys: createKeyStore(dataRoot, safeStorage, log),
    hubDir,
    log,
    // Shared with the command line, which follows the same choice.
    helperPreference: {
      read: () => readHelperEnabled(dataRoot),
      write: (enabled) => writeHelperEnabled(dataRoot, enabled),
    },
    ...(testServerUrl ? { testServerUrl } : {}),
    ...(testServerUrl && env.DAWG_TEST_SERVER_SLOTS === "1" ? { testServerSlots: true } : {}),
  });
}
