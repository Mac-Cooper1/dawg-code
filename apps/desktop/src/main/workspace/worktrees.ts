/**
 * A git worktree per session (`worktrees` in the bridge; "Worktree per session" in the Phase 3
 * spec): `<project>/.dawg/worktrees/<name>` on a new branch `dawg/<name>`, kept out of git by the
 * repository's `info/exclude`, with the untracked files `.worktreeinclude` lists copied in.
 * Cleanup removes a worktree and its branch only when nothing would be lost.
 */
import { constants } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import type {
  BranchList,
  CreateWorktreeInput,
  WorktreeCleanup,
  WorktreeInfo,
} from "../../shared/bridge.ts";
import { joinRelative } from "./changes.ts";
import {
  currentBranch,
  firstLine,
  GitError,
  gitText,
  resolveCommit,
  runGit,
  splitNul,
  topLevelOf,
} from "./git.ts";
import { realPathOf } from "./paths.ts";
import type { WorkspaceStore } from "./store.ts";

export interface WorktreeService {
  branches(projectDir: string): Promise<BranchList>;
  create(input: CreateWorktreeInput): Promise<WorktreeInfo>;
  cleanup(worktreePath: string): Promise<WorktreeCleanup>;
}

export interface WorktreeServiceOptions {
  store: WorkspaceStore;
  log: (message: string) => void;
}

/** Checking out a big repository takes a while. */
const ADD_TIMEOUT_MS = 10 * 60_000;

const BRANCH_PREFIX = "dawg/";
export const WORKTREES_DIR = path.join(".dawg", "worktrees");

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function existingDir(input: string): Promise<string> {
  try {
    const real = await realPathOf(input);
    if ((await lstat(real)).isDirectory()) return real;
  } catch {
    // Reported below.
  }
  throw new Error(`The folder ${input} does not exist.`);
}

/**
 * Keeps `.dawg/worktrees/` out of git through `info/exclude`, which is never committed. Only the
 * worktrees folder: `.dawg/settings.json` is project settings people commit.
 */
async function excludeWorktrees(top: string, project: string): Promise<void> {
  const file = path.resolve(
    top,
    await gitText(["rev-parse", "--git-path", "info/exclude"], { cwd: top }),
  );
  const prefix = path.relative(top, project).split(path.sep).join("/");
  const pattern = `/${prefix === "" ? "" : `${prefix}/`}.dawg/worktrees/`;
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

/** Untracked files in the project that `.worktreeinclude` lists (gitignore-style patterns). */
async function includedFiles(project: string): Promise<string[]> {
  const list = path.join(project, ".worktreeinclude");
  if (!(await exists(list))) return [];
  const { stdout } = await runGit(
    ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${list}`],
    { cwd: project },
  );
  return splitNul(stdout).filter(
    (name) => name !== "" && !name.endsWith("/") && !name.startsWith(".dawg/worktrees/"),
  );
}

async function copyInto(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  const stats = await lstat(from);
  if (stats.isSymbolicLink()) await symlink(await readlink(from), to);
  // A file the new checkout already has (tracked at the base) is not overwritten.
  else if (stats.isFile()) await copyFile(from, to, constants.COPYFILE_EXCL);
}

interface ListedWorktree {
  path: string;
  /** "refs/heads/…", or null when detached. */
  branch: string | null;
}

async function listWorktrees(top: string): Promise<ListedWorktree[]> {
  // Line by line: `-z` needs git 2.36, newer than some Macs have.
  const output = await gitText(["worktree", "list", "--porcelain"], { cwd: top });
  const listed: ListedWorktree[] = [];
  for (const field of output.split("\n")) {
    if (field.startsWith("worktree ")) listed.push({ path: field.slice(9), branch: null });
    else if (field.startsWith("branch ") && listed.length > 0) {
      const last = listed[listed.length - 1];
      if (last) last.branch = field.slice(7);
    }
  }
  return listed;
}

export function createWorktreeService(options: WorktreeServiceOptions): WorktreeService {
  const { store, log } = options;

  return {
    async branches(projectDir) {
      const project = await existingDir(projectDir);
      const top = await topLevelOf(project);
      if (top === null) return { isRepo: false, current: null, branches: [] };
      const current = await currentBranch(project);
      // Most recently committed first. Branch names cannot hold a newline.
      const output = await gitText(
        ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"],
        { cwd: project },
      );
      const listed = output.split("\n").filter((name) => name !== "");
      const branches = listed.filter((name) => name !== current);
      if (current !== null && listed.includes(current)) branches.unshift(current);
      return { isRepo: true, current, branches };
    },

    async create(input) {
      const project = await existingDir(input.projectDir);
      const top = await topLevelOf(project);
      if (top === null) {
        throw new Error("This folder is not in a git repository, so it cannot have a worktree.");
      }
      const realTop = await realPathOf(top);
      const baseCommit = input.base.startsWith("-")
        ? null
        : await resolveCommit(realTop, input.base);
      if (baseCommit === null)
        throw new Error(`There is no branch or commit named "${input.base}".`);

      const branch = `${BRANCH_PREFIX}${input.name}`;
      const { exitCode } = await runGit(
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        {
          cwd: realTop,
          okCodes: [0, 1],
        },
      );
      if (exitCode === 0) {
        throw new Error(`A branch named ${branch} already exists. Choose another name.`);
      }
      const realPath = path.join(project, WORKTREES_DIR, input.name);
      if (await exists(realPath)) {
        throw new Error(
          `The folder .dawg/worktrees/${input.name} already exists. Choose another name.`,
        );
      }

      await excludeWorktrees(realTop, project);
      await mkdir(path.dirname(realPath), { recursive: true });
      try {
        await runGit(["worktree", "add", "--quiet", "-b", branch, realPath, baseCommit], {
          cwd: realTop,
          timeoutMs: ADD_TIMEOUT_MS,
        });
      } catch (error) {
        const why = error instanceof GitError ? firstLine(error.stderr) : "";
        throw new Error(`Git could not make the worktree${why ? `: ${why}` : "."}`);
      }

      try {
        for (const relative of await includedFiles(project)) {
          try {
            await copyInto(joinRelative(project, relative), joinRelative(realPath, relative));
          } catch (error) {
            log(`Did not copy ${relative} into ${realPath}: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        log(`Could not read .worktreeinclude in ${project}: ${(error as Error).message}`);
      }

      const info: WorktreeInfo = {
        path: path.join(path.resolve(input.projectDir), WORKTREES_DIR, input.name),
        branch,
        base: input.base,
        baseCommit,
      };
      await store.setWorktree(await realPathOf(realPath), {
        ...info,
        projectDir: path.resolve(input.projectDir),
        createdAt: Date.now(),
      });
      return info;
    },

    async cleanup(worktreePath) {
      const given = path.resolve(worktreePath);
      const name = path.basename(given);
      const worktreesDir = path.dirname(given);
      if (
        path.basename(worktreesDir) !== "worktrees" ||
        path.basename(path.dirname(worktreesDir)) !== ".dawg"
      ) {
        throw new Error(`${worktreePath} is not in a project's .dawg/worktrees folder.`);
      }
      const projectDir = path.dirname(path.dirname(worktreesDir));
      const project = await existingDir(projectDir);
      if (!(await exists(path.join(project, WORKTREES_DIR, name)))) {
        return { removed: false, reason: "The worktree folder no longer exists." };
      }
      const realPath = await realPathOf(path.join(project, WORKTREES_DIR, name));
      const top = await topLevelOf(project);
      if (top === null) throw new Error(`${projectDir} is not in a git repository.`);
      const realTop = await realPathOf(top);

      const listed: ListedWorktree[] = [];
      for (const entry of await listWorktrees(realTop)) {
        listed.push({ ...entry, path: await realPathOf(entry.path).catch(() => entry.path) });
      }
      const worktree = listed.find((entry) => entry.path === realPath);
      if (!worktree) throw new Error(`${worktreePath} is not a git worktree of ${projectDir}.`);
      if (worktree.branch === null) {
        return {
          removed: false,
          reason: "Its HEAD is detached, so dawg cannot tell whether its work is merged.",
        };
      }
      const branch = worktree.branch.replace(/^refs\/heads\//, "");

      const record = await store.worktree(realPath);
      const base = record?.base ?? (await currentBranch(realTop));
      if (base === null) {
        return { removed: false, reason: "dawg has no record of the branch it was made from." };
      }

      const status = await runGit(
        ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"],
        { cwd: realPath },
      );
      if (status.stdout.length > 0) {
        return { removed: false, reason: "It has changes that are not committed." };
      }

      const baseNow = await resolveCommit(realTop, base);
      if (baseNow === null) return { removed: false, reason: `Its base ${base} no longer exists.` };
      const tip = await resolveCommit(realTop, `refs/heads/${branch}`);
      const merged =
        tip !== null &&
        (
          await runGit(["merge-base", "--is-ancestor", tip, baseNow], {
            cwd: realTop,
            okCodes: [0, 1],
          })
        ).exitCode === 0;
      if (!merged) {
        return { removed: false, reason: `Its branch ${branch} is not merged into ${base}.` };
      }

      try {
        await runGit(["worktree", "remove", realPath], { cwd: realTop });
      } catch (error) {
        const why = error instanceof GitError ? firstLine(error.stderr) : String(error);
        return { removed: false, reason: `Git could not remove it: ${why}` };
      }
      try {
        // Merged, checked above: `-D` because `-d` asks about the main checkout's branch instead.
        await runGit(["branch", "-D", branch], { cwd: realTop });
      } catch (error) {
        log(`Removed ${realPath} but not its branch ${branch}: ${(error as Error).message}`);
      }
      await store.deleteWorktree(realPath);
      return { removed: true, reason: null };
    },
  };
}
