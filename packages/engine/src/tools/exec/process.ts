/**
 * Running child processes so that they can always be stopped completely.
 *
 * Every child starts in a new session (and so a new process group, with no controlling
 * terminal), with standard input connected to /dev/null. Stopping one signals the whole group
 * and also every descendant found in the process table, which catches processes that moved to a
 * group or session of their own. Groups still alive when the engine exits are killed then.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type OutputStream = "stdout" | "stderr";

export interface ExitInfo {
  /** Null when the process was ended by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all. */
  error?: Error;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Decoded text as it arrives, in arrival order across both streams. */
  onOutput?: (stream: OutputStream, text: string) => void;
  /** Called with raw bytes instead of text when set. */
  onBytes?: (stream: OutputStream, bytes: Buffer) => void;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly child: ChildProcess;
  /** Resolves when the main process has exited. Never rejects. */
  readonly exited: Promise<ExitInfo>;
  /** Resolves when both output pipes have closed. Never rejects. */
  readonly drained: Promise<void>;
  /**
   * Stops the process and everything it started: SIGINT, then SIGKILL after `graceMs` for
   * whatever is left. Resolves once nothing is left or the wait for SIGKILL gives up.
   */
  terminate(graceMs: number): Promise<void>;
  /** Stops reading output. Use when processes that cannot be stopped still hold the pipes. */
  detachOutput(): void;
  pauseOutput(): void;
  resumeOutput(): void;
}

/** Process groups started here that may still have members. Killed when the engine exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pgid of liveGroups) signalGroup(pgid, "SIGKILL");
  });
}

/** Remembers a group so that it is killed if the engine exits before it ends. */
export function trackGroup(pgid: number): void {
  installExitHook();
  liveGroups.add(pgid);
}

export function untrackGroup(pgid: number): void {
  liveGroups.delete(pgid);
}

export function spawnInGroup(file: string, args: string[], options: SpawnOptions): ProcessHandle {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid !== undefined) trackGroup(pid);

  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const streams: [OutputStream, NodeJS.ReadableStream & { destroy(): void }][] = [];
  if (child.stdout) streams.push(["stdout", child.stdout]);
  if (child.stderr) streams.push(["stderr", child.stderr]);
  const drained = Promise.all(
    streams.map(
      ([name, stream]) =>
        new Promise<void>((resolve) => {
          const decoder = new StringDecoder("utf8");
          stream.on("data", (chunk: Buffer) => {
            if (options.onBytes) options.onBytes(name, chunk);
            else if (options.onOutput) {
              const text = decoder.write(chunk);
              if (text) options.onOutput(name, text);
            }
          });
          const done = () => {
            if (!options.onBytes && options.onOutput) {
              const rest = decoder.end();
              if (rest) options.onOutput(name, rest);
            }
            resolve();
          };
          stream.once("end", done);
          stream.once("close", done);
          stream.once("error", done);
        }),
    ),
  ).then(() => undefined);

  let terminating: Promise<void> | null = null;
  const handle: ProcessHandle = {
    pid,
    child,
    exited,
    drained,
    terminate(graceMs: number) {
      if (pid === undefined) return Promise.resolve();
      terminating ??= terminateTree(pid, graceMs, exited);
      return terminating;
    },
    detachOutput() {
      for (const [, stream] of streams) stream.destroy();
    },
    pauseOutput() {
      for (const [, stream] of streams) stream.pause();
    },
    resumeOutput() {
      for (const [, stream] of streams) stream.resume();
    },
  };

  void exited.then(() => {
    // The group lives on while any member does; forget it only once it is empty.
    if (pid !== undefined && !groupAlive(pid)) untrackGroup(pid);
  });
  return handle;
}

/** Sends `signal` to every process in group `pgid`. Returns false when the group is gone. */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid: number): boolean {
  return signalGroup(pgid, 0);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the pid now belongs to another user's process, so not ours any more.
    return false;
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** A snapshot of the process table. Empty when `ps` is unavailable. */
export function listProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid="],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const rows: ProcessRow[] = [];
        for (const line of stdout.split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const [pid, ppid, pgid] = parts.map(Number);
          if (pid === undefined || ppid === undefined || pgid === undefined) continue;
          if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
            rows.push({ pid, ppid, pgid });
          }
        }
        resolve(rows);
      },
    );
  });
}

/** Every process descended from `roots` or belonging to group `pgid`, excluding this one. */
export async function findTree(roots: Iterable<number>, pgid: number): Promise<Set<number>> {
  const rows = await listProcesses();
  const children = new Map<number, number[]>();
  const found = new Set<number>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
    if (row.pgid === pgid) found.add(row.pid);
  }
  const queue = [...roots, ...found];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    found.add(next);
    for (const child of children.get(next) ?? []) {
      if (!found.has(child)) queue.push(child);
    }
  }
  found.delete(process.pid);
  return found;
}

async function terminateTree(
  pgid: number,
  graceMs: number,
  exited: Promise<ExitInfo>,
): Promise<void> {
  // Snapshot first: once a parent dies its children are adopted by init and the link is lost.
  const tree = await findTree([pgid], pgid);
  signalGroup(pgid, "SIGINT");
  for (const pid of tree) signalPid(pid, "SIGINT");

  const allGone = () => !groupAlive(pgid) && [...tree].every((pid) => !processAlive(pid));
  if (await waitUntil(allGone, graceMs)) {
    await exited;
    untrackGroup(pgid);
    return;
  }

  // Processes started during the grace period are descendants of ones still alive.
  const alive = [...tree].filter(processAlive);
  const late = await findTree(alive, pgid);
  for (const pid of late) tree.add(pid);
  signalGroup(pgid, "SIGKILL");
  for (const pid of tree) signalPid(pid, "SIGKILL");
  await waitUntil(allGone, 2000);
  await Promise.race([exited, delay(2000)]);
  if (!groupAlive(pgid)) untrackGroup(pgid);
}

/** Polls `check` until it is true or `timeoutMs` passes. Returns the last result. */
export async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
