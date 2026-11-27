/**
 * Background commands for one session (Bash with `run_in_background`).
 *
 * Each task runs in its own process group and writes its output, cleaned of terminal escapes,
 * to a file under the session's tool-results folder. The registry lives in the session's state
 * bag; the turn loop uses it to hear when tasks finish and to stop them all when the session
 * ends.
 */
import { type FileHandle, open } from "node:fs/promises";
import type { SessionStateBag } from "../../contracts/tools.ts";
import { OutputCollector } from "../exec/output.ts";
import {
  delay,
  groupAlive,
  type OutputStream,
  type ProcessHandle,
  signalGroup,
  spawnInGroup,
  untrackGroup,
  waitUntil,
} from "../exec/process.ts";
import { EscapeStripper } from "../exec/terminal.ts";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

/** Why a task was stopped by us rather than ending on its own. */
export type StopReason = "requested" | "time_limit" | "output_limit" | "session_end";

export interface BackgroundTaskInfo {
  id: string;
  command: string;
  description: string | null;
  /** Directory the command started in (absolute). */
  cwd: string;
  /** File collecting the output (absolute). */
  outputPath: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  signal: string | null;
  stopReason: StopReason | null;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number | null;
  outputBytes: number;
}

export interface StartTaskOptions {
  command: string;
  description: string | null;
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  /** An existing (empty) file that receives the output. */
  outputPath: string;
  /** Stops the task after this long. None when absent. */
  timeLimitMs?: number;
  /** Time between SIGINT and SIGKILL when the task is stopped. */
  killGraceMs: number;
  /** Total output after which the task is stopped. */
  outputLimitBytes: number;
  /**
   * Added (Phase 4, sandbox): what the shell really runs, when it differs from `command` (the
   * command wrapped in the sandbox). `command` is still what the task shows.
   */
  script?: string;
  /** Added (Phase 4, sandbox): called once when the task has ended, however it ended. */
  onEnded?: () => void;
}

export interface TaskOutputRead {
  info: BackgroundTaskInfo;
  /** Output written since the previous read, shortened to head and tail when long. */
  text: string;
  /** Bytes of new output, including any part left out of `text`. */
  newBytes: number;
  truncated: boolean;
}

interface TaskRecord {
  info: BackgroundTaskInfo;
  handle: ProcessHandle;
  collector: OutputCollector;
  graceMs: number;
  /** Resolves when the task has ended and its output file is complete. */
  done: Promise<void>;
  /** Bytes of the output file already returned by `readOutput`. */
  readOffset: number;
}

export type TaskFinishedListener = (info: BackgroundTaskInfo) => void;
export type TaskUpdatedListener = (info: BackgroundTaskInfo) => void;

/** A page of a task's output file, from `background.output`. */
export interface OutputPage {
  /** The bytes read, decoded; never ends or starts in the middle of a character. */
  text: string;
  /** Where the next page starts. */
  nextOffset: number;
  /** The file's size when it was read. */
  totalBytes: number;
}

export const BACKGROUND_TASKS_KEY = "bash.backgroundTasks";

/** The session's registry, created on first use. */
export function getBackgroundTasks(state: SessionStateBag): BackgroundTasks {
  return state.get(BACKGROUND_TASKS_KEY, () => new BackgroundTasks());
}

export class BackgroundTasks {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<TaskFinishedListener>();
  private readonly updatedListeners = new Set<TaskUpdatedListener>();
  private unreported: string[] = [];
  /**
   * Process groups left behind by foreground commands (`nohup x &`), stopped with the rest.
   * Each maps to the grace period between SIGINT and SIGKILL.
   */
  private readonly leftoverGroups = new Map<number, number>();
  private counter = 0;

  start(options: StartTaskOptions): BackgroundTaskInfo {
    this.counter += 1;
    const id = `bash-${this.counter}`;
    const info: BackgroundTaskInfo = {
      id,
      command: options.command,
      description: options.description,
      cwd: options.cwd,
      outputPath: options.outputPath,
      status: "running",
      exitCode: null,
      signal: null,
      stopReason: null,
      startedAt: Date.now(),
      endedAt: null,
      outputBytes: 0,
    };

    let handle: ProcessHandle | null = null;
    let record: TaskRecord | null = null;
    const collector = new OutputCollector({
      maxChars: 4000,
      fileCapBytes: options.outputLimitBytes + 4096,
      filePath: options.outputPath,
      limitBytes: options.outputLimitBytes,
      onLimit: () => {
        if (record) void this.stopRecord(record, "output_limit");
      },
      pause: () => handle?.pauseOutput(),
      resume: () => handle?.resumeOutput(),
    });
    const strippers: Record<OutputStream, EscapeStripper> = {
      stdout: new EscapeStripper(),
      stderr: new EscapeStripper(),
    };
    handle = spawnInGroup(options.shell, ["-c", options.script ?? options.command], {
      cwd: options.cwd,
      env: options.env,
      onOutput: (stream, text) => {
        const clean = strippers[stream].push(text);
        if (clean) {
          collector.push(clean);
          info.outputBytes = collector.bytes;
        }
      },
    });

    const started = handle;
    let timer: NodeJS.Timeout | null = null;
    const done = (async () => {
      const exit = await started.exited;
      if (exit.error) collector.push(`Could not start the shell: ${exit.error.message}\n`);
      // The task is the shell's lifetime: whatever it left behind goes with it. A process that
      // escaped the tree and still holds the output is cut off rather than waited for.
      const drained = await settlesWithin(started.drained, DRAIN_GRACE_MS);
      if (!drained || (started.pid !== undefined && groupAlive(started.pid))) {
        await started.terminate(options.killGraceMs);
      }
      if (!drained && !(await settlesWithin(started.drained, 500))) started.detachOutput();
      await collector.finish();
      info.exitCode = exit.code;
      info.signal = exit.signal;
      info.endedAt = Date.now();
      if (info.stopReason !== null) info.status = "stopped";
      else info.status = exit.code === 0 ? "completed" : "failed";
      if (timer) clearTimeout(timer);
      if (started.pid !== undefined) untrackGroup(started.pid);
      try {
        options.onEnded?.();
      } catch {
        // Releasing what the task held must not keep it from being reported.
      }
      this.unreported.push(id);
      notify(this.updatedListeners, info);
      notify(this.listeners, info);
    })();

    record = {
      info,
      handle: started,
      collector,
      graceMs: options.killGraceMs,
      done,
      readOffset: 0,
    };
    this.tasks.set(id, record);
    const current = record;
    if (options.timeLimitMs !== undefined) {
      timer = setTimeout(() => void this.stopRecord(current, "time_limit"), options.timeLimitMs);
      timer.unref();
    }
    notify(this.updatedListeners, info);
    return { ...info };
  }

  /**
   * Makes new ids continue after `bash-<n>`, so a resumed session never reuses the id of a task
   * an earlier run started (the model and the client both know those ids).
   */
  continueAfter(n: number): void {
    if (Number.isInteger(n) && n > this.counter) this.counter = n;
  }

  /** The last characters a task printed, for a short notice when it finishes. */
  recentOutput(id: string, maxChars: number): string {
    return this.tasks.get(id)?.collector.recentText(maxChars) ?? "";
  }

  list(): BackgroundTaskInfo[] {
    return [...this.tasks.values()].map((r) => ({ ...r.info }));
  }

  running(): BackgroundTaskInfo[] {
    return this.list().filter((t) => t.status === "running");
  }

  get(id: string): BackgroundTaskInfo | undefined {
    const record = this.tasks.get(id);
    return record ? { ...record.info } : undefined;
  }

  /** Output written since the previous call for this task, at most about `maxChars`. */
  async readOutput(id: string, maxChars: number): Promise<TaskOutputRead | undefined> {
    const record = this.tasks.get(id);
    if (!record) return undefined;
    const file = await open(record.info.outputPath, "r").catch(() => null);
    if (!file) return { info: { ...record.info }, text: "", newBytes: 0, truncated: false };
    try {
      const size = (await file.stat()).size;
      const start = record.readOffset;
      const available = Math.max(0, size - start);
      if (available === 0) {
        return { info: { ...record.info }, text: "", newBytes: 0, truncated: false };
      }
      if (available <= maxChars) {
        const bytes = await readRange(file, start, available);
        const end = completeUtf8Length(bytes);
        record.readOffset = start + end;
        return {
          info: { ...record.info },
          text: bytes.subarray(0, end).toString("utf8"),
          newBytes: end,
          truncated: false,
        };
      }
      const half = Math.floor(maxChars / 2);
      const head = await readRange(file, start, half);
      const tail = await readRange(file, size - half, half);
      const tailEnd = completeUtf8Length(tail);
      record.readOffset = size - half + tailEnd;
      const newBytes = record.readOffset - start;
      const omitted = newBytes - head.length - tailEnd;
      const text =
        `${head.toString("utf8")}\n\n[... ${omitted.toLocaleString("en-US")} bytes omitted; ` +
        `the full output is in ${record.info.outputPath} ...]\n\n` +
        tail.subarray(0, tailEnd).toString("utf8");
      return { info: { ...record.info }, text, newBytes, truncated: true };
    } finally {
      await file.close();
    }
  }

  /** Waits until the task ends, `timeoutMs` passes or `signal` aborts; returns its state. */
  async waitFor(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BackgroundTaskInfo | undefined> {
    const record = this.tasks.get(id);
    if (!record) return undefined;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      record.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
      new Promise<void>((resolve) => {
        if (!signal) return;
        if (signal.aborted) resolve();
        onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    return { ...record.info };
  }

  /** Stops a running task and everything it started. Returns its final state. */
  async stop(
    id: string,
    reason: StopReason = "requested",
  ): Promise<BackgroundTaskInfo | undefined> {
    const record = this.tasks.get(id);
    if (!record) return undefined;
    await this.stopRecord(record, reason);
    return { ...record.info };
  }

  /** Stops every running task and every leftover process group. For the end of a session. */
  async stopAll(reason: StopReason = "session_end"): Promise<void> {
    const pending = [...this.tasks.values()]
      .filter((r) => r.info.status === "running")
      .map((r) => this.stopRecord(r, reason));
    const leftovers = [...this.leftoverGroups].map(async ([pgid, graceMs]) => {
      this.leftoverGroups.delete(pgid);
      if (!groupAlive(pgid)) return;
      signalGroup(pgid, "SIGINT");
      if (!(await waitUntil(() => !groupAlive(pgid), graceMs))) {
        signalGroup(pgid, "SIGKILL");
        await waitUntil(() => !groupAlive(pgid), 2000);
      }
      untrackGroup(pgid);
    });
    await Promise.all([...pending, ...leftovers]);
  }

  /** Remembers a process group a foreground command left running, to stop it with the rest. */
  adoptLeftoverGroup(pgid: number, graceMs: number): void {
    // Forget groups that have ended, so a reused id is never signalled.
    for (const known of this.leftoverGroups.keys()) {
      if (!groupAlive(known)) {
        this.leftoverGroups.delete(known);
        untrackGroup(known);
      }
    }
    this.leftoverGroups.set(pgid, graceMs);
  }

  /**
   * Calls `listener` when a task starts and when it ends (or is stopped), with its state then.
   * Returns a function that removes it.
   */
  onUpdated(listener: TaskUpdatedListener): () => void {
    this.updatedListeners.add(listener);
    return () => this.updatedListeners.delete(listener);
  }

  /** Calls `listener` whenever a task ends. Returns a function that removes it. */
  onFinished(listener: TaskFinishedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Tasks that ended since the previous call, oldest first. The turn loop uses this to tell
   * the model about finished tasks without missing any or repeating one.
   */
  takeFinished(): BackgroundTaskInfo[] {
    const ids = this.unreported;
    this.unreported = [];
    return ids.flatMap((id) => {
      const record = this.tasks.get(id);
      return record ? [{ ...record.info }] : [];
    });
  }

  private async stopRecord(record: TaskRecord, reason: StopReason): Promise<void> {
    if (record.info.status === "running" && record.info.stopReason === null) {
      record.info.stopReason = reason;
      await record.handle.terminate(record.graceMs);
    }
    await record.done;
  }
}

function notify(listeners: ReadonlySet<TaskUpdatedListener>, info: BackgroundTaskInfo): void {
  for (const listener of listeners) {
    try {
      listener({ ...info });
    } catch {
      // A failing listener must not affect the task or the other listeners.
    }
  }
}

/**
 * Reads at most `limit` bytes of a task's output file from `offset`. The file holds plain text
 * (control sequences were removed as it was written). A page never splits a UTF-8 character: it
 * ends before a character cut off at the limit, and an offset inside a character moves on to the
 * next one. A page holds at least one whole character when there is one, even past `limit`, so
 * paging always moves forward. A missing file reads as empty.
 */
export async function readOutputPage(
  file: string,
  offset: number,
  limit: number,
): Promise<OutputPage> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return { text: "", nextOffset: 0, totalBytes: 0 };
  try {
    const size = (await handle.stat()).size;
    let start = Math.min(Math.max(0, Math.floor(offset)), size);
    // A few bytes more: to skip continuation bytes at the start and to finish a character.
    const bytes = await readRange(handle, start, Math.min(size - start, Math.max(1, limit) + 6));
    let skip = 0;
    while (skip < 3 && skip < bytes.length && ((bytes[skip] ?? 0) & 0xc0) === 0x80) skip += 1;
    start += skip;
    const rest = bytes.subarray(skip);
    let end = completeUtf8Length(rest.subarray(0, Math.min(rest.length, limit)));
    if (end === 0 && rest.length > 0) {
      // The limit is smaller than the first character: return it whole once it is all written.
      const whole = utf8Length(rest[0] ?? 0);
      if (rest.length >= whole) end = whole;
    }
    return {
      text: rest.subarray(0, end).toString("utf8"),
      nextOffset: start + end,
      totalBytes: size,
    };
  } finally {
    await handle.close();
  }
}

/** The length of the UTF-8 sequence that `lead` starts; 1 for a byte that starts none. */
function utf8Length(lead: number): number {
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/** How long to wait for output pipes to close after the shell exits. */
const DRAIN_GRACE_MS = 300;

/** Whether `promise` settles within `ms`. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

async function readRange(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** The length of `bytes` without a UTF-8 sequence cut off at its end. */
function completeUtf8Length(bytes: Buffer): number {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const byte = bytes[n - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    if ((byte & 0x80) === 0) return n; // ASCII
    const needed = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;
    return back >= needed ? n : n - back;
  }
  return n;
}
