import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildIndex,
  createFileIndexCache,
  entriesFor,
  type FileIndexCache,
  type IndexSource,
} from "./file-index.ts";
import { realPathOf } from "./paths.ts";
import { createWorkspaceService, type WorkspaceService } from "./service.ts";
import { createWorkspaceStore } from "./store.ts";
import { makeRepo, makeTempDir, removeTempDirs, type TestRepo } from "./test-repo.ts";

const caches: FileIndexCache[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const cache of caches.splice(0)) cache.dispose();
  for (const service of services.splice(0)) service.dispose();
  await removeTempDirs();
});

const noLog = () => {};

async function rootOf(dir: string) {
  return { logical: dir, real: await realPathOf(dir) };
}

function cacheWith(options: { sources?: IndexSource[]; maxEntries?: number } = {}) {
  // Tests wait for every rebuild, however slow the machine.
  const cache = createFileIndexCache({ log: noLog, staleWaitMs: 60_000, ...options });
  caches.push(cache);
  return cache;
}

function relatives(result: { matches: { relativePath: string }[] }): string[] {
  return result.matches.map((match) => match.relativePath);
}

async function sampleRepo(): Promise<TestRepo> {
  const repo = await makeRepo({
    "README.md": "# tally\n",
    "src/tally/money.py": "x = 1\n",
    "src/tally/report.py": "y = 2\n",
    "tests/test_money.py": "z = 3\n",
    ".gitignore": "build/\n*.log\n",
  });
  await repo.write("notes.txt", "untracked\n");
  await repo.write("build/out.js", "ignored\n");
  await repo.write("debug.log", "ignored\n");
  return repo;
}

describe("entriesFor", () => {
  it("adds the folders the files imply", () => {
    const { entries, truncated } = entriesFor(
      [
        { relative: "a.ts", directory: false },
        { relative: "src/lib/b.ts", directory: false },
        { relative: "vendor/sub", directory: true },
      ],
      100,
    );
    expect(entries.map((entry) => `${entry.kind}:${entry.text}`).sort()).toEqual([
      "directory:src/",
      "directory:src/lib/",
      "directory:vendor/",
      "directory:vendor/sub/",
      "file:a.ts",
      "file:src/lib/b.ts",
    ]);
    expect(truncated).toBe(false);
  });

  it("keeps the shallowest paths when there are too many", () => {
    const listed = [
      { relative: "deep/er/still/x.ts", directory: false },
      { relative: "top.ts", directory: false },
      { relative: "src/a.ts", directory: false },
      { relative: "src/b.ts", directory: false },
    ];
    const { entries, truncated } = entriesFor(listed, 4);
    expect(truncated).toBe(true);
    expect(entries.map((entry) => entry.text)).toEqual(["top.ts", "src/", "src/a.ts", "src/b.ts"]);
  });
});

describe("listing", () => {
  it("lists tracked and untracked files from git, without ignored or deleted ones", async () => {
    const repo = await sampleRepo();
    await rm(repo.abs("src/tally/report.py"));
    const index = await buildIndex(await realPathOf(repo.dir), { log: noLog });
    expect(index.source).toBe("git");
    expect([...index.paths].sort()).toEqual([
      ".gitignore",
      "README.md",
      "notes.txt",
      "src/",
      "src/tally/",
      "src/tally/money.py",
      "tests/",
      "tests/test_money.py",
    ]);
    expect(index.gitPrefix).toBe("");
  });

  it("lists paths relative to a working directory below the repository's top", async () => {
    const repo = await sampleRepo();
    const index = await buildIndex(await realPathOf(repo.abs("src")), { log: noLog });
    expect(index.source).toBe("git");
    expect(index.gitPrefix).toBe("src/");
    expect([...index.paths].sort()).toEqual(["tally/", "tally/money.py", "tally/report.py"]);
  });

  it("lists a worktree's own files", async () => {
    const repo = await sampleRepo();
    repo.git("worktree", "add", "-q", "-b", "feature", repo.abs("../wt-feature"));
    const worktree = repo.abs("../wt-feature");
    try {
      await writeFile(path.join(worktree, "only-here.ts"), "new\n");
      const index = await buildIndex(await realPathOf(worktree), { log: noLog });
      expect(index.source).toBe("git");
      expect(index.paths.has("only-here.ts")).toBe(true);
      expect(index.paths.has("notes.txt")).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("uses ripgrep outside git, honouring ignore files", async () => {
    const dir = await makeTempDir("dawg-plain-");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(dir, "src/a.ts"), "a");
    await writeFile(path.join(dir, ".env.example"), "x");
    await writeFile(path.join(dir, "secret.tmp"), "x");
    await writeFile(path.join(dir, ".ignore"), "*.tmp\n");
    await writeFile(path.join(dir, "node_modules/pkg/index.js"), "x");
    const index = await buildIndex(await realPathOf(dir), {
      log: noLog,
      sources: ["git", "ripgrep"],
      ripgrepPath: path.resolve(
        import.meta.dirname,
        `../../../resources/bin/${process.platform}-${process.arch}/rg`,
      ),
    });
    // Without a fetched ripgrep (`pnpm fetch-ripgrep`) and none on PATH, nothing lists.
    if (index.entries.length === 0) return;
    expect(index.source).toBe("ripgrep");
    expect([...index.paths].sort()).toEqual([".env.example", ".ignore", "src/", "src/a.ts"]);
  });

  it("walks the folder when nothing else can list it, skipping heavy folders and links", async () => {
    const dir = await makeTempDir("dawg-walk-");
    await mkdir(path.join(dir, "src/deep"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
    await mkdir(path.join(dir, ".git/objects"), { recursive: true });
    await writeFile(path.join(dir, "src/deep/a.ts"), "a");
    await writeFile(path.join(dir, "top.md"), "a");
    await writeFile(path.join(dir, "node_modules/pkg/index.js"), "x");
    await writeFile(path.join(dir, ".git/objects/x"), "x");
    await symlink("/etc", path.join(dir, "etc-link"));
    const index = await buildIndex(await realPathOf(dir), { log: noLog, sources: ["walk"] });
    expect(index.source).toBe("walk");
    expect([...index.paths].sort()).toEqual(["src/", "src/deep/", "src/deep/a.ts", "top.md"]);
  });

  it("says when the folder holds more than the index keeps", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.txt`] = "x";
    files["a/b/c.txt"] = "x";
    const repo = await makeRepo(files);
    const index = await buildIndex(await realPathOf(repo.dir), { log: noLog, maxEntries: 20 });
    expect(index.truncated).toBe(true);
    expect(index.entries.length).toBeLessThanOrEqual(20);
    // The top level is kept first.
    expect(index.paths.has("f0.txt")).toBe(true);
    expect(index.paths.has("a/b/c.txt")).toBe(false);
  });

  it("lists a submodule as a folder", async () => {
    const inner = await makeRepo({ "lib.ts": "x" });
    const repo = await makeRepo({ "a.ts": "x" });
    repo.git(
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      inner.dir,
      "vendor/inner",
    );
    repo.commitAll("submodule");
    const index = await buildIndex(await realPathOf(repo.dir), { log: noLog });
    expect(index.paths.has("vendor/inner/")).toBe(true);
    expect(index.paths.has("vendor/inner")).toBe(false);
  });
});

describe("finding", () => {
  it("matches fuzzily, best first, with highlights and absolute paths", async () => {
    const repo = await sampleRepo();
    const cache = cacheWith();
    const root = await rootOf(repo.dir);
    const result = await cache.find(root, "money", 10);
    expect(relatives(result)).toEqual(["src/tally/money.py", "tests/test_money.py"]);
    expect(result.truncated).toBe(false);
    const [first] = result.matches;
    expect(first).toEqual({
      path: path.join(repo.dir, "src/tally/money.py"),
      relativePath: "src/tally/money.py",
      kind: "file",
      highlights: [10, 11, 12, 13, 14],
    });
    const folders = await cache.find(root, "tally", 10);
    expect(folders.matches[0]).toMatchObject({
      path: path.join(repo.dir, "src/tally"),
      relativePath: "src/tally/",
      kind: "directory",
    });
  });

  it("starts an empty query with changed files, newest first, then the top level", async () => {
    const repo = await sampleRepo();
    await repo.write("src/tally/money.py", "changed\n");
    await repo.write("tests/test_money.py", "changed\n");
    const older = new Date(Date.now() - 30_000);
    const oldest = new Date(Date.now() - 60_000);
    await utimes(repo.abs("notes.txt"), older, older);
    await utimes(repo.abs("src/tally/money.py"), oldest, oldest);
    const cache = cacheWith();
    const result = await cache.find(await rootOf(repo.dir), "", 50);
    expect(relatives(result)).toEqual([
      "tests/test_money.py",
      "notes.txt",
      "src/tally/money.py",
      "src/",
      "tests/",
      ".gitignore",
      "README.md",
    ]);
    expect(result.matches.every((match) => match.highlights.length === 0)).toBe(true);
    const limited = await cache.find(await rootOf(repo.dir), "", 3);
    expect(relatives(limited)).toHaveLength(3);
  });

  it("starts an empty query outside git with the newest files", async () => {
    const dir = await makeTempDir("dawg-plain-");
    await writeFile(path.join(dir, "old.txt"), "x");
    await writeFile(path.join(dir, "new.txt"), "x");
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(dir, "old.txt"), old, old);
    const cache = cacheWith({ sources: ["walk"] });
    const result = await cache.find(await rootOf(dir), "", 2);
    expect(relatives(result)).toEqual(["new.txt", "old.txt"]);
  });

  it("builds once and shares the index between queries", async () => {
    const repo = await sampleRepo();
    const cache = cacheWith();
    const root = await rootOf(repo.dir);
    await Promise.all([cache.find(root, "a", 5), cache.find(root, "b", 5)]);
    const first = cache.peek(root.real);
    await cache.find(root, "c", 5);
    expect(cache.peek(root.real)).toBe(first);
  });

  it("rebuilds after files appear or go, but not after an edit", async () => {
    const repo = await sampleRepo();
    const cache = cacheWith();
    const root = await rootOf(repo.dir);
    await cache.find(root, "x", 5);
    const first = cache.peek(root.real);

    // An edit to a listed file keeps the index.
    await repo.write("README.md", "# edited\n");
    await cache.changed(root, [repo.abs("README.md")]);
    await cache.find(root, "readme", 5);
    expect(cache.peek(root.real)).toBe(first);

    // A new file is found on the next query.
    await repo.write("src/tally/ledger.py", "new\n");
    await cache.changed(root, [repo.abs("src/tally/ledger.py")]);
    expect(relatives(await cache.find(root, "ledger", 5))).toEqual(["src/tally/ledger.py"]);

    // A deleted one goes.
    await rm(repo.abs("src/tally/ledger.py"));
    await cache.changed(root, [repo.abs("src/tally/ledger.py")]);
    expect(relatives(await cache.find(root, "ledger", 5))).toEqual([]);

    // A change the watcher could not name rebuilds too.
    await repo.write("fresh.md", "x");
    await cache.changed(root, []);
    expect(relatives(await cache.find(root, "fresh", 5))).toEqual(["fresh.md"]);
  });

  it("puts files the watcher saw change first in the starting list", async () => {
    const repo = await sampleRepo();
    repo.commitAll("everything");
    const cache = cacheWith();
    const root = await rootOf(repo.dir);
    expect(relatives(await cache.find(root, "", 3))).toEqual(["src/", "tests/", ".gitignore"]);
    await cache.changed(root, [repo.abs("tests/test_money.py")]);
    expect(relatives(await cache.find(root, "", 3))[0]).toBe("tests/test_money.py");
  });

  it("rebuilds when an ignore file changes", async () => {
    const repo = await sampleRepo();
    const cache = cacheWith();
    const root = await rootOf(repo.dir);
    expect(relatives(await cache.find(root, "notes", 5))).toEqual(["notes.txt"]);
    await writeFile(repo.abs(".gitignore"), "build/\n*.log\nnotes.txt\n");
    await cache.changed(root, [repo.abs(".gitignore")]);
    expect(relatives(await cache.find(root, "notes", 5))).toEqual([]);
  });

  it("forgets a released folder", async () => {
    const repo = await sampleRepo();
    const cache = cacheWith();
    const root = await rootOf(repo.dir);
    await cache.find(root, "a", 5);
    cache.release(root.real);
    expect(cache.peek(root.real)).toBeNull();
  });
});

describe("the workspace service", () => {
  async function tracked(repo: TestRepo) {
    const dataRoot = await makeTempDir("dawg-data-");
    let report: ((relative: string | null) => void) | null = null;
    const service = createWorkspaceService({
      store: createWorkspaceStore(path.join(dataRoot, "workspace.json"), noLog),
      log: noLog,
      watch: (_dir, onEvent) => {
        report = onEvent;
        return { close() {} };
      },
      debounceMs: 5,
      maxWaitMs: 20,
    });
    services.push(service);
    await service.track(
      { sessionId: "s1", cwd: repo.dir, projectDir: repo.dir, additionalDirectories: [] },
      "window",
    );
    return { service, report: (relative: string | null) => report?.(relative) };
  }

  it("answers findFiles for a tracked session, and refuses untracked ones", async () => {
    const repo = await sampleRepo();
    const { service } = await tracked(repo);
    const result = await service.findFiles({ sessionId: "s1", query: "report", limit: 5 });
    expect(result.matches.map((match) => match.path)).toEqual([
      path.join(repo.dir, "src/tally/report.py"),
    ]);
    await expect(service.findFiles({ sessionId: "nope", query: "a", limit: 5 })).rejects.toThrow(
      /not tracked/,
    );
  });

  it("keeps the index fresh from the watcher", async () => {
    const repo = await sampleRepo();
    const { service, report } = await tracked(repo);
    expect(
      (await service.findFiles({ sessionId: "s1", query: "invoice", limit: 5 })).matches,
    ).toEqual([]);
    await repo.write("src/tally/invoice.py", "new\n");
    report(path.join("src", "tally", "invoice.py"));
    // The watcher's report is debounced and a rebuild may outlast a query: ask until it lands.
    await vi.waitFor(
      async () => {
        const after = await service.findFiles({ sessionId: "s1", query: "invoice", limit: 5 });
        expect(after.matches.map((match) => match.relativePath)).toEqual(["src/tally/invoice.py"]);
      },
      { timeout: 10_000, interval: 50 },
    );
  });
});
