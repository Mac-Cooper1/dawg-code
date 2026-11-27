import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { requestJson } from "../endpoint/http.ts";
import type { CatalogEntry, Endpoint } from "../types.ts";
import { type ApiKeyFile, createApiKeyFile } from "./api-key.ts";
import { buildLaunchArgs, type LaunchModel, RUNTIME_HOST, type RuntimeSettings } from "./args.ts";
import {
  type CacheTarget,
  eraseSlot,
  type ModelIdentity,
  modelIdentityFromFile,
  restoreSlot,
  type SlotRestoreResult,
  type SlotSaveResult,
  saveSlot,
  slotCacheKey,
  type WarmRequest,
  type WarmResult,
  warmPrefix,
} from "./cache.ts";
import { describeExit, type ExitInfo, RuntimeCrashLoopError, RuntimeError } from "./errors.ts";
import { LineSplitter, RotatingLog } from "./log.ts";
import { findFreePort, isBindFailure } from "./port.ts";
import { bundledEndpoint, parseServerInfo, type ServerInfo } from "./server-info.ts";
import { type WatchdogMessage, watchdogEntry } from "./watchdog-protocol.ts";

export type RuntimeState = "stopped" | "starting" | "ready" | "crashed";

export interface RuntimeModel extends LaunchModel {
  /** The catalog entry, when the model came from the catalog. Refines capabilities. */
  catalogEntry?: CatalogEntry;
  /** Content hash of the model file, for cache keys. Defaults to the catalog's SHA-256. */
  sha256?: string;
}

/** Everything that, when changed, requires a new process. */
export interface RuntimeConfig {
  model: RuntimeModel;
  /** `-c`, the cache in tokens (see `twoSlotLayout`); the per-slot window is read back from the server. */
  contextSize: number;
  slots: number;
  settings: RuntimeSettings;
}

export interface SupervisorPaths {
  /** `--slot-save-path`, e.g. ~/.dawg/runtime/slots */
  slotSaveDir: string;
  /** Holds runtime.log (captured output, rotated) and llama-server.log (`--log-file`). */
  logDir: string;
  /** Parent directory for the per-launch key files. Defaults to the OS temp directory. */
  keyDir?: string;
  /**
   * Put before both log files' names, so a second runtime (the helper model's) keeps logs of its
   * own in the same folder: "helper-" gives helper-runtime.log and helper-llama-server.log.
   */
  logPrefix?: string;
}

export interface SupervisorTiming {
  /** How long a model may take to load before the launch is abandoned. */
  loadTimeoutMs: number;
  healthIntervalMs: number;
  /** SIGTERM → SIGKILL grace period, used by stop() and by the watchdog. */
  stopGraceMs: number;
  restartBaseDelayMs: number;
  restartMaxDelayMs: number;
  /** Restarts after unexpected exits before giving up. */
  maxRestarts: number;
  /** Being ready this long restores the full restart budget. */
  stableAfterMs: number;
  /** New ports to try when the chosen one turns out to be taken. */
  portAttempts: number;
  /** Timeout for each readback request (/props, /v1/models). */
  requestTimeoutMs: number;
}

export const defaultTiming: SupervisorTiming = {
  loadTimeoutMs: 15 * 60_000,
  healthIntervalMs: 250,
  stopGraceMs: 10_000,
  restartBaseDelayMs: 1_000,
  restartMaxDelayMs: 30_000,
  maxRestarts: 3,
  stableAfterMs: 5 * 60_000,
  portAttempts: 5,
  requestTimeoutMs: 15_000,
};

export interface SupervisorOptions extends RuntimeConfig {
  /** The llama-server executable (see resolveRuntimeBinary). */
  binary: string;
  paths: SupervisorPaths;
  timing?: Partial<SupervisorTiming>;
  log?: { maxBytes?: number; files?: number };
  /**
   * Run llama-server under the watchdog (default true), which kills it if this process dies
   * for any reason. Without it only clean exits and catchable signals are covered.
   */
  watchdog?: boolean;
  /**
   * The watchdog script. Defaults to the one beside this module (`watchdogEntry()`). An app that
   * bundles this package builds the script on its own and passes where it put it.
   */
  watchdogPath?: string;
  /**
   * Node binary for the watchdog. Defaults to process.execPath; under Electron pass
   * process.execPath and set ELECTRON_RUN_AS_NODE=1 in `watchdogEnv`.
   */
  nodePath?: string;
  watchdogEnv?: NodeJS.ProcessEnv;
  /** Base environment for the runtime. `LLAMA_*` variables are always removed. */
  env?: NodeJS.ProcessEnv;
  pickPort?: () => Promise<number>;
  fetchImpl?: typeof fetch;
}

export interface StateChange {
  previous: RuntimeState;
  /** Why the state changed, for logs and the UI. */
  reason: "start" | "restart" | "ready" | "exit" | "stop" | "load-timeout" | "crash-loop" | "error";
  exit?: ExitInfo;
  error?: RuntimeError;
}

export interface SupervisorEvents {
  state: [state: RuntimeState, change: StateChange];
  ready: [endpoint: Endpoint, info: ServerInfo];
  /** Every process exit, expected or not. `pid` is llama-server's. */
  exit: [exit: ExitInfo & { expected: boolean; pid: number | undefined }];
  restarting: [attempt: number, delayMs: number];
  /** A terminal failure: the supervisor has stopped and will not retry on its own. */
  failure: [error: RuntimeError];
}

interface Launch {
  id: number;
  port: number;
  key: ApiKeyFile;
  child: ChildProcess;
  viaWatchdog: boolean;
  serverPid: number | undefined;
  /** Output of this launch only (bounded), for diagnosing an early exit. */
  output: string[];
  exitInfo: ExitInfo | undefined;
  /** Set when the watchdog reported llama-server's own exit status. */
  reportedExit: ExitInfo | undefined;
  spawnError: string | undefined;
  expected: boolean;
  exited: Promise<ExitInfo>;
  /** Resolves once llama-server's pid is known. */
  spawned: Promise<void>;
  terminating?: Promise<void>;
}

interface Run {
  abort: AbortController;
  finished: Promise<void>;
}

type Waiter = { resolve: (endpoint: Endpoint) => void; reject: (error: RuntimeError) => void };

const live = new Set<RuntimeSupervisor>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous last resort on a normal exit. Crashes and SIGKILL are the watchdog's job.
  process.once("exit", () => {
    for (const supervisor of live) supervisor.killNowSync();
  });
}

/**
 * Owns one llama-server process: launch, health, readback, restart with backoff, stop.
 *
 * States: stopped → starting → ready → (crashed → starting …) → stopped. A crash restarts the
 * process with exponential backoff up to `maxRestarts` times; after that the supervisor stops
 * and emits `failure` with the log tail.
 */
export class RuntimeSupervisor extends EventEmitter<SupervisorEvents> {
  private config: RuntimeConfig;
  private readonly options: SupervisorOptions;
  private readonly timing: SupervisorTiming;
  private readonly log: RotatingLog;
  private currentState: RuntimeState = "stopped";
  private run: Run | undefined;
  private launch: Launch | undefined;
  private stopping: Promise<void> | undefined;
  private waiters: Waiter[] = [];
  private launchCount = 0;
  private currentEndpoint: Endpoint | undefined;
  private currentInfo: ServerInfo | undefined;
  private lastError: RuntimeError | undefined;

  constructor(options: SupervisorOptions) {
    super();
    this.options = options;
    this.config = {
      model: options.model,
      contextSize: options.contextSize,
      slots: options.slots,
      settings: options.settings,
    };
    this.timing = { ...defaultTiming, ...options.timing };
    this.log = new RotatingLog(
      join(options.paths.logDir, `${options.paths.logPrefix ?? ""}runtime.log`),
      {
        maxBytes: options.log?.maxBytes ?? 5 * 1024 * 1024,
        files: options.log?.files ?? 3,
      },
    );
    // Fail fast on a bad configuration, before anything is spawned.
    this.validate(this.config);
  }

  get state(): RuntimeState {
    return this.currentState;
  }

  /** The endpoint while ready, else undefined. */
  get endpoint(): Endpoint | undefined {
    return this.currentState === "ready" ? this.currentEndpoint : undefined;
  }

  get serverInfo(): ServerInfo | undefined {
    return this.currentState === "ready" ? this.currentInfo : undefined;
  }

  /** llama-server's pid while a process is running. */
  get pid(): number | undefined {
    return this.launch?.exitInfo ? undefined : this.launch?.serverPid;
  }

  get port(): number | undefined {
    return this.launch?.port;
  }

  /** Both pids of the running launch (the watchdog is absent when disabled). */
  get processIds(): { watchdog: number | undefined; server: number | undefined } {
    const launch = this.launch;
    if (!launch || launch.exitInfo) return { watchdog: undefined, server: undefined };
    return {
      watchdog: launch.viaWatchdog ? launch.child.pid : undefined,
      server: launch.serverPid,
    };
  }

  get currentConfig(): RuntimeConfig {
    return this.config;
  }

  /** The failure that last stopped the supervisor, if any. */
  get error(): RuntimeError | undefined {
    return this.lastError;
  }

  get logPath(): string {
    return this.log.path;
  }

  logTail(lines = 60): string {
    return this.log.tail(lines);
  }

  /** Starts the runtime (if needed) and resolves once it is ready. */
  async start(): Promise<Endpoint> {
    if (this.stopping) await this.stopping;
    if (this.currentState === "ready" && this.currentEndpoint) return this.currentEndpoint;
    if (!this.run) {
      this.lastError = undefined;
      live.add(this);
      installExitHook();
      const abort = new AbortController();
      const run: Run = { abort, finished: Promise.resolve() };
      this.run = run;
      run.finished = this.supervise(run).finally(() => {
        if (this.run === run) this.run = undefined;
        if (!this.run) live.delete(this);
      });
    }
    return this.waitUntilReady();
  }

  /** Resolves with the endpoint once ready; rejects if the supervisor stops or gives up first. */
  waitUntilReady(): Promise<Endpoint> {
    if (this.currentState === "ready" && this.currentEndpoint) {
      return Promise.resolve(this.currentEndpoint);
    }
    if (!this.run) {
      return Promise.reject(
        this.lastError ?? new RuntimeError("stopped", "the runtime is not running"),
      );
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** SIGTERM, then SIGKILL after the grace period. Idempotent; concurrent calls share one stop. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const run = this.run;
    if (!run && !this.launch) return Promise.resolve();
    this.stopping = (async () => {
      run?.abort.abort();
      const launch = this.launch;
      if (launch) await this.terminate(launch);
      await run?.finished;
      this.rejectWaiters(new RuntimeError("stopped", "the runtime was stopped"));
      this.setState("stopped", { reason: "stop" });
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  /** Applies a new model, context, slot count or settings. Always restarts the process. */
  async reconfigure(changes: Partial<RuntimeConfig>): Promise<Endpoint> {
    const next: RuntimeConfig = { ...this.config, ...changes };
    this.validate(next);
    await this.stop();
    this.config = next;
    return this.start();
  }

  /** Whether the server has put the model to sleep (idle unload). */
  async isSleeping(): Promise<boolean> {
    const target = this.cacheTarget();
    const result = await requestJson(`${target.origin}/props`, {
      apiKey: target.apiKey,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.timing.requestTimeoutMs,
    });
    if (!result.ok)
      throw new RuntimeError("bad-response", `reading /props failed: ${result.message}`);
    return (result.data as { is_sleeping?: unknown }).is_sleeping === true;
  }

  // --- prompt-cache hooks -------------------------------------------------------------------

  /** Processes a prefix into a slot so the next request that starts with it skips that work. */
  async warm(request: WarmRequest): Promise<WarmResult> {
    return warmPrefix(this.cacheTarget(), request);
  }

  async saveSlot(slot: number, key: string): Promise<SlotSaveResult> {
    return saveSlot(this.cacheTarget(), slot, key);
  }

  async restoreSlot(slot: number, key: string): Promise<SlotRestoreResult> {
    return restoreSlot(this.cacheTarget(), slot, key);
  }

  async eraseSlot(slot: number): Promise<void> {
    return eraseSlot(this.cacheTarget(), slot);
  }

  /** The cache key for `prefix` with the running model, template and build. */
  async slotKey(prefix: string | Uint8Array, extra?: string): Promise<string> {
    const info = this.currentInfo;
    if (this.currentState !== "ready" || !info) {
      throw new RuntimeError("not-ready", "the runtime is not ready");
    }
    return slotCacheKey({
      model: await this.modelIdentity(),
      chatTemplate: info.chatTemplate,
      runtimeBuild: info.buildInfo,
      prefix,
      extra,
    });
  }

  async modelIdentity(): Promise<ModelIdentity> {
    const model = this.config.model;
    const sha256 = model.sha256 ?? model.catalogEntry?.source.sha256;
    return sha256 ? { sha256 } : modelIdentityFromFile(model.path);
  }

  /** Last-resort synchronous kill, used from the process exit hook. */
  killNowSync(): void {
    const launch = this.launch;
    if (!launch || launch.exitInfo || launch.child.pid === undefined) return;
    launch.expected = true;
    try {
      // One SIGTERM to the watchdog (or the server); the watchdog escalates on its own.
      process.kill(launch.child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  // --- internals ----------------------------------------------------------------------------

  private validate(config: RuntimeConfig): void {
    buildLaunchArgs({
      ...config,
      port: 1,
      paths: { apiKeyFile: "-", slotSaveDir: "-", logFile: "-" },
    });
  }

  private cacheTarget(): CacheTarget {
    const launch = this.launch;
    const info = this.currentInfo;
    if (this.currentState !== "ready" || !launch || !info) {
      throw new RuntimeError("not-ready", "the runtime is not ready");
    }
    return {
      origin: `http://${RUNTIME_HOST}:${launch.port}`,
      apiKey: launch.key.key,
      totalSlots: info.totalSlots,
      slotSaveDir: this.options.paths.slotSaveDir,
      fetchImpl: this.options.fetchImpl,
    };
  }

  private setState(state: RuntimeState, change: Omit<StateChange, "previous">): void {
    const previous = this.currentState;
    if (previous === state && change.reason !== "restart") return;
    this.currentState = state;
    if (state !== "ready") {
      this.currentEndpoint = undefined;
    }
    this.emit("state", state, { previous, ...change });
  }

  private rejectWaiters(error: RuntimeError): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(error);
  }

  private resolveWaiters(endpoint: Endpoint): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve(endpoint);
  }

  private fail(error: RuntimeError, reason: StateChange["reason"]): void {
    this.lastError = error;
    // Detach the finished run now, so a start() from a failure listener begins a fresh one.
    this.run = undefined;
    this.setState("stopped", { reason, error });
    this.rejectWaiters(error);
    if (this.listenerCount("failure") > 0) this.emit("failure", error);
  }

  private async supervise(run: Run): Promise<void> {
    const { signal } = run.abort;
    let restarts = 0;
    let reason: StateChange["reason"] = "start";
    while (!signal.aborted) {
      this.setState("starting", { reason });
      let outcome: Awaited<ReturnType<RuntimeSupervisor["launchUntilReady"]>>;
      try {
        outcome = await this.launchUntilReady(signal);
      } catch (error) {
        const launch = this.launch;
        if (launch) await this.terminate(launch);
        if (signal.aborted) return;
        const runtimeError =
          error instanceof RuntimeError
            ? error
            : new RuntimeError("spawn-failed", String(error), {
                cause: error,
                logTail: this.log.tail(),
              });
        this.fail(runtimeError, runtimeError.code === "load-timeout" ? "load-timeout" : "error");
        return;
      }
      if (signal.aborted) return;

      let exit: ExitInfo;
      if (outcome.kind === "ready") {
        const { launch, endpoint, info } = outcome;
        this.currentEndpoint = endpoint;
        this.currentInfo = info;
        this.setState("ready", { reason: "ready" });
        this.emit("ready", endpoint, info);
        this.resolveWaiters(endpoint);
        const stable = setTimeout(() => {
          restarts = 0;
        }, this.timing.stableAfterMs);
        stable.unref();
        const ended = await Promise.race([launch.exited, untilAborted(signal)]);
        clearTimeout(stable);
        if (signal.aborted || !ended) return;
        exit = ended;
      } else {
        exit = outcome.exit;
      }

      this.setState("crashed", { reason: "exit", exit });
      if (restarts >= this.timing.maxRestarts) {
        this.fail(new RuntimeCrashLoopError(restarts, exit, this.log.tail()), "crash-loop");
        return;
      }
      const delay = Math.min(
        this.timing.restartBaseDelayMs * 2 ** restarts,
        this.timing.restartMaxDelayMs,
      );
      restarts++;
      this.log.writeLine(
        `[dawg] llama-server exited unexpectedly (${describeExit(exit)}); restart ${restarts} of ${this.timing.maxRestarts} in ${delay} ms`,
      );
      this.emit("restarting", restarts, delay);
      try {
        await sleep(delay, undefined, { signal });
      } catch {
        return;
      }
      reason = "restart";
    }
  }

  /** Spawns (retrying on port conflicts) and waits for health, or reports an early exit. */
  private async launchUntilReady(
    signal: AbortSignal,
  ): Promise<
    | { kind: "ready"; launch: Launch; endpoint: Endpoint; info: ServerInfo }
    | { kind: "exited"; launch: Launch; exit: ExitInfo }
  > {
    for (let attempt = 1; ; attempt++) {
      const port = await (this.options.pickPort ?? (() => findFreePort(RUNTIME_HOST)))();
      const launch = await this.spawnLaunch(port);
      const health = await this.waitForHealth(launch, signal);
      if (health === "aborted") throw new RuntimeError("stopped", "the runtime was stopped");
      if (health === "timeout") {
        throw new RuntimeError(
          "load-timeout",
          `llama-server did not become ready within ${this.timing.loadTimeoutMs} ms`,
          { logTail: this.log.tail() },
        );
      }
      if (health === "ready") {
        let readBack: { endpoint: Endpoint; info: ServerInfo };
        try {
          readBack = await this.readBack(launch);
        } catch (error) {
          // Dying right after reporting healthy is a crash, not a protocol problem.
          const exited = await Promise.race([
            launch.exited,
            sleep(500, undefined, { ref: false }).then(() => undefined),
          ]);
          if (!exited) throw error;
          await launch.key.dispose();
          return { kind: "exited", launch, exit: exited };
        }
        const { endpoint, info } = readBack;
        await launch.key.dispose();
        // The watchdog reports llama-server's pid over IPC; it normally arrives long before
        // health, but make sure callers can rely on `pid` once ready.
        await Promise.race([launch.spawned, sleep(2_000, undefined, { ref: false })]);
        return { kind: "ready", launch, endpoint, info };
      }
      // Exited before becoming ready.
      const exit = await launch.exited;
      await launch.key.dispose();
      if (launch.spawnError) {
        throw new RuntimeError(
          "spawn-failed",
          `could not start llama-server: ${launch.spawnError}`,
          {
            logTail: this.log.tail(),
          },
        );
      }
      if (isBindFailure(launch.output.join("\n"))) {
        if (attempt < this.timing.portAttempts) {
          this.log.writeLine(`[dawg] port ${port} was taken; retrying with another port`);
          continue;
        }
        throw new RuntimeError(
          "port-unavailable",
          `llama-server could not bind a port after ${attempt} attempts`,
          { logTail: this.log.tail() },
        );
      }
      return { kind: "exited", launch, exit };
    }
  }

  private async spawnLaunch(port: number): Promise<Launch> {
    const { paths } = this.options;
    await mkdir(paths.slotSaveDir, { recursive: true });
    await mkdir(paths.logDir, { recursive: true });
    if (paths.keyDir) await mkdir(paths.keyDir, { recursive: true, mode: 0o700 });
    const key = await createApiKeyFile(paths.keyDir);
    const args = buildLaunchArgs({
      ...this.config,
      port,
      paths: {
        apiKeyFile: key.path,
        slotSaveDir: paths.slotSaveDir,
        logFile: join(paths.logDir, `${paths.logPrefix ?? ""}llama-server.log`),
      },
    });
    const id = ++this.launchCount;
    this.log.setSecrets([key.key]);
    this.log.writeLine(
      `[dawg] launch ${id} at ${new Date().toISOString()} on port ${port}: ${this.options.binary} ${args.join(" ")}`,
    );

    const env = runtimeEnv(this.options.env ?? process.env);
    const viaWatchdog = this.options.watchdog !== false;
    const child = viaWatchdog
      ? spawn(
          this.options.nodePath ?? process.execPath,
          [
            this.options.watchdogPath ?? watchdogEntry(),
            "--grace-ms",
            String(this.timing.stopGraceMs),
            "--",
            this.options.binary,
            ...args,
          ],
          {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            detached: true,
            env: { ...env, ...this.options.watchdogEnv },
          },
        )
      : spawn(this.options.binary, args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          env,
        });

    const launch: Launch = {
      id,
      port,
      key,
      child,
      viaWatchdog,
      serverPid: viaWatchdog ? undefined : child.pid,
      output: [],
      exitInfo: undefined,
      reportedExit: undefined,
      spawnError: undefined,
      expected: false,
      exited: Promise.resolve({ code: null, signal: null }),
      spawned: Promise.resolve(),
    };
    this.launch = launch;
    let markSpawned = () => {};
    if (viaWatchdog) launch.spawned = new Promise<void>((resolve) => (markSpawned = resolve));

    const onLine = (line: string) => {
      this.log.writeLine(line);
      if (launch.output.length < 400) launch.output.push(line);
    };
    const out = new LineSplitter(onLine);
    const err = new LineSplitter(onLine);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    child.on("message", (message: WatchdogMessage) => {
      if (message.type === "spawned") {
        launch.serverPid = message.pid;
        markSpawned();
      } else if (message.type === "exit")
        launch.reportedExit = { code: message.code, signal: message.signal };
      else if (message.type === "spawn-error") launch.spawnError = message.message;
    });

    launch.exited = new Promise<ExitInfo>((resolve) => {
      let done = false;
      const finish = (info: ExitInfo) => {
        if (done) return;
        done = true;
        out.flush();
        err.flush();
        const exit = launch.reportedExit ?? info;
        if (launch.viaWatchdog && !launch.reportedExit && child.pid !== undefined) {
          // The watchdog died without reporting llama-server's exit (e.g. it was SIGKILLed):
          // llama-server may still be running in the watchdog's process group. Sweep it.
          killGroup(child.pid, "SIGKILL");
        }
        launch.exitInfo = exit;
        this.log.writeLine(`[dawg] launch ${id}: llama-server exited (${describeExit(exit)})`);
        this.emit("exit", { ...exit, expected: launch.expected, pid: launch.serverPid });
        resolve(exit);
      };
      child.once("exit", (code, signal) => finish({ code, signal }));
      child.once("error", (error) => {
        launch.spawnError ??= error.message;
        // When spawning itself failed there is no exit event.
        if (child.pid === undefined) finish({ code: null, signal: null });
      });
    });
    return launch;
  }

  private async waitForHealth(
    launch: Launch,
    signal: AbortSignal,
  ): Promise<"ready" | "exited" | "timeout" | "aborted"> {
    const deadline = Date.now() + this.timing.loadTimeoutMs;
    const url = `http://${RUNTIME_HOST}:${launch.port}/health`;
    // An exit must interrupt a request in flight: whatever holds the port may never answer.
    const exitedSignal = new AbortController();
    void launch.exited.then(() => exitedSignal.abort());
    const requestSignal = AbortSignal.any([signal, exitedSignal.signal]);
    for (;;) {
      if (signal.aborted) return "aborted";
      if (launch.exitInfo) return "exited";
      if (Date.now() >= deadline) return "timeout";
      const result = await requestJson(url, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())),
        signal: requestSignal,
      });
      if (result.ok && result.status === 200) {
        // A server that just died can still have answered; trust the exit first.
        return launch.exitInfo ? "exited" : "ready";
      }
      const wait = Math.max(0, Math.min(this.timing.healthIntervalMs, deadline - Date.now()));
      await Promise.race([sleep(wait, undefined, { signal }).catch(() => {}), launch.exited]);
    }
  }

  private async readBack(launch: Launch): Promise<{ endpoint: Endpoint; info: ServerInfo }> {
    const origin = `http://${RUNTIME_HOST}:${launch.port}`;
    const options = {
      apiKey: launch.key.key,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.timing.requestTimeoutMs,
    };
    const [props, models] = await Promise.all([
      requestJson(`${origin}/props`, options),
      requestJson(`${origin}/v1/models`, options),
    ]);
    if (!props.ok || !models.ok) {
      const failed = !props.ok ? props : models;
      throw new RuntimeError(
        "bad-response",
        `readback failed: ${failed.ok ? "" : failed.message}`,
        {
          logTail: this.log.tail(),
        },
      );
    }
    let info: ServerInfo;
    try {
      info = parseServerInfo(props.data, models.data);
    } catch (error) {
      throw new RuntimeError("bad-response", "unexpected /props or /v1/models response", {
        cause: error,
        logTail: this.log.tail(),
      });
    }
    this.log.writeLine(
      `[dawg] launch ${launch.id} ready: model ${info.modelId}, ${info.totalSlots} slot(s) of ${info.contextWindow} tokens, build ${info.buildInfo}`,
    );
    return {
      info,
      endpoint: bundledEndpoint(launch.port, launch.key.key, info, this.config.model.catalogEntry),
    };
  }

  /** Stops one launch. Memoized, so the process never receives SIGTERM twice from here. */
  private terminate(launch: Launch): Promise<void> {
    launch.terminating ??= this.terminateOnce(launch);
    return launch.terminating;
  }

  private async terminateOnce(launch: Launch): Promise<void> {
    if (launch.exitInfo) {
      await launch.key.dispose();
      return;
    }
    launch.expected = true;
    const pid = launch.child.pid;
    if (pid !== undefined) {
      try {
        // Signal the watchdog only: it forwards exactly one SIGTERM. A second SIGTERM makes
        // llama-server skip its clean shutdown.
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exiting.
      }
      const exitedInTime = await Promise.race([
        launch.exited.then(() => true),
        sleep(this.timing.stopGraceMs, undefined, { ref: false }).then(() => false),
      ]);
      if (!exitedInTime) {
        this.log.writeLine(`[dawg] launch ${launch.id}: no exit after SIGTERM; sending SIGKILL`);
        killGroup(pid, "SIGKILL");
      }
    }
    await launch.exited;
    await launch.key.dispose();
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already empty.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/** Resolves (with undefined) once `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

/** The runtime's environment: the parent's, minus anything that would change llama-server's flags. */
export function runtimeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith("LLAMA_")) continue;
    env[name] = value;
  }
  return env;
}
