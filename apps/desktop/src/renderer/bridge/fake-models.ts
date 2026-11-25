/**
 * A model manager that runs in the page: the `models` API of the browser fallback bridge and of
 * the tests' bridge. It keeps a `ModelsState` and changes it the way main's manager does:
 * downloads progress on a timer and are then checked and installed, a model takes a moment to
 * load, and remote servers can be added and removed.
 *
 * Tests turn `auto` off and drive it with `advanceDownload`, `failDownload` and `finishLoad`.
 */
import {
  type AddedModelFile,
  type CatalogModel,
  ConnectServerInputSchema,
  type DawgBridge,
  type DownloadState,
  IdleUnloadSchema,
  ModelIdSchema,
  type ModelOption,
  type ModelStatus,
  type ModelsState,
  type ServerInfo,
  type Unsubscribe,
} from "../../shared/bridge.ts";
import { findMockModel, mockModelsState } from "../../shared/mock-models.ts";
import { formatTokens } from "../lib/format.ts";
import { validate } from "./validate.ts";

export type ModelsApi = DawgBridge["models"];

export interface FakeModelManagerOptions {
  /** Where it starts. Default: every mock model installed (`mockModelsState()`). */
  state?: ModelsState;
  /** Downloads progress by themselves and loads finish after `loadMs`. Default true. */
  auto?: boolean;
  /** Download speed while `auto`. Default 1.5 GB/s, so a mock download takes about 20 s. */
  bytesPerSecond?: number;
  /** How often a running download moves on while `auto`. Default 250 ms, as main sends it. */
  tickMs?: number;
  /** How long a model takes to load while `auto`. Default 1.5 s. */
  loadMs?: number;
  /** What "Add a model file…" answers; null as if the picker was cancelled. Default: a sample file. */
  modelFile?: AddedModelFile | null;
}

export interface FakeModelManager {
  readonly api: ModelsApi;
  /** A copy of the state as it stands. */
  current(): ModelsState;
  /** Moves a download on by `bytes`, or to the end (then it is checked and installed). */
  advanceDownload(modelId: string, bytes?: number): void;
  failDownload(modelId: string, error: string): void;
  /** Ends the load `start` waits for: ready, or failed with `error`. */
  finishLoad(error?: string): void;
  /** Replaces the runtime's status, as a crash or an idle unload would. */
  setStatus(status: ModelStatus): void;
  /** Stops its timers. */
  dispose(): void;
}

const ACTIVE: readonly DownloadState["phase"][] = [
  "queued",
  "checking",
  "downloading",
  "verifying",
];

const GIB = 2 ** 30;

/** A short stable hash, for remote server ids ("remote:1f3a9c"). FNV-1a. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function optionFor(entry: CatalogModel, origin: ModelOption["origin"]): ModelOption {
  const known = findMockModel(entry.id)?.option;
  const base: ModelOption = known
    ? { ...known }
    : {
        id: entry.id,
        label: entry.displayName,
        shortLabel: entry.shortLabel,
        description: `Bundled runtime · ${formatTokens(entry.context.default)} context`,
        source: "bundled",
        contextWindow: entry.context.default,
        origin,
        removable: origin === "catalog",
      };
  return { ...base, origin, removable: origin === "catalog" };
}

function sampleModelFile(state: ModelsState): AddedModelFile {
  const needs = 20 * GIB;
  const memory = Math.round(state.machine.memoryBytes / GIB);
  return {
    option: {
      id: `file:${shortHash("/Users/you/Models/my-model-Q4_K_M.gguf")}`,
      label: "my-model-Q4_K_M.gguf",
      shortLabel: "my-model · Q4_K_M",
      description: "Model file · ~/Models/my-model-Q4_K_M.gguf · 32K context",
      source: "bundled",
      contextWindow: 32_768,
      origin: "file",
      removable: false,
    },
    memoryWarning:
      state.machine.memoryBytes < needs * 1.5
        ? `This model may need more memory than this Mac has (about 20 GB; this Mac has ${memory} GB). It may load slowly or not at all.`
        : null,
  };
}

export function createFakeModelManager(options: FakeModelManagerOptions = {}): FakeModelManager {
  const auto = options.auto ?? true;
  const bytesPerSecond = options.bytesPerSecond ?? 1_500_000_000;
  const tickMs = options.tickMs ?? 250;
  const loadMs = options.loadMs ?? 1500;
  let state: ModelsState = structuredClone(options.state ?? mockModelsState());
  const stateListeners = new Set<(state: ModelsState) => void>();
  const statusListeners = new Set<(status: ModelStatus) => void>();
  let lastStatus = JSON.stringify(state.status);
  let ticker: ReturnType<typeof setInterval> | null = null;
  let load: {
    modelId: string;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  function emit(): void {
    for (const listener of [...stateListeners]) listener(structuredClone(state));
    const status = JSON.stringify(state.status);
    if (status !== lastStatus) {
      lastStatus = status;
      for (const listener of [...statusListeners]) listener({ ...state.status });
    }
  }

  function subscribe<T>(set: Set<(value: T) => void>, listener: (value: T) => void): Unsubscribe {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  function entryOf(modelId: string): CatalogModel {
    const entry = state.catalog.find((candidate) => candidate.id === modelId);
    if (!entry) throw new Error(`There is no catalog model called ${modelId}`);
    return entry;
  }

  function downloadOf(modelId: string): DownloadState | undefined {
    return state.downloads.find((download) => download.modelId === modelId);
  }

  function putDownload(next: DownloadState): void {
    const others = state.downloads.filter((download) => download.modelId !== next.modelId);
    state = { ...state, downloads: [...others, next] };
  }

  function setEntryState(modelId: string, entryState: CatalogModel["state"]): void {
    state = {
      ...state,
      catalog: state.catalog.map((entry) =>
        entry.id === modelId ? { ...entry, state: entryState } : entry,
      ),
    };
  }

  /** Installed models, the default first. */
  function withInstalled(installed: ModelOption[]): ModelOption[] {
    const first = installed.filter((option) => option.id === state.defaultModelId);
    return [...first, ...installed.filter((option) => option.id !== state.defaultModelId)];
  }

  function install(option: ModelOption): void {
    if (state.installed.some((existing) => existing.id === option.id)) return;
    state = { ...state, installed: withInstalled([...state.installed, option]) };
  }

  /** Drops models; a default among them gives way to the first one left. */
  function uninstall(ids: readonly string[]): void {
    const installed = state.installed.filter((option) => !ids.includes(option.id));
    const defaultModelId =
      state.defaultModelId !== null && ids.includes(state.defaultModelId)
        ? (installed[0]?.id ?? null)
        : state.defaultModelId;
    state = { ...state, installed, defaultModelId };
    state = { ...state, installed: withInstalled(state.installed) };
  }

  function complete(download: DownloadState): void {
    putDownload({
      ...download,
      phase: "done",
      bytesDone: download.bytesTotal,
      bytesPerSecond: 0,
      secondsLeft: null,
      error: null,
    });
    setEntryState(download.modelId, "installed");
    install(optionFor(entryOf(download.modelId), "catalog"));
  }

  function tick(): void {
    let active = false;
    for (const download of state.downloads) {
      if (download.phase === "queued" || download.phase === "checking") {
        putDownload({ ...download, phase: "downloading" });
        active = true;
      } else if (download.phase === "downloading") {
        const bytesDone = Math.min(
          download.bytesTotal,
          Math.round(download.bytesDone + (bytesPerSecond * tickMs) / 1000),
        );
        const finished = bytesDone >= download.bytesTotal;
        putDownload({
          ...download,
          phase: finished ? "verifying" : "downloading",
          bytesDone,
          bytesPerSecond: finished ? 0 : bytesPerSecond,
          secondsLeft: finished ? null : (download.bytesTotal - bytesDone) / bytesPerSecond,
        });
        active = true;
      } else if (download.phase === "verifying") {
        complete(download);
      }
    }
    if (!active) stopTicker();
    emit();
  }

  function startTicker(): void {
    if (!auto || ticker !== null) return;
    ticker = setInterval(tick, tickMs);
  }

  function stopTicker(): void {
    if (ticker === null) return;
    clearInterval(ticker);
    ticker = null;
  }

  function settleLoad(error: string | null): void {
    const pending = load;
    if (!pending) return;
    load = null;
    if (pending.timer !== null) clearTimeout(pending.timer);
    const option = state.installed.find((candidate) => candidate.id === pending.modelId);
    if (error === null) {
      const entry = state.catalog.find((candidate) => candidate.id === pending.modelId);
      state = {
        ...state,
        status: {
          state: "ready",
          modelId: pending.modelId,
          label: option?.shortLabel ?? pending.modelId,
          message: null,
          memoryBytes: entry?.memoryBytes ?? 12 * GIB,
        },
      };
      emit();
      pending.resolve();
    } else {
      state = {
        ...state,
        status: {
          state: "error",
          modelId: null,
          label: null,
          message: error,
          memoryBytes: null,
        },
      };
      emit();
      pending.reject(new Error(error));
    }
  }

  function installedOption(modelId: string): ModelOption {
    const option = state.installed.find((candidate) => candidate.id === modelId);
    if (!option) throw new Error(`No model called ${modelId} is on this Mac`);
    return option;
  }

  const api: ModelsApi = {
    list: async () => structuredClone(state.installed),
    status: async () => ({ ...state.status }),
    onStatus: (listener) => subscribe(statusListeners, listener),
    state: async () => structuredClone(state),
    onState: (listener) => subscribe(stateListeners, listener),

    async download(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const entry = entryOf(id);
      if (entry.state === "installed") return;
      if (!entry.fits)
        throw new Error(entry.fitNote ?? `${entry.displayName} does not fit this Mac`);
      const existing = downloadOf(id);
      if (existing && ACTIVE.includes(existing.phase)) return;
      // Paused and failed downloads carry on from where they stopped.
      const resumable = existing?.phase === "paused" || existing?.phase === "failed";
      putDownload({
        modelId: id,
        phase: "checking",
        bytesDone: resumable ? existing.bytesDone : 0,
        bytesTotal: entry.sizeBytes,
        bytesPerSecond: 0,
        secondsLeft: null,
        error: null,
      });
      setEntryState(id, "downloading");
      emit();
      startTicker();
    },
    async pauseDownload(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const download = downloadOf(id);
      if (!download || !ACTIVE.includes(download.phase)) return;
      putDownload({ ...download, phase: "paused", bytesPerSecond: 0, secondsLeft: null });
      setEntryState(id, "paused");
      emit();
    },
    async cancelDownload(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const download = downloadOf(id);
      if (!download || download.phase === "done" || download.phase === "cancelled") return;
      putDownload({
        ...download,
        phase: "cancelled",
        bytesDone: 0,
        bytesPerSecond: 0,
        secondsLeft: null,
        error: null,
      });
      setEntryState(id, "available");
      emit();
    },
    async dismissDownload(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const download = downloadOf(id);
      if (!download || ACTIVE.includes(download.phase) || download.phase === "paused") return;
      state = { ...state, downloads: state.downloads.filter((item) => item.modelId !== id) };
      emit();
    },
    async useExisting(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const entry = entryOf(id);
      if (entry.foundIn === null)
        throw new Error(`No other app has a copy of ${entry.displayName}`);
      const origin = entry.foundIn === "huggingface" ? "catalog" : entry.foundIn;
      setEntryState(id, "installed");
      install({ ...optionFor(entry, origin), removable: false });
      emit();
    },
    async remove(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const option = installedOption(id);
      if (!option.removable)
        throw new Error(`dawg did not download ${option.label}, so it leaves it`);
      if (state.status.modelId === id) {
        settleLoad("The model was deleted");
        state = {
          ...state,
          status: {
            state: "stopped",
            modelId: null,
            label: null,
            message: "Stopped",
            memoryBytes: null,
          },
        };
      }
      uninstall([id]);
      if (state.catalog.some((entry) => entry.id === id)) setEntryState(id, "available");
      emit();
    },
    async start(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      const option = installedOption(id);
      if (option.source === "server") {
        const server = state.servers.find((candidate) => id.startsWith(`${candidate.id}/`));
        if (server && !server.reachable) throw new Error(`${server.url} did not answer`);
        return;
      }
      if (state.status.state === "ready" && state.status.modelId === id) return;
      settleLoad("Another model was started");
      state = {
        ...state,
        status: {
          state: "loading",
          modelId: id,
          label: option.shortLabel,
          message: "Loading into memory",
          memoryBytes: null,
        },
      };
      emit();
      return new Promise<void>((resolve, reject) => {
        load = {
          modelId: id,
          resolve,
          reject,
          timer: auto ? setTimeout(() => settleLoad(null), loadMs) : null,
        };
      });
    },
    async stop() {
      settleLoad("The model was stopped");
      state = {
        ...state,
        status: {
          state: "stopped",
          modelId: null,
          label: null,
          message: "Stopped",
          memoryBytes: null,
        },
      };
      emit();
    },
    async setDefault(modelId) {
      const id = validate(ModelIdSchema, modelId, "model id");
      installedOption(id);
      state = { ...state, defaultModelId: id };
      state = { ...state, installed: withInstalled(state.installed) };
      emit();
    },
    async setIdleUnload(minutes) {
      state = { ...state, idleUnloadMinutes: validate(IdleUnloadSchema, minutes, "idle time") };
      emit();
    },
    async addModelFile() {
      const added = options.modelFile === undefined ? sampleModelFile(state) : options.modelFile;
      if (added === null) return null;
      install({ ...added.option });
      emit();
      return structuredClone(added);
    },
    async connectServer(input) {
      const valid = validate(ConnectServerInputSchema, input, "server");
      const url = new URL(valid.url);
      url.username = "";
      url.password = "";
      const shown = url.href.replace(/\/$/, "");
      if (/unreachable|invalid/.test(url.hostname)) {
        throw new Error(`Could not reach ${shown}: it did not answer within 5 seconds`);
      }
      const id = `remote:${shortHash(shown)}`;
      const existing = state.servers.find((server) => server.id === id);
      if (existing) {
        const updated: ServerInfo = { ...existing, hasKey: valid.apiKey !== undefined };
        state = {
          ...state,
          servers: state.servers.map((server) => (server.id === id ? updated : server)),
        };
        emit();
        return { ...updated, modelIds: [...updated.modelIds] };
      }
      const modelId = `${id}/gpt-oss-120b`;
      const server: ServerInfo = {
        id,
        kind: "remote",
        url: shown,
        reachable: true,
        modelIds: [modelId],
        hasKey: valid.apiKey !== undefined,
      };
      state = { ...state, servers: [...state.servers, server] };
      install({
        id: modelId,
        label: `${url.host} · gpt-oss-120b`,
        shortLabel: `gpt-oss-120b · ${url.hostname}`,
        description: `${url.host} · 128K context`,
        source: "server",
        contextWindow: 131_072,
        origin: "remote",
        removable: false,
      });
      emit();
      return { ...server, modelIds: [...server.modelIds] };
    },
    async removeServer(serverId) {
      const id = validate(ModelIdSchema, serverId, "server id");
      const server = state.servers.find((candidate) => candidate.id === id);
      if (!server) throw new Error(`There is no server called ${id}`);
      if (server.kind !== "remote") {
        throw new Error("dawg finds Ollama and LM Studio by itself; quit them to stop using them");
      }
      state = { ...state, servers: state.servers.filter((candidate) => candidate.id !== id) };
      uninstall(server.modelIds);
      emit();
    },
    async refreshServers() {
      emit();
    },
  };

  return {
    api,
    current: () => structuredClone(state),
    advanceDownload(modelId, bytes) {
      const download = downloadOf(modelId);
      if (!download) throw new Error(`No download of ${modelId}`);
      const bytesDone =
        bytes === undefined
          ? download.bytesTotal
          : Math.min(download.bytesTotal, download.bytesDone + bytes);
      if (bytesDone >= download.bytesTotal) {
        complete({ ...download, bytesDone });
      } else {
        putDownload({
          ...download,
          phase: "downloading",
          bytesDone,
          bytesPerSecond,
          secondsLeft: (download.bytesTotal - bytesDone) / bytesPerSecond,
        });
        setEntryState(modelId, "downloading");
      }
      emit();
    },
    failDownload(modelId, error) {
      const download = downloadOf(modelId);
      if (!download) throw new Error(`No download of ${modelId}`);
      putDownload({ ...download, phase: "failed", bytesPerSecond: 0, secondsLeft: null, error });
      setEntryState(modelId, "failed");
      emit();
    },
    finishLoad(error) {
      settleLoad(error ?? null);
    },
    setStatus(status) {
      state = { ...state, status: { ...status } };
      emit();
    },
    dispose() {
      stopTicker();
      if (load?.timer != null) clearTimeout(load.timer);
    },
  };
}
