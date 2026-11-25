import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceService } from "./service.ts";
import { createWorkspaceStore, type WorkspaceStore } from "./store.ts";
import { makeRepo, makeTempDir, removeTempDirs, repoAt, type TestRepo } from "./test-repo.ts";
import { createWorktreeService } from "./worktrees.ts";

afterEach(async () => {
  await removeTempDirs();
});

async function setup(files: Record<string, string> = { "README.md": "hello\n" }) {
  const repo = await makeRepo(files);
  const dataRoot = await makeTempDir("dawg-data-");
  const logs: string[] = [];
  const store: WorkspaceStore = createWorkspaceStore(path.join(dataRoot, "workspace.json"), (m) =>
    logs.push(m),
  );
  const worktrees = createWorktreeService({ store, log: (m) => logs.push(m) });
  return { repo, store, worktrees, logs, dataRoot };
}

function worktreeRepo(repo: TestRepo, name: string): TestRepo {
  return repoAt(path.join(repo.dir, ".dawg", "worktrees", name));
}

describe("branches", () => {
  it("lists local branches, the current one first", async () => {
    const { repo, worktrees } = await setup();
    repo.git("branch", "feature");
    repo.git("branch", "zeta");
    const list = await worktrees.branches(repo.dir);
    expect(list.isRepo).toBe(true);
    expect(list.current).toBe("main");
    expect(list.branches[0]).toBe("main");
    expect([...list.branches].sort()).toEqual(["feature", "main", "zeta"]);
  });

  it("says when a folder is not a repository", async () => {
    const { worktrees } = await setup();
    const plain = await makeTempDir("dawg-plain-");
    expect(await worktrees.branches(plain)).toEqual({ isRepo: false, current: null, branches: [] });
    await expect(worktrees.branches("/no/such/folder")).rejects.toThrow(/does not exist/);
  });
});

describe("create", () => {
  it("makes a worktree on a new branch, keeps it out of git and copies .worktreeinclude files", async () => {
    const { repo, worktrees, store } = await setup({
      ".gitignore": ".env\nnode_modules/\n*.local\n",
      ".worktreeinclude": ".env\nconfig/*.local\n",
      "README.md": "hello\n",
      ".dawg/settings.json": "{}\n",
    });
    await repo.write(".env", "SECRET=1\n");
    await repo.write("config/app.local", "local\n");
    await repo.write("node_modules/pkg/index.js", "not copied\n");
    await repo.write("notes.txt", "untracked, not listed\n");
    const base = repo.git("rev-parse", "main");

    const info = await worktrees.create({ projectDir: repo.dir, name: "fix-login", base: "main" });
    const wtPath = path.join(repo.dir, ".dawg", "worktrees", "fix-login");
    expect(info).toEqual({
      path: wtPath,
      branch: "dawg/fix-login",
      base: "main",
      baseCommit: base,
    });

    const wt = worktreeRepo(repo, "fix-login");
    expect(wt.git("symbolic-ref", "--short", "HEAD")).toBe("dawg/fix-login");
    expect(await wt.read("README.md")).toBe("hello\n");
    expect(await wt.read(".env")).toBe("SECRET=1\n");
    expect(await wt.read("config/app.local")).toBe("local\n");
    await expect(stat(wt.abs("node_modules"))).rejects.toThrow();
    await expect(stat(wt.abs("notes.txt"))).rejects.toThrow();

    // The worktrees folder is excluded; the project's own .dawg settings are not.
    const exclude = await readFile(path.join(repo.dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.dawg/worktrees/\n");
    expect(repo.git("status", "--porcelain")).toBe("?? notes.txt");
    await repo.write(".dawg/settings.local.json", "{}\n");
    expect(repo.git("status", "--porcelain")).toContain(".dawg/settings.local.json");

    // Creating a second one does not add the pattern twice.
    await worktrees.create({ projectDir: repo.dir, name: "second", base: "main" });
    const again = await readFile(path.join(repo.dir, ".git", "info", "exclude"), "utf8");
    expect(again.split("/.dawg/worktrees/").length).toBe(2);

    const record = await store.worktree(await realpath(wtPath));
    expect(record).toMatchObject({ branch: "dawg/fix-login", base: "main", baseCommit: base });
  });

  it("gives a worktree session its base, so the Changes pane shows the branch's diff", async () => {
    const { repo, worktrees, store } = await setup({ "a.txt": "a\n" });
    const base = repo.git("rev-parse", "HEAD");
    const info = await worktrees.create({ projectDir: repo.dir, name: "w", base: "main" });
    const wt = worktreeRepo(repo, "w");
    await wt.write("a.txt", "changed\n");
    wt.commitAll("work on the branch");
    await wt.write("b.txt", "new\n");

    const workspace = createWorkspaceService({
      store,
      log: () => {},
      watch: () => ({ close() {} }),
    });
    try {
      const tracked = await workspace.track(
        { sessionId: "w1", cwd: info.path, projectDir: repo.dir, additionalDirectories: [] },
        "window",
      );
      expect(tracked.git).toEqual({
        root: info.path,
        branch: "dawg/w",
        baseCommit: base,
        baseLabel: "main",
        worktree: info,
      });
      const changes = await workspace.changes("w1");
      expect(changes.files.map((file) => [file.path, file.status])).toEqual([
        [wt.abs("a.txt"), "modified"],
        [wt.abs("b.txt"), "untracked"],
      ]);
    } finally {
      workspace.dispose();
    }
  });

  it("refuses with a sentence when it cannot", async () => {
    const { repo, worktrees } = await setup();
    const plain = await makeTempDir("dawg-plain-");
    repo.git("branch", "dawg/taken");
    await worktrees.create({ projectDir: repo.dir, name: "exists", base: "main" });
    repo.git("worktree", "remove", path.join(repo.dir, ".dawg", "worktrees", "exists"));
    repo.git("branch", "-D", "dawg/exists");
    await repo.write(".dawg/worktrees/exists/leftover.txt", "x");

    const cases: [() => Promise<unknown>, RegExp][] = [
      [
        () => worktrees.create({ projectDir: plain, name: "a", base: "main" }),
        /not in a git repository/,
      ],
      [
        () => worktrees.create({ projectDir: repo.dir, name: "taken", base: "main" }),
        /branch named dawg\/taken already exists/,
      ],
      [
        () => worktrees.create({ projectDir: repo.dir, name: "exists", base: "main" }),
        /folder .dawg\/worktrees\/exists already exists/,
      ],
      [
        () => worktrees.create({ projectDir: repo.dir, name: "b", base: "nope" }),
        /no branch or commit named "nope"/,
      ],
      [
        () => worktrees.create({ projectDir: repo.dir, name: "c", base: "--orphan" }),
        /no branch or commit named/,
      ],
    ];
    for (const [call, message] of cases) await expect(call()).rejects.toThrow(message);
  });
});

describe("cleanup", () => {
  it("removes a clean, merged worktree and its branch", async () => {
    const { repo, worktrees, store } = await setup();
    const info = await worktrees.create({ projectDir: repo.dir, name: "done", base: "main" });
    const realPath = await realpath(info.path);
    expect(await store.worktree(realPath)).not.toBeNull();
    const wt = worktreeRepo(repo, "done");
    await wt.write("feature.txt", "f\n");
    wt.commitAll("feature");
    repo.git("merge", "-q", "--ff-only", "dawg/done");

    expect(await worktrees.cleanup(info.path)).toEqual({ removed: true, reason: null });
    await expect(stat(info.path)).rejects.toThrow();
    expect(repo.git("branch", "--list", "dawg/done")).toBe("");
    expect(await store.worktree(realPath)).toBeNull();
  });

  it("keeps a worktree with uncommitted changes, or with work not merged, and says why", async () => {
    const { repo, worktrees } = await setup();
    const info = await worktrees.create({ projectDir: repo.dir, name: "busy", base: "main" });
    const wt = worktreeRepo(repo, "busy");

    await wt.write("draft.txt", "not committed\n");
    expect(await worktrees.cleanup(info.path)).toEqual({
      removed: false,
      reason: "It has changes that are not committed.",
    });

    wt.commitAll("draft");
    expect(await worktrees.cleanup(info.path)).toEqual({
      removed: false,
      reason: "Its branch dawg/busy is not merged into main.",
    });
    expect((await stat(info.path)).isDirectory()).toBe(true);
    expect(repo.git("branch", "--list", "dawg/busy")).toContain("dawg/busy");
  });

  it("ignores ignored files, such as the ones .worktreeinclude copied", async () => {
    const { repo, worktrees } = await setup({
      ".gitignore": ".env\n",
      ".worktreeinclude": ".env\n",
    });
    await repo.write(".env", "S=1\n");
    const info = await worktrees.create({ projectDir: repo.dir, name: "env", base: "main" });
    expect(await worktrees.cleanup(info.path)).toEqual({ removed: true, reason: null });
  });

  it("refuses paths that are not a project's worktree", async () => {
    const { repo, worktrees } = await setup();
    await expect(worktrees.cleanup(repo.dir)).rejects.toThrow(
      /not in a project's .dawg\/worktrees/,
    );
    await repo.write(".dawg/worktrees/fake/a.txt", "a");
    await expect(
      worktrees.cleanup(path.join(repo.dir, ".dawg", "worktrees", "fake")),
    ).rejects.toThrow(/not a git worktree/);
    expect(await worktrees.cleanup(path.join(repo.dir, ".dawg", "worktrees", "missing"))).toEqual({
      removed: false,
      reason: "The worktree folder no longer exists.",
    });
  });
});
