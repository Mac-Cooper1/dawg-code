/**
 * The model manager: everything Settings → Models and the welcome screen show, and the models
 * the engine host asks for. Built on @dawg/models (hardware probe, catalog and recommendation,
 * downloader, scanner, server detection, runtime supervisor), each reached through `ModelBackend`
 * so the manager is unit-tested with fakes.
 *
 * - State is assembled whole on every change and sent to every window; download progress is
 *   throttled to about 4 updates a second.
 * - Downloads run one at a time. Pause keeps the partial files; cancel removes them. Unfinished
 *   downloads are saved and picked up again at the next launch.
 * - The bundled runtime runs one model at a time. Loading another model replaces it. Every time
 *   the runtime becomes ready (a load, a restart after a crash) `generation` grows and the engine
 *   host is told its grants may be out of date.
 * - Server keys live in the Keychain (keys.ts) and are read only to make a request.
 */
import { open, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  type CatalogEntry,
  cachePaths,
  type DiscoveredModel,
  type DiscoveredServer,
  DownloadError,
  type DownloadedEntry,
  type DownloadProgress,
  type Endpoint,
  type ExistingCopy,
  entryMemoryNeed,
  entryTargets,
  entryWeightsBytes,
  type HardwareProfile,
  MEMORY_BUDGET_FRACTION,
  type RemoteResult,
  RUNTIME_OVERHEAD_BYTES,
  type RuntimeState,
  recommend,
  toEndpoint,
  workingSetBytes,
} from "@dawg/models";
import type {
  AddedModelFile,
  CatalogModel,
  ConnectServerInput,
  DownloadState,
  MachineInfo,
  ModelOption,
  ModelStatus,
  ModelsState,
  ServerInfo,
} from "../../shared/bridge.ts";
import type { ModelGrant } from "../../shared/engine-host-messages.ts";
import type { Logger } from "../json-file.ts";
import {
  displayUrl,
  fileLabel,
  fileModelId,
  formatContext,
  formatDisk,
  formatMemory,
  hostOf,
  messageOf,
  remoteServerId,
  serverModelId,
  shortLabelFor,
  splitServerModelId,
} from "./format.ts";
import type { KeyStore } from "./keys.ts";
import {
  type BundledRuntime,
  type CreateRuntime,
  contextPerSlot,
  describeRuntimeError,
  MODEL_FILE_CONTEXT,
  RUNTIME_SLOTS,
  type RuntimeEvent,
  type RuntimeLaunch,
} from "./runtime.ts";
import { listeners, type ModelAnswer, type ModelService } from "./service.ts";
import type {
  InstalledRecord,
  ModelFileRecord,
  ModelsFile,
  ModelsStore,
  PendingDownload,
} from "./store.ts";

export const NO_MODEL_MESSAGE = "No model is installed yet. Download one in Settings → Models.";

/** Everything the manager reaches outside itself. `models/index.ts` plugs in @dawg/models. */
export interface ModelBackend {
  probeHardware(): Promise<HardwareProfile>;
  freeSpace(dir: string): Promise<number>;
  loadCatalog(): Promise<readonly CatalogEntry[]>;
  download(
    entry: CatalogEntry,
    options: {
      hubDir: string;
      signal: AbortSignal;
      onProgress: (progress: DownloadProgress) => void;
    },
  ): Promise<DownloadedEntry>;
  discardPartial(entry: CatalogEntry, hubDir: string): Promise<void>;
  scan(options: {
    catalog: readonly CatalogEntry[];
    hubDir: string;
    signal: AbortSignal;
  }): Promise<ExistingCopy[]>;
  detectLocalServers(): Promise<DiscoveredServer[]>;
  /** Asks Ollama or LM Studio at `baseUrl` (its `/v1` root) for its models; null when it does not answer. */
  probeLocalServer(kind: "ollama" | "lmstudio", baseUrl: string): Promise<DiscoveredServer | null>;
  connectRemote(options: { url: string; apiKey?: string }): Promise<RemoteResult>;
  createRuntime: CreateRuntime;
  residentBytes(pid: number): Promise<number | null>;
}

export interface ModelManagerOptions {
  backend: ModelBackend;
  store: ModelsStore;
  keys: KeyStore;
  /** The Hugging Face hub cache, where downloads go. */
  hubDir: string;
  log: Logger;
  /**
   * DAWG_TEST_SERVER_URL: added as a remote server (in memory, no key) whose first model is the
   * default. Set for end-to-end tests, which also skip the scan and the local server probes.
   */
  testServerUrl?: string;
  /**
   * DAWG_TEST_SERVER_SLOTS: the test server's grants carry the bundled runtime's slots, so
   * sessions share one conversation slot and queue for it as they do on the bundled runtime.
   * For end-to-end tests of several sessions at once.
   */
  testServerSlots?: boolean;
  /** Minimum time between state updates caused by download progress. Default 250 ms. */
  progressIntervalMs?: number;
  /** How often the runtime's memory (and idle sleep) is read. Default 5 s. */
  pollIntervalMs?: number;
}

type ServerKind = "ollama" | "lmstudio" | "remote";

interface ServerRecord {
  id: string;
  kind: ServerKind;
  /** OpenAI-compatible root, with `/v1`. */
  baseUrl: string;
  reachable: boolean;
  models: DiscoveredModel[];
  /** In memory only: the test hook's server. */
  ephemeral: boolean;
}

interface DownloadRecord extends DownloadState {
  controller?: AbortController;
  /** Why the running transfer is being aborted. */
  stopAs?: "pause" | "cancel";
  /** Settles when the running transfer has stopped. */
  settled?: Promise<void>;
}

interface LoadedRuntime {
  modelId: string;
  handle: BundledRuntime | null;
  state: RuntimeState;
  endpoint: Endpoint | null;
  /** A sentence once it failed for good; it stays until the next load. */
  error: string | null;
  restarting: boolean;
  memoryBytes: number | null;
  sleeping: boolean;
  unsubscribe: () => void;
}

/** A refusal that carries whether asking again later may work. */
export class ModelError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ModelError";
    this.retryable = retryable;
  }
}

const ACTIVE_PHASES = new Set<DownloadState["phase"]>([
  "queued",
  "checking",
  "downloading",
  "verifying",
]);
const ENDED_PHASES = new Set<DownloadState["phase"]>(["done", "failed", "cancelled"]);
const LOCAL_KINDS = ["ollama", "lmstudio"] as const;
/** How many times the end-to-end test hook asks its server before giving up (about 4 s in all). */
const TEST_SERVER_TRIES = 5;
const SERVER_NAMES: Record<"ollama" | "lmstudio", string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export class ModelManager implements ModelService {
  private readonly backend: ModelBackend;
  private readonly options: ModelManagerOptions;
  private readonly log: Logger;

  private ready: Promise<void> | null = null;
  private loaded = false;
  private disposed = false;

  private saved: ModelsFile = {
    installed: [],
    files: [],
    servers: [],
    defaultModelId: null,
    idleUnloadMinutes: null,
    downloads: [],
  };
  private machine: HardwareProfile | null = null;
  private catalog: readonly CatalogEntry[] = [];
  private readonly downloads = new Map<string, DownloadRecord>();
  private activeDownload: string | null = null;
  private readonly found = new Map<string, ExistingCopy>();
  private readonly servers = new Map<string, ServerRecord>();
  private serversChecked: Promise<void> = Promise.resolve();
  private runtime: LoadedRuntime | null = null;
  private pendingLoad: { modelId: string; promise: Promise<Endpoint> } | null = null;
  private runtimeQueue: Promise<unknown> = Promise.resolve();
  private generation = 0;

  private scanAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;
  private lastStatus = "";

  private readonly stateListeners = listeners<[ModelsState]>();
  private readonly statusListeners = listeners<[ModelStatus]>();
  private readonly changeListeners = listeners<[]>();

  constructor(options: ModelManagerOptions) {
    this.options = options;
    this.backend = options.backend;
    this.log = options.log;
  }

  // -------------------------------------------------------------------------------------------
  // Start and stop
  // -------------------------------------------------------------------------------------------

  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    this.saved = await this.options.store.load();
    await this.options.keys.load();
    const [machine, catalog] = await Promise.all([
      this.backend.probeHardware().catch((error: unknown) => {
        this.log(`Could not read this Mac's hardware: ${messageOf(error)}`);
        return null;
      }),
      this.backend.loadCatalog().catch((error: unknown) => {
        this.log(`Could not load the model catalog: ${messageOf(error)}`);
        return [] as readonly CatalogEntry[];
      }),
    ]);
    this.machine = machine;
    this.catalog = catalog;
    await this.dropMissingModels();
    await this.restoreDownloads();
    this.loaded = true;

    const quick = this.options.testServerUrl !== undefined;
    if (this.options.testServerUrl !== undefined) {
      await this.connectTestServer(this.options.testServerUrl);
    }
    this.serversChecked = this.checkServersAtStart(quick);
    if (!quick) this.startScan();
    this.pollTimer = setInterval(
      () => void this.pollRuntime(),
      this.options.pollIntervalMs ?? 5000,
    );
    this.pollTimer.unref?.();
    this.pump();
    this.changed();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ready) await this.ready.catch(() => {});
    this.scanAbort?.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    // Nothing was loaded (a second instance quitting at once): nothing to save or stop.
    if (!this.loaded) return;
    // Saved first: the running download is picked up again at the next launch.
    await this.save().catch((error: unknown) =>
      this.log(`Could not save models: ${messageOf(error)}`),
    );
    const active = this.activeDownload ? this.downloads.get(this.activeDownload) : undefined;
    active?.controller?.abort();
    await active?.settled;
    // Stopping the handle first ends a load in progress, so the queue is free for the unload.
    await this.runtime?.handle?.stop().catch(() => {});
    await this.serial(() => this.unload());
  }

  /**
   * Forgets installed models whose files are gone (deleted by hand, or by the app that had them).
   * One the catalog does not list (it failed to load, or dropped the entry) is kept but not shown.
   */
  private async dropMissingModels(): Promise<void> {
    const kept: InstalledRecord[] = [];
    for (const record of this.saved.installed) {
      if (await isFile(record.modelPath)) kept.push(record);
      else this.log(`Forgetting ${record.id}: ${record.modelPath} is gone.`);
    }
    const files: ModelFileRecord[] = [];
    for (const file of this.saved.files) {
      if (await isFile(file.path)) files.push(file);
      else this.log(`Forgetting the model file ${file.path}: it is gone.`);
    }
    if (kept.length !== this.saved.installed.length || files.length !== this.saved.files.length) {
      this.saved = { ...this.saved, installed: kept, files };
      await this.save();
    }
  }

  private async restoreDownloads(): Promise<void> {
    for (const pending of this.saved.downloads) {
      const entry = this.entry(pending.modelId);
      if (!entry || this.installedRecord(entry.id)) continue;
      this.downloads.set(entry.id, {
        ...this.newDownload(entry),
        phase: pending.phase,
        bytesDone: await this.bytesOnDisk(entry),
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  async state(): Promise<ModelsState> {
    await this.init();
    return this.buildState();
  }

  async list(): Promise<ModelOption[]> {
    await this.init();
    return this.installedOptions();
  }

  async status(): Promise<ModelStatus> {
    await this.init();
    return this.runtimeStatus();
  }

  onState(listener: (state: ModelsState) => void) {
    return this.stateListeners.add(listener);
  }

  onStatus(listener: (status: ModelStatus) => void) {
    return this.statusListeners.add(listener);
  }

  onModelsChanged(listener: () => void) {
    return this.changeListeners.add(listener);
  }

  private buildState(): ModelsState {
    const installed = this.installedOptions();
    return {
      machine: this.machineInfo(),
      installed,
      catalog: this.catalogView(),
      downloads: [...this.downloads.values()].map(publicDownload),
      servers: this.serverList(),
      status: this.runtimeStatus(),
      defaultModelId: this.effectiveDefault(installed),
      idleUnloadMinutes: this.saved.idleUnloadMinutes,
    };
  }

  /**
   * Something changed. Progress waits so updates go out at most every `progressIntervalMs`;
   * anything else goes out at once.
   */
  private changed(kind: "now" | "progress" = "now"): void {
    if (!this.loaded || this.disposed) return;
    if (kind === "now") {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.flush();
      return;
    }
    if (this.emitTimer) return;
    const interval = this.options.progressIntervalMs ?? 250;
    const wait = Math.max(0, this.lastEmitAt + interval - Date.now());
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    this.lastEmitAt = Date.now();
    const state = this.buildState();
    this.stateListeners.emit(state);
    const status = JSON.stringify(state.status);
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.statusListeners.emit(state.status);
    }
  }

  private modelsChanged(): void {
    if (!this.disposed) this.changeListeners.emit();
  }

  private machineInfo(): MachineInfo {
    const machine = this.machine;
    return {
      chip: machine?.chip || "Unknown chip",
      arch: machine?.arch ?? (process.arch === "arm64" ? "arm64" : "x64"),
      memoryBytes: machine?.memoryBytes ?? 0,
      freeDiskBytes: machine?.freeDiskBytes ?? 0,
      macosVersion: machine?.macosVersion ?? "",
    };
  }

  private async refreshFreeDisk(): Promise<void> {
    if (!this.machine) return;
    try {
      this.machine = {
        ...this.machine,
        freeDiskBytes: await this.backend.freeSpace(this.options.hubDir),
      };
    } catch {
      // Keep the last reading.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Catalog and installed models
  // -------------------------------------------------------------------------------------------

  private entry(id: string): CatalogEntry | undefined {
    return this.catalog.find((entry) => entry.id === id);
  }

  private installedRecord(id: string): InstalledRecord | undefined {
    return this.saved.installed.find((record) => record.id === id);
  }

  private fileRecord(id: string): ModelFileRecord | undefined {
    return this.saved.files.find((file) => file.id === id);
  }

  /** Entries that fit this Mac, best first, then the rest by rank. */
  private orderedCatalog(): { entries: CatalogEntry[]; recommendedId: string | null } {
    const fitting = this.machine ? recommend(this.machine, this.catalog) : [];
    const fitIds = new Set(fitting.map((entry) => entry.id));
    const rest = this.catalog
      .filter((entry) => !fitIds.has(entry.id))
      .sort((a, b) => b.rank - a.rank || a.minMemoryBytes - b.minMemoryBytes);
    return { entries: [...fitting, ...rest], recommendedId: fitting[0]?.id ?? null };
  }

  private catalogView(): CatalogModel[] {
    const { entries, recommendedId } = this.orderedCatalog();
    return entries.map((entry) => {
      const installed = this.installedRecord(entry.id) !== undefined;
      const fitNote = this.fitNote(entry, installed);
      const copy = this.found.get(entry.id);
      return {
        id: entry.id,
        displayName: entry.displayName,
        shortLabel: shortLabelFor(entry.displayName),
        licence: { ...entry.licence },
        sizeBytes: entryWeightsBytes(entry),
        memoryBytes: memoryNeedBytes(entry),
        context: { ...entry.context },
        capabilities: { ...entry.capabilities },
        recommended: entry.id === recommendedId,
        fits: fitNote === null,
        fitNote,
        state: installed ? "installed" : catalogDownloadState(this.downloads.get(entry.id)),
        foundIn: !installed && copy?.ready && copy.model ? copy.model.source : null,
      };
    });
  }

  private fitNote(entry: CatalogEntry, installed: boolean): string | null {
    const machine = this.machine;
    if (!machine) return null;
    if (machine.arch !== "arm64" || machine.chipClass === "intel") {
      return "Needs a Mac with Apple silicon.";
    }
    if (entry.minMemoryBytes > machine.memoryBytes) {
      return `Needs ${formatMemory(entry.minMemoryBytes)} of memory; this Mac has ${formatMemory(machine.memoryBytes)}.`;
    }
    if (entry.chipClasses && !entry.chipClasses.includes(machine.chipClass)) {
      return `Meant for Macs with ${describeChipClasses(entry.chipClasses)} chip; this Mac has ${machine.chip || "another chip"}.`;
    }
    const size = entryWeightsBytes(entry);
    const needed = Math.ceil(size * 1.1);
    if (!installed && machine.freeDiskBytes > 0 && needed > machine.freeDiskBytes) {
      return `Needs ${formatDisk(needed)} of free disk space; this Mac has ${formatDisk(machine.freeDiskBytes)} free.`;
    }
    return null;
  }

  /** Models that can run now: catalog models, model files, then servers'; the default first. */
  private installedOptions(): ModelOption[] {
    const options: ModelOption[] = [];
    for (const entry of this.orderedCatalog().entries) {
      const record = this.installedRecord(entry.id);
      if (record) options.push(this.catalogOption(entry, record));
    }
    for (const file of this.saved.files) options.push(this.fileOption(file));
    for (const server of this.serverRecords()) {
      if (!server.reachable) continue;
      for (const model of server.models) options.push(this.serverOption(server, model));
    }
    const first = this.effectiveDefault(options);
    const index = options.findIndex((option) => option.id === first);
    if (index > 0) options.unshift(...options.splice(index, 1));
    return options;
  }

  private effectiveDefault(installed: readonly ModelOption[]): string | null {
    const saved = this.saved.defaultModelId;
    if (saved !== null && installed.some((option) => option.id === saved)) return saved;
    return installed[0]?.id ?? null;
  }

  /** The endpoint while this model is loaded and answering. */
  private loadedEndpoint(modelId: string): Endpoint | null {
    const runtime = this.runtime;
    return runtime?.modelId === modelId && runtime.state === "ready" ? runtime.endpoint : null;
  }

  private catalogOption(entry: CatalogEntry, record: InstalledRecord): ModelOption {
    const loaded = this.loadedEndpoint(entry.id);
    const context = loaded?.contextWindow ?? contextPerSlot(entry, this.machineInfo().memoryBytes);
    const where =
      record.source === "lmstudio"
        ? "LM Studio’s copy"
        : record.source === "ollama"
          ? "Ollama’s copy"
          : "Bundled runtime";
    return {
      id: entry.id,
      label: entry.displayName,
      shortLabel: shortLabelFor(entry.displayName),
      description: describeOption(where, context, entry.capabilities.vision, loaded !== null),
      source: "bundled",
      contextWindow: context,
      origin:
        record.source === "lmstudio" || record.source === "ollama" ? record.source : "catalog",
      removable: record.source === "download",
    };
  }

  private fileOption(file: ModelFileRecord): ModelOption {
    const loaded = this.loadedEndpoint(file.id);
    const context = loaded?.contextWindow ?? MODEL_FILE_CONTEXT;
    const name = fileLabel(file.path);
    return {
      id: file.id,
      label: name,
      shortLabel: name,
      description: describeOption("Model file", context, true, loaded !== null),
      source: "bundled",
      contextWindow: context,
      origin: "file",
      removable: false,
    };
  }

  private serverOption(server: ServerRecord, model: DiscoveredModel): ModelOption {
    const name = serverName(server);
    return {
      id: serverModelId(server.id, model.id),
      label: `${name} · ${model.id}`,
      shortLabel: `${model.id} · ${name}`,
      description: `${hostOf(server.baseUrl)} · ${formatContext(model.contextWindow)} context · no prompt cache control`,
      source: "server",
      contextWindow: model.contextWindow,
      origin: server.kind,
      removable: false,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------------------------------

  async download(modelId: string): Promise<void> {
    await this.init();
    const entry = this.entry(modelId);
    if (!entry) throw new Error(`The catalog has no model “${modelId}”.`);
    if (this.installedRecord(modelId)) return;
    const existing = this.downloads.get(modelId);
    if (existing && ACTIVE_PHASES.has(existing.phase)) return;
    const record: DownloadRecord = existing ?? this.newDownload(entry);
    if (existing?.phase !== "paused") record.bytesDone = await this.bytesOnDisk(entry);
    record.phase = "queued";
    record.error = null;
    record.bytesPerSecond = 0;
    record.secondsLeft = null;
    this.downloads.set(modelId, record);
    await this.save();
    this.changed();
    this.pump();
  }

  async pauseDownload(modelId: string): Promise<void> {
    await this.init();
    const record = this.downloads.get(modelId);
    if (!record) return;
    if (record.controller) {
      record.stopAs = "pause";
      record.controller.abort();
      await record.settled;
      return;
    }
    if (record.phase !== "queued") return;
    record.phase = "paused";
    await this.save();
    this.changed();
  }

  async cancelDownload(modelId: string): Promise<void> {
    await this.init();
    const entry = this.entry(modelId);
    const record = this.downloads.get(modelId);
    if (record?.controller) {
      record.stopAs = "cancel";
      record.controller.abort();
      await record.settled;
      return;
    }
    if (entry) await this.discardPartial(entry);
    if (record && !ENDED_PHASES.has(record.phase)) {
      record.phase = "cancelled";
      record.bytesDone = 0;
      record.bytesPerSecond = 0;
      record.secondsLeft = null;
      await this.save();
      this.changed();
    }
  }

  async dismissDownload(modelId: string): Promise<void> {
    await this.init();
    const record = this.downloads.get(modelId);
    if (!record) return;
    if (!ENDED_PHASES.has(record.phase)) {
      throw new Error("Only a finished, failed or cancelled download can be dismissed.");
    }
    this.downloads.delete(modelId);
    this.changed();
  }

  private newDownload(entry: CatalogEntry): DownloadRecord {
    return {
      modelId: entry.id,
      phase: "queued",
      bytesDone: 0,
      bytesTotal: entryWeightsBytes(entry),
      bytesPerSecond: 0,
      secondsLeft: null,
      error: null,
    };
  }

  /** Starts the next queued download when none runs. */
  private pump(): void {
    if (this.activeDownload !== null || this.disposed || !this.loaded) return;
    const next = [...this.downloads.values()].find((record) => record.phase === "queued");
    if (!next) return;
    const entry = this.entry(next.modelId);
    if (!entry) {
      next.phase = "failed";
      next.error = "The catalog no longer has this model.";
      this.changed();
      this.pump();
      return;
    }
    this.activeDownload = next.modelId;
    next.settled = this.runDownload(entry, next).finally(() => {
      this.activeDownload = null;
      next.settled = undefined;
      this.pump();
    });
  }

  private async runDownload(entry: CatalogEntry, record: DownloadRecord): Promise<void> {
    const controller = new AbortController();
    record.controller = controller;
    record.stopAs = undefined;
    record.phase = "checking";
    this.changed();
    try {
      const result = await this.backend.download(entry, {
        hubDir: this.options.hubDir,
        signal: controller.signal,
        onProgress: (progress) => {
          if (record.stopAs || controller.signal.aborted) return;
          record.phase = progress.phase === "done" ? "verifying" : progress.phase;
          record.bytesDone = progress.bytesDone;
          record.bytesTotal = progress.bytesTotal;
          record.bytesPerSecond = progress.bytesPerSecond;
          record.secondsLeft = progress.etaSeconds;
          this.changed("progress");
        },
      });
      record.controller = undefined;
      record.phase = "done";
      record.bytesDone = record.bytesTotal;
      record.bytesPerSecond = 0;
      record.secondsLeft = null;
      this.found.delete(entry.id);
      this.install({
        id: entry.id,
        source: "download",
        modelPath: result.model.path,
        ...(result.projector ? { projectorPath: result.projector.path } : {}),
      });
      await this.save();
      await this.refreshFreeDisk();
      this.log(`Downloaded ${entry.id}.`);
      this.changed();
      this.modelsChanged();
    } catch (error) {
      record.controller = undefined;
      record.bytesPerSecond = 0;
      record.secondsLeft = null;
      if (this.disposed && !record.stopAs) {
        // Quitting: it stays queued in models.json and resumes at the next launch.
        return;
      }
      if (record.stopAs === "pause") {
        record.phase = "paused";
      } else if (record.stopAs === "cancel") {
        await this.discardPartial(entry);
        record.phase = "cancelled";
        record.bytesDone = 0;
      } else {
        record.phase = "failed";
        record.error = describeDownloadError(error, entry);
        this.log(`Downloading ${entry.id} failed: ${messageOf(error)}`);
      }
      record.stopAs = undefined;
      await this.save();
      await this.refreshFreeDisk();
      this.changed();
    }
  }

  private async discardPartial(entry: CatalogEntry): Promise<void> {
    try {
      await this.backend.discardPartial(entry, this.options.hubDir);
    } catch (error) {
      this.log(`Could not remove the partial download of ${entry.id}: ${messageOf(error)}`);
    }
  }

  /** Bytes already on disk for an entry: finished files plus partial data. */
  private async bytesOnDisk(entry: CatalogEntry): Promise<number> {
    let total = 0;
    for (const target of entryTargets(entry)) {
      const paths = cachePaths(
        this.options.hubDir,
        target.repo,
        target.revision,
        target.file,
        target.sha256,
      );
      const blob = await fileSize(paths.blobPath);
      if (blob === target.sizeBytes) total += blob;
      else total += Math.min(target.sizeBytes, (await fileSize(paths.incompletePath)) ?? 0);
    }
    return total;
  }

  /** Records an installed catalog model; the first model on this Mac becomes the default. */
  private install(record: InstalledRecord): void {
    const hadDefault = this.effectiveDefault(this.installedOptions()) !== null;
    this.saved = {
      ...this.saved,
      installed: [...this.saved.installed.filter((r) => r.id !== record.id), record],
    };
    if (!hadDefault) this.saved = { ...this.saved, defaultModelId: record.id };
  }

  // -------------------------------------------------------------------------------------------
  // Copies other apps have
  // -------------------------------------------------------------------------------------------

  private startScan(): void {
    const abort = new AbortController();
    this.scanAbort = abort;
    const started = Date.now();
    this.backend
      .scan({ catalog: this.catalog, hubDir: this.options.hubDir, signal: abort.signal })
      .then((copies) => {
        if (abort.signal.aborted) return;
        for (const copy of copies) this.found.set(copy.entryId, copy);
        const ready = copies.filter((copy) => copy.ready).map((copy) => copy.entryId);
        this.log(
          `Scan for existing models took ${Date.now() - started} ms; found ${ready.length > 0 ? ready.join(", ") : "none"}.`,
        );
        this.changed();
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          this.log(`The scan for existing models failed: ${messageOf(error)}`);
      });
  }

  async useExisting(modelId: string): Promise<void> {
    await this.init();
    const entry = this.entry(modelId);
    if (!entry) throw new Error(`The catalog has no model “${modelId}”.`);
    if (this.installedRecord(modelId)) return;
    const copy = this.found.get(modelId);
    if (!copy?.ready || !copy.model) {
      throw new Error(`No complete copy of ${entry.displayName} was found on this Mac.`);
    }
    const download = this.downloads.get(modelId);
    if (download && !ENDED_PHASES.has(download.phase)) await this.cancelDownload(modelId);
    this.downloads.delete(modelId);
    this.install({
      id: modelId,
      source: copy.model.source,
      modelPath: copy.model.path,
      ...(copy.projector ? { projectorPath: copy.projector.path } : {}),
    });
    await this.save();
    this.log(`Using the copy of ${modelId} in ${copy.model.path}.`);
    this.changed();
    this.modelsChanged();
  }

  // -------------------------------------------------------------------------------------------
  // Model files
  // -------------------------------------------------------------------------------------------

  async addModelFile(choose: () => Promise<string | null>): Promise<AddedModelFile | null> {
    await this.init();
    const picked = await choose();
    if (picked === null) return null;
    const filePath = path.resolve(picked);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`${filePath} is not a file.`);
    if (!(await hasGgufMagic(filePath))) {
      throw new Error(`${path.basename(filePath)} is not a GGUF model file.`);
    }
    const id = fileModelId(filePath);
    if (!this.fileRecord(id)) {
      const hadDefault = this.effectiveDefault(this.installedOptions()) !== null;
      this.saved = {
        ...this.saved,
        files: [...this.saved.files, { id, path: filePath, sizeBytes: info.size }],
        ...(hadDefault ? {} : { defaultModelId: id }),
      };
      await this.save();
      this.log(`Added the model file ${filePath}.`);
      this.changed();
      this.modelsChanged();
    }
    const file = this.fileRecord(id) as ModelFileRecord;
    return { option: this.fileOption(file), memoryWarning: this.fileMemoryWarning(file.sizeBytes) };
  }

  /** The spec: any GGUF is accepted, with a warning instead of a refusal when it may not fit. */
  private fileMemoryWarning(sizeBytes: number): string | null {
    const machine = this.machine;
    if (!machine || machine.memoryBytes === 0) return null;
    const need = sizeBytes + RUNTIME_OVERHEAD_BYTES;
    if (need <= machine.memoryBytes * MEMORY_BUDGET_FRACTION) return null;
    return `This model may need more memory than this Mac has (about ${formatMemory(need)} before its context; this Mac has ${formatMemory(machine.memoryBytes)}). It can still be loaded, but it may be slow or fail.`;
  }

  // -------------------------------------------------------------------------------------------
  // Remove, default, idle unload
  // -------------------------------------------------------------------------------------------

  async remove(modelId: string): Promise<void> {
    await this.init();
    if (splitServerModelId(modelId, this.servers.keys()) || isLocalServerModelId(modelId)) {
      throw new Error(
        "A server’s models are managed on the server. To stop using it, remove the server.",
      );
    }
    const record = this.installedRecord(modelId);
    const file = this.fileRecord(modelId);
    if (!record && !file) throw new Error("That model is not installed.");
    if (this.runtime?.modelId === modelId || this.pendingLoad?.modelId === modelId) {
      await this.serial(() => this.unload());
    }
    if (record) {
      this.saved = {
        ...this.saved,
        installed: this.saved.installed.filter((r) => r.id !== modelId),
      };
      const entry = this.entry(modelId);
      if (record.source === "download" && entry) await this.deleteDownloaded(entry);
      if (record.source === "download") this.found.delete(modelId);
    }
    if (file) {
      this.saved = { ...this.saved, files: this.saved.files.filter((f) => f.id !== modelId) };
    }
    if (this.saved.defaultModelId === modelId) this.saved = { ...this.saved, defaultModelId: null };
    const download = this.downloads.get(modelId);
    if (download?.phase === "done") this.downloads.delete(modelId);
    await this.save();
    await this.refreshFreeDisk();
    this.log(`Removed ${modelId}.`);
    this.changed();
    this.modelsChanged();
  }

  /** Deletes a downloaded entry's blobs and snapshot links. Other files in the cache stay. */
  private async deleteDownloaded(entry: CatalogEntry): Promise<void> {
    for (const target of entryTargets(entry)) {
      const paths = cachePaths(
        this.options.hubDir,
        target.repo,
        target.revision,
        target.file,
        target.sha256,
      );
      await rm(paths.snapshotPath, { force: true });
      await rm(paths.blobPath, { force: true });
    }
  }

  async setDefault(modelId: string): Promise<void> {
    await this.init();
    if (!this.installedOptions().some((option) => option.id === modelId)) {
      await this.serversChecked;
      if (!this.installedOptions().some((option) => option.id === modelId)) {
        throw new Error("That model is not installed.");
      }
    }
    this.saved = { ...this.saved, defaultModelId: modelId };
    await this.save();
    this.changed();
    this.modelsChanged();
  }

  async setIdleUnload(minutes: number | null): Promise<void> {
    await this.init();
    if (this.saved.idleUnloadMinutes === minutes) return;
    this.saved = { ...this.saved, idleUnloadMinutes: minutes };
    await this.save();
    this.changed();
    // The runtime reads the idle time at launch: a loaded model restarts with the new one.
    const runtime = this.runtime;
    if (runtime && !runtime.error && runtime.state !== "stopped") {
      const modelId = runtime.modelId;
      this.serial(() => this.loadNow(modelId, true)).catch((error: unknown) =>
        this.log(`Reloading ${modelId} for the new idle time failed: ${messageOf(error)}`),
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // The bundled runtime
  // -------------------------------------------------------------------------------------------

  async start(modelId: string): Promise<void> {
    await this.init();
    const answer = await this.makeAvailable(modelId);
    if (!answer.ok) throw new Error(answer.message);
  }

  async stop(): Promise<void> {
    await this.init();
    await this.serial(() => this.unload());
  }

  /** Runtime operations run one at a time, in order. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.runtimeQueue.then(task, task);
    this.runtimeQueue = run.catch(() => {});
    return run;
  }

  private ensureLoaded(modelId: string): Promise<Endpoint> {
    const runtime = this.runtime;
    if (runtime?.modelId === modelId && runtime.state === "ready" && runtime.endpoint) {
      return Promise.resolve(runtime.endpoint);
    }
    if (this.pendingLoad?.modelId === modelId) return this.pendingLoad.promise;
    const promise = this.serial(() => this.loadNow(modelId));
    const pending = { modelId, promise };
    this.pendingLoad = pending;
    const clear = () => {
      if (this.pendingLoad === pending) this.pendingLoad = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private launchFor(modelId: string): RuntimeLaunch {
    const idle = this.saved.idleUnloadMinutes;
    const idleUnload = idle === null ? {} : { idleUnloadSeconds: idle * 60 };
    const record = this.installedRecord(modelId);
    const entry = record ? this.entry(modelId) : undefined;
    if (record && entry) {
      return {
        modelId,
        modelPath: record.modelPath,
        ...(record.projectorPath === undefined ? {} : { projectorPath: record.projectorPath }),
        catalogEntry: entry,
        contextPerSlot: contextPerSlot(entry, this.machineInfo().memoryBytes),
        ...idleUnload,
      };
    }
    const file = this.fileRecord(modelId);
    if (file) {
      return { modelId, modelPath: file.path, contextPerSlot: MODEL_FILE_CONTEXT, ...idleUnload };
    }
    throw new ModelError("That model is not on this Mac.");
  }

  /** Loads a model, replacing the one loaded. Runs inside `serial`. */
  private async loadNow(modelId: string, force = false): Promise<Endpoint> {
    if (this.disposed) throw new ModelError("The app is quitting.");
    const launch = this.launchFor(modelId);
    const current = this.runtime;
    if (current?.modelId === modelId && current.handle && !current.error && !force) {
      if (current.state === "ready" && current.endpoint) return current.endpoint;
      if (current.state === "starting" || current.state === "crashed") {
        return this.awaitReady(current);
      }
    }
    await this.unload();

    const runtime: LoadedRuntime = {
      modelId,
      handle: null,
      state: "starting",
      endpoint: null,
      error: null,
      restarting: false,
      memoryBytes: null,
      sleeping: false,
      unsubscribe: () => {},
    };
    this.runtime = runtime;
    this.changed();
    this.log(`Loading ${modelId} (${formatContext(launch.contextPerSlot)} context per slot).`);
    try {
      runtime.handle = await this.backend.createRuntime(launch);
    } catch (error) {
      runtime.state = "stopped";
      runtime.error = describeRuntimeError(error);
      this.log(`Could not start the runtime: ${messageOf(error)}`);
      this.changed();
      throw new ModelError(runtime.error);
    }
    runtime.unsubscribe = runtime.handle.subscribe((event) => this.onRuntimeEvent(runtime, event));
    if (this.disposed) {
      await this.unload();
      throw new ModelError("The app is quitting.");
    }
    return this.awaitReady(runtime);
  }

  private async awaitReady(runtime: LoadedRuntime): Promise<Endpoint> {
    const handle = runtime.handle as BundledRuntime;
    try {
      const endpoint = await handle.start();
      if (this.runtime === runtime && runtime.endpoint === null) {
        // The ready event normally arrives first; this covers a runtime that only resolves.
        this.onRuntimeEvent(runtime, { type: "ready", endpoint });
      }
      return endpoint;
    } catch (error) {
      if (this.runtime !== runtime) {
        throw new ModelError(describeRuntimeError(error), true);
      }
      runtime.error ??= describeRuntimeError(error, handle.logPath);
      runtime.state = "stopped";
      runtime.endpoint = null;
      this.changed();
      throw new ModelError(runtime.error);
    }
  }

  private onRuntimeEvent(runtime: LoadedRuntime, event: RuntimeEvent): void {
    if (this.runtime !== runtime) return;
    switch (event.type) {
      case "state":
        runtime.state = event.state;
        if (event.state === "starting") {
          runtime.restarting = event.reason === "restart";
        } else if (event.state === "crashed") {
          runtime.endpoint = null;
          runtime.memoryBytes = null;
          this.log(`The runtime running ${runtime.modelId} stopped unexpectedly; restarting it.`);
          this.modelsChanged();
        } else if (event.state === "stopped") {
          runtime.endpoint = null;
          runtime.memoryBytes = null;
        }
        break;
      case "ready":
        runtime.state = "ready";
        runtime.endpoint = event.endpoint;
        runtime.restarting = false;
        runtime.sleeping = false;
        runtime.error = null;
        this.generation += 1;
        this.log(
          `${runtime.modelId} is ready (${formatContext(event.endpoint.contextWindow)} context per slot).`,
        );
        this.modelsChanged();
        void this.pollRuntime();
        break;
      case "failure":
        runtime.state = "stopped";
        runtime.endpoint = null;
        runtime.memoryBytes = null;
        runtime.error = describeRuntimeError(event.error, runtime.handle?.logPath);
        this.log(`The runtime failed: ${messageOf(event.error)}`);
        this.modelsChanged();
        break;
    }
    this.changed();
  }

  /** Stops the loaded model, if any. Runs inside `serial`. */
  private async unload(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = null;
    runtime.unsubscribe();
    this.changed();
    if (runtime.handle) {
      try {
        await runtime.handle.stop();
      } catch (error) {
        this.log(`Stopping the runtime failed: ${messageOf(error)}`);
      }
      this.log(`Unloaded ${runtime.modelId}.`);
    }
    this.modelsChanged();
  }

  private runtimeStatus(): ModelStatus {
    const runtime = this.runtime;
    if (!runtime) {
      return {
        state: "stopped",
        modelId: null,
        label: null,
        message: "Not loaded",
        memoryBytes: null,
      };
    }
    const label = this.labelFor(runtime.modelId);
    const base = { modelId: runtime.modelId, label };
    if (runtime.error) {
      return { ...base, state: "error", message: runtime.error, memoryBytes: null };
    }
    switch (runtime.state) {
      case "ready": {
        const minutes = this.saved.idleUnloadMinutes;
        const message = runtime.sleeping
          ? `Unloaded after ${minutes ?? "some"} idle minutes; it loads again on the next message`
          : null;
        return { ...base, state: "ready", message, memoryBytes: runtime.memoryBytes };
      }
      case "starting":
        return {
          ...base,
          state: "loading",
          message: runtime.restarting
            ? "Restarting after the runtime stopped"
            : "Loading into memory",
          memoryBytes: null,
        };
      case "crashed":
        return {
          ...base,
          state: "loading",
          message: "The runtime stopped; restarting",
          memoryBytes: null,
        };
      default:
        return { ...base, state: "stopped", message: "Stopped", memoryBytes: null };
    }
  }

  private labelFor(modelId: string): string {
    const entry = this.entry(modelId);
    if (entry) return shortLabelFor(entry.displayName);
    const file = this.fileRecord(modelId);
    return file ? fileLabel(file.path) : modelId;
  }

  /** Reads the runtime's memory, and whether it is asleep when idle unload is on. */
  private async pollRuntime(): Promise<void> {
    const runtime = this.runtime;
    const pid = runtime?.handle?.pid;
    if (runtime?.state !== "ready" || pid === undefined) return;
    const [memory, sleeping] = await Promise.all([
      this.backend.residentBytes(pid).catch(() => null),
      this.saved.idleUnloadMinutes === null
        ? Promise.resolve(false)
        : (runtime.handle?.isSleeping().catch(() => runtime.sleeping) ?? Promise.resolve(false)),
    ]);
    if (this.runtime !== runtime) return;
    const before = runtime.memoryBytes;
    const memoryMoved =
      memory !== before &&
      (memory === null ||
        before === null ||
        Math.abs(memory - before) > Math.max(16 * 1024 ** 2, before * 0.01));
    if (!memoryMoved && sleeping === runtime.sleeping) return;
    if (memoryMoved) runtime.memoryBytes = memory;
    runtime.sleeping = sleeping;
    this.changed();
  }

  // -------------------------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------------------------

  private serverRecords(): ServerRecord[] {
    const local = LOCAL_KINDS.map((kind) => this.servers.get(kind)).filter(
      (server): server is ServerRecord => server !== undefined,
    );
    const remote = [...this.servers.values()].filter((server) => server.kind === "remote");
    return [...local, ...remote];
  }

  private serverList(): ServerInfo[] {
    return this.serverRecords().map((server) => this.serverInfo(server));
  }

  private serverInfo(server: ServerRecord): ServerInfo {
    return {
      id: server.id,
      kind: server.kind,
      url: displayUrl(server.baseUrl),
      reachable: server.reachable,
      modelIds: server.reachable
        ? server.models.map((model) => serverModelId(server.id, model.id))
        : [],
      hasKey: server.kind === "remote" && this.options.keys.has(server.id),
    };
  }

  private async checkServersAtStart(quick: boolean): Promise<void> {
    for (const saved of this.saved.servers) {
      if (this.servers.has(saved.id)) continue;
      this.servers.set(saved.id, {
        id: saved.id,
        kind: "remote",
        baseUrl: saved.url,
        reachable: false,
        models: [],
        ephemeral: false,
      });
    }
    const remote = [...this.servers.values()].filter((s) => s.kind === "remote" && !s.ephemeral);
    await Promise.all([
      quick ? Promise.resolve() : this.detectLocal(),
      ...remote.map((server) => this.checkServer(server)),
    ]);
    this.changed();
  }

  async refreshServers(): Promise<void> {
    await this.init();
    const quick = this.options.testServerUrl !== undefined;
    await Promise.all([
      quick ? Promise.resolve() : this.detectLocal(),
      ...[...this.servers.values()]
        .filter((server) => server.kind === "remote")
        .map((server) => this.checkServer(server)),
    ]);
    this.changed();
  }

  private async detectLocal(): Promise<void> {
    let found: DiscoveredServer[];
    try {
      found = await this.backend.detectLocalServers();
    } catch (error) {
      this.log(`Looking for Ollama and LM Studio failed: ${messageOf(error)}`);
      return;
    }
    for (const kind of LOCAL_KINDS) {
      const server = found.find((s) => s.kind === kind);
      const before = this.servers.get(kind);
      if (server) {
        this.servers.set(kind, {
          id: kind,
          kind,
          baseUrl: server.baseUrl,
          reachable: true,
          models: server.models,
          ephemeral: false,
        });
      } else if (before) {
        this.servers.set(kind, { ...before, reachable: false, models: [] });
      }
      if (serverChanged(before, this.servers.get(kind))) this.modelsChanged();
    }
  }

  /** Asks a server for its models now and records what it said. Null when it does not answer. */
  private async checkServer(server: ServerRecord): Promise<DiscoveredServer | null> {
    let discovered: DiscoveredServer | null = null;
    if (server.kind === "remote") {
      const apiKey = await this.options.keys.get(server.id);
      const result = await this.backend.connectRemote({
        url: server.baseUrl,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      if (result.ok) discovered = { ...result.server, ...(apiKey === undefined ? {} : { apiKey }) };
      else this.log(`${displayUrl(server.baseUrl)} did not answer: ${result.error}`);
    } else {
      discovered = await this.backend
        .probeLocalServer(server.kind, server.baseUrl)
        .catch(() => null);
    }
    const current = this.servers.get(server.id);
    if (!current) return discovered;
    const next: ServerRecord = {
      ...current,
      reachable: discovered !== null,
      models: discovered?.models ?? [],
    };
    this.servers.set(server.id, next);
    if (serverChanged(current, next)) {
      this.changed();
      this.modelsChanged();
    }
    return discovered;
  }

  async connectServer(input: ConnectServerInput): Promise<ServerInfo> {
    await this.init();
    const parsed = new URL(input.url);
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("Put the key in the key field, not in the server address.");
    }
    const given = input.url.replace(/\/+$/, "");
    const withV1 = /\/v1$/.test(parsed.pathname.replace(/\/+$/, "")) ? null : `${given}/v1`;
    // Replacing a key, or checking again with the one stored.
    let apiKey = input.apiKey;
    if (apiKey === undefined) {
      for (const candidate of [given, withV1]) {
        if (candidate === null) continue;
        apiKey ??= await this.options.keys.get(remoteServerId(normalizeRoot(candidate)));
      }
    }
    const auth = apiKey === undefined ? {} : { apiKey };
    let result = await this.backend.connectRemote({ url: given, ...auth });
    // A root given without its /v1 segment is the commonest slip; try once with it.
    if (!result.ok && withV1 !== null) {
      const retry = await this.backend.connectRemote({ url: withV1, ...auth });
      if (retry.ok) result = retry;
    }
    if (!result.ok) {
      const status = result.status === undefined ? "" : ` (HTTP ${result.status})`;
      const hint =
        result.status === 401 || result.status === 403
          ? apiKey === undefined
            ? " The server wants a key."
            : " The server refused the key."
          : "";
      throw new Error(
        `Could not connect to ${displayUrl(given)}${status}: ${result.error}.${hint}`,
      );
    }
    const baseUrl = result.server.baseUrl;
    const id = remoteServerId(baseUrl);
    if (input.apiKey !== undefined) await this.options.keys.set(id, input.apiKey);
    const record: ServerRecord = {
      id,
      kind: "remote",
      baseUrl,
      reachable: true,
      models: result.server.models,
      ephemeral: false,
    };
    this.servers.set(id, record);
    this.saved = {
      ...this.saved,
      servers: [...this.saved.servers.filter((s) => s.id !== id), { id, url: baseUrl }],
    };
    await this.save();
    this.log(`Connected to ${displayUrl(baseUrl)} (${result.server.models.length} models).`);
    this.changed();
    this.modelsChanged();
    return this.serverInfo(record);
  }

  async removeServer(serverId: string): Promise<void> {
    await this.init();
    const server = this.servers.get(serverId);
    if (!server) return;
    if (server.kind !== "remote") {
      throw new Error(
        "Ollama and LM Studio are found on this Mac by themselves; only servers you added can be removed.",
      );
    }
    this.servers.delete(serverId);
    await this.options.keys.delete(serverId);
    const defaultId = this.saved.defaultModelId;
    this.saved = {
      ...this.saved,
      servers: this.saved.servers.filter((s) => s.id !== serverId),
      defaultModelId: defaultId?.startsWith(`${serverId}/`) ? null : defaultId,
    };
    await this.save();
    this.log(`Removed the server ${displayUrl(server.baseUrl)}.`);
    this.changed();
    this.modelsChanged();
  }

  /** `connectRemote` for the test hook's address, with or without its `/v1`. */
  private async probeTestServer(url: string): ReturnType<ModelBackend["connectRemote"]> {
    const result = await this.backend.connectRemote({ url });
    if (result.ok || /\/v1\/?$/.test(url)) return result;
    const retry = await this.backend.connectRemote({ url: `${url.replace(/\/+$/, "")}/v1` });
    return retry.ok ? retry : result;
  }

  /** The test hook: the server, in memory and without a key, with its first model the default. */
  private async connectTestServer(url: string): Promise<void> {
    // A few tries: a server that has only just started may not answer yet, and Node's fetch in
    // Electron's main process has been seen to fail once for no reason of the server's (on a CI
    // runner: "Cannot read properties of undefined (reading 'markResourceTiming')").
    let result = await this.probeTestServer(url);
    for (let attempt = 1; !result.ok && attempt < TEST_SERVER_TRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      result = await this.probeTestServer(url);
    }
    if (!result.ok) {
      this.log(`DAWG_TEST_SERVER_URL ${displayUrl(url)} did not answer: ${result.error}`);
      return;
    }
    const id = remoteServerId(result.server.baseUrl);
    this.servers.set(id, {
      id,
      kind: "remote",
      baseUrl: result.server.baseUrl,
      reachable: true,
      models: result.server.models,
      ephemeral: true,
    });
    const first = result.server.models[0];
    if (first) this.saved = { ...this.saved, defaultModelId: serverModelId(id, first.id) };
    this.log(
      `Test server ${displayUrl(result.server.baseUrl)} added; ${first?.id ?? "no model"} is the default.`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // The engine host's requests
  // -------------------------------------------------------------------------------------------

  async requestModel(modelId: string | null): Promise<ModelAnswer> {
    await this.init();
    let id = modelId;
    if (id === null) {
      const saved = this.saved.defaultModelId;
      if (saved !== null && !this.installedOptions().some((option) => option.id === saved)) {
        await this.serversChecked;
      }
      id = this.effectiveDefault(this.installedOptions());
      if (id === null) {
        return { ok: false, message: NO_MODEL_MESSAGE, retryable: this.hasActiveDownload() };
      }
    }
    return this.makeAvailable(id);
  }

  private hasActiveDownload(): boolean {
    return [...this.downloads.values()].some((record) => ACTIVE_PHASES.has(record.phase));
  }

  /** Loads a bundled model, or checks a server's model answers, and says how to reach it. */
  private async makeAvailable(modelId: string): Promise<ModelAnswer> {
    if (this.installedRecord(modelId) || this.fileRecord(modelId)) {
      try {
        const endpoint = await this.ensureLoaded(modelId);
        return { ok: true, grant: this.grant(modelId, endpoint, true) };
      } catch (error) {
        return refusal(error);
      }
    }

    let split = splitServerModelId(modelId, this.servers.keys());
    if (!split) {
      await this.serversChecked;
      split = splitServerModelId(modelId, this.servers.keys());
    }
    if (split) return this.serverAnswer(split.serverId, split.model, modelId);
    if (isLocalServerModelId(modelId)) {
      const kind = modelId.startsWith("ollama/") ? "ollama" : "lmstudio";
      return {
        ok: false,
        message: `${SERVER_NAMES[kind]} is not running on this Mac.`,
        retryable: true,
      };
    }

    const entry = this.entry(modelId);
    if (entry) {
      const download = this.downloads.get(modelId);
      if (download && ACTIVE_PHASES.has(download.phase)) {
        return {
          ok: false,
          message: `${entry.displayName} is still downloading.`,
          retryable: true,
        };
      }
      return {
        ok: false,
        message: `${entry.displayName} is not downloaded yet. Download it in Settings → Models.`,
        retryable: false,
      };
    }
    return {
      ok: false,
      message: `The model “${modelId}” is not available. Choose another one in the model picker.`,
      retryable: false,
    };
  }

  private async serverAnswer(
    serverId: string,
    model: string,
    modelId: string,
  ): Promise<ModelAnswer> {
    const server = this.servers.get(serverId) as ServerRecord;
    const discovered = await this.checkServer(server);
    if (!discovered) {
      return {
        ok: false,
        message: `${serverName(server)} at ${displayUrl(server.baseUrl)} is not answering.`,
        retryable: true,
      };
    }
    if (!discovered.models.some((m) => m.id === model)) {
      return {
        ok: false,
        message: `${serverName(server)} no longer has the model ${model}.`,
        retryable: false,
      };
    }
    const endpoint = toEndpoint(discovered, model);
    const shared = server.ephemeral && this.options.testServerSlots === true;
    return { ok: true, grant: this.grant(modelId, endpoint, shared) };
  }

  private grant(modelId: string, endpoint: Endpoint, bundled: boolean): ModelGrant {
    // The catalog names the engine profile for its own models; for the rest the host picks one.
    const profile = this.installedRecord(modelId) ? this.entry(modelId)?.profile : undefined;
    return {
      modelId,
      endpoint: {
        kind: endpoint.kind,
        baseUrl: endpoint.baseUrl,
        ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }),
        model: endpoint.model,
        contextWindow: endpoint.contextWindow,
        capabilities: { ...endpoint.capabilities },
        ...(endpoint.template === undefined ? {} : { template: { ...endpoint.template } }),
      },
      ...(bundled
        ? {
            slots: {
              conversation: [...RUNTIME_SLOTS.conversation],
              utility: [...RUNTIME_SLOTS.utility],
            },
          }
        : {}),
      generation: this.generation,
      ...(profile === undefined ? {} : { profile }),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------------------------

  private async save(): Promise<void> {
    const pending: PendingDownload[] = [];
    for (const record of this.downloads.values()) {
      if (ACTIVE_PHASES.has(record.phase))
        pending.push({ modelId: record.modelId, phase: "queued" });
      else if (record.phase === "paused")
        pending.push({ modelId: record.modelId, phase: "paused" });
    }
    this.saved = { ...this.saved, downloads: pending };
    await this.options.store.save(this.saved);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function publicDownload(record: DownloadRecord): DownloadState {
  return {
    modelId: record.modelId,
    phase: record.phase,
    bytesDone: Math.max(0, Math.round(record.bytesDone)),
    bytesTotal: Math.max(0, Math.round(record.bytesTotal)),
    bytesPerSecond: Math.max(0, record.bytesPerSecond),
    secondsLeft: record.secondsLeft === null ? null : Math.max(0, record.secondsLeft),
    error: record.error,
  };
}

function catalogDownloadState(record: DownloadRecord | undefined): CatalogModel["state"] {
  if (!record) return "available";
  if (ACTIVE_PHASES.has(record.phase)) return "downloading";
  if (record.phase === "paused") return "paused";
  if (record.phase === "failed") return "failed";
  return "available";
}

/** Memory the entry uses at its default context: weights + cache + overhead. */
function memoryNeedBytes(entry: CatalogEntry): number {
  const need = entryMemoryNeed(entry);
  if (need) return workingSetBytes(need);
  return entryWeightsBytes(entry) + RUNTIME_OVERHEAD_BYTES;
}

/** ["base", "pro"] → "a base or Pro"; ["ultra"] → "an Ultra". */
function describeChipClasses(classes: readonly string[]): string {
  const names = classes.map((c) => (c === "base" ? "base" : `${c[0]?.toUpperCase()}${c.slice(1)}`));
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `${/^[AEIOU]/.test(list ?? "") ? "an" : "a"} ${list}`;
}

function describeOption(where: string, context: number, vision: boolean, loaded: boolean): string {
  return [
    where,
    `${formatContext(context)} context`,
    ...(vision ? [] : ["text only"]),
    ...(loaded ? ["loaded"] : []),
  ].join(" · ");
}

function serverName(server: ServerRecord): string {
  return server.kind === "remote" ? hostOf(server.baseUrl) : SERVER_NAMES[server.kind];
}

function isLocalServerModelId(modelId: string): boolean {
  return modelId.startsWith("ollama/") || modelId.startsWith("lmstudio/");
}

function serverChanged(before: ServerRecord | undefined, after: ServerRecord | undefined): boolean {
  if (!before || !after) return before !== after;
  if (before.reachable !== after.reachable || before.baseUrl !== after.baseUrl) return true;
  const ids = (server: ServerRecord) =>
    server.models.map((m) => `${m.id}:${m.contextWindow}`).join("\n");
  return ids(before) !== ids(after);
}

/** How `connectRemote` writes a root: parsed, without a trailing slash. */
function normalizeRoot(url: string): string {
  try {
    return new URL(url).toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function refusal(error: unknown): ModelAnswer {
  if (error instanceof ModelError) {
    return { ok: false, message: error.message, retryable: error.retryable };
  }
  return { ok: false, message: messageOf(error), retryable: false };
}

/** A sentence for a failed download. */
export function describeDownloadError(error: unknown, entry: CatalogEntry): string {
  if (error instanceof DownloadError) {
    switch (error.code) {
      case "insufficient-space":
        return `There is not enough free disk space for ${entry.displayName} (${formatDisk(entryWeightsBytes(entry))}). Free up some space and try again.`;
      case "hash-mismatch":
        return "The downloaded file did not match the catalog’s checksum, so it was deleted. Try again.";
      case "listing-mismatch":
        return "Hugging Face lists a different file than the catalog expects, so nothing was downloaded. Try again later.";
      case "not-found":
        return "The file was not found on Hugging Face. Try again later.";
      case "network":
        return "The download kept failing, so it stopped. Check the connection and try again; it picks up where it stopped.";
      case "busy":
        return `${entry.displayName} is already downloading.`;
      case "io":
        return `The file could not be saved: ${error.message}.`;
      case "aborted":
        return "The download stopped. Try again to pick up where it stopped.";
    }
  }
  return `The download failed: ${messageOf(error)}.`;
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function isFile(file: string): Promise<boolean> {
  return (await fileSize(file)) !== null;
}

/** GGUF files start with the bytes "GGUF". */
async function hasGgufMagic(file: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && buffer.toString("latin1") === "GGUF";
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
