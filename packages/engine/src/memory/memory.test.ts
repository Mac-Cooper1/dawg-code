import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectKey } from "../session/paths.ts";
import {
  agentMemoryDirectory,
  autoMemoryEnabled,
  loadMemoryIndex,
  MEMORY_MAX_BYTES,
  memoryDirectory,
  memoryProjectRoot,
  renderMemoryPrompt,
} from "./memory.ts";

let root: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-memory-"));
  store = path.join(root, "store");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the project a memory belongs to", () => {
  it("is the git repository's root, for the root and any folder in it", async () => {
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(path.join(repo, "packages", "app"), { recursive: true });
    expect(memoryProjectRoot(repo)).toBe(repo);
    expect(memoryProjectRoot(path.join(repo, "packages", "app"))).toBe(repo);
  });

  it("is the main working tree for a linked worktree, so worktrees share it", async () => {
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, ".dawg", "worktrees", "fix-tests");
    await mkdir(path.join(repo, ".git", "worktrees", "fix-tests"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "fix-tests")}\n`,
    );
    expect(memoryProjectRoot(worktree)).toBe(repo);
    // A worktree elsewhere, named relatively, too.
    const outside = path.join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, ".git"), "gitdir: ../repo/.git/worktrees/fix-tests\n");
    expect(memoryProjectRoot(outside)).toBe(repo);
  });

  it("is a submodule's own folder", async () => {
    const sub = path.join(root, "repo", "vendor", "lib");
    await mkdir(path.join(root, "repo", ".git", "modules", "lib"), { recursive: true });
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, ".git"), "gitdir: ../../.git/modules/lib\n");
    expect(memoryProjectRoot(sub)).toBe(sub);
  });

  it("is the folder itself outside git", async () => {
    const plain = path.join(root, "plain", "deep");
    await mkdir(plain, { recursive: true });
    expect(memoryProjectRoot(plain)).toBe(plain);
  });
});

describe("the memory folder", () => {
  it("is <data root>/projects/<project key>/memory, beside the project's sessions", async () => {
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    const dir = await memoryDirectory(store, path.join(repo, "src"));
    expect(dir).toBe(path.join(store, "projects", projectKey(repo), "memory"));
    // The project folder is claimed for the repository.
    const claim = JSON.parse(
      await readFile(path.join(store, "projects", projectKey(repo), "project.json"), "utf8"),
    );
    expect(claim).toEqual({ path: repo });
    expect(await memoryDirectory(store, repo)).toBe(dir);
  });

  it("gives subagents a folder per scope", () => {
    const project = path.join(root, "proj");
    expect(
      agentMemoryDirectory({
        scope: "user",
        agentName: "reviewer",
        storeRoot: store,
        projectDir: project,
      }),
    ).toBe(path.join(store, "agent-memory", "reviewer"));
    expect(
      agentMemoryDirectory({
        scope: "project",
        agentName: "reviewer",
        storeRoot: store,
        projectDir: project,
      }),
    ).toBe(path.join(project, ".dawg", "agent-memory", "reviewer"));
    expect(
      agentMemoryDirectory({
        scope: "local",
        agentName: "../x/y",
        storeRoot: store,
        projectDir: project,
      }),
    ).toBe(path.join(project, ".dawg", "agent-memory-local", "-x-y"));
  });
});

describe("loading MEMORY.md", () => {
  it("loads the first 200 lines and says when it left some out", async () => {
    const dir = path.join(root, "memory");
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `- memory ${i + 1}`);
    await writeFile(path.join(dir, "MEMORY.md"), `${lines.join("\r\n")}\r\n`);
    const index = await loadMemoryIndex(dir);
    expect(index).toMatchObject({
      exists: true,
      totalLines: 250,
      loadedLines: 200,
      truncated: true,
    });
    expect(index.text.split("\n")).toEqual(lines.slice(0, 200));
    const prompt = renderMemoryPrompt(index);
    expect(prompt).toContain("- memory 200");
    expect(prompt).not.toContain("- memory 201");
    expect(prompt).toContain("Only the first 200 of its 250 lines were loaded");
  });

  it("stops at 25 KB, at a line boundary", async () => {
    const dir = path.join(root, "memory");
    await mkdir(dir, { recursive: true });
    const long = "x".repeat(200);
    await writeFile(path.join(dir, "MEMORY.md"), Array(180).fill(long).join("\n"));
    const index = await loadMemoryIndex(dir);
    expect(Buffer.byteLength(index.text) + 1).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(index.loadedLines).toBe(Math.floor(MEMORY_MAX_BYTES / 201));
    expect(index.truncated).toBe(true);
  });

  it("is empty when there is no MEMORY.md", async () => {
    const index = await loadMemoryIndex(path.join(root, "none"));
    expect(index).toMatchObject({ exists: false, text: "", truncated: false });
    expect(renderMemoryPrompt(index)).toContain("(Empty: nothing has been saved yet.)");
  });

  it("renders the same bytes for the same folder and text", async () => {
    const dir = path.join(root, "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "MEMORY.md"), "- [Style](style.md): tabs, not spaces\n");
    const a = renderMemoryPrompt(await loadMemoryIndex(dir));
    const b = renderMemoryPrompt(await loadMemoryIndex(dir));
    expect(a).toBe(b);
    expect(a).toContain(dir);
    expect(a).toContain("- [Style](style.md): tabs, not spaces");
    // The instructions say when to save and when not to.
    expect(a).toMatch(/Save a memory when/);
    expect(a).toMatch(/Do not save what can be learned again from the project/);
  });
});

describe("autoMemoryEnabled", () => {
  it("takes the first settings file that sets it, else on", async () => {
    const a = path.join(root, "a.json");
    const b = path.join(root, "b.json");
    await writeFile(a, JSON.stringify({ permissions: {} }));
    await writeFile(b, JSON.stringify({ autoMemoryEnabled: false }));
    expect(await autoMemoryEnabled([])).toBe(true);
    expect(
      await autoMemoryEnabled([
        { path: a, exists: true },
        { path: b, exists: true },
      ]),
    ).toBe(false);
    expect(await autoMemoryEnabled([{ path: b, exists: false }])).toBe(true);
  });
});
