import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Files that receive the child's stdout and stderr (appended). */
  stdoutPath: string;
  stderrPath: string;
  /** Wall-clock limit. On expiry the whole process group is killed. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL. Default 2000 ms. */
  killGraceMs?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError: string | null;
}

/**
 * Sends a signal to a whole process group. Ignores "no such process".
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a command in its own process group (POSIX `setsid` via `detached`), with stdout and stderr
 * written straight to files. On timeout or abort the whole group gets SIGTERM, then SIGKILL after a
 * grace period. When the group leader exits, any stragglers it left in the group are SIGKILLed too,
 * so a hung background child can never outlive its run.
 */
export function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  const outFd = openSync(opts.stdoutPath, "a");
  const errFd = openSync(opts.stderrPath, "a");
  const grace = opts.killGraceMs ?? 2000;

  return new Promise<ProcessResult>((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    closeSync(outFd);
    closeSync(errFd);

    const pid = child.pid;

    const terminate = () => {
      if (pid === undefined) return;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), grace);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (result: Omit<ProcessResult, "durationMs" | "timedOut" | "aborted">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pid !== undefined && groupAlive(pid)) {
        // Leftover children (background servers, sleeping shells): SIGKILL them now.
        killGroup(pid, "SIGKILL");
      }
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ...result,
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - started),
      });
    };

    child.once("error", (err) => {
      finish({ exitCode: null, signal: null, spawnError: err.message });
    });
    child.once("exit", (code, signal) => {
      finish({ exitCode: code, signal, spawnError: null });
    });
  });
}

/**
 * Splits a command line into argv words. Supports single quotes, double quotes and backslash
 * escapes; no expansion of any kind. Used for `--proxy-cmd` and `--agent-cmd` templates.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1] as string)) {
        cur += input[++i];
      } else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in command: ${input}`);
  if (inWord) out.push(cur);
  return out;
}

const PASSTHROUGH_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "SHELL",
  "USER",
  "LOGNAME",
];

/**
 * A minimal environment for anything the runner launches on a task's behalf (agents and task
 * scripts). Built from an allowlist, so no API keys or tokens from the runner's own environment
 * leak into the agent under test.
 */
export function baseEnv(homeDir: string, tmpDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  env.LANG ??= "en_US.UTF-8";
  env.HOME = homeDir;
  env.TMPDIR = tmpDir;
  env.XDG_CONFIG_HOME = `${homeDir}/.config`;
  env.XDG_DATA_HOME = `${homeDir}/.local/share`;
  env.XDG_STATE_HOME = `${homeDir}/.local/state`;
  env.XDG_CACHE_HOME = `${homeDir}/.cache`;
  // Keep git away from the host's system and global config.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.NO_COLOR = "1";
  env.CI = "1";
  return env;
}
