/**
 * Temporary git repositories for the workspace and worktree tests. Git runs without the person's
 * own config (no signing, no hooks), as a fixed author.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitEnv } from "./git.ts";

const env = {
  ...gitEnv(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export interface TestRepo {
  /** As `os.tmpdir()` names it (on macOS, a symlink away from the resolved path). */
  dir: string;
  git(...args: string[]): string;
  write(relative: string, content: string | Uint8Array): Promise<void>;
  read(relative: string): Promise<string>;
  /** Adds everything and commits; returns the new commit. */
  commitAll(message: string): string;
  abs(relative: string): string;
}

const made: string[] = [];

export async function makeTempDir(prefix = "dawg-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function repoAt(dir: string): TestRepo {
  const abs = (relative: string) => path.join(dir, relative);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).replace(/\n$/, "");
  return {
    dir,
    git,
    abs,
    async write(relative, content) {
      await mkdir(path.dirname(abs(relative)), { recursive: true });
      await writeFile(abs(relative), content);
    },
    read: (relative) => readFile(abs(relative), "utf8"),
    commitAll(message) {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
}

/** A new repository on `main` with the given files committed. */
export async function makeRepo(files: Record<string, string> = {}): Promise<TestRepo> {
  const repo = repoAt(await makeTempDir("dawg-repo-"));
  repo.git("init", "-q", "-b", "main");
  for (const [relative, content] of Object.entries(files)) await repo.write(relative, content);
  if (Object.keys(files).length > 0) repo.commitAll("init");
  return repo;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
