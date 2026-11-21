/**
 * How a command line becomes a shell process: which shell, what environment, and the small
 * wrapper that reports the shell's final working directory.
 */
import { accessSync, constants, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionStateBag } from "../../contracts/tools.ts";

/**
 * Settings that keep a command from waiting on a person. Commands also get no terminal and no
 * standard input, so most prompts fail at once; these cover the tools that would otherwise
 * start a pager or an editor, or ask for credentials.
 */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  PAGER: "cat",
  GIT_PAGER: "cat",
  MANPAGER: "cat",
  GH_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
  DEBIAN_FRONTEND: "noninteractive",
};

const shellByPath = new Map<string, string>();

/**
 * The shell commands run with: the first `bash` on `pathValue` (the PATH the command will run
 * with), else /bin/bash, else /bin/sh. Always bash, never the user's $SHELL: the permission
 * engine reads command lines as bash, and another shell (zsh especially) can give the same text
 * a different meaning, so a command judged safe would not be the command that runs.
 */
export function findBash(pathValue: string | undefined): string {
  const key = pathValue ?? "";
  const cached = shellByPath.get(key);
  if (cached) return cached;
  let found: string | undefined;
  for (const dir of key.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "bash");
    if (isExecutableFile(candidate)) {
      found = candidate;
      break;
    }
  }
  found ??= ["/bin/bash", "/bin/sh"].find(isExecutableFile) ?? "/bin/sh";
  shellByPath.set(key, found);
  return found;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The environment a command runs with: ours, the non-interactive settings, then `extra`. */
export function buildShellEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...NON_INTERACTIVE_ENV, ...extra };
  // The shell adopts PWD when it names the directory it starts in, which keeps the logical
  // path (through symbolic links) rather than the physical one.
  env.PWD = cwd;
  delete env.OLDPWD;
  return env;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script given to `<shell> -c`. With `cwdFile`, an exit trap writes the final working
 * directory there, whichever way the shell ends (`exit N`, a failing command, the last line).
 * Everything is on the command's first line so that line numbers in the shell's error
 * messages match the command as written.
 */
export function buildScript(command: string, cwdFile: string | null): string {
  if (cwdFile === null) return command;
  return `__dawg_cwd_file=${shellQuote(cwdFile)}; trap 'pwd >| "$__dawg_cwd_file" 2>/dev/null' EXIT; ${command}`;
}

// ---------------------------------------------------------------------------------------------
// The shell's working directory, which persists between calls
// ---------------------------------------------------------------------------------------------

export interface ShellState {
  /** Where the next command starts (absolute). */
  cwd: string;
}

export const SHELL_STATE_KEY = "bash.shell";

export function getShellState(state: SessionStateBag, initialCwd: string): ShellState {
  return state.get<ShellState>(SHELL_STATE_KEY, () => ({ cwd: initialCwd }));
}

/**
 * The directory the next command will start in, without changing anything: the shell's
 * directory, or the session's when that directory has since been deleted. Synchronous and cheap,
 * for permission checks.
 */
export function nextCommandCwd(state: SessionStateBag, sessionCwd: string): string {
  const current = getShellState(state, sessionCwd).cwd;
  if (current === sessionCwd) return current;
  try {
    return statSync(current).isDirectory() ? current : sessionCwd;
  } catch {
    return sessionCwd;
  }
}

export async function isDirectory(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => null);
  return info?.isDirectory() ?? false;
}

function lexicallyInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Whether `dir` is one of `roots` or below one. Compared lexically first and then with links
 * resolved, so that /tmp and /private/tmp (and the like) count as the same place.
 */
export async function isInsideAny(dir: string, roots: readonly string[]): Promise<boolean> {
  if (roots.some((root) => lexicallyInside(dir, root))) return true;
  const real = await realpath(dir).catch(() => null);
  if (!real) return false;
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot && lexicallyInside(real, realRoot)) return true;
  }
  return false;
}
