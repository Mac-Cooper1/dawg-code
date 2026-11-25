import { mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceChangedEvent } from "../../shared/bridge.ts";
import { createWorkspaceService, MAX_CHANGED_FILES, type WorkspaceService } from "./service.ts";
import { createWorkspaceStore } from "./store.ts";
import { makeRepo, makeTempDir, removeTempDirs, type TestRepo } from "./test-repo.ts";
import type { WatchFactory } from "./watcher.ts";

const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await removeTempDirs();
});

async function serviceFor(options: { dataRoot?: string; watch?: WatchFactory } = {}) {
  const dataRoot = options.dataRoot ?? (await makeTempDir("dawg-data-"));
  const logs: string[] = [];
  const service = createWorkspaceService({
    store: createWorkspaceStore(path.join(dataRoot, "workspace.json"), (m) => logs.push(m)),
    log: (m) => logs.push(m),
    // No real watching unless a test asks for it.
    watch: options.watch ?? (() => ({ close() {} })),
    debounceMs: 20,
    maxWaitMs: 100,
  });
  services.push(service);
  return { service, dataRoot, logs };
}

async function tracked(repo: TestRepo, sessionId = "s1") {
  const made = await serviceFor();
  const info = await made.service.track(
    { sessionId, cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [] },
    "window",
  );
  return { ...made, info };
}

describe("track", () => {
  it("records the base commit once and keeps it across relaunches", async () => {
    const repo = await makeRepo({ "a.txt": "one\n" });
    const base = repo.git("rev-parse", "HEAD");
    const { service, dataRoot, info } = await tracked(repo);
    expect(info).toEqual({
      sessionId: "s1",
      cwd: repo.dir,
      git: {
        root: repo.dir,
        branch: "main",
        baseCommit: base,
        baseLabel: `where the session started (${base.slice(0, 7)})`,
        worktree: null,
      },
    });

    // The agent commits; the base stays where the session started, also after a relaunch.
    await repo.write("a.txt", "two\n");
    repo.commitAll("change");
    const again = await service.track(
      { sessionId: "s1", cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [] },
      "window",
    );
    expect(again.git?.baseCommit).toBe(base);
    const relaunched = await serviceFor({ dataRoot });
    const afterRelaunch = await relaunched.service.track(
      { sessionId: "s1", cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [] },
      "window",
    );
    expect(afterRelaunch.git?.baseCommit).toBe(base);
    const saved = JSON.parse(await readFile(path.join(dataRoot, "workspace.json"), "utf8"));
    expect(saved.sessions.s1.baseCommit).toBe(base);
  });

  it("says when a folder is not in git, and shows no git changes", async () => {
    const dir = await makeTempDir("dawg-plain-");
    await writeFile(path.join(dir, "x.txt"), "x");
    const { service } = await serviceFor();
    const info = await service.track(
      { sessionId: "p", cwd: dir, projectDir: dir, additionalDirectories: [] },
      "window",
    );
    expect(info.git).toBeNull();
    expect(await service.changes("p")).toEqual({ baseCommit: null, files: [], truncated: false });
    await expect(
      service.fileDiff({ sessionId: "p", path: path.join(dir, "x.txt") }),
    ).rejects.toThrow(/not in a git repository/);
  });

  it("compares a repository with no commits yet with the empty tree", async () => {
    const repo = await makeRepo();
    await repo.write("new.txt", "a\nb\n");
    const { service, info } = await tracked(repo);
    expect(info.git?.baseLabel).toBe("where the session started (no commits yet)");
    const changes = await service.changes("s1");
    expect(changes.files).toEqual([
      expect.objectContaining({ path: repo.abs("new.txt"), status: "untracked", additions: 2 }),
    ]);
  });

  it("refuses a missing folder and calls for untracked sessions", async () => {
    const { service } = await serviceFor();
    await expect(
      service.track(
        {
          sessionId: "x",
          cwd: "/no/such/folder",
          projectDir: "/no/such/folder",
          additionalDirectories: [],
        },
        "window",
      ),
    ).rejects.toThrow(/does not exist/);
    await expect(service.changes("x")).rejects.toThrow(/not tracked/);
  });

  it("keeps a session while any window tracks it", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    const { service } = await tracked(repo);
    const input = {
      sessionId: "s1",
      cwd: repo.dir,
      projectDir: repo.dir,
      additionalDirectories: [],
    };
    await service.track(input, "other-window");
    await service.untrack("s1", "window");
    await expect(service.changes("s1")).resolves.toMatchObject({ files: [] });
    service.releaseOwner("other-window");
    await expect(service.changes("s1")).rejects.toThrow(/not tracked/);
  });
});

describe("changes", () => {
  it("lists committed, staged, unstaged, untracked, renamed, deleted and binary changes", async () => {
    const repo = await makeRepo({
      ".gitignore": "*.log\n",
      "committed.txt": "1\n2\n3\n",
      "unstaged.txt": "a\nb\n",
      "old-name.txt": "same\ncontent\nhere\n",
      "gone.txt": "bye\n",
      "image.bin": "\0\x01\x02",
    });
    const { service, info } = await tracked(repo);
    await repo.write("committed.txt", "1\ntwo\n3\n4\n");
    repo.commitAll("after the base");
    await repo.write("staged.txt", "s\n");
    repo.git("add", "staged.txt");
    await repo.write("unstaged.txt", "a\nB\n");
    repo.git("mv", "old-name.txt", "new-name.txt");
    repo.git("rm", "-q", "gone.txt");
    await repo.write("image.bin", "\0\x03\x02");
    await repo.write("dir/untracked.txt", "u1\nu2\nu3");
    await repo.write("debug.log", "ignored\n");

    const changes = await service.changes("s1");
    expect(changes.baseCommit).toBe(info.git?.baseCommit);
    expect(changes.truncated).toBe(false);
    expect(changes.files).toEqual([
      {
        path: repo.abs("committed.txt"),
        oldPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        binary: false,
      },
      {
        path: repo.abs("dir/untracked.txt"),
        oldPath: null,
        status: "untracked",
        additions: 3,
        deletions: 0,
        binary: false,
      },
      {
        path: repo.abs("gone.txt"),
        oldPath: null,
        status: "deleted",
        additions: 0,
        deletions: 1,
        binary: false,
      },
      {
        path: repo.abs("image.bin"),
        oldPath: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: true,
      },
      {
        path: repo.abs("new-name.txt"),
        oldPath: repo.abs("old-name.txt"),
        status: "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
      },
      {
        path: repo.abs("staged.txt"),
        oldPath: null,
        status: "added",
        additions: 1,
        deletions: 0,
        binary: false,
      },
      {
        path: repo.abs("unstaged.txt"),
        oldPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
      },
    ]);
  });

  it("handles odd names, files taken out of the index and new files deleted again", async () => {
    const repo = await makeRepo({ "a [b]*.txt": "x\n", "kept.txt": "k\n" });
    const { service } = await tracked(repo);
    await repo.write("a [b]*.txt", "y\n");
    repo.git("rm", "-q", "--cached", "kept.txt");
    await repo.write("brief.txt", "b\n");
    repo.git("add", "brief.txt");
    repo.git("rm", "-q", "-f", "brief.txt");
    await repo.write("staged-then-gone.txt", "s\n");
    repo.git("add", "staged-then-gone.txt");
    await rm(repo.abs("staged-then-gone.txt"));

    const changes = await service.changes("s1");
    expect(changes.files.map((file) => [path.basename(file.path), file.status])).toEqual([
      ["a [b]*.txt", "modified"],
      ["kept.txt", "modified"],
    ]);
    await service.revert({ sessionId: "s1", path: repo.abs("a [b]*.txt") });
    expect(await repo.read("a [b]*.txt")).toBe("x\n");
    await service.revert({ sessionId: "s1", path: repo.abs("kept.txt") });
    // Back in the index too; the staged file that is gone again is not the pane's to show.
    expect(repo.git("status", "--porcelain")).toBe("AD staged-then-gone.txt");
  });

  it("lists at most 2,000 files and says there were more", async () => {
    const repo = await makeRepo({ "a.txt": "a\n" });
    const { service } = await tracked(repo);
    await mkdir(repo.abs("many"));
    await Promise.all(
      Array.from({ length: MAX_CHANGED_FILES + 5 }, (_, i) =>
        writeFile(repo.abs(`many/f${String(i).padStart(5, "0")}.txt`), "x\n"),
      ),
    );
    const changes = await service.changes("s1");
    expect(changes.files).toHaveLength(MAX_CHANGED_FILES);
    expect(changes.truncated).toBe(true);
  });

  it("leaves out files outside the session's folders", async () => {
    const repo = await makeRepo({ "app/a.txt": "a\n", "other/b.txt": "b\n" });
    const { service } = await serviceFor();
    await service.track(
      { sessionId: "sub", cwd: repo.abs("app"), projectDir: repo.dir, additionalDirectories: [] },
      "window",
    );
    await repo.write("app/a.txt", "A\n");
    await repo.write("other/b.txt", "B\n");
    const changes = await service.changes("sub");
    expect(changes.files.map((file) => file.path)).toEqual([repo.abs("app/a.txt")]);
  });
});

describe("fileDiff", () => {
  it("gives both sides and the hunks of a changed file", async () => {
    const repo = await makeRepo({ "f.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" });
    const { service } = await tracked(repo);
    await repo.write("f.txt", "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n");
    const diff = await service.fileDiff({ sessionId: "s1", path: repo.abs("f.txt") });
    expect(diff.original).toBe("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    expect(diff.modified).toBe("1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n");
    expect(diff.binary).toBe(false);
    expect(diff.tooLarge).toBe(false);
    expect(diff.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 5,
        newStart: 1,
        newLines: 5,
        lines: [" 1", "-2", "+TWO", " 3", " 4", " 5"],
      },
      { oldStart: 8, oldLines: 3, newStart: 8, newLines: 4, lines: [" 8", " 9", " 10", "+11"] },
    ]);
  });

  it("handles new, deleted, binary and large files", async () => {
    const repo = await makeRepo({ "gone.txt": "x\n", "b.bin": "\0a" });
    const { service } = await tracked(repo);
    await repo.write("new.txt", "n\n");
    await repo.write("b.bin", "\0b");
    await repo.write("big.txt", "x".repeat(5 * 1024 * 1024 + 1));
    repo.git("rm", "-q", "gone.txt");
    const ref = (name: string) => ({ sessionId: "s1", path: repo.abs(name) });

    expect(await service.fileDiff(ref("new.txt"))).toMatchObject({
      original: null,
      modified: "n\n",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+n"] }],
    });
    expect(await service.fileDiff(ref("gone.txt"))).toMatchObject({
      original: "x\n",
      modified: null,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-x"] }],
    });
    expect(await service.fileDiff(ref("b.bin"))).toMatchObject({
      original: null,
      modified: null,
      binary: true,
      hunks: [],
    });
    expect(await service.fileDiff(ref("big.txt"))).toMatchObject({
      original: null,
      modified: null,
      tooLarge: true,
    });
  });
});

describe("revert", () => {
  it("puts whole files back as they were at the base", async () => {
    const repo = await makeRepo({ "m.txt": "m\n", "d.txt": "d\n", "r.txt": "r\nr\nr\n" });
    const { service } = await tracked(repo);
    await repo.write("m.txt", "changed\n");
    await repo.write("n.txt", "new\n");
    repo.git("rm", "-q", "d.txt");
    repo.git("mv", "r.txt", "renamed.txt");
    const revert = (name: string) => service.revert({ sessionId: "s1", path: repo.abs(name) });

    await revert("m.txt");
    await revert("n.txt");
    await revert("d.txt");
    await revert("renamed.txt");
    expect(await repo.read("m.txt")).toBe("m\n");
    expect(await repo.read("d.txt")).toBe("d\n");
    expect(await repo.read("r.txt")).toBe("r\nr\nr\n");
    await expect(stat(repo.abs("n.txt"))).rejects.toThrow();
    await expect(stat(repo.abs("renamed.txt"))).rejects.toThrow();
    expect((await service.changes("s1")).files).toEqual([]);
  });

  it("takes back one hunk and refuses a hunk that no longer matches", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const repo = await makeRepo({ "f.txt": `${lines.join("\n")}\n` });
    const { service } = await tracked(repo);
    const edited = [...lines];
    edited[1] = "first change";
    edited[17] = "second change";
    await repo.write("f.txt", `${edited.join("\n")}\n`);
    const diff = await service.fileDiff({ sessionId: "s1", path: repo.abs("f.txt") });
    expect(diff.hunks).toHaveLength(2);
    const [first, second] = diff.hunks;
    if (!first || !second) throw new Error("expected two hunks");

    await service.revert({ sessionId: "s1", path: repo.abs("f.txt"), hunk: second });
    const expected = [...lines];
    expected[1] = "first change";
    expect(await repo.read("f.txt")).toBe(`${expected.join("\n")}\n`);

    // The same hunk again: its lines are gone.
    await expect(
      service.revert({ sessionId: "s1", path: repo.abs("f.txt"), hunk: second }),
    ).rejects.toThrow(/no longer matches/);
    // The first hunk after someone edited inside it.
    await repo.write("f.txt", `${expected.join("\n").replace("first change", "edited again")}\n`);
    await expect(
      service.revert({ sessionId: "s1", path: repo.abs("f.txt"), hunk: first }),
    ).rejects.toThrow(/no longer matches/);
  });

  it("restores the base's missing newline at the end of the file", async () => {
    const repo = await makeRepo({ "f.txt": "a\nb" });
    const { service } = await tracked(repo);
    await repo.write("f.txt", "a\nb\nc\n");
    const diff = await service.fileDiff({ sessionId: "s1", path: repo.abs("f.txt") });
    const [hunk] = diff.hunks;
    if (!hunk) throw new Error("expected a hunk");
    await service.revert({ sessionId: "s1", path: repo.abs("f.txt"), hunk });
    expect(await repo.read("f.txt")).toBe("a\nb");
  });
});

describe("files", () => {
  it("lists one level: folders first, ignored entries flagged and last", async () => {
    const repo = await makeRepo({
      ".gitignore": "build/\n*.log\n",
      "src/index.ts": "x",
      "b.txt": "bb",
      "A.txt": "a",
    });
    await repo.write("build/out.js", "o");
    await repo.write("z.log", "log");
    const { service } = await tracked(repo);
    const entries = await service.listDirectory({ sessionId: "s1", path: repo.dir });
    expect(entries.map((entry) => [entry.name, entry.kind, entry.ignored, entry.size])).toEqual([
      ["src", "directory", false, null],
      [".gitignore", "file", false, 13],
      ["A.txt", "file", false, 1],
      ["b.txt", "file", false, 2],
      [".git", "directory", true, null],
      ["build", "directory", true, null],
      ["z.log", "file", true, 3],
    ]);
    expect(entries[0]?.path).toBe(repo.abs("src"));
  });

  it("reads and saves text, and refuses a save over a newer change", async () => {
    const repo = await makeRepo({ "f.txt": "﻿hello\n", "b.bin": "\0\x01" });
    const { service } = await tracked(repo);
    const file = await service.readFile({ sessionId: "s1", path: repo.abs("f.txt") });
    expect(file).toMatchObject({ content: "﻿hello\n", binary: false, tooLarge: false, size: 9 });
    expect(await service.readFile({ sessionId: "s1", path: repo.abs("b.bin") })).toMatchObject({
      content: null,
      binary: true,
    });

    // Someone else writes the file after it was read.
    await writeFile(repo.abs("f.txt"), "theirs\n");
    const later = new Date(file.mtimeMs + 5000);
    await utimes(repo.abs("f.txt"), later, later);
    await expect(
      service.writeFile({
        sessionId: "s1",
        path: repo.abs("f.txt"),
        content: "mine\n",
        expectedMtimeMs: file.mtimeMs,
      }),
    ).rejects.toThrow(/changed on disk after it was opened/);
    expect(await repo.read("f.txt")).toBe("theirs\n");

    const fresh = await service.readFile({ sessionId: "s1", path: repo.abs("f.txt") });
    const saved = await service.writeFile({
      sessionId: "s1",
      path: repo.abs("f.txt"),
      content: "mine\n",
      expectedMtimeMs: fresh.mtimeMs,
    });
    expect(await repo.read("f.txt")).toBe("mine\n");
    expect(saved.mtimeMs).toBe((await stat(repo.abs("f.txt"))).mtimeMs);
  });

  it("says when a file is too large to show", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    await repo.write("big.txt", "y".repeat(5 * 1024 * 1024 + 1));
    const { service } = await tracked(repo);
    expect(await service.readFile({ sessionId: "s1", path: repo.abs("big.txt") })).toMatchObject({
      content: null,
      tooLarge: true,
      size: 5 * 1024 * 1024 + 1,
    });
  });
});

describe("path checks", () => {
  it("refuses paths that leave the session's folders", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const outside = await makeTempDir("dawg-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), repo.abs("link-out.txt"));
    await symlink(outside, repo.abs("dir-out"));
    await symlink(path.join(outside, "not-yet.txt"), repo.abs("dangling-out.txt"));
    await symlink(repo.abs("a.txt"), repo.abs("link-in.txt"));
    const { service } = await tracked(repo);
    const ref = (p: string) => ({ sessionId: "s1", path: p });

    const refused = [
      () => service.readFile(ref(`${repo.dir}/../${path.basename(outside)}/secret.txt`)),
      () => service.readFile(ref(repo.abs("link-out.txt"))),
      () => service.listDirectory(ref(repo.abs("dir-out"))),
      () => service.readFile(ref(repo.abs("dir-out/secret.txt"))),
      () => service.writeFile({ ...ref(repo.abs("dangling-out.txt")), content: "x" }),
      () => service.writeFile({ ...ref(path.join(outside, "new.txt")), content: "x" }),
      () => service.revert(ref(repo.abs("link-out.txt"))),
      () => service.fileDiff(ref("/etc/hosts")),
    ];
    for (const call of refused) {
      await expect(call()).rejects.toThrow(/outside this session's folders/);
    }
    await expect(stat(path.join(outside, "not-yet.txt"))).rejects.toThrow();
    await expect(stat(path.join(outside, "new.txt"))).rejects.toThrow();

    // A link that stays inside is fine.
    expect((await service.readFile(ref(repo.abs("link-in.txt")))).content).toBe("a");
  });

  it("allows the session's additional folders", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const extra = await makeTempDir("dawg-extra-");
    await writeFile(path.join(extra, "notes.md"), "notes");
    const { service } = await serviceFor();
    await service.track(
      { sessionId: "s1", cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [extra] },
      "window",
    );
    const file = await service.readFile({ sessionId: "s1", path: path.join(extra, "notes.md") });
    expect(file.content).toBe("notes");
    expect(file.path).toBe(path.join(extra, "notes.md"));
  });
});

describe("watching", () => {
  it("reports changed files once per burst, without git's own files", async () => {
    const repo = await makeRepo({ "a.txt": "a" });
    const emitters: ((relative: string | null) => void)[] = [];
    const { service } = await serviceFor({
      watch: (_dir, onEvent) => {
        emitters.push(onEvent);
        return { close() {} };
      },
    });
    await service.track(
      { sessionId: "s1", cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [] },
      "window",
    );
    const events: WorkspaceChangedEvent[] = [];
    service.onChanged((event) => events.push(event));
    const emit = emitters[0];
    if (!emit) throw new Error("not watching");
    emit("a.txt");
    emit(path.join(".git", "index"));
    emit(path.join("node_modules", "x", "y.js"));
    emit(path.join(".dawg", "worktrees", "w1", "a.txt"));
    emit(path.join("src", "b.ts"));
    emit("a.txt");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual([{ sessionId: "s1", paths: [repo.abs("a.txt"), repo.abs("src/b.ts")] }]);

    emit(null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events[1]).toEqual({ sessionId: "s1", paths: [] });

    await service.untrack("s1", "window");
    emit("a.txt");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toHaveLength(2);
  });

  it.skipIf(process.platform !== "darwin")(
    "notices a real file change on macOS",
    async () => {
      const repo = await makeRepo({ "a.txt": "a" });
      // The real `fs.watch`, unlike the other tests.
      const real = createWorkspaceService({
        store: createWorkspaceStore(path.join(await makeTempDir(), "w.json"), () => {}),
        log: () => {},
        debounceMs: 20,
      });
      services.push(real);
      await real.track(
        { sessionId: "s1", cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [] },
        "window",
      );
      const seen = new Promise<WorkspaceChangedEvent>((resolve) => real.onChanged(resolve));
      // FSEvents starts a moment after the watch call.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(repo.abs("b.txt"), "b");
      const event = await seen;
      expect(event.sessionId).toBe("s1");
      expect(event.paths.length === 0 || event.paths.includes(repo.abs("b.txt"))).toBe(true);
    },
    10_000,
  );
});
