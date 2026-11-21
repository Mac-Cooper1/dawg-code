import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyTask, TASKS, tempDir } from "./__fixtures__/paths.ts";
import { loadTask } from "./task.ts";
import {
  finalDiff,
  GIT_EMAIL,
  prepareWorkspace,
  removeWorkspace,
  SetupError,
  type Workspace,
} from "./workspace.ts";

const git = (ws: Workspace, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: ws.dir,
    encoding: "utf8",
    env: { ...process.env, HOME: ws.homeDir, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

describe("prepareWorkspace", () => {
  let artifacts: string;
  let cleanup: () => void;
  const made: Workspace[] = [];
  beforeEach(() => {
    ({ dir: artifacts, cleanup } = tempDir());
  });
  afterEach(() => {
    for (const ws of made.splice(0)) removeWorkspace(ws);
    cleanup();
  });

  test("copies the fixture, runs setup.sh and commits the starting state", async () => {
    const task = loadTask(join(TASKS, "setup-and-delete"));
    const ws = await prepareWorkspace(task, { artifactsDir: artifacts });
    made.push(ws);

    expect(ws.root.startsWith(tmpdir()) || ws.root.startsWith("/private")).toBe(true);
    expect(readFileSync(join(ws.dir, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(ws.dir, "generated.txt"), "utf8")).toBe("generated\n");
    // Hidden checker assets and the solution never reach the workspace.
    expect(existsSync(join(ws.dir, "check"))).toBe(false);
    expect(existsSync(join(ws.dir, "answer.txt"))).toBe(false);
    // setup.sh saw the documented environment.
    expect(readFileSync(join(artifacts, "setup.stdout.log"), "utf8")).toContain(
      `setup ran in ${ws.dir} with TASK_DIR=${task.dir}`,
    );

    // A fresh repo: exactly one commit, clean tree, repo-local identity.
    expect(git(ws, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(git(ws, "rev-parse", "HEAD")).toBe(ws.baselineSha);
    expect(git(ws, "config", "--local", "user.email")).toBe(GIT_EMAIL);
    expect(git(ws, "ls-files").split("\n").sort()).toEqual([
      "generated.txt",
      "keep.txt",
      "obsolete.txt",
    ]);
    // The workspace repo is its own toplevel, not part of some enclosing repo.
    expect(git(ws, "rev-parse", "--show-toplevel")).toBe(ws.dir);
  });

  test("each run gets its own workspace and throwaway HOME", async () => {
    const task = loadTask(join(TASKS, "edit-greeting"));
    const a = await prepareWorkspace(task, { artifactsDir: artifacts });
    const b = await prepareWorkspace(task, { artifactsDir: artifacts });
    made.push(a, b);
    expect(a.dir).not.toBe(b.dir);
    expect(a.homeDir).not.toBe(b.homeDir);
    expect(a.homeDir).not.toBe(process.env.HOME);
    expect(readFileSync(join(a.homeDir, ".gitconfig"), "utf8")).toContain(GIT_EMAIL);
    writeFileSync(join(a.dir, "greeting.txt"), "changed\n");
    expect(readFileSync(join(b.dir, "greeting.txt"), "utf8")).toBe("hello\n");
  });

  test("a failing setup.sh raises SetupError", async () => {
    const { dir: root, cleanup: c2 } = tempDir();
    try {
      const dir = copyTask(root, join(TASKS, "edit-greeting"), "edit-greeting");
      writeFileSync(join(dir, "setup.sh"), "echo boom >&2\nexit 4\n");
      await expect(
        prepareWorkspace(loadTask(dir), { artifactsDir: artifacts, tempParent: root }),
      ).rejects.toBeInstanceOf(SetupError);
      expect(readFileSync(join(artifacts, "setup.stderr.log"), "utf8")).toContain("boom");
    } finally {
      c2();
    }
  });

  test("finalDiff covers edits, new files, deletions and the agent's own commits", async () => {
    const task = loadTask(join(TASKS, "setup-and-delete"));
    const ws = await prepareWorkspace(task, { artifactsDir: artifacts });
    made.push(ws);
    writeFileSync(join(ws.dir, "keep.txt"), "kept and edited\n");
    git(ws, "commit", "-qam", "agent commit");
    writeFileSync(join(ws.dir, "new.txt"), "brand new\n");
    unlinkSync(join(ws.dir, "obsolete.txt"));

    const diff = await finalDiff(ws);
    expect(diff).toContain("+kept and edited");
    expect(diff).toContain("+++ b/new.txt");
    expect(diff).toContain("deleted file mode");
    // The workspace's own index is untouched: new.txt is still untracked.
    expect(git(ws, "status", "--porcelain")).toContain("?? new.txt");
  });
});
