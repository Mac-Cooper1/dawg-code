/**
 * Runs git for the workspace and worktree services: always through `execFile` (never a shell),
 * with paths after `--` or as literal pathspecs, and without the variables a git hook sets, so a
 * command never lands in another repository.
 */
import { execFile } from "node:child_process";

/** Variables a parent git (a hook, `git rebase -x`) sets, which would redirect our git. */
const INHERITED_GIT_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
];

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of INHERITED_GIT_VARIABLES) delete env[name];
  // Reading never takes the index lock, so the person's own git never finds it held.
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export class GitError extends Error {
  /** The exit code; -1 when git did not run or was stopped. */
  readonly exitCode: number;
  readonly stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.name = "GitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitOptions {
  cwd: string;
  /** Written to git's standard input. */
  input?: string;
  /** Exit codes that are answers, not failures (`check-ignore` exits 1 when nothing matched). */
  okCodes?: readonly number[];
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export function runGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const okCodes = options.okCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderrBuffer) => {
        const stderr = stderrBuffer.toString("utf8");
        if (error && typeof error.code !== "number") {
          const why = error.killed
            ? "it took too long"
            : error.code === "ENOENT"
              ? "git is not installed"
              : error.message;
          reject(new GitError(`git ${args[0] ?? ""} did not run: ${why}`, -1, stderr));
          return;
        }
        const exitCode = error ? Number(error.code) : 0;
        if (!okCodes.includes(exitCode)) {
          reject(
            new GitError(
              `git ${args[0] ?? ""} failed: ${firstLine(stderr) || `exit code ${exitCode}`}`,
              exitCode,
              stderr,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode });
      },
    );
    // Git may exit before it reads everything (an error); that must not crash main.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}

/** Stdout as text, with the trailing newline removed. */
export async function gitText(args: readonly string[], options: GitOptions): Promise<string> {
  const { stdout } = await runGit(args, options);
  return stdout.toString("utf8").replace(/\n$/, "");
}

/** Splits `-z` output into its fields (the trailing NUL leaves no empty field). */
export function splitNul(output: Buffer | string): string[] {
  const text = typeof output === "string" ? output : output.toString("utf8");
  const fields = text.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
}

export function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return (line ?? "").replace(/^(fatal|error): /, "");
}

/** The repository's top level for a directory (resolved), or null when it is not in one. */
export async function topLevelOf(dir: string): Promise<string | null> {
  try {
    const top = await gitText(["rev-parse", "--show-toplevel"], { cwd: dir });
    return top === "" ? null : top;
  } catch {
    return null;
  }
}

/** The checked-out branch's short name, or null when HEAD is detached. */
export async function currentBranch(dir: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], {
    cwd: dir,
    okCodes: [0, 1],
  });
  if (exitCode !== 0) return null;
  const name = stdout.toString("utf8").trim();
  return name === "" ? null : name;
}

/** The commit a revision names, or null when it names none. */
export async function resolveCommit(dir: string, revision: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
    { cwd: dir, okCodes: [0, 1, 128] },
  );
  if (exitCode !== 0) return null;
  const hash = stdout.toString("utf8").trim();
  return hash === "" ? null : hash;
}

/** The empty tree's hash in this repository's format: the base of a repository with no commits. */
export async function emptyTree(dir: string): Promise<string> {
  return gitText(["hash-object", "-t", "tree", "--stdin"], { cwd: dir, input: "" });
}

/** "commit", "tree", "blob" or "tag" for an object hash; null when the repository lacks it. */
export async function objectType(dir: string, hash: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,64}$/.test(hash)) return null;
  const { stdout, exitCode } = await runGit(["cat-file", "-t", hash], {
    cwd: dir,
    okCodes: [0, 1, 128],
  });
  return exitCode === 0 ? stdout.toString("utf8").trim() : null;
}

export type BaseObject =
  | { kind: "missing" }
  | { kind: "blob"; hash: string; size: number }
  /** A submodule's commit or a directory: not something a text diff can show. */
  | { kind: "other" };

/** What `<base>:<path>` is, without reading it. */
export async function describeBaseObject(
  root: string,
  base: string,
  relativePath: string,
): Promise<BaseObject> {
  const { stdout } = await runGit(
    ["--literal-pathspecs", "ls-tree", "-z", "-l", "--full-tree", base, "--", relativePath],
    { cwd: root },
  );
  // "<mode> <type> <hash> <size>\t<path>"
  const entry = splitNul(stdout).find((field) => field.endsWith(`\t${relativePath}`));
  const match = entry === undefined ? null : /^\d+ (\w+) ([0-9a-f]+) +(\d+|-)\t/.exec(entry);
  if (!match) return { kind: "missing" };
  const [, type, hash = "", size = "0"] = match;
  if (type !== "blob") return { kind: "other" };
  return { kind: "blob", hash, size: Number(size) };
}

export async function readBlob(root: string, hash: string): Promise<Buffer> {
  const { stdout } = await runGit(["cat-file", "blob", hash], { cwd: root });
  return stdout;
}
