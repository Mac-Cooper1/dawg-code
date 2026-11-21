import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { baseEnv, type ProcessResult, runProcess } from "./proc.ts";
import type { Task } from "./task.ts";

const execFileP = promisify(execFile);

export const GIT_NAME = "dawg-eval";
export const GIT_EMAIL = "dawg-eval@example.invalid";

export interface Workspace {
  /** Parent temp directory holding everything below. */
  root: string;
  /** The project the agent works in: a fresh git repo with the fixture committed. */
  dir: string;
  /** Throwaway HOME for the agent. */
  homeDir: string;
  /** Separate HOME for task scripts (setup.sh, check.sh, solution.sh), so the agent cannot touch it. */
  scriptHomeDir: string;
  /** TMPDIR for processes launched for this run. */
  tmpDir: string;
  /** The baseline commit the agent starts from. */
  baselineSha: string;
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

async function git(ws: { dir: string; homeDir: string; tmpDir: string }, args: string[]) {
  const env = { ...baseEnv(ws.homeDir, ws.tmpDir), GIT_CONFIG_GLOBAL: "/dev/null" };
  const { stdout } = await execFileP("git", args, {
    cwd: ws.dir,
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Environment for task scripts: the minimal base plus TASK_DIR and WORKSPACE. */
export function scriptEnv(
  task: Task,
  ws: Pick<Workspace, "dir" | "scriptHomeDir" | "tmpDir">,
): Record<string, string> {
  return {
    ...baseEnv(ws.scriptHomeDir, ws.tmpDir),
    TASK_DIR: task.dir,
    WORKSPACE: ws.dir,
  };
}

export interface ScriptRun {
  script: string;
  cwd: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function runScript(s: ScriptRun): Promise<ProcessResult> {
  return runProcess({
    command: "bash",
    args: [s.script],
    cwd: s.cwd,
    env: s.env,
    stdoutPath: s.stdoutPath,
    stderrPath: s.stderrPath,
    timeoutMs: s.timeoutMs,
    signal: s.signal,
  });
}

export interface PrepareOptions {
  /** Where setup.sh output goes. */
  artifactsDir: string;
  setupTimeoutMs?: number;
  signal?: AbortSignal;
  /** Parent for the temp directory. Defaults to os.tmpdir(). */
  tempParent?: string;
}

/**
 * Creates a fresh temp workspace for one run: copies the fixture, runs setup.sh, initialises git
 * with a repo-local identity and commits the starting state. Also creates the throwaway HOME.
 * Throws SetupError if setup.sh fails; the caller is responsible for cleanup.
 */
export async function prepareWorkspace(task: Task, opts: PrepareOptions): Promise<Workspace> {
  const root = realpathSync(
    mkdtempSync(join(opts.tempParent ?? tmpdir(), `dawg-eval-${task.id}-`)),
  );
  const dir = join(root, "workspace");
  const homeDir = join(root, "home");
  const scriptHomeDir = join(root, "script-home");
  const tmpDir = join(root, "tmp");
  for (const d of [dir, homeDir, scriptHomeDir, tmpDir]) mkdirSync(d, { recursive: true });

  // Git identity for anything the agent commits, inside its throwaway HOME only.
  writeFileSync(
    join(homeDir, ".gitconfig"),
    `[user]\n\tname = ${GIT_NAME}\n\temail = ${GIT_EMAIL}\n[commit]\n\tgpgsign = false\n`,
  );

  cpSync(task.fixtureDir, dir, { recursive: true });

  const ws: Workspace = { root, dir, homeDir, scriptHomeDir, tmpDir, baselineSha: "" };

  if (task.setupScript) {
    const res = await runScript({
      script: task.setupScript,
      cwd: dir,
      env: scriptEnv(task, ws),
      stdoutPath: join(opts.artifactsDir, "setup.stdout.log"),
      stderrPath: join(opts.artifactsDir, "setup.stderr.log"),
      timeoutMs: opts.setupTimeoutMs ?? 600_000,
      signal: opts.signal,
    });
    if (res.spawnError) throw new SetupError(`setup.sh could not start: ${res.spawnError}`);
    if (res.timedOut) throw new SetupError("setup.sh timed out");
    if (res.exitCode !== 0)
      throw new SetupError(`setup.sh exited with ${res.exitCode ?? res.signal}`);
  }

  if (!existsSync(join(dir, ".git"))) await git(ws, ["init", "-q"]);
  await git(ws, ["config", "user.name", GIT_NAME]);
  await git(ws, ["config", "user.email", GIT_EMAIL]);
  await git(ws, ["config", "commit.gpgsign", "false"]);
  await git(ws, ["add", "-A"]);
  await git(ws, [
    "commit",
    "-q",
    "--allow-empty",
    "--no-verify",
    "-m",
    "dawg-eval: starting state",
  ]);
  ws.baselineSha = (await git(ws, ["rev-parse", "HEAD"])).trim();
  return ws;
}

/**
 * The agent's changes against the baseline commit, including untracked files and anything the
 * agent committed itself. Uses a temporary index, so the workspace's own index is untouched.
 */
export async function finalDiff(ws: Workspace): Promise<string> {
  const indexFile = join(ws.tmpDir, `diff-index-${process.pid}`);
  const env = {
    ...baseEnv(ws.homeDir, ws.tmpDir),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_INDEX_FILE: indexFile,
  };
  const run = async (args: string[]) =>
    (await execFileP("git", args, { cwd: ws.dir, env, maxBuffer: 256 * 1024 * 1024 })).stdout;
  try {
    await run(["add", "-A"]);
    return await run(["diff", "--cached", "--binary", ws.baselineSha]);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

export function removeWorkspace(ws: Pick<Workspace, "root">): void {
  rmSync(ws.root, { recursive: true, force: true });
}
