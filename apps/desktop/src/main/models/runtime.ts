/**
 * The bundled runtime as the model manager sees it: one llama-server for one model, behind a
 * small interface so the manager is tested with a fake. `bundledRuntimeFactory` builds the real
 * one on `RuntimeSupervisor` from @dawg/models, laid out like `setupModelFile` in
 * packages/cli/src/models.ts (`twoSlotLayout`: slot 0 for conversations, slot 1 for side
 * requests such as titles, on one shared cache), with the CLI's cache settings, under the
 * package's watchdog so llama-server never outlives the app.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import {
  CACHE_BYTES_PER_TOKEN,
  type CatalogEntry,
  type Endpoint,
  entryWeightsBytes,
  maxContextForMemory,
  RuntimeError,
  type RuntimeState,
  RuntimeSupervisor,
  resolveRuntimeBinary,
  twoSlotLayout,
  UTILITY_CONTEXT_RESERVE,
} from "@dawg/models";
import { messageOf } from "./format.ts";

/** Slot 0 for conversations, slot 1 for side requests: what grants hand the engine. The ids are the same for every window. */
export const RUNTIME_SLOTS = twoSlotLayout(1).slotIds;

/** The window a model file gets per slot: its size alone does not say what its cache costs. */
export const MODEL_FILE_CONTEXT = 32_768;
/** No model is loaded with less than this per slot, however tight memory is. */
export const MIN_CONTEXT = 8_192;

/** The CLI's cache settings (packages/cli/src/models.ts). */
export const CACHE_SETTINGS = { cacheRamMiB: 4096, ctxCheckpoints: 8, checkpointMinStep: 256 };

/** What the manager asks the runtime to load. */
export interface RuntimeLaunch {
  /** The model id, passed as `--alias` so `endpoint.model` matches it. */
  modelId: string;
  modelPath: string;
  projectorPath?: string;
  catalogEntry?: CatalogEntry;
  /** The window each slot gets. */
  contextPerSlot: number;
  /** `--sleep-idle-seconds`; absent never unloads. */
  idleUnloadSeconds?: number;
}

export type RuntimeEvent =
  | { type: "state"; state: RuntimeState; reason: string }
  | { type: "ready"; endpoint: Endpoint }
  /** It stopped for good (a crash loop, a load that failed); `start` again to retry. */
  | { type: "failure"; error: Error };

/** One llama-server for one model. */
export interface BundledRuntime {
  readonly state: RuntimeState;
  /** llama-server's pid while it runs. */
  readonly pid: number | undefined;
  readonly logPath: string;
  /** Resolves once ready; rejects when it stops or fails first. */
  start(): Promise<Endpoint>;
  stop(): Promise<void>;
  /** Whether the server unloaded the model after the idle time. */
  isSleeping(): Promise<boolean>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

export type CreateRuntime = (launch: RuntimeLaunch) => Promise<BundledRuntime>;

/**
 * The conversation's window: the catalog entry's default, capped so the shared cache (the window
 * plus the side requests' reserve) fits the memory rule (weights + cache + 2 GB within 70% of
 * memory), and never under `MIN_CONTEXT`. Model files get `MODEL_FILE_CONTEXT`. Rounded down to
 * a multiple of 1024.
 */
export function contextPerSlot(entry: CatalogEntry | undefined, memoryBytes: number): number {
  if (!entry) return MODEL_FILE_CONTEXT;
  const perToken = CACHE_BYTES_PER_TOKEN[entry.source.repo];
  if (perToken === undefined) return Math.max(MIN_CONTEXT, Math.min(entry.context.default, 32_768));
  const cacheTokens = maxContextForMemory(entryWeightsBytes(entry), perToken, memoryBytes);
  const window = Math.min(entry.context.default, cacheTokens - UTILITY_CONTEXT_RESERVE);
  return Math.max(MIN_CONTEXT, Math.floor(window / 1024) * 1024);
}

/** A sentence for a runtime failure. */
export function describeRuntimeError(error: unknown, logPath?: string): string {
  const where = logPath ? ` Its log is in ${logPath}.` : "";
  if (error instanceof RuntimeError) {
    switch (error.code) {
      case "not-found":
        return "The bundled runtime (llama-server) is missing. In a checkout, run pnpm fetch-runtime.";
      case "unsupported-arch":
        return "The bundled runtime does not support this Mac.";
      case "load-timeout":
        return `The model took too long to load.${where}`;
      case "crash-loop":
        return `The runtime kept stopping: ${firstLine(error.message)}.${where}`;
      case "port-unavailable":
        return "The runtime could not find a free local port.";
      case "bad-response":
        return `The runtime gave an answer dawg could not read.${where}`;
      case "stopped":
        return "Loading stopped because another model was started or the runtime was stopped.";
      default:
        return `The runtime could not start: ${firstLine(error.message)}.${where}`;
    }
  }
  return `The runtime could not start: ${firstLine(messageOf(error))}.${where}`;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").replace(/\.$/, "");
}

/** How the watchdog runs (see `RuntimeSupervisor`): it ends llama-server if the app dies. */
export interface WatchdogLaunch {
  /** The watchdog script: `out/main/watchdog.js` in the app, built beside main. */
  path: string;
  /** What runs it: Electron itself (`process.execPath`) with ELECTRON_RUN_AS_NODE=1 in `env`. */
  nodePath: string;
  env?: NodeJS.ProcessEnv;
}

export interface BundledRuntimeOptions {
  dataRoot: string;
  /** Parent of the per-arch runtime folders: `<resources>/runtime`. */
  runtimeDir: string;
  env: NodeJS.ProcessEnv;
  watchdog: WatchdogLaunch;
}

/** The real runtime factory. Rejects with a `RuntimeError` when the binary is missing. */
export function bundledRuntimeFactory(options: BundledRuntimeOptions): CreateRuntime {
  return async (launch) => {
    const { binary } = await resolveRuntimeBinary({
      env: options.env,
      runtimeDir: options.runtimeDir,
    });
    const layout = twoSlotLayout(launch.contextPerSlot);
    const supervisor = new RuntimeSupervisor({
      binary,
      model: {
        path: launch.modelPath,
        ...(launch.projectorPath === undefined ? {} : { projectorPath: launch.projectorPath }),
        ...(launch.catalogEntry === undefined ? {} : { catalogEntry: launch.catalogEntry }),
      },
      contextSize: layout.contextSize,
      slots: layout.slots,
      settings: {
        ...CACHE_SETTINGS,
        ...layout.settings,
        alias: launch.modelId,
        ...(launch.idleUnloadSeconds === undefined
          ? {}
          : { idleUnloadSeconds: launch.idleUnloadSeconds }),
      },
      paths: {
        slotSaveDir: path.join(options.dataRoot, "runtime", "slots"),
        logDir: path.join(options.dataRoot, "logs"),
      },
      watchdog: true,
      watchdogPath: options.watchdog.path,
      nodePath: options.watchdog.nodePath,
      ...(options.watchdog.env === undefined ? {} : { watchdogEnv: options.watchdog.env }),
      env: options.env,
    });
    return adaptSupervisor(supervisor);
  };
}

function adaptSupervisor(supervisor: RuntimeSupervisor): BundledRuntime {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const emit = (event: RuntimeEvent) => {
    for (const listener of listeners) listener(event);
  };
  supervisor.on("state", (state, change) => emit({ type: "state", state, reason: change.reason }));
  supervisor.on("ready", (endpoint) => emit({ type: "ready", endpoint }));
  supervisor.on("failure", (error) => emit({ type: "failure", error }));
  return {
    get state() {
      return supervisor.state;
    },
    get pid() {
      return supervisor.pid;
    },
    get logPath() {
      return supervisor.logPath;
    },
    start: () => supervisor.start(),
    stop: () => supervisor.stop(),
    isSleeping: () => supervisor.isSleeping(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Resident memory of a process, from `ps`; null when it cannot be read. */
export function residentBytes(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
      const kib = Number(String(stdout).trim());
      resolve(error || !Number.isFinite(kib) || kib <= 0 ? null : kib * 1024);
    });
  });
}
