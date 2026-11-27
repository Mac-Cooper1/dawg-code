/**
 * The sandbox runtime, shared by every session of the process: the open-source sandbox runtime
 * (`@anthropic-ai/sandbox-runtime`, Apache-2.0) wraps each command line in a Seatbelt profile on
 * macOS (bubblewrap on Linux) and runs one local proxy that lets sandboxed commands reach listed
 * hosts only.
 *
 * What it starts and where, as checked against its source (0.0.83):
 * - One proxy on 127.0.0.1 (HTTP and SOCKS on one port), started the first time an engine runs a
 *   sandboxed command, not per command, and closed when the last engine using it closes.
 * - On macOS, one `log stream` process that reads the system's sandbox log, so a refused write
 *   can be named in the command's result. Stopped with the proxy.
 * - Nothing on disk on macOS: it writes CA material only for TLS termination and masked
 *   credentials, neither of which dawg turns on. (On Linux it keeps a socket folder and empty
 *   mount points under the system's temp folder, and removes them.)
 * - dawg adds one folder under the system's temp folder, `dawg-sandbox-*`, which sandboxed
 *   commands get as $TMPDIR, removed when the runtime stops (and at process exit).
 *
 * The runtime keeps one configuration for the whole process. What differs between sessions is
 * applied per command: file rules are passed with each wrap, and each command's allowed hosts are
 * registered under a random id its proxy credentials carry. Hosts denied by any session with a
 * command running are denied for all while it runs (stricter, never looser), and the few
 * profile switches that live in the shared configuration are set just before each wrap, one wrap
 * at a time.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NetworkConfigSchema,
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

/** Whether the sandbox can run here, and why not when it cannot. */
export interface SandboxAvailability {
  available: boolean;
  /** A sentence for people and the model; null when available. */
  reason: string | null;
  /** Things worth saying that do not stop it (a dependency's warning). */
  warnings: string[];
}

/** One command to wrap, with everything about its session that the wrap needs. */
export interface WrapRequest {
  /** The script to run in the sandbox (bash). */
  script: string;
  /** What the command represents, for violation reports: the command line as the model wrote it. */
  commandText: string;
  /** The shell the script runs in, absolute. */
  shell: string;
  allowWrite: readonly string[];
  denyWrite: readonly (string | { path: string; literal: true })[];
  denyRead: readonly string[];
  allowRead: readonly string[];
  /** `sandbox.filesystem.disabled`: no file rules at all; the network rules still hold. */
  filesystemDisabled: boolean;
  allowedDomains: readonly string[];
  deniedDomains: readonly string[];
  credentials: { files: readonly string[]; envVars: readonly string[] };
  /** The profile switches of the session's settings. */
  switches: SandboxSwitches;
  signal?: AbortSignal;
}

export interface SandboxSwitches {
  allowLocalBinding: boolean;
  allowUnixSockets: readonly string[];
  allowAllUnixSockets: boolean;
  allowMachLookup: readonly string[];
  enableWeakerNetworkIsolation: boolean;
  enableWeakerNestedSandbox: boolean;
  allowAppleEvents: boolean;
  allowNestedUserNamespaces: boolean;
}

export interface WrappedCommand {
  /** A command line for `bash -c`: runs `script` in the sandbox. */
  command: string;
  /** The id the command's violations are filed under. */
  commandId: string;
  /** Call once the command has ended (or never started): drops its allowed hosts. */
  release(): void;
}

/** Turns a domain list into what the runtime accepts, dropping (and naming) what it refuses. */
export function acceptedDomains(
  entries: readonly string[],
  list: "allowedDomains" | "deniedDomains",
): { accepted: string[]; refused: string[] } {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const entry of entries) {
    const probe =
      list === "allowedDomains"
        ? { allowedDomains: [entry], deniedDomains: [] }
        : { allowedDomains: [], deniedDomains: [entry] };
    if (NetworkConfigSchema.safeParse(probe).success) accepted.push(entry);
    else refused.push(entry);
  }
  return { accepted, refused };
}

/** Where the runtime package is installed, so sandboxed commands can be kept from rewriting it. */
function runtimeInstallDir(): string | null {
  try {
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
    // .../@anthropic-ai/sandbox-runtime/dist/index.js
    return realpathSync(path.dirname(path.dirname(entry)));
  } catch {
    return null;
  }
}

function checkAvailability(): SandboxAvailability {
  if (process.platform === "win32") {
    return {
      available: false,
      reason: "The sandbox does not run on Windows in dawg yet.",
      warnings: [],
    };
  }
  if (!SandboxManager.isSupportedPlatform()) {
    const reason =
      process.platform === "linux"
        ? "The sandbox needs WSL 2 or a regular Linux system; WSL 1 is not supported."
        : `The sandbox does not run on ${process.platform}.`;
    return { available: false, reason, warnings: [] };
  }
  if (process.platform === "darwin" && !existsSync("/usr/bin/sandbox-exec")) {
    return {
      available: false,
      reason: "macOS's sandbox-exec is missing from /usr/bin.",
      warnings: [],
    };
  }
  try {
    const check = SandboxManager.checkDependencies();
    if (check.errors.length > 0) {
      const hint =
        process.platform === "linux"
          ? " On Linux it needs bubblewrap, socat and ripgrep installed (for example: sudo apt-get install bubblewrap socat ripgrep)."
          : "";
      return {
        available: false,
        reason: `The sandbox cannot run here: ${check.errors.join("; ")}.${hint}`,
        warnings: check.warnings,
      };
    }
    return { available: true, reason: null, warnings: check.warnings };
  } catch (error) {
    return {
      available: false,
      reason: `The sandbox cannot run here: ${error instanceof Error ? error.message : String(error)}.`,
      warnings: [],
    };
  }
}

/** How long the first start waits for the system's sandbox log to begin reporting. */
const LOG_MONITOR_WAIT_MS = 3000;

/**
 * Waits until the sandbox log the runtime reads (`log stream`) reports refusals, so the first
 * command's blocked writes are named too: a refusal made before the stream is listening is never
 * seen. A probe command that writes nowhere it may is run until its refusal shows, or the wait
 * ends (the commands still run; only their reports may then be missing).
 */
async function waitForLogMonitor(tempDir: string): Promise<void> {
  const until = Date.now() + LOG_MONITOR_WAIT_MS;
  // Writable for dawg, but not for a command wrapped with the base configuration.
  const target = path.join(tempDir, "log-probe");
  while (Date.now() < until) {
    const commandId = randomBytes(16).toString("base64url");
    const wrapped = await SandboxManager.wrapWithSandbox(
      `: > '${target}'`,
      "/bin/sh",
      undefined,
      undefined,
      { commandId },
    );
    await new Promise<void>((resolve) => {
      const child = spawn("/bin/sh", ["-c", wrapped], { stdio: "ignore" });
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    });
    const seenBy = Date.now() + 250;
    while (Date.now() < seenBy) {
      const store = SandboxManager.getSandboxViolationStore();
      if (store.getViolationsForCommand(commandId).length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** Runs tasks one at a time, in order. */
class Queue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

const BASE_CONFIG: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
};

/**
 * The process's sandbox runtime. Engines hold it through `SandboxHost`; it starts on first use
 * and stops when the last host that started it closes.
 */
class SharedSandboxRuntime {
  #users = new Set<object>();
  #starting: Promise<void> | null = null;
  #tempDir: string | null = null;
  #queue = new Queue();
  /** Denied hosts of each command running, by command id. */
  #running = new Map<string, readonly string[]>();
  /** The configuration last installed, as JSON, so an unchanged one is not installed again. */
  #installed = "";
  #exitHook: (() => void) | null = null;

  #availability: SandboxAvailability | null = null;

  /** Checked once per process: the platform and, on Linux, bubblewrap, socat and ripgrep. */
  availability(): SandboxAvailability {
    this.#availability ??= checkAvailability();
    return this.#availability;
  }

  /** The folder sandboxed commands use as temp; null before the runtime has started. */
  get tempDir(): string | null {
    return this.#tempDir;
  }

  /** Where the runtime itself is installed; kept read-only for sandboxed commands. */
  readonly installDir = runtimeInstallDir();

  async start(user: object): Promise<void> {
    this.#users.add(user);
    this.#starting ??= this.#initialize().catch((error: unknown) => {
      this.#starting = null;
      throw error;
    });
    await this.#starting;
  }

  async #initialize(): Promise<void> {
    const listeners = {
      SIGINT: new Set(process.listeners("SIGINT")),
      SIGTERM: new Set(process.listeners("SIGTERM")),
    };
    // Real paths: macOS's /var is a link to /private/var, and Seatbelt compares real paths.
    this.#tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "dawg-sandbox-")));
    const tempDir = this.#tempDir;
    this.#exitHook = () => rmSync(tempDir, { recursive: true, force: true });
    process.once("exit", this.#exitHook);
    try {
      await SandboxManager.initialize(BASE_CONFIG, undefined, process.platform === "darwin");
      this.#installed = JSON.stringify(BASE_CONFIG);
      if (process.platform === "darwin") await waitForLogMonitor(tempDir);
    } catch (error) {
      this.#removeTemp();
      throw error;
    } finally {
      // The runtime adds SIGINT and SIGTERM handlers of its own, which would stop a process that
      // has none from exiting on Ctrl-C. dawg's hosts stop it themselves (close, below).
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!listeners[signal].has(listener)) process.removeListener(signal, listener);
        }
      }
    }
  }

  #removeTemp(): void {
    if (this.#exitHook !== null) process.removeListener("exit", this.#exitHook);
    this.#exitHook = null;
    if (this.#tempDir !== null) rmSync(this.#tempDir, { recursive: true, force: true });
    this.#tempDir = null;
  }

  async stop(user: object): Promise<void> {
    if (!this.#users.delete(user) || this.#users.size > 0) return;
    const starting = this.#starting;
    if (starting === null) return;
    this.#starting = null;
    await starting.catch(() => {});
    await this.#queue.run(async () => {
      await SandboxManager.reset().catch(() => {});
      this.#running.clear();
      this.#installed = "";
      this.#removeTemp();
    });
  }

  /** The configuration a wrap needs installed: shared denies plus this command's switches. */
  #configFor(request: WrapRequest, extraDenied: readonly string[]): SandboxRuntimeConfig {
    const denied = new Set<string>(extraDenied);
    for (const list of this.#running.values()) for (const d of list) denied.add(d);
    const s = request.switches;
    return {
      network: {
        allowedDomains: [],
        deniedDomains: [...denied].sort(),
        allowLocalBinding: s.allowLocalBinding,
        allowUnixSockets: [...s.allowUnixSockets],
        allowAllUnixSockets: s.allowAllUnixSockets,
        allowMachLookup: [...s.allowMachLookup],
      },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      enableWeakerNetworkIsolation: s.enableWeakerNetworkIsolation,
      enableWeakerNestedSandbox: s.enableWeakerNestedSandbox,
      allowAppleEvents: s.allowAppleEvents,
      allowNestedUserNamespaces: s.allowNestedUserNamespaces,
    };
  }

  #install(config: SandboxRuntimeConfig): void {
    const json = JSON.stringify(config);
    if (json === this.#installed) return;
    SandboxManager.updateConfig(config);
    this.#installed = json;
  }

  async wrap(request: WrapRequest): Promise<WrappedCommand> {
    if (this.#starting === null) throw new Error("The sandbox has not been started.");
    await this.#starting;
    const commandId = randomBytes(16).toString("base64url");
    const denied = acceptedDomains(request.deniedDomains, "deniedDomains").accepted;
    const allowed = acceptedDomains(request.allowedDomains, "allowedDomains").accepted;
    const command = await this.#queue.run(async () => {
      this.#install(this.#configFor(request, denied));
      const wrapped = await SandboxManager.wrapWithSandbox(
        request.script,
        request.shell,
        {
          filesystem: {
            allowWrite: [...request.allowWrite],
            denyWrite: [...request.denyWrite],
            denyRead: [...request.denyRead],
            allowRead: [...request.allowRead],
            disabled: request.filesystemDisabled,
          },
          credentials: {
            files: request.credentials.files.map((p) => ({ path: p, mode: "deny" as const })),
            envVars: request.credentials.envVars.map((name) => ({ name, mode: "deny" as const })),
          },
        },
        request.signal,
        { commandId, commandText: request.commandText },
      );
      this.#running.set(commandId, denied);
      if (allowed.length > 0) {
        SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: allowed });
      }
      return wrapped;
    });
    let released = false;
    return {
      command,
      commandId,
      release: () => {
        if (released) return;
        released = true;
        SandboxManager.unregisterCommandNetworkLists(commandId);
        void this.#queue.run(() => {
          this.#running.delete(commandId);
          if (this.#starting === null) return;
          // The shared denies shrink back once no command needs them.
          const current = JSON.parse(this.#installed || "null") as SandboxRuntimeConfig | null;
          if (current === null) return;
          const denied = new Set<string>();
          for (const list of this.#running.values()) for (const d of list) denied.add(d);
          this.#install({
            ...current,
            network: { ...current.network, deniedDomains: [...denied].sort() },
          });
          SandboxManager.cleanupAfterCommand();
        });
      },
    };
  }

  /** What the sandbox recorded for one command, as the runtime words it. */
  violations(commandId: string): string[] {
    return SandboxManager.getSandboxViolationStore()
      .getViolationsForCommand(commandId)
      .map((v) => v.line);
  }

  get running(): boolean {
    return this.#starting !== null;
  }
}

const shared = new SharedSandboxRuntime();

/**
 * One engine's hold on the process's sandbox runtime: it starts the runtime when a session first
 * needs it and lets it go when the engine closes.
 */
export class SandboxHost {
  #closed = false;

  availability(): SandboxAvailability {
    return shared.availability();
  }

  /** Starts the runtime for this engine (once); rejects when it cannot start. */
  async start(): Promise<void> {
    if (this.#closed) throw new Error("The engine is closing.");
    await shared.start(this);
  }

  /** The folder sandboxed commands use as temp. Null until `start` has finished. */
  get tempDir(): string | null {
    return shared.tempDir;
  }

  get installDir(): string | null {
    return shared.installDir;
  }

  wrap(request: WrapRequest): Promise<WrappedCommand> {
    return shared.wrap(request);
  }

  violations(commandId: string): string[] {
    return shared.violations(commandId);
  }

  /** Lets the runtime go; it stops when no other engine in the process holds it. */
  async close(): Promise<void> {
    this.#closed = true;
    await shared.stop(this);
  }
}
