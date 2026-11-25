/**
 * The Bash tool: runs a command line with non-interactive bash.
 *
 * - Always bash (the first on the command's PATH, else /bin/bash), never the user's $SHELL: the
 *   permission engine judges command lines as bash, so they must run as bash.
 * - Standard input is /dev/null and there is no controlling terminal, so nothing can wait on a
 *   person. Each command gets its own process group, and stopping one (timeout, interrupt)
 *   sends SIGINT and then SIGKILL to that group and to every descendant.
 * - The working directory persists between calls; environment changes do not. As documented
 *   for Claude Code, a command that ends outside the working directories has the shell's
 *   directory reset to the project directory, and the result says so.
 * - Output is cleaned of terminal escapes, streamed live, and kept in bounded memory. Long
 *   output is cut to head and tail with the full text saved to a file.
 * - A foreground command that leaves processes behind still holding its output is followed by
 *   stopping them; detached leftovers are stopped with the session.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandDisplay } from "@dawg/protocol";
import type { PermissionSubject } from "../../contracts/permissions.ts";
import {
  DEFAULT_TOOL_LIMITS,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
  type ToolProbeContext,
} from "../../contracts/tools.ts";
import { OutputCollector } from "../exec/output.ts";
import { delay, groupAlive, type OutputStream, spawnInGroup } from "../exec/process.ts";
import { EscapeStripper } from "../exec/terminal.ts";
import { getBackgroundTasks } from "./background.ts";
import {
  buildScript,
  buildShellEnv,
  findBash,
  getShellState,
  isDirectory,
  isInsideAny,
  nextCommandCwd,
} from "./shell.ts";

export interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

export interface BashToolOptions {
  /** The bash binary to run commands with. Defaults to the first bash on the command's PATH. */
  bashPath?: string;
  /** Time between SIGINT and SIGKILL when a command is stopped. */
  killGraceMs?: number;
  /** How long to wait for output pipes to close after the shell exits. */
  drainGraceMs?: number;
}

export const KILL_GRACE_MS = 2000;
const DRAIN_GRACE_MS = 300;
/** The overflow file for one foreground command holds at most this much (as documented). */
export const OUTPUT_FILE_CAP_BYTES = 64 * 1024 * 1024;
/** A command that prints more than this is stopped. */
export const OUTPUT_KILL_BYTES = 1024 * 1024 * 1024;
/** Live output sent as progress per call; the rest is still collected, just not streamed. */
const PROGRESS_MAX_CHARS = 1024 * 1024;
/** The longest time limit a background command can ask for. */
export const BACKGROUND_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const limits = DEFAULT_TOOL_LIMITS;
const DESCRIPTION = `Run a shell command with bash and get back its output and exit code.

- Commands run in non-interactive bash with no input and no terminal. Write bash syntax; the bash may be an old version (3.2 on macOS), so avoid features newer than that, such as associative arrays (declare -A), mapfile, or case changes with ,, and ^^. Anything that waits for input, a password or an editor fails or ends at once, so use flags that avoid prompts (for example -y, --no-edit, -m "message").
- The working directory carries over between calls: after "cd src" the next command starts in src. If a command leaves the project's working directories, the directory is reset to the project directory. Environment variables, aliases and other shell state do not carry over.
- Quote paths that contain spaces.
- Standard output and standard error come back together, in the order they were printed. Very long output is cut to its beginning and end, and the full text is saved to a file whose path is given.
- timeout is in milliseconds: ${limits.bashDefaultTimeoutMs} (${limits.bashDefaultTimeoutMs / 60_000} minutes) by default, at most ${limits.bashMaxTimeoutMs} (${limits.bashMaxTimeoutMs / 60_000} minutes); a larger value is lowered to that. A command still running at its timeout is stopped.
- Set run_in_background for servers, watchers and other commands that keep running. The call returns at once with a task id and the path of a file that collects the output: read that file to check on the task, and stop it with TaskStop when it is no longer needed. Do not add "&" yourself. With run_in_background, timeout (up to ${BACKGROUND_MAX_TIMEOUT_MS} ms, 2 hours) stops the task after that long; without it the task runs until it ends or is stopped.
- description: a few words on what the command does, for example "Run the unit tests".
- To read, edit, create or search files, use the Read, Edit, Write, Glob and Grep tools rather than cat, sed, echo, find or grep.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command line to run." },
    timeout: {
      type: "integer",
      minimum: 1,
      // The background ceiling; a foreground command is lowered to the session's own maximum.
      maximum: BACKGROUND_MAX_TIMEOUT_MS,
      description: "Time limit in milliseconds.",
    },
    description: {
      type: "string",
      description: "What the command does, in a few words.",
    },
    run_in_background: {
      type: "boolean",
      description: "Start the command in the background and return at once.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

export function createBashTool(options: BashToolOptions = {}): ToolDefinition<BashInput> {
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const drainGraceMs = options.drainGraceMs ?? DRAIN_GRACE_MS;
  return {
    name: "Bash",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    readOnly: false,

    permission(input: BashInput, ctx: ToolProbeContext): PermissionSubject {
      return { kind: "command", command: input.command, cwd: nextCommandCwd(ctx.state, ctx.cwd) };
    },

    async execute(input: BashInput, ctx: ToolContext): Promise<ToolOutput> {
      if (!input.command.trim()) return errorOutput("The command is empty.");
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
      const state = getShellState(ctx.state, ctx.cwd);
      const notes: string[] = [];
      if (!(await isDirectory(state.cwd))) {
        notes.push(
          `The previous working directory ${state.cwd} no longer exists, so the command ran in ${ctx.cwd}.`,
        );
        state.cwd = ctx.cwd;
      }
      const env = buildShellEnv(process.env, ctx.env, state.cwd);
      const shell = options.bashPath ?? findBash(env.PATH);
      if (input.run_in_background) {
        return startInBackground(input, ctx, { shell, env, cwd: state.cwd, killGraceMs, notes });
      }
      return runInForeground(input, ctx, { shell, env, killGraceMs, drainGraceMs, notes });
    },
  };
}

export const bashTool: ToolDefinition<BashInput> = createBashTool();

async function runInForeground(
  input: BashInput,
  ctx: ToolContext,
  run: {
    shell: string;
    env: NodeJS.ProcessEnv;
    killGraceMs: number;
    drainGraceMs: number;
    notes: string[];
  },
): Promise<ToolOutput> {
  const state = getShellState(ctx.state, ctx.cwd);
  const runCwd = state.cwd;
  const timeoutMs = clampTimeout(
    input.timeout,
    ctx.limits.bashDefaultTimeoutMs,
    ctx.limits.bashMaxTimeoutMs,
  );
  const scratch = await mkdtemp(path.join(tmpdir(), "dawg-shell-"));
  const cwdFile = path.join(scratch, "cwd");
  const started = Date.now();

  let timedOut = false;
  let interrupted = false;
  let outputLimited = false;
  let leftoversStopped = false;
  let leftoversDetached = false;
  let progressChars = 0;
  let progressCapped = false;

  try {
    let stopNow: () => void = () => {};
    let pause: () => void = () => {};
    let resume: () => void = () => {};
    const collector = new OutputCollector({
      maxChars: ctx.limits.bashMaxOutputChars,
      fileCapBytes: OUTPUT_FILE_CAP_BYTES,
      createFile: (initial) => ctx.saveOutput("bash-output.txt", initial),
      limitBytes: OUTPUT_KILL_BYTES,
      onLimit: () => {
        outputLimited = true;
        stopNow();
      },
      pause: () => pause(),
      resume: () => resume(),
    });
    const strippers: Record<OutputStream, EscapeStripper> = {
      stdout: new EscapeStripper(),
      stderr: new EscapeStripper(),
    };
    const handle = spawnInGroup(run.shell, ["-c", buildScript(input.command, cwdFile)], {
      cwd: runCwd,
      env: run.env,
      onOutput: (stream, text) => {
        const clean = strippers[stream].push(text);
        if (!clean) return;
        collector.push(clean);
        if (progressChars < PROGRESS_MAX_CHARS) {
          progressChars += clean.length;
          ctx.progress({ kind: "output", stream, text: clean });
        } else if (!progressCapped) {
          progressCapped = true;
          ctx.progress({
            kind: "status",
            message: "Live output is no longer shown; it is still being collected.",
          });
        }
      },
    });
    stopNow = () => void handle.terminate(run.killGraceMs);
    pause = () => handle.pauseOutput();
    resume = () => handle.resumeOutput();

    const timer = setTimeout(() => {
      timedOut = true;
      stopNow();
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      stopNow();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    // An interrupt that arrived while the command was being set up fired before this listener
    // existed, and an abort event is never repeated.
    if (ctx.signal.aborted) onAbort();

    let exit: Awaited<typeof handle.exited>;
    try {
      exit = await handle.exited;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
    if (exit.error) {
      await collector.finish();
      return errorOutput(`Could not start the shell (${run.shell}): ${exit.error.message}`);
    }

    const stopped = timedOut || interrupted || outputLimited;
    const drainedInTime = await Promise.race([
      handle.drained.then(() => true),
      delay(run.drainGraceMs).then(() => false),
    ]);
    if (!drainedInTime) {
      // Something the command started is still running and holding its output open.
      if (!stopped) leftoversStopped = true;
      await handle.terminate(run.killGraceMs);
      const drainedAfterKill = await Promise.race([
        handle.drained.then(() => true),
        delay(500).then(() => false),
      ]);
      if (!drainedAfterKill) {
        // A process that left the tree before it could be found still holds the output.
        handle.detachOutput();
        leftoversDetached = true;
      }
    }
    if (stopped) {
      await handle.terminate(run.killGraceMs);
    } else if (handle.pid !== undefined && groupAlive(handle.pid)) {
      // Detached from the output (nohup and the like): left running, stopped with the session.
      getBackgroundTasks(ctx.state).adoptLeftoverGroup(handle.pid, run.killGraceMs);
    }
    strippers.stdout.flush();
    strippers.stderr.flush();
    const collected = await collector.finish();

    const cwdNote = await updateCwd(cwdFile, ctx);
    if (cwdNote) run.notes.push(cwdNote);

    const durationMs = Date.now() - started;
    // The sentences added for the model after the output. The display carries them too, apart
    // from the exit code line, which it has as a number.
    const notes: string[] = [];
    let exitLine: string | null = null;
    if (timedOut) {
      notes.push(`The command did not finish within ${formatDuration(timeoutMs)} and was stopped.`);
    } else if (interrupted) {
      notes.push("The command was interrupted.");
    } else if (outputLimited) {
      notes.push("The command printed more than 1 GiB of output and was stopped.");
    } else if (exit.signal) {
      notes.push(`The command was ended by ${exit.signal}.`);
    } else if (exit.code !== 0) {
      exitLine = `Exit code ${exit.code}`;
    }
    if (collected.truncated) {
      if (collected.outputPath) {
        const extent = collected.fileTruncated
          ? `The first ${OUTPUT_FILE_CAP_BYTES / (1024 * 1024)} MiB of it are saved in`
          : "The full output is saved in";
        notes.push(
          `The output was ${collected.totalChars.toLocaleString("en-US")} characters, so only its beginning and end are shown. ${extent} ${collected.outputPath}.`,
        );
      } else {
        notes.push(
          `The output was ${collected.totalChars.toLocaleString("en-US")} characters, so only its beginning and end are shown. It could not be saved (${collected.fileError ?? "unknown error"}).`,
        );
      }
    }
    if (leftoversStopped) {
      notes.push(
        leftoversDetached
          ? "The command left processes running that kept its output open. Those that could be found were stopped; output from any others is no longer collected. Use run_in_background for servers and other long-running commands."
          : "The command left processes running that kept its output open, so they were stopped. Use run_in_background for servers and other long-running commands.",
      );
    }
    notes.push(...run.notes);

    const body = collected.text.replace(/\n+$/, "");
    const footerText = (exitLine === null ? notes : [exitLine, ...notes]).join("\n");
    const text = body
      ? footerText
        ? `${body}\n\n${footerText}`
        : body
      : footerText || "(no output)";
    const exitCode = timedOut || interrupted || outputLimited || exit.signal ? null : exit.code;
    const display: CommandDisplay = {
      kind: "command",
      command: input.command,
      cwd: runCwd,
      exitCode,
      durationMs,
      timedOut,
      interrupted,
      backgroundTaskId: null,
      outputPath: collected.truncated ? collected.outputPath : null,
      output: body,
      notes,
    };
    return {
      content: [{ type: "text", text }],
      isError: exitCode !== 0,
      display,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Reads where the shell ended up and decides where the next command starts. */
async function updateCwd(cwdFile: string, ctx: ToolContext): Promise<string | null> {
  const state = getShellState(ctx.state, ctx.cwd);
  const reported = (await readFile(cwdFile, "utf8").catch(() => "")).replace(/\n$/, "");
  // No report (the shell was killed, or replaced itself with exec): the directory is unchanged.
  if (!reported || !path.isAbsolute(reported)) return null;
  if (!(await isDirectory(reported))) {
    state.cwd = ctx.cwd;
    return `The working directory ${reported} no longer exists, so the shell is back in ${ctx.cwd}.`;
  }
  if (!(await isInsideAny(reported, ctx.workingDirectories))) {
    state.cwd = ctx.cwd;
    return `The command ended in ${reported}, outside the working directories, so the shell's working directory was reset to ${ctx.cwd}.`;
  }
  state.cwd = reported;
  return null;
}

async function startInBackground(
  input: BashInput,
  ctx: ToolContext,
  run: {
    shell: string;
    env: NodeJS.ProcessEnv;
    cwd: string;
    killGraceMs: number;
    notes: string[];
  },
): Promise<ToolOutput> {
  const { shell, env, cwd, killGraceMs, notes } = run;
  const tasks = getBackgroundTasks(ctx.state);
  const outputPath = await ctx.saveOutput("bash-background.txt", "");
  const timeLimitMs =
    input.timeout !== undefined && input.timeout > 0
      ? Math.min(Math.floor(input.timeout), BACKGROUND_MAX_TIMEOUT_MS)
      : undefined;
  const info = tasks.start({
    command: input.command,
    description: input.description?.trim() || null,
    cwd,
    shell,
    env,
    outputPath,
    timeLimitMs,
    killGraceMs,
    outputLimitBytes: OUTPUT_KILL_BYTES,
  });
  const lines = [
    `Started in the background as task ${info.id}.`,
    `Its output is being written to ${outputPath}. Read that file to check on it.`,
    `Stop it with TaskStop (task_id "${info.id}") when it is no longer needed.`,
  ];
  if (timeLimitMs !== undefined) {
    lines.push(`It will be stopped if it is still running after ${formatDuration(timeLimitMs)}.`);
  }
  lines.push(...notes);
  const display: CommandDisplay = {
    kind: "command",
    command: input.command,
    cwd,
    exitCode: null,
    durationMs: null,
    timedOut: false,
    interrupted: false,
    backgroundTaskId: info.id,
    outputPath,
    // Nothing printed yet; the client follows the task through its output file.
    output: null,
    notes: [],
  };
  return { content: [{ type: "text", text: lines.join("\n") }], display };
}

function clampTimeout(requested: number | undefined, fallback: number, max: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(fallback, max);
  }
  return Math.min(Math.floor(requested), Math.max(max, 1));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 120) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} seconds`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
}

function errorOutput(message: string): ToolOutput {
  return { content: [{ type: "text", text: message }], isError: true };
}
