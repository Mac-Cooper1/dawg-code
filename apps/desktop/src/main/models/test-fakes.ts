/**
 * Fakes for the model manager's tests: catalog entries, a downloader the test drives step by
 * step (writing real partial and finished files into a temporary Hugging Face cache), a runtime
 * that becomes ready or crashes when told, and servers that answer from a table. Nothing here
 * touches the network or starts llama-server.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  entryTargets,
  type HardwareProfile,
  type RemoteResult,
  RuntimeError,
  type RuntimeState,
} from "@dawg/models";
import { createKeyStore, type Encryption } from "./keys.ts";
import { type ModelBackend, ModelManager, type ModelManagerOptions } from "./manager.ts";
import type { BundledRuntime, RuntimeEvent, RuntimeLaunch } from "./runtime.ts";
import { createModelsStore, modelsFilePath } from "./store.ts";

export const GB = 1024 ** 3;

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function testEntry(
  id: string,
  options: {
    rank?: number;
    minMemoryGb?: number;
    sizeBytes?: number;
    vision?: boolean;
    chipClasses?: CatalogEntry["chipClasses"];
    displayName?: string;
  } = {},
): CatalogEntry {
  const vision = options.vision ?? false;
  return {
    id,
    displayName: options.displayName ?? `Model ${id} (8-bit)`,
    licence: { spdx: "Apache-2.0", url: "https://example.com/licence" },
    source: {
      repo: "unsloth/Qwen3.8-27B-GGUF",
      revision: "a".repeat(40),
      file: `${id}.gguf`,
      sha256: sha(id),
      sizeBytes: options.sizeBytes ?? 1000,
    },
    ...(vision
      ? { projector: { file: `${id}-mmproj.gguf`, sha256: sha(`${id}/p`), sizeBytes: 200 } }
      : {}),
    minMemoryBytes: (options.minMemoryGb ?? 24) * GB,
    ...(options.chipClasses ? { chipClasses: options.chipClasses } : {}),
    context: { default: 131_072, max: 262_144 },
    capabilities: { tools: true, vision, reasoning: true },
    profile: "qwen3.8",
    rank: options.rank ?? 10,
  };
}

export const M4_MAX: HardwareProfile = {
  arch: "arm64",
  chip: "Apple M4 Max",
  chipClass: "max",
  memoryBytes: 64 * GB,
  performanceCores: 12,
  freeDiskBytes: 500e9,
  macosVersion: "26.1",
};

/** One call to the fake downloader, driven by the test. */
export class DownloadCall {
  readonly entry: CatalogEntry;
  readonly hubDir: string;
  readonly signal: AbortSignal;
  private readonly onProgress: (progress: DownloadProgress) => void;
  private readonly settle: {
    resolve: (value: DownloadedEntry) => void;
    reject: (error: unknown) => void;
  };

  constructor(
    entry: CatalogEntry,
    options: { hubDir: string; signal: AbortSignal; onProgress: (p: DownloadProgress) => void },
    settle: { resolve: (value: DownloadedEntry) => void; reject: (error: unknown) => void },
  ) {
    this.entry = entry;
    this.hubDir = options.hubDir;
    this.signal = options.signal;
    this.onProgress = options.onProgress;
    this.settle = settle;
  }

  private paths(index: number) {
    const target = entryTargets(this.entry)[index];
    if (!target) throw new Error("no such target");
    return cachePaths(this.hubDir, target.repo, target.revision, target.file, target.sha256);
  }

  /** Writes `bytes` of partial model data and reports it. */
  async progress(bytes: number): Promise<void> {
    const paths = this.paths(0);
    await mkdir(path.dirname(paths.incompletePath), { recursive: true });
    await writeFile(paths.incompletePath, Buffer.alloc(bytes, 1));
    const total = entryTargets(this.entry).reduce((sum, t) => sum + t.sizeBytes, 0);
    this.onProgress({
      file: this.entry.source.file,
      phase: "downloading",
      bytesDone: bytes,
      bytesTotal: total,
      bytesPerSecond: 100,
      etaSeconds: (total - bytes) / 100,
    });
  }

  /** Writes every file whole, links the snapshots, and resolves like `downloadEntry`. */
  async finish(): Promise<DownloadedEntry> {
    const files = [];
    const targets = entryTargets(this.entry);
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index] as (typeof targets)[number];
      const paths = this.paths(index);
      await mkdir(path.dirname(paths.blobPath), { recursive: true });
      await writeFile(paths.blobPath, Buffer.alloc(target.sizeBytes, 2));
      await rm(paths.incompletePath, { force: true });
      await mkdir(path.dirname(paths.snapshotPath), { recursive: true });
      await rm(paths.snapshotPath, { force: true });
      await symlink(paths.snapshotTarget, paths.snapshotPath);
      files.push({
        file: target.file,
        path: paths.snapshotPath,
        blobPath: paths.blobPath,
        transferred: true,
      });
    }
    const result: DownloadedEntry = {
      model: files[0] as DownloadedEntry["model"],
      ...(files[1] ? { projector: files[1] } : {}),
    };
    this.settle.resolve(result);
    return result;
  }

  fail(error: unknown): void {
    this.settle.reject(error);
  }
}

export class FakeRuntime implements BundledRuntime {
  state: RuntimeState = "stopped";
  pid: number | undefined;
  readonly logPath = "/data/logs/runtime.log";
  readonly launch: RuntimeLaunch;
  sleeping = false;
  stopped = false;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private waiters: { resolve: (e: Endpoint) => void; reject: (e: unknown) => void }[] = [];
  private endpoint: Endpoint | undefined;
  private readonly ports: () => number;
  private readonly autoReady: boolean;

  constructor(launch: RuntimeLaunch, ports: () => number, autoReady: boolean) {
    this.launch = launch;
    this.ports = ports;
    this.autoReady = autoReady;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  start(): Promise<Endpoint> {
    if (this.state === "ready" && this.endpoint) return Promise.resolve(this.endpoint);
    const promise = new Promise<Endpoint>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.state === "stopped") {
      this.state = "starting";
      this.pid = 4000 + this.ports();
      this.emit({ type: "state", state: "starting", reason: "start" });
      if (this.autoReady) queueMicrotask(() => this.becomeReady());
    }
    return promise;
  }

  /** Answers health: ready on a fresh port. */
  becomeReady(contextWindow = this.launch.contextPerSlot): Endpoint {
    const port = this.ports();
    const endpoint: Endpoint = {
      kind: "bundled",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: `launch-key-${port}`,
      model: this.launch.modelId,
      contextWindow,
      capabilities: { tools: true, vision: false, reasoning: true, cacheControl: true },
      template: { parallelToolCalls: true, reasoningEffortLevels: ["low", "high"] },
    };
    this.state = "ready";
    this.endpoint = endpoint;
    this.emit({ type: "state", state: "ready", reason: "ready" });
    this.emit({ type: "ready", endpoint });
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve(endpoint);
    return endpoint;
  }

  /** llama-server exits unexpectedly; the supervisor restarts it. */
  crash(): void {
    this.state = "crashed";
    this.endpoint = undefined;
    this.emit({ type: "state", state: "crashed", reason: "exit" });
    this.state = "starting";
    this.pid = 4000 + this.ports();
    this.emit({ type: "state", state: "starting", reason: "restart" });
  }

  /** It gave up (a crash loop). */
  fail(message = "llama-server exited unexpectedly (signal SIGKILL) after 3 restarts"): void {
    const error = new RuntimeError("crash-loop", message);
    this.state = "stopped";
    this.endpoint = undefined;
    this.emit({ type: "state", state: "stopped", reason: "crash-loop" });
    this.emit({ type: "failure", error });
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const was = this.state;
    this.state = "stopped";
    this.endpoint = undefined;
    this.pid = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters)
      waiter.reject(new RuntimeError("stopped", "the runtime was stopped"));
    if (was !== "stopped") this.emit({ type: "state", state: "stopped", reason: "stop" });
  }

  async isSleeping(): Promise<boolean> {
    return this.sleeping;
  }
}

export interface FakeServer {
  key?: string;
  models: string[];
}

export function discovered(id: string, contextWindow = 32_768): DiscoveredModel {
  return {
    id,
    contextWindow,
    contextSource: "reported",
    capabilities: { tools: true, vision: false, reasoning: false },
    capabilitiesSource: "reported",
  };
}

/** XOR "encryption", enough to show the key never sits in the file in the clear. */
export const fakeEncryption: Encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(Buffer.from(text, "utf8").map((b) => b ^ 0x5a)),
  decryptString: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString("utf8"),
};

export interface HarnessOptions {
  catalog?: CatalogEntry[];
  hardware?: HardwareProfile;
  /** OpenAI-compatible roots (with /v1) that answer `connectRemote`. */
  remote?: Record<string, FakeServer>;
  local?: DiscoveredServer[];
  scan?: ExistingCopy[];
  testServerUrl?: string;
  testServerSlots?: boolean;
  /** The fake runtime answers health at once. Default true. */
  autoReady?: boolean;
  /** Reuse a data root (a relaunch). */
  dir?: string;
  createRuntimeError?: Error;
}

export async function harness(options: HarnessOptions = {}) {
  const dir = options.dir ?? (await mkdtemp(path.join(tmpdir(), "dawg-models-")));
  const dataRoot = path.join(dir, "dawg");
  const hubDir = path.join(dir, "hub");
  const logs: string[] = [];
  const downloads: DownloadCall[] = [];
  const runtimes: FakeRuntime[] = [];
  const remoteCalls: { url: string; apiKey?: string }[] = [];
  const calls = { scan: 0, detectLocal: 0, discard: 0 };
  let port = 9000;
  const remote = new Map(Object.entries(options.remote ?? {}));

  const backend: ModelBackend = {
    probeHardware: async () => ({ ...(options.hardware ?? M4_MAX) }),
    freeSpace: async () => (options.hardware ?? M4_MAX).freeDiskBytes,
    loadCatalog: async () => options.catalog ?? [],
    download: (entry, download) =>
      new Promise<DownloadedEntry>((resolve, reject) => {
        download.signal.addEventListener(
          "abort",
          () => reject(new DownloadError("aborted", entry.source.file, "stopped")),
          { once: true },
        );
        downloads.push(new DownloadCall(entry, download, { resolve, reject }));
      }),
    discardPartial: async (entry, dir) => {
      calls.discard += 1;
      for (const target of entryTargets(entry)) {
        const paths = cachePaths(dir, target.repo, target.revision, target.file, target.sha256);
        await rm(paths.incompletePath, { force: true });
      }
    },
    scan: async () => {
      calls.scan += 1;
      return options.scan ?? [];
    },
    detectLocalServers: async () => {
      calls.detectLocal += 1;
      return options.local ?? [];
    },
    probeLocalServer: async (kind) => options.local?.find((s) => s.kind === kind) ?? null,
    connectRemote: async ({ url, apiKey }): Promise<RemoteResult> => {
      remoteCalls.push({ url, ...(apiKey === undefined ? {} : { apiKey }) });
      const base = url.replace(/\/+$/, "");
      const server = remote.get(base);
      if (!server) return { ok: false, error: "the server did not answer" };
      if (server.key !== undefined && apiKey !== server.key) {
        return { ok: false, error: "Unauthorized", status: 401 };
      }
      return {
        ok: true,
        server: {
          kind: "remote",
          baseUrl: base,
          ...(apiKey === undefined ? {} : { apiKey }),
          models: server.models.map((id) => discovered(id)),
        },
      };
    },
    createRuntime: async (launch) => {
      if (options.createRuntimeError) throw options.createRuntimeError;
      const runtime = new FakeRuntime(launch, () => port++, options.autoReady ?? true);
      runtimes.push(runtime);
      return runtime;
    },
    residentBytes: async () => 31 * GB,
  };

  const log = (message: string) => logs.push(message);
  const managerOptions: ModelManagerOptions = {
    backend,
    store: createModelsStore(modelsFilePath(dataRoot), log),
    keys: createKeyStore(dataRoot, fakeEncryption, log),
    hubDir,
    log,
    progressIntervalMs: 40,
    pollIntervalMs: 3_600_000,
    ...(options.testServerUrl === undefined ? {} : { testServerUrl: options.testServerUrl }),
    ...(options.testServerSlots === undefined ? {} : { testServerSlots: options.testServerSlots }),
  };
  const manager = new ModelManager(managerOptions);
  let modelsChanged = 0;
  manager.onModelsChanged(() => {
    modelsChanged += 1;
  });
  return {
    dir,
    dataRoot,
    hubDir,
    manager,
    backend,
    downloads,
    runtimes,
    remote,
    remoteCalls,
    calls,
    logs,
    modelsChanged: () => modelsChanged,
    cleanup: async () => {
      await manager.dispose();
      if (!options.dir) await rm(dir, { recursive: true, force: true });
    },
  };
}
