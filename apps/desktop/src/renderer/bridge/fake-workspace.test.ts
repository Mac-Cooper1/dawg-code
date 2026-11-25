import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceChangedEvent } from "../../shared/bridge.ts";
import { createFakeTerminal } from "./fake-terminal.ts";
import {
  BROWSER_NON_GIT_PROJECT,
  createFakeWorkspace,
  FAKE_BASE_COMMIT,
} from "./fake-workspace.ts";

const PROJECT = "/Users/you/code/tally";
const TREE = `${PROJECT}/.dawg/worktrees/split-cents`;

afterEach(() => {
  vi.useRealTimers();
});

async function tracked(cwd = PROJECT, extra: string[] = []) {
  const fake = createFakeWorkspace();
  const info = await fake.workspace.track({
    sessionId: "s1",
    cwd,
    projectDir: PROJECT,
    additionalDirectories: extra,
  });
  return { fake, api: fake.workspace, info };
}

describe("the browser fallback's workspace", () => {
  it("tracks a git folder: its base, branch and label, and a worktree's base branch", async () => {
    const { info } = await tracked();
    expect(info.git).toMatchObject({
      root: PROJECT,
      branch: "main",
      baseCommit: FAKE_BASE_COMMIT,
      baseLabel: "where the session started (4e1c9a2)",
      worktree: null,
    });
    const worktree = await tracked(TREE);
    expect(worktree.info.git).toMatchObject({
      branch: "dawg/split-cents",
      baseLabel: "main",
      worktree: { path: TREE, base: "main" },
    });
  });

  it("lists one added, modified, deleted and untracked file, and leaves ignored ones out", async () => {
    const { api } = await tracked();
    const set = await api.changes("s1");
    expect(set.baseCommit).toBe(FAKE_BASE_COMMIT);
    const byPath = Object.fromEntries(
      set.files.map((file) => [file.path.slice(PROJECT.length + 1), file]),
    );
    expect(byPath["tests/test_money.py"]?.status).toBe("added");
    expect(byPath["src/tally/money.py"]).toMatchObject({ status: "modified", binary: false });
    expect(byPath["src/tally/money.py"]?.additions).toBeGreaterThan(0);
    expect(byPath["src/tally/legacy.py"]?.status).toBe("deleted");
    expect(byPath["notes/todo.md"]?.status).toBe("untracked");
    expect(byPath["assets/logo.png"]).toMatchObject({ status: "modified", binary: true });
    expect(byPath["data/rates.csv"]?.additions).toBe(5000);
    expect(
      Object.keys(byPath).some((path) => path.startsWith(".venv") || path === "build.log"),
    ).toBe(false);
  });

  it("gives both sides of a file with its hunks, and says when it is binary or too large", async () => {
    const { api } = await tracked();
    const diff = await api.fileDiff({ sessionId: "s1", path: `${PROJECT}/src/tally/money.py` });
    expect(diff.original).toContain("share = (total / parts)");
    expect(diff.modified).toContain("divmod(cents, parts)");
    expect(diff.hunks.length).toBeGreaterThan(0);
    const added = await api.fileDiff({ sessionId: "s1", path: `${PROJECT}/tests/test_money.py` });
    expect(added.original).toBeNull();
    expect(
      await api.fileDiff({ sessionId: "s1", path: `${PROJECT}/assets/logo.png` }),
    ).toMatchObject({ binary: true, original: null, modified: null });
    expect(await api.fileDiff({ sessionId: "s1", path: `${PROJECT}/data/dump.sql` })).toMatchObject(
      {
        tooLarge: true,
      },
    );
  });

  it("reverts one hunk, or a whole file, and says files changed", async () => {
    vi.useFakeTimers();
    const { fake, api } = await tracked();
    const events: WorkspaceChangedEvent[] = [];
    api.onChanged((event) => events.push(event));
    const path = `${PROJECT}/README.md`;
    const diff = await api.fileDiff({ sessionId: "s1", path });
    expect(diff.hunks.length).toBe(2);
    await api.revert({ sessionId: "s1", path, hunk: diff.hunks[1] });
    expect((await api.fileDiff({ sessionId: "s1", path })).hunks).toHaveLength(1);
    await api.revert({ sessionId: "s1", path });
    expect(fake.read(path)).toBe(diff.original);
    await api.revert({ sessionId: "s1", path: `${PROJECT}/tests/test_money.py` });
    expect(fake.read(`${PROJECT}/tests/test_money.py`)).toBeNull();
    await vi.runAllTimersAsync();
    expect(events.map((event) => event.paths[0])).toEqual([
      path,
      path,
      `${PROJECT}/tests/test_money.py`,
    ]);
    // A hunk that no longer matches is refused.
    await expect(api.revert({ sessionId: "s1", path, hunk: diff.hunks[0] })).rejects.toThrow(
      "That change no longer matches the file.",
    );
  });

  it("lists a folder: directories first, files next, ignored entries last", async () => {
    const { api } = await tracked();
    const entries = await api.listDirectory({ sessionId: "s1", path: PROJECT });
    const names = entries.map((entry) => `${entry.kind === "directory" ? "d" : "f"}:${entry.name}`);
    expect(names.slice(0, 5)).toEqual(["d:assets", "d:data", "d:notes", "d:src", "d:tests"]);
    expect(names.at(-1)).toBe("f:build.log");
    expect(entries.find((entry) => entry.name === ".venv")).toMatchObject({ ignored: true });
    expect(entries.find((entry) => entry.name === "README.md")?.size).toBeGreaterThan(0);
  });

  it("reads and writes files, refusing a save over a newer version", async () => {
    const { fake, api } = await tracked();
    const path = `${PROJECT}/README.md`;
    const file = await api.readFile({ sessionId: "s1", path });
    expect(file.content).toContain("# tally");
    const saved = await api.writeFile({
      sessionId: "s1",
      path,
      content: "mine\n",
      expectedMtimeMs: file.mtimeMs,
    });
    expect(saved.mtimeMs).toBeGreaterThan(file.mtimeMs);
    fake.writeExternally(path, "theirs\n");
    await expect(
      api.writeFile({ sessionId: "s1", path, content: "again\n", expectedMtimeMs: saved.mtimeMs }),
    ).rejects.toThrow("The file changed on disk since it was opened.");
    expect(
      await api.readFile({ sessionId: "s1", path: `${PROJECT}/assets/logo.png` }),
    ).toMatchObject({ binary: true, content: null });
    expect(await api.readFile({ sessionId: "s1", path: `${PROJECT}/data/dump.sql` })).toMatchObject(
      {
        tooLarge: true,
        content: null,
      },
    );
  });

  it("refuses paths outside the session's folders, untracked sessions and bad input", async () => {
    const { api } = await tracked(PROJECT, ["/Users/you/shared"]);
    await expect(api.readFile({ sessionId: "s1", path: "/etc/passwd" })).rejects.toThrow(
      "outside the session's folders",
    );
    await expect(
      api.readFile({ sessionId: "s1", path: `${PROJECT}/../secrets.txt` }),
    ).rejects.toThrow("outside the session's folders");
    expect(
      (await api.readFile({ sessionId: "s1", path: "/Users/you/shared/README.md" })).content,
    ).toContain("Shared notes");
    await expect(api.changes("nobody")).rejects.toThrow("not tracked");
    await expect(api.readFile({ sessionId: "s1", path: "relative.txt" })).rejects.toThrow(
      /Invalid file/,
    );
  });

  it("outside git: plain folders and no change set", async () => {
    const fake = createFakeWorkspace();
    const cwd = BROWSER_NON_GIT_PROJECT;
    const info = await fake.workspace.track({ sessionId: "n1", cwd, projectDir: cwd });
    expect(info.git).toBeNull();
    expect(await fake.workspace.changes("n1")).toEqual({
      baseCommit: null,
      files: [],
      truncated: false,
    });
    const names = (await fake.workspace.listDirectory({ sessionId: "n1", path: cwd })).map(
      (entry) => entry.name,
    );
    expect(names).toContain("pyproject.toml");
    expect((await fake.worktrees.branches(cwd)).isRepo).toBe(false);
  });

  it("makes worktrees, refuses a taken name, and keeps one with changes", async () => {
    const { worktrees } = createFakeWorkspace();
    expect(await worktrees.branches(PROJECT)).toMatchObject({ isRepo: true, current: "main" });
    const made = await worktrees.create({ projectDir: PROJECT, name: "csv-fix", base: "main" });
    expect(made).toEqual({
      path: `${PROJECT}/.dawg/worktrees/csv-fix`,
      branch: "dawg/csv-fix",
      base: "main",
      baseCommit: FAKE_BASE_COMMIT,
    });
    expect((await worktrees.branches(PROJECT)).branches).toContain("dawg/csv-fix");
    await expect(
      worktrees.create({ projectDir: PROJECT, name: "csv-fix", base: "main" }),
    ).rejects.toThrow("already exists");
    await expect(
      worktrees.create({ projectDir: PROJECT, name: "Bad Name", base: "main" }),
    ).rejects.toThrow(/Invalid worktree/);
    expect(await worktrees.cleanup(made.path)).toEqual({ removed: true, reason: null });

    const fake = createFakeWorkspace();
    await fake.workspace.track({ sessionId: "w", cwd: TREE, projectDir: PROJECT });
    expect(await fake.worktrees.cleanup(TREE)).toEqual({
      removed: false,
      reason: "It has changes that are not committed.",
    });
  });
});

describe("the browser fallback's terminal", () => {
  async function flush() {
    await vi.runAllTimersAsync();
  }

  it("echoes what is typed, answers a few commands, and keeps a backlog", async () => {
    vi.useFakeTimers();
    const { api } = createFakeTerminal();
    let output = "";
    api.onData((event) => {
      output += event.data;
    });
    const info = await api.open({ sessionId: "s1", cwd: PROJECT, cols: 80, rows: 24 });
    expect(info).toMatchObject({ sessionId: "s1", title: "zsh", alive: true });
    await flush();
    expect(output).toContain("tally");
    api.write(info.terminalId, "pwdx\x7f\r");
    await flush();
    // Typed, a backspace rubbed out, then the command's answer.
    expect(output).toContain(`pwdx\b \b\r\n${PROJECT}\r\n`);
    api.write(info.terminalId, "make\r");
    await flush();
    expect(output).toContain("command not found: make");
    const [reattach] = await api.list("s1");
    expect(reattach?.backlog).toBe(output);
  });

  it("ends on exit or close, and forgets the terminal", async () => {
    vi.useFakeTimers();
    const fake = createFakeTerminal();
    const exits: (number | null)[] = [];
    fake.api.onExit((event) => exits.push(event.exitCode));
    const first = await fake.api.open({ sessionId: "s1", cwd: PROJECT, cols: 80, rows: 24 });
    const second = await fake.api.open({ sessionId: "s1", cwd: PROJECT, cols: 80, rows: 24 });
    fake.api.write(first.terminalId, "exit\r");
    await fake.api.close(second.terminalId);
    await flush();
    expect(exits).toEqual([0, null]);
    expect(fake.openIds()).toEqual([]);
    expect(await fake.api.list("s1")).toEqual([]);
    expect(() => fake.api.resize(first.terminalId, 1, 1)).toThrow(/Invalid terminal size/);
  });
});
