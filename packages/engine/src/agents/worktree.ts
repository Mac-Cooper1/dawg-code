/**
 * Isolation (`isolation: "worktree"`): a subagent that works in a git worktree of its own, so its
 * file changes stay apart from the person's checkout until someone merges them.
 *
 * The engine makes the worktree itself, rather than asking its client:
 * - the command-line tool has no worktree service, and a headless run has nobody to ask;
 * - the agent runs inside the engine, which already runs git for the session's context;
 * - one implementation behaves the same in the app and on the command line.
 * It follows the app's layout for session worktrees (apps/desktop/src/main/workspace), so the
 * app's Changes pane and cleanup recognise it: `<repository>/.dawg/worktrees/<name>` on a new
 * branch `dawg/<name>` from the current commit, kept out of git by `info/exclude`.
 *
 * When the agent ends, a worktree with no changes (nothing uncommitted, no new commits) is
 * removed with its branch, as Claude Code documents; one with changes is kept, and the parent is
 * told where.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AgentWorktree {
  /** The worktree's root (absolute). */
  path: string;
  branch: string;
  /** Where the agent works: the same folder inside the worktree as the parent's in its checkout. */
  cwd: string;
  /** The repository's top folder, where git commands about the worktree run. */
  top: string;
  /** The commit it started from. */
  base: string;
}

const GIT_TIMEOUT_MS = 10 * 60_000;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
      (error, stdout, stderr) => {
        if (error) {
          const said = String(stderr).trim().split("\n")[0] ?? "";
          reject(new Error(said === "" ? error.message : said));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

async function excludeWorktrees(top: string): Promise<void> {
  const file = path.resolve(
    top,
    (await git(["rev-parse", "--git-path", "info/exclude"], top)).trim(),
  );
  const pattern = "/.dawg/worktrees/";
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    // No exclude file yet.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
  await mkdir(path.dirname(file), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}# Worktrees dawg made for sessions\n${pattern}\n`, "utf8");
}

/**
 * Makes a worktree named `name` for an agent whose parent works in `cwd`. Throws an error with a
 * sentence for the model when `cwd` is not in a git repository or git refuses.
 */
export async function createAgentWorktree(cwd: string, name: string): Promise<AgentWorktree> {
  let top: string;
  try {
    top = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new Error(
      "isolation: worktree needs a git repository, and the working directory is not in one.",
    );
  }
  const base = (await git(["rev-parse", "HEAD"], top)).trim();
  await excludeWorktrees(top);
  const root = path.join(top, ".dawg", "worktrees", name);
  const branch = `dawg/${name}`;
  await mkdir(path.dirname(root), { recursive: true });
  await git(["worktree", "add", "--quiet", "-b", branch, root, base], top);
  const inner = path.relative(top, cwd);
  const agentCwd = inner === "" || inner.startsWith("..") ? root : path.join(root, inner);
  await mkdir(agentCwd, { recursive: true });
  return { path: root, branch, cwd: agentCwd, top, base };
}

/**
 * Removes the worktree and its branch when the agent left nothing in it. Returns whether it was
 * kept, and a short summary of what it holds.
 */
export async function finishAgentWorktree(
  worktree: AgentWorktree,
): Promise<{ kept: boolean; summary: string }> {
  try {
    const status = (await git(["status", "--porcelain"], worktree.path)).trim();
    const commits = (await git(["rev-list", "--count", `${worktree.base}..HEAD`], worktree.path))
      .trim()
      .replace(/\D/g, "");
    const changed = status === "" ? 0 : status.split("\n").length;
    const committed = Number(commits || "0");
    if (changed === 0 && committed === 0) {
      await git(["worktree", "remove", "--force", worktree.path], worktree.top);
      await git(["branch", "-D", worktree.branch], worktree.top).catch(() => "");
      return { kept: false, summary: "no changes" };
    }
    const parts = [
      changed > 0 ? `${changed} changed ${changed === 1 ? "file" : "files"} not committed` : "",
      committed > 0 ? `${committed} new ${committed === 1 ? "commit" : "commits"}` : "",
    ].filter((part) => part !== "");
    return { kept: true, summary: parts.join(" and ") };
  } catch {
    // Anything unclear keeps the worktree: removing it could lose work.
    return { kept: true, summary: "its state could not be read" };
  }
}
