/**
 * Runs one `command` hook handler (code.claude.com/docs/en/hooks, "Command hooks"): the input as
 * JSON on standard input, the project as working directory, and a timeout after which the whole
 * process group is stopped. The shell form goes through `sh -c`, as on macOS in Claude Code; the
 * exec form (`args` present) starts the program directly, with no shell.
 */
import { spawn } from "node:child_process";
import { signalGroup, trackGroup, untrackGroup } from "../tools/exec/index.ts";

export interface CommandRun {
  /** Null when it was stopped by a signal, timed out, or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when it could not be started at all ("No such file or directory"). */
  startError: string | null;
  /** True when the caller's signal stopped it. */
  aborted: boolean;
  durationMs: number;
}

export interface CommandSpec {
  command: string;
  /** Exec form: the program is `command`, these its arguments, no shell. */
  args: readonly string[] | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to standard input, then closed. */
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Most characters kept of each output stream. */
  maxOutputChars?: number;
  now?: () => number;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
/** After the process exits, how long its pipes may stay open (a child it left running). */
const DRAIN_MS = 200;
/** Between asking the group to stop and making it. */
const KILL_GRACE_MS = 500;

export function runCommand(spec: CommandSpec): Promise<CommandRun> {
  const now = spec.now ?? Date.now;
  const startedAt = now();
  const max = spec.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  return new Promise<CommandRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (fields: Pick<CommandRun, "exitCode" | "startError">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({
        ...fields,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child =
        spec.args === null
          ? spawn("/bin/sh", ["-c", spec.command], {
              cwd: spec.cwd,
              env: spec.env,
              detached: true,
              stdio: ["pipe", "pipe", "pipe"],
            })
          : spawn(spec.command, [...spec.args], {
              cwd: spec.cwd,
              env: spec.env,
              detached: true,
              stdio: ["pipe", "pipe", "pipe"],
            });
    } catch (error) {
      finish({
        exitCode: null,
        startError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) trackGroup(pid);

    const stop = () => {
      if (pid === undefined) return;
      signalGroup(pid, "SIGTERM");
      setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1, spec.timeoutMs),
    );
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < max) stdout += chunk.slice(0, max - stdout.length);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < max) stderr += chunk.slice(0, max - stderr.length);
    });
    // A hook that exits without reading its input closes the pipe under us; that is fine.
    child.stdin?.on("error", () => {});
    child.stdin?.end(spec.stdin);

    child.once("error", (error) => {
      if (pid !== undefined) untrackGroup(pid);
      finish({ exitCode: null, startError: error.message });
    });
    child.once("exit", (code) => {
      // Output may still be in the pipes; a child the hook left running may hold them open, so
      // they get a moment and no more.
      const done = () => {
        if (pid !== undefined) untrackGroup(pid);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ exitCode: timedOut || aborted ? null : code, startError: null });
      };
      let open = 0;
      for (const stream of [child.stdout, child.stderr]) {
        if (stream === null || stream.readableEnded || stream.destroyed) continue;
        open += 1;
        stream.once("close", () => {
          open -= 1;
          if (open === 0) done();
        });
      }
      if (open === 0) done();
      else setTimeout(done, DRAIN_MS).unref();
    });
  });
}
