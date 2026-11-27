/**
 * Runs one `!` command from a skill or command body, as Claude Code documents it
 * (code.claude.com/docs/en/skills, "Inject dynamic context"): in bash, in the session's working
 * directory, with the Bash tool's default timeout; its output replaces the placeholder. A
 * non-zero exit fails the whole invocation, except exit 1 from commands that use it for "no
 * match" or "differs" (grep, rg, diff and the like). Permission is checked by the caller.
 */
import { buildShellEnv, findBash } from "../tools/bash/shell.ts";
import { delay, type OutputStream, spawnInGroup } from "../tools/exec/process.ts";
import { EscapeStripper } from "../tools/exec/terminal.ts";

export interface InjectedCommand {
  command: string;
  cwd: string;
  /** Extra environment variables from settings. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Characters of output kept; more is cut with a note. */
  maxChars: number;
  signal: AbortSignal;
}

export type InjectedResult =
  | { ok: true; output: string }
  | {
      ok: false;
      reason: "failed" | "timeout" | "interrupted" | "start";
      output: string;
      code: number | null;
    };

/** Commands for which exit 1 is a result ("no match", "the files differ"), not a failure. */
const EXIT_ONE_IS_A_RESULT =
  /^(?:\S+=\S*\s+)*(?:grep|egrep|fgrep|rg|diff|cmp|git\s+(?:grep|diff))\b/;

export function exitOneIsResult(command: string): boolean {
  // The last command of a pipeline decides the exit code.
  const last = command.split(/\|(?!\|)/).at(-1) ?? command;
  return EXIT_ONE_IS_A_RESULT.test(last.trim());
}

const KILL_GRACE_MS = 1000;
const DRAIN_GRACE_MS = 1000;

export async function runInjectedCommand(input: InjectedCommand): Promise<InjectedResult> {
  const env = buildShellEnv(process.env, input.env, input.cwd);
  const strippers: Record<OutputStream, EscapeStripper> = {
    stdout: new EscapeStripper(),
    stderr: new EscapeStripper(),
  };
  let output = "";
  let cut = false;
  const handle = spawnInGroup(findBash(env.PATH), ["-c", input.command], {
    cwd: input.cwd,
    env,
    onOutput: (stream, text) => {
      if (cut) return;
      output += strippers[stream].push(text);
      if (output.length > input.maxChars) {
        output = output.slice(0, input.maxChars);
        cut = true;
      }
    },
  });
  let timedOut = false;
  let interrupted = false;
  const stop = () => void handle.terminate(KILL_GRACE_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs);
  const onAbort = () => {
    interrupted = true;
    stop();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  let exit: Awaited<typeof handle.exited>;
  try {
    exit = await handle.exited;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
  const drained = await Promise.race([
    handle.drained.then(() => true),
    delay(DRAIN_GRACE_MS).then(() => false),
  ]);
  if (!drained) {
    // Something it started still holds the output: it is not waited for.
    await handle.terminate(KILL_GRACE_MS);
    handle.detachOutput();
  }
  if (!cut) output += strippers.stdout.flush() + strippers.stderr.flush();
  const text = `${output.replace(/\n+$/, "")}${cut ? `\n[output cut at ${input.maxChars} characters]` : ""}`;
  if (exit.error) return { ok: false, reason: "start", output: exit.error.message, code: null };
  if (interrupted) return { ok: false, reason: "interrupted", output: text, code: exit.code };
  if (timedOut) return { ok: false, reason: "timeout", output: text, code: exit.code };
  if (exit.code === 0 || (exit.code === 1 && exitOneIsResult(input.command))) {
    return { ok: true, output: text };
  }
  return { ok: false, reason: "failed", output: text, code: exit.code };
}
