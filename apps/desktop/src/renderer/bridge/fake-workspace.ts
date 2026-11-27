/**
 * The browser fallback's workspace and worktrees: an in-memory disk with a small project, so the
 * Changes and Files panes can be tried in a plain browser.
 *
 * Any session folder that is tracked gets the project below, as a git repository whose base
 * version differs from the working tree by one added, one modified, one deleted and one untracked
 * file (and a few more: a binary file, a file over 5 MB and a 5,000-line new file). Folders under
 * `BROWSER_NON_GIT_PROJECT` are not repositories, so the pane's "session's own edits" view shows.
 */
import {
  type BranchList,
  type ChangedFile,
  type ChangeSet,
  CreateWorktreeInputSchema,
  type DawgBridge,
  type DirEntry,
  type FileContent,
  type FileDiff,
  type FileMatch,
  FileRefSchema,
  FindFilesInputSchema,
  type FindFilesResult,
  ProjectRefSchema,
  RevertInputSchema,
  SessionRefSchema,
  TrackSessionInputSchema,
  type Unsubscribe,
  type WorkspaceChangedEvent,
  type WorkspaceInfo,
  type WorktreeCleanup,
  type WorktreeInfo,
  WriteFileInputSchema,
} from "../../shared/bridge.ts";
import { fuzzySearch, normalizeQuery, prepareTarget } from "../../shared/fuzzy.ts";
import { countChanges, makeHunks, reverseHunk } from "../code/diff.ts";
import { validate } from "./validate.ts";

/** Sessions in this project see plain folders, not a git repository. */
export const BROWSER_NON_GIT_PROJECT = "/Users/you/code/notes-cli";
/** The commit the fake repository's base points at. */
export const FAKE_BASE_COMMIT = "4e1c9a2f7b3d8e6a0c5b1d9f2e7a4c8b6d0f3e1a";
/** What the editor may load: larger files are reported as too large, as main does. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

type FakeFile =
  | { kind: "text"; text: string; mtimeMs: number }
  | { kind: "binary"; size: number; mtimeMs: number; tag: string }
  | { kind: "large"; size: number; mtimeMs: number; tag: string };

type Template = Record<string, string | { binary: number; tag: string } | { large: number }>;

interface TrackedSession {
  sessionId: string;
  cwd: string;
  dirs: string[];
  /** The repository the session's working directory is in; null outside git. */
  repo: string | null;
  info: WorkspaceInfo;
}

interface Repo {
  root: string;
  /** The base version: path → file. */
  base: Map<string, FakeFile>;
  /** New files committed or staged since the base; any other new file is untracked. */
  added: Set<string>;
  /** Ignored paths and folders (a folder also ignores everything under it). */
  ignored: string[];
}

export interface FakeWorkspaceOptions {
  /** Folders that are not git repositories. Default: `BROWSER_NON_GIT_PROJECT`. */
  nonGitRoots?: string[];
  /** Clock for modification times. Default `Date.now`. */
  now?: () => number;
  /** Where a project's memory folder is, as main's `memoryDirectory` would say. */
  memoryDirectory?: (projectDir: string) => string;
}

/** The fake data root's memory folder for a project: `/Users/you/.dawg/projects/<key>/memory`. */
export function fakeMemoryDirectory(projectDir: string): string {
  return `/Users/you/.dawg/projects/${trimSlash(projectDir).replace(/[^A-Za-z0-9]/g, "-")}/memory`;
}

export interface FakeWorkspace {
  readonly workspace: DawgBridge["workspace"];
  readonly worktrees: DawgBridge["worktrees"];
  /**
   * Test helper: another program writes (or deletes, with null) a file. `notify: false` skips the
   * change event, as when the watcher missed it.
   */
  writeExternally(path: string, text: string | null, options?: { notify?: boolean }): void;
  /** Test helper: a file's text on the fake disk, or null. */
  read(path: string): string | null;
}

// ---------------------------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------------------------

const MONEY_BASE = `from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def to_cents(amount: Decimal) -> Decimal:
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def split_evenly(total: Decimal, parts: int) -> list[Decimal]:
    """Split total into parts that add up to it exactly."""
    if parts < 1:
        raise ValueError("parts must be at least 1")
    share = (total / parts).quantize(CENT, rounding=ROUND_HALF_UP)
    return [share] * parts


def format_amount(amount: Decimal, currency: str = "USD") -> str:
    return f"{amount:,.2f} {currency}"
`;

const MONEY_NOW = `from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def to_cents(amount: Decimal) -> Decimal:
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def split_evenly(total: Decimal, parts: int) -> list[Decimal]:
    """Split total into parts that add up to it exactly."""
    if parts < 1:
        raise ValueError("parts must be at least 1")
    sign = -1 if total < 0 else 1
    cents = int((abs(total) / CENT).to_integral_value())
    base, extra = divmod(cents, parts)
    return [
        sign * (base + (1 if i < extra else 0)) * CENT
        for i in range(parts)
    ]


def format_amount(amount: Decimal, currency: str = "USD") -> str:
    """Format an amount with thousands separators and its currency code."""
    return f"{amount:,.2f} {currency}"
`;

const README_BASE = `# tally

Split bills between friends, to the cent.

## Usage

\`\`\`python
from decimal import Decimal
from tally.money import split_evenly

split_evenly(Decimal("100.00"), 3)
\`\`\`
`;

const README_NOW = `# tally

Split bills between friends, to the cent. Refunds split the same way.

## Usage

\`\`\`python
from decimal import Decimal
from tally.money import split_evenly

split_evenly(Decimal("100.00"), 3)   # [33.34, 33.33, 33.33]
split_evenly(Decimal("-100.00"), 3)  # [-33.34, -33.33, -33.33]
\`\`\`
`;

const TEST_MONEY = `from decimal import Decimal

from tally.money import split_evenly


def test_split_adds_up():
    parts = split_evenly(Decimal("100.00"), 3)
    assert sum(parts) == Decimal("100.00")


def test_refunds_split_the_same_way():
    assert split_evenly(Decimal("-100.00"), 3) == [
        Decimal("-33.34"),
        Decimal("-33.33"),
        Decimal("-33.33"),
    ]
`;

const LEGACY = `"""The old rounding helpers. Use tally.money instead."""


def round_half_up(value):
    return int(value + 0.5)
`;

const BILL = `from dataclasses import dataclass
from decimal import Decimal

from tally.money import split_evenly


@dataclass
class Bill:
    total: Decimal
    people: list[str]

    def shares(self) -> dict[str, Decimal]:
        return dict(zip(self.people, split_evenly(self.total, len(self.people))))
`;

const PYPROJECT = `[project]
name = "tally"
version = "0.4.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
pythonpath = ["src"]
`;

/** A 5,000-line new file, for the "large diff opens quickly" budget. */
function ratesTable(): string {
  const lines = ["date,from,to,rate"];
  const currencies = ["EUR", "GBP", "JPY", "CHF", "CAD"];
  for (let i = 1; i < 5000; i++) {
    const day = new Date(Date.UTC(2012, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const to = currencies[i % currencies.length];
    lines.push(`${day},USD,${to},${(0.5 + ((i * 7919) % 1000) / 1000).toFixed(4)}`);
  }
  return `${lines.join("\n")}\n`;
}

function baseTemplate(): Template {
  return {
    ".gitignore": ".venv/\n__pycache__/\n*.log\n",
    "README.md": README_BASE,
    "pyproject.toml": PYPROJECT,
    "src/tally/__init__.py": "",
    "src/tally/bill.py": BILL,
    "src/tally/legacy.py": LEGACY,
    "src/tally/money.py": MONEY_BASE,
    "assets/logo.png": { binary: 18_204, tag: "v1" },
  };
}

function workingTemplate(): Template {
  const { "src/tally/legacy.py": _deleted, ...kept } = baseTemplate();
  return {
    ...kept,
    "README.md": README_NOW,
    "src/tally/money.py": MONEY_NOW,
    "tests/test_money.py": TEST_MONEY,
    "data/rates.csv": ratesTable(),
    "assets/logo.png": { binary: 19_330, tag: "v2" },
    "notes/todo.md": "- Ask Sam about rounding rules for JPY\n",
    "data/dump.sql": { large: 12_400_000 },
    "build.log": "collected 10 items\n10 passed in 0.21s\n",
    ".venv/pyvenv.cfg": "home = /usr/local/bin\nversion = 3.13.1\n",
    "src/tally/__pycache__/money.cpython-313.pyc": { binary: 2_310, tag: "pyc" },
  };
}

/** New files that are not committed or staged (the rest are). */
/** New files committed since the base (the other new files are untracked). */
const ADDED = ["tests/test_money.py", "data/rates.csv"];
/** As `.gitignore` says, plus dawg's own folder (main keeps `.dawg/` out of git). */
const IGNORED = [".venv", "__pycache__", "build.log", ".dawg"];

function nonGitTemplate(): Template {
  return {
    "README.md": "# notes-cli\n\nKeep notes from the terminal.\n",
    "pyproject.toml": '[project]\nname = "notes-cli"\nrequires-python = ">=3.13"\n',
    "src/notes_cli/__init__.py": "",
    "src/notes_cli/cli.py":
      'import sys\n\n\ndef main() -> None:\n    print("notes", sys.argv[1:])\n',
  };
}

/** For an additional directory: one file, so it is not empty. */
function extraTemplate(): Template {
  return { "README.md": "Shared notes for every project.\n" };
}

// ---------------------------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------------------------

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function relative(path: string, root: string): string {
  return path === root ? "" : path.slice(root.length + 1);
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function sameFile(a: FakeFile | undefined, b: FakeFile | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind !== "text" && b.kind !== "text") return a.tag === b.tag && a.size === b.size;
  return false;
}

/**
 * `@` search over files given by absolute path, as main answers it: files and the folders they
 * imply under `cwd`, matched fuzzily; an empty query lists `recent` files (relative paths, newest
 * first) and then the top level. Shared with the store tests' fake bridge.
 */
export function findInFiles(
  cwd: string,
  files: Iterable<string>,
  query: string,
  limit: number,
  recent: readonly string[] = [],
): FindFilesResult {
  const root = trimSlash(cwd);
  const relatives = new Set<string>();
  for (const path of files) {
    if (!path.startsWith(`${root}/`)) continue;
    const rel = path.slice(root.length + 1);
    // Other sessions' worktrees are not this folder's files.
    if (/(^|\/)\.dawg\/worktrees\//.test(rel)) continue;
    relatives.add(rel);
    for (let slash = rel.indexOf("/"); slash !== -1; slash = rel.indexOf("/", slash + 1)) {
      relatives.add(rel.slice(0, slash + 1));
    }
  }
  const toMatch = (rel: string, highlights: number[]): FileMatch => ({
    path: `${root}/${trimSlash(rel)}`,
    relativePath: rel,
    kind: rel.endsWith("/") ? "directory" : "file",
    highlights,
  });
  if (normalizeQuery(query) === "") {
    const chosen = recent.filter((rel) => relatives.has(rel)).slice(0, Math.min(10, limit));
    const topLevel = [...relatives]
      .filter((rel) => !trimSlash(rel).includes("/"))
      .sort((a, b) => {
        const aFolder = a.endsWith("/");
        if (aFolder !== b.endsWith("/")) return aFolder ? -1 : 1;
        return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
      });
    for (const rel of topLevel) {
      if (chosen.length >= limit) break;
      if (!chosen.includes(rel)) chosen.push(rel);
    }
    return { matches: chosen.map((rel) => toMatch(rel, [])), truncated: false };
  }
  const targets = [...relatives].map(prepareTarget);
  return {
    matches: fuzzySearch(query, targets, limit).map((match) =>
      toMatch(match.target.text, match.positions),
    ),
    truncated: false,
  };
}

function fileSize(file: FakeFile): number {
  return file.kind === "text" ? new TextEncoder().encode(file.text).length : file.size;
}

function withoutMemory(info: WorkspaceInfo): WorkspaceInfo {
  const { memoryDirectory: _memory, ...rest } = info;
  return rest;
}

export function createFakeWorkspace(options: FakeWorkspaceOptions = {}): FakeWorkspace {
  const nonGitRoots = options.nonGitRoots ?? [BROWSER_NON_GIT_PROJECT];
  const clock = options.now ?? Date.now;
  let lastTime = 0;
  /** Strictly increasing, so every write has a new modification time. */
  const tick = () => {
    lastTime = Math.max(lastTime + 1, clock());
    return lastTime;
  };

  const disk = new Map<string, FakeFile>();
  /** Folders seeded with a template (each only once). */
  const seeded = new Set<string>();
  const repos = new Map<string, Repo>();
  const sessions = new Map<string, TrackedSession>();
  const listeners = new Set<(event: WorkspaceChangedEvent) => void>();
  const worktrees = new Map<string, WorktreeInfo & { untouched: boolean }>();

  function toFile(value: Template[string], mtimeMs: number): FakeFile {
    if (typeof value === "string") return { kind: "text", text: value, mtimeMs };
    if ("binary" in value) return { kind: "binary", size: value.binary, mtimeMs, tag: value.tag };
    return { kind: "large", size: value.large, mtimeMs, tag: "large" };
  }

  function seed(root: string, template: Template): void {
    if (seeded.has(root)) return;
    seeded.add(root);
    const time = tick();
    for (const [path, value] of Object.entries(template)) {
      disk.set(`${root}/${path}`, toFile(value, time));
    }
  }

  function seedRepo(root: string, clean: boolean): Repo {
    const existing = repos.get(root);
    if (existing) return existing;
    const time = tick();
    const base = new Map<string, FakeFile>();
    for (const [path, value] of Object.entries(baseTemplate())) {
      base.set(`${root}/${path}`, toFile(value, time));
    }
    const repo: Repo = {
      root,
      base,
      added: new Set(clean ? [] : ADDED.map((path) => `${root}/${path}`)),
      ignored: IGNORED,
    };
    repos.set(root, repo);
    if (!seeded.has(root)) {
      seeded.add(root);
      if (clean) for (const [path, file] of base) disk.set(path, { ...file });
      else
        for (const [path, value] of Object.entries(workingTemplate())) {
          disk.set(`${root}/${path}`, toFile(value, time));
        }
    }
    return repo;
  }

  function isIgnored(repo: Repo, path: string): boolean {
    const rel = relative(path, repo.root);
    return repo.ignored.some((pattern) => rel === pattern || rel.split("/").includes(pattern));
  }

  function session(sessionId: string): TrackedSession {
    const tracked = sessions.get(sessionId);
    if (!tracked) throw new Error(`The session ${sessionId} is not tracked.`);
    return tracked;
  }

  function checkPath(tracked: TrackedSession, path: string): string {
    const clean = trimSlash(path);
    if (clean.split("/").includes(".."))
      throw new Error("That path is outside the session's folders.");
    if (!tracked.dirs.some((dir) => isInside(clean, dir))) {
      throw new Error("That path is outside the session's folders.");
    }
    return clean;
  }

  function emit(paths: string[]): void {
    for (const tracked of sessions.values()) {
      const mine = paths.filter((path) => tracked.dirs.some((dir) => isInside(path, dir)));
      if (mine.length === 0) continue;
      const event: WorkspaceChangedEvent = { sessionId: tracked.sessionId, paths: mine };
      // Main sends these over IPC, debounced: never synchronously.
      setTimeout(() => {
        for (const listener of [...listeners]) listener(event);
      }, 0);
    }
  }

  function write(path: string, text: string | null): void {
    if (text === null) disk.delete(path);
    else disk.set(path, { kind: "text", text, mtimeMs: tick() });
    emit([path]);
  }

  function repoOf(tracked: TrackedSession): Repo {
    if (!tracked.repo) throw new Error("This folder is not in a git repository.");
    const repo = repos.get(tracked.repo);
    if (!repo) throw new Error("This folder is not in a git repository.");
    return repo;
  }

  function changedFile(repo: Repo, path: string): ChangedFile | null {
    const before = repo.base.get(path);
    const after = disk.get(path);
    if (sameFile(before, after)) return null;
    const status: ChangedFile["status"] = !before
      ? repo.added.has(path)
        ? "added"
        : "untracked"
      : !after
        ? "deleted"
        : "modified";
    const binary = before?.kind === "binary" || after?.kind === "binary";
    const textOf = (file: FakeFile | undefined) => (file?.kind === "text" ? file.text : null);
    const tooLarge = before?.kind === "large" || after?.kind === "large";
    const counts =
      binary || tooLarge
        ? { additions: 0, deletions: 0 }
        : countChanges(makeHunks(textOf(before), textOf(after)));
    return { path, oldPath: null, status, binary, ...counts };
  }

  function listChanges(repo: Repo): ChangedFile[] {
    const paths = new Set<string>();
    for (const path of repo.base.keys()) paths.add(path);
    for (const path of disk.keys()) {
      if (isInside(path, repo.root) && !isIgnored(repo, path)) paths.add(path);
    }
    const files: ChangedFile[] = [];
    for (const path of [...paths].sort()) {
      const changed = changedFile(repo, path);
      if (changed) files.push(changed);
    }
    return files;
  }

  function worktreeOf(cwd: string): WorktreeInfo | null {
    const known = worktrees.get(cwd);
    if (known) return known;
    const match = /^(.*)\/\.dawg\/worktrees\/([^/]+)$/.exec(cwd);
    if (!match) return null;
    return { path: cwd, branch: `dawg/${match[2]}`, base: "main", baseCommit: FAKE_BASE_COMMIT };
  }

  const workspace: DawgBridge["workspace"] = {
    async track(input) {
      const valid = validate(TrackSessionInputSchema, input, "session folders");
      const cwd = trimSlash(valid.cwd);
      const extra = valid.additionalDirectories.map(trimSlash);
      const nonGit = nonGitRoots.some((root) => isInside(cwd, root));
      const worktree = nonGit ? null : worktreeOf(cwd);
      if (nonGit) seed(cwd, nonGitTemplate());
      else seedRepo(cwd, worktree !== null && (worktrees.get(cwd)?.untouched ?? false));
      for (const dir of extra) seed(dir, extraTemplate());
      // `/memory`: the project's memory folder, worked out here as main does, never sent in.
      const memory = valid.memory
        ? (options.memoryDirectory ?? fakeMemoryDirectory)(valid.projectDir)
        : null;
      if (memory !== null) seed(memory, { "MEMORY.md": "" });
      const existing = sessions.get(valid.sessionId);
      const known: WorkspaceInfo = existing?.info ?? {
        sessionId: valid.sessionId,
        cwd,
        git: nonGit
          ? null
          : {
              root: cwd,
              branch: worktree ? worktree.branch : "main",
              baseCommit: FAKE_BASE_COMMIT,
              baseLabel: worktree
                ? worktree.base
                : `where the session started (${FAKE_BASE_COMMIT.slice(0, 7)})`,
              worktree,
            },
      };
      const info: WorkspaceInfo = valid.memory
        ? { ...known, memoryDirectory: memory }
        : withoutMemory(known);
      sessions.set(valid.sessionId, {
        sessionId: valid.sessionId,
        cwd,
        dirs: memory === null ? [cwd, ...extra] : [cwd, ...extra, memory],
        repo: nonGit ? null : cwd,
        info,
      });
      return structuredClone(info);
    },
    async untrack(sessionId) {
      sessions.delete(validate(SessionRefSchema, sessionId, "session"));
    },
    async changes(sessionId) {
      const tracked = session(validate(SessionRefSchema, sessionId, "session"));
      if (!tracked.repo)
        return { baseCommit: null, files: [], truncated: false } satisfies ChangeSet;
      return {
        baseCommit: FAKE_BASE_COMMIT,
        files: listChanges(repoOf(tracked)),
        truncated: false,
      };
    },
    async fileDiff(ref) {
      const valid = validate(FileRefSchema, ref, "file");
      const tracked = session(valid.sessionId);
      const path = checkPath(tracked, valid.path);
      const repo = repoOf(tracked);
      const before = repo.base.get(path);
      const after = disk.get(path);
      const binary = before?.kind === "binary" || after?.kind === "binary";
      const tooLarge = before?.kind === "large" || after?.kind === "large";
      if (binary || tooLarge) {
        return { path, original: null, modified: null, binary, tooLarge, hunks: [] };
      }
      const original = before?.kind === "text" ? before.text : null;
      const modified = after?.kind === "text" ? after.text : null;
      return {
        path,
        original,
        modified,
        binary: false,
        tooLarge: false,
        hunks: makeHunks(original, modified),
      } satisfies FileDiff;
    },
    async revert(input) {
      const valid = validate(RevertInputSchema, input, "revert");
      const tracked = session(valid.sessionId);
      const path = checkPath(tracked, valid.path);
      const repo = repoOf(tracked);
      const before = repo.base.get(path);
      if (!valid.hunk) {
        if (before) disk.set(path, { ...before, mtimeMs: tick() });
        else disk.delete(path);
        emit([path]);
        return;
      }
      const after = disk.get(path);
      if (after && after.kind !== "text")
        throw new Error("Only text files can be reverted a part at a time.");
      const next = reverseHunk(after?.text ?? "", valid.hunk);
      if (!before && next === "" && after?.text !== "") write(path, null);
      else write(path, next);
    },
    async listDirectory(ref) {
      const valid = validate(FileRefSchema, ref, "folder");
      const tracked = session(valid.sessionId);
      const dir = checkPath(tracked, valid.path);
      const repo = tracked.repo ? repos.get(tracked.repo) : undefined;
      const children = new Map<string, DirEntry>();
      for (const [path, file] of disk) {
        if (!path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        const full = `${dir}/${name}`;
        if (children.has(full)) continue;
        const ignored = repo ? isIgnored(repo, full) : false;
        children.set(
          full,
          slash === -1
            ? { name, path: full, kind: "file", ignored, size: fileSize(file) }
            : { name, path: full, kind: "directory", ignored, size: null },
        );
      }
      if (children.size === 0 && !tracked.dirs.includes(dir))
        throw new Error(`No folder at ${dir}.`);
      const rank = (entry: DirEntry) =>
        (entry.ignored ? 2 : 0) + (entry.kind === "directory" ? 0 : 1);
      return [...children.values()].sort(
        (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en", { numeric: true }),
      );
    },
    async readFile(ref) {
      const valid = validate(FileRefSchema, ref, "file");
      const path = checkPath(session(valid.sessionId), valid.path);
      const file = disk.get(path);
      if (!file) throw new Error(`No file at ${path}.`);
      const size = fileSize(file);
      const tooLarge = file.kind === "large" || size > MAX_TEXT_BYTES;
      return {
        path,
        content: file.kind === "text" && !tooLarge ? file.text : null,
        binary: file.kind === "binary",
        tooLarge,
        size,
        mtimeMs: file.mtimeMs,
      } satisfies FileContent;
    },
    async writeFile(input) {
      const valid = validate(WriteFileInputSchema, input, "file");
      const path = checkPath(session(valid.sessionId), valid.path);
      const current = disk.get(path);
      if (valid.expectedMtimeMs !== undefined && current?.mtimeMs !== valid.expectedMtimeMs) {
        throw new Error("The file changed on disk since it was opened.");
      }
      const mtimeMs = tick();
      disk.set(path, { kind: "text", text: valid.content, mtimeMs });
      emit([path]);
      return { mtimeMs };
    },
    async findFiles(input) {
      const valid = validate(FindFilesInputSchema, input, "file search");
      const tracked = session(valid.sessionId);
      const repo = tracked.repo ? repos.get(tracked.repo) : undefined;
      const files: string[] = [];
      for (const path of disk.keys()) {
        if (!isInside(path, tracked.cwd) || (repo && isIgnored(repo, path))) continue;
        files.push(path);
      }
      // Files written since the project was made (by the agent or the editor), newest first.
      const seededAt = Math.min(...files.map((path) => disk.get(path)?.mtimeMs ?? 0));
      const recent = files
        .filter((path) => (disk.get(path)?.mtimeMs ?? 0) > seededAt)
        .sort((a, b) => (disk.get(b)?.mtimeMs ?? 0) - (disk.get(a)?.mtimeMs ?? 0))
        .map((path) => relative(path, tracked.cwd));
      return findInFiles(tracked.cwd, files, valid.query, valid.limit, recent);
    },

    onChanged(listener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const worktreesApi: DawgBridge["worktrees"] = {
    async branches(projectDir): Promise<BranchList> {
      const valid = validate(ProjectRefSchema, { projectDir }, "project");
      if (nonGitRoots.some((root) => isInside(valid.projectDir, root))) {
        return { isRepo: false, current: null, branches: [] };
      }
      const made = [...worktrees.values()].map((tree) => tree.branch);
      return { isRepo: true, current: "main", branches: ["main", "release/0.4", ...made] };
    },
    async create(input) {
      const valid = validate(CreateWorktreeInputSchema, input, "worktree");
      const project = trimSlash(valid.projectDir);
      if (nonGitRoots.some((root) => isInside(project, root))) {
        throw new Error("This folder is not in a git repository, so it cannot have worktrees.");
      }
      const path = `${project}/.dawg/worktrees/${valid.name}`;
      if (worktrees.has(path) || seeded.has(path)) {
        throw new Error(`A worktree named ${valid.name} already exists.`);
      }
      const info = {
        path,
        branch: `dawg/${valid.name}`,
        base: valid.base,
        baseCommit: FAKE_BASE_COMMIT,
      };
      worktrees.set(path, { ...info, untouched: true });
      seedRepo(path, true);
      return info;
    },
    async cleanup(worktreePath): Promise<WorktreeCleanup> {
      const path = trimSlash(worktreePath);
      const repo = repos.get(path);
      if (repo && listChanges(repo).length > 0) {
        return { removed: false, reason: "It has changes that are not committed." };
      }
      worktrees.delete(path);
      repos.delete(path);
      seeded.delete(path);
      for (const file of [...disk.keys()]) if (isInside(file, path)) disk.delete(file);
      return { removed: true, reason: null };
    },
  };

  return {
    workspace,
    worktrees: worktreesApi,
    writeExternally(path, text, options) {
      if (options?.notify === false) {
        if (text === null) disk.delete(path);
        else disk.set(path, { kind: "text", text, mtimeMs: tick() });
        return;
      }
      write(path, text);
    },
    read(path) {
      const file = disk.get(path);
      return file?.kind === "text" ? file.text : null;
    },
  };
}
