/**
 * The file index behind `@` mentions: every file and folder under a session's working directory,
 * matched fuzzily (`shared/fuzzy.ts`).
 *
 * Listing, in order of preference:
 * 1. git, in a working tree (worktrees included): tracked files plus untracked ones that are not
 *    ignored, without files deleted from the working tree. Submodules count as folders.
 * 2. ripgrep (`rg --files`), which honours `.gitignore` and `.ignore` files outside git too.
 * 3. A bounded walk that skips heavy folders (dependencies, caches, version control).
 * Folders come from the files' paths. The index holds at most about 100,000 entries; past that,
 * shallower paths are kept and answers say the index is truncated.
 *
 * One index per working directory, built on the first query and shared by the sessions there.
 * The workspace watcher's reports mark it stale only when the set of paths may have changed (a
 * file appeared or went, an ignore file changed, or the watcher could not say what changed); an
 * edit to a file the index already has does not. A stale index still answers at once if the
 * rebuild takes long, so typing never waits on a big repository.
 */
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FileMatch, FindFilesResult } from "../../shared/bridge.ts";
import { FuzzyIndex, type FuzzyTarget, normalizeQuery, prepareTarget } from "../../shared/fuzzy.ts";
import { gitEnv, runGit, splitNul } from "./git.ts";
import { isNoise } from "./watcher.ts";

/** The most entries (files and folders) an index holds. */
export const MAX_INDEX_ENTRIES = 100_000;

/** How long a query waits for a stale index's rebuild before answering from the stale one. */
const STALE_WAIT_MS = 150;

/** How many recently changed files lead the list for an empty query. */
const MAX_RECENT = 10;

/** Files whose modification time is read to find recent ones outside git (shallowest first). */
const MAX_MTIME_PROBES = 2000;

/** The walk gives up after this long and says the index is truncated. */
const WALK_BUDGET_MS = 5000;

/** Folders the walk (and ripgrep) never enter: dependencies, caches, version control. */
export const HEAVY_FOLDERS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  ".terraform",
  "Pods",
  "DerivedData",
  ".DS_Store",
]);

/** Changing one of these can change which files are listed. */
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".rgignore", ".gitmodules"]);

export type IndexSource = "git" | "ripgrep" | "walk";

export interface IndexEntry extends FuzzyTarget {
  kind: "file" | "directory";
}

export interface BuiltIndex {
  /** The working directory, resolved. */
  dir: string;
  source: IndexSource;
  entries: IndexEntry[];
  /** Relative paths of the entries (folders end with "/"). */
  paths: Set<string>;
  truncated: boolean;
  /** The working directory's path inside its repository ("" at the top, "src/" below). */
  gitPrefix: string | null;
  /** The top level's entries: folders first, then files, by name. */
  topLevel: IndexEntry[];
  /** Searches `entries`, narrowing as a query is typed. */
  fuzzy: FuzzyIndex<IndexEntry>;
}

/** A file the listing found, and whether it is a folder (a submodule). */
interface Listed {
  relative: string;
  directory: boolean;
}

interface Listing {
  files: Listed[];
  /** The source stopped before listing everything. */
  stopped: boolean;
}

export interface FileIndexOptions {
  log: (message: string) => void;
  /** The bundled ripgrep; without it, `DAWG_RG_PATH` and then `rg` on PATH are tried. */
  ripgrepPath?: string | null;
  maxEntries?: number;
  /** Which sources to try, in order (tests). Default: git, ripgrep, walk. */
  sources?: readonly IndexSource[];
  /** How long a query waits for a stale index's rebuild (default 150 ms). */
  staleWaitMs?: number;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSlashes(relative: string): string {
  return path.sep === "/" ? relative : relative.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

class SpawnFailed extends Error {}

/**
 * Runs a program and hands each NUL-terminated field of its output to `onField`, which returns
 * false to stop early (the program is then killed). Resolves with whether it stopped early.
 */
function streamFields(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; okCodes: readonly number[] },
  onField: (field: string) => boolean,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let stopped = false;
    let settled = false;
    let pending = "";
    let stderr = "";
    const decoder = new TextDecoder();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      stopped = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stopped);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new SpawnFailed(`${command} did not run: ${error.code ?? error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      pending += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (;;) {
        const nul = pending.indexOf("\0", start);
        if (nul === -1) break;
        const field = pending.slice(start, nul);
        start = nul + 1;
        if (!onField(field)) {
          stopped = true;
          child.kill("SIGKILL");
          break;
        }
      }
      pending = pending.slice(start);
    });
    child.on("close", (code) => {
      if (stopped) return finish(null);
      if (code !== null && !options.okCodes.includes(code)) {
        const why = stderr.trim().split("\n")[0] ?? "";
        return finish(new Error(`${command} exited with ${code}${why ? `: ${why}` : ""}`));
      }
      finish(null);
    });
  });
}

/** "" at the top of a working tree, "src/" below it; null outside git. */
async function gitPrefixOf(dir: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runGit(
      ["rev-parse", "--is-inside-work-tree", "--show-prefix"],
      {
        cwd: dir,
        okCodes: [0, 128],
      },
    );
    if (exitCode !== 0) return null;
    const [inside, prefix = ""] = stdout.toString("utf8").split("\n");
    return inside === "true" ? prefix : null;
  } catch {
    return null;
  }
}

async function listWithGit(dir: string, hardLimit: number): Promise<Listing> {
  const options = { cwd: dir, env: gitEnv(), timeoutMs: 30_000, okCodes: [0] };
  // Deleted files are still in the index; leave them out.
  const deletedRun = runGit(["ls-files", "-z", "--deleted"], { cwd: dir })
    .then(({ stdout }) => new Set(splitNul(stdout)))
    .catch(() => new Set<string>());

  const seen = new Set<string>();
  const files: Listed[] = [];
  let count = 0;
  // Tracked files with their modes: 160000 is a submodule, listed as a folder.
  const cachedStopped = await streamFields(
    "git",
    ["ls-files", "-z", "--cached", "--stage"],
    options,
    (field) => {
      const tab = field.indexOf("\t");
      if (tab === -1) return true;
      const relative = field.slice(tab + 1);
      if (seen.has(relative)) return true; // a conflicted file has up to three stages
      seen.add(relative);
      files.push({ relative, directory: field.startsWith("160000 ") });
      return ++count < hardLimit;
    },
  );
  let othersStopped = false;
  if (!cachedStopped) {
    othersStopped = await streamFields(
      "git",
      ["ls-files", "-z", "--others", "--exclude-standard"],
      options,
      (relative) => {
        // Other sessions' worktrees live in `.dawg/worktrees`, normally ignored; never list them.
        if (relative === "" || isNoise(relative)) return true;
        files.push({ relative, directory: false });
        return ++count < hardLimit;
      },
    );
  }
  const deleted = await deletedRun;
  return {
    files: deleted.size === 0 ? files : files.filter((file) => !deleted.has(file.relative)),
    stopped: cachedStopped || othersStopped,
  };
}

function ripgrepCandidates(explicit: string | null | undefined): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const fromEnv = process.env.DAWG_RG_PATH;
  if (fromEnv) candidates.push(fromEnv);
  candidates.push("rg");
  return [...new Set(candidates)];
}

async function listWithRipgrep(
  dir: string,
  hardLimit: number,
  ripgrepPath: string | null | undefined,
): Promise<Listing> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A personal ripgrep config could change what is listed or how.
  delete env.RIPGREP_CONFIG_PATH;
  const args = [
    "--files",
    "--null",
    "--hidden",
    "--no-require-git",
    "--no-messages",
    "--no-follow",
    ...[...HEAVY_FOLDERS].map((name) => `--glob=!${name}`),
  ];
  let lastError: unknown = null;
  for (const command of ripgrepCandidates(ripgrepPath)) {
    const files: Listed[] = [];
    try {
      const stopped = await streamFields(
        command,
        args,
        // rg exits 1 when it lists nothing, and 2 after errors it skipped (unreadable folders).
        { cwd: dir, env, timeoutMs: 30_000, okCodes: [0, 1, 2] },
        (field) => {
          const relative = toSlashes(field.replace(/^\.\//, ""));
          if (relative === "" || isNoise(relative)) return true;
          files.push({ relative, directory: false });
          return files.length < hardLimit;
        },
      );
      return { files, stopped };
    } catch (error) {
      lastError = error;
      if (!(error instanceof SpawnFailed)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ripgrep is not available");
}

async function listByWalking(dir: string, hardLimit: number, now: () => number): Promise<Listing> {
  const files: Listed[] = [];
  const started = now();
  // Breadth first, so a cut-off keeps the shallow files.
  const queue: string[] = [""];
  let stopped = false;
  while (queue.length > 0) {
    if (files.length >= hardLimit || now() - started > WALK_BUDGET_MS) {
      stopped = true;
      break;
    }
    const relativeDir = queue.shift() ?? "";
    let dirents: Dirent[];
    try {
      dirents = await readdir(path.join(dir, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of dirents) {
      if (HEAVY_FOLDERS.has(entry.name)) continue;
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      // Links are not followed: they could lead outside the session's folders.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".dawg") continue;
        queue.push(relative);
      } else if (entry.isFile()) {
        files.push({ relative, directory: false });
      }
    }
  }
  return { files, stopped };
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

function depthOf(relative: string): number {
  let depth = 0;
  const end = relative.endsWith("/") ? relative.length - 1 : relative.length;
  for (let i = 0; i < end; i++) if (relative.charCodeAt(i) === 0x2f) depth++;
  return depth;
}

/**
 * Entries for listed files and the folders they imply, at most `max`. When there are more, the
 * shallowest files are kept (with their folders), as those are the ones people mention most.
 */
export function entriesFor(
  listed: readonly Listed[],
  max: number,
): { entries: IndexEntry[]; paths: Set<string>; truncated: boolean } {
  const paths = new Set<string>();
  const entries: IndexEntry[] = [];
  const add = (relative: string, kind: IndexEntry["kind"]) => {
    if (paths.has(relative)) return;
    paths.add(relative);
    entries.push({ ...prepareTarget(relative), kind });
  };
  /** How many of a path's folders are not entries yet. */
  const missingFolders = (relative: string) => {
    let missing = 0;
    let slash = relative.indexOf("/");
    while (slash !== -1 && slash < relative.length - 1) {
      if (!paths.has(relative.slice(0, slash + 1))) missing++;
      slash = relative.indexOf("/", slash + 1);
    }
    return missing;
  };
  const addFolders = (relative: string) => {
    let slash = relative.indexOf("/");
    while (slash !== -1 && slash < relative.length - 1) {
      add(relative.slice(0, slash + 1), "directory");
      slash = relative.indexOf("/", slash + 1);
    }
  };

  // Folders implied by everything listed, to know whether it all fits.
  const folders = new Set<string>();
  for (const file of listed) {
    let slash = file.relative.indexOf("/");
    while (slash !== -1) {
      folders.add(file.relative.slice(0, slash + 1));
      slash = file.relative.indexOf("/", slash + 1);
    }
  }
  const fits = listed.length + folders.size <= max;

  let ordered = listed;
  if (!fits) {
    // Bucket by depth: shallow first, keeping each bucket's order.
    const buckets: Listed[][] = [];
    for (const file of listed) {
      const depth = depthOf(file.relative);
      const bucket = buckets[depth];
      if (bucket) bucket.push(file);
      else buckets[depth] = [file];
    }
    ordered = buckets.flatMap((bucket) => bucket ?? []);
  }

  for (const file of ordered) {
    const relative = file.directory ? `${file.relative.replace(/\/$/, "")}/` : file.relative;
    if (!fits && entries.length + missingFolders(relative) + 1 > max) break;
    addFolders(relative);
    add(relative, file.directory ? "directory" : "file");
  }
  return { entries, paths, truncated: !fits };
}

export async function buildIndex(dir: string, options: FileIndexOptions): Promise<BuiltIndex> {
  const max = options.maxEntries ?? MAX_INDEX_ENTRIES;
  const now = options.now ?? Date.now;
  // List a little more than fits, so the shallowest can be chosen when there are too many.
  const hardLimit = max * 2;
  const sources = options.sources ?? ["git", "ripgrep", "walk"];
  const gitPrefix = sources.includes("git") ? await gitPrefixOf(dir) : null;
  for (const source of sources) {
    let listing: Listing;
    try {
      if (source === "git") {
        if (gitPrefix === null) continue;
        listing = await listWithGit(dir, hardLimit);
        // Inside an ignored folder git lists nothing: let the next source look.
        if (listing.files.length === 0) continue;
      } else if (source === "ripgrep") {
        listing = await listWithRipgrep(dir, hardLimit, options.ripgrepPath);
      } else {
        listing = await listByWalking(dir, hardLimit, now);
      }
    } catch (error) {
      options.log(`Listing ${dir} with ${source} failed: ${messageOf(error)}`);
      continue;
    }
    const built = entriesFor(listing.files, max);
    return {
      dir,
      source,
      entries: built.entries,
      paths: built.paths,
      truncated: built.truncated || listing.stopped,
      gitPrefix: source === "git" ? gitPrefix : null,
      topLevel: topLevelOf(built.entries),
      fuzzy: new FuzzyIndex(built.entries),
    };
  }
  return {
    dir,
    source: "walk",
    entries: [],
    paths: new Set(),
    truncated: false,
    gitPrefix: null,
    topLevel: [],
    fuzzy: new FuzzyIndex([]),
  };
}

function topLevelOf(entries: readonly IndexEntry[]): IndexEntry[] {
  return entries
    .filter((entry) => entry.depth === 0)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.text.localeCompare(b.text, undefined, { numeric: true, sensitivity: "base" });
    });
}

// ---------------------------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------------------------

/** A working directory as the renderer names it and resolved (see `paths.ts`). */
export interface IndexRoot {
  logical: string;
  real: string;
}

interface CacheEntry {
  index: BuiltIndex | null;
  building: Promise<BuiltIndex> | null;
  stale: boolean;
  /** Bumped by every invalidation; a build started before one is stale when it lands. */
  generation: number;
  /** Files the watcher saw change, newest last: relative path → when. */
  recent: Map<string, number>;
  /** The recently changed files for an empty query (git status, or modification times). */
  changed: Promise<string[]> | null;
}

export interface FileIndexCache {
  /** Files and folders under `root` matching `query`, best first. */
  find(root: IndexRoot, query: string, limit: number): Promise<FindFilesResult>;
  /**
   * The watcher saw these files change (absolute, as the renderer names them; empty when it
   * could not say which). Marks the index stale when its list of paths may be out of date.
   */
  changed(root: IndexRoot, paths: readonly string[]): Promise<void>;
  /** No tracked session works in this directory any more. */
  release(realDir: string): void;
  /** The index for a directory, if built (tests). */
  peek(realDir: string): BuiltIndex | null;
  dispose(): void;
}

/** `promise`'s value, or "timeout" if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function statOrNull(file: string) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

export function createFileIndexCache(options: FileIndexOptions): FileIndexCache {
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  let disposed = false;

  function entryFor(realDir: string): CacheEntry {
    let entry = entries.get(realDir);
    if (!entry) {
      entry = {
        index: null,
        building: null,
        stale: true,
        generation: 0,
        recent: new Map(),
        changed: null,
      };
      entries.set(realDir, entry);
    }
    return entry;
  }

  function rebuild(realDir: string, entry: CacheEntry): Promise<BuiltIndex> {
    if (entry.building) return entry.building;
    const generation = entry.generation;
    const building = buildIndex(realDir, options).then(
      (index) => {
        if (entries.get(realDir) === entry && !disposed) {
          entry.index = index;
          entry.changed = null;
          // A change that arrived while listing may not be in it: build again next time.
          if (entry.generation === generation) entry.stale = false;
        }
        if (entry.building === building) entry.building = null;
        return index;
      },
      (error: unknown) => {
        if (entry.building === building) entry.building = null;
        throw error;
      },
    );
    entry.building = building;
    return building;
  }

  async function current(realDir: string): Promise<BuiltIndex> {
    const entry = entryFor(realDir);
    if (entry.index && !entry.stale) return entry.index;
    const building = rebuild(realDir, entry);
    if (!entry.index) return building;
    const stale = entry.index;
    const first = await within(
      building.catch(() => stale),
      options.staleWaitMs ?? STALE_WAIT_MS,
    );
    return first === "timeout" ? stale : first;
  }

  /** Changed files for the starting list: git's view of the working tree, newest first. */
  async function changedFiles(index: BuiltIndex): Promise<string[]> {
    let candidates: string[];
    if (index.gitPrefix !== null) {
      try {
        const { stdout } = await runGit(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
          { cwd: index.dir, timeoutMs: 10_000 },
        );
        const prefix = index.gitPrefix;
        candidates = [];
        for (const field of splitNul(stdout)) {
          // "XY path": the path is relative to the repository's top level.
          const repoPath = field.slice(3);
          if (field.length < 4 || !repoPath.startsWith(prefix)) continue;
          const relative = repoPath.slice(prefix.length);
          if (index.paths.has(relative)) candidates.push(relative);
        }
      } catch (error) {
        options.log(`git status in ${index.dir} failed: ${messageOf(error)}`);
        candidates = [];
      }
    } else {
      // Outside git: the most recently modified of the shallowest files.
      candidates = index.entries
        .filter((entry) => entry.kind === "file")
        .sort((a, b) => a.depth - b.depth)
        .slice(0, MAX_MTIME_PROBES)
        .map((entry) => entry.text);
    }
    const timed = await Promise.all(
      candidates.slice(0, MAX_MTIME_PROBES).map(async (relative) => {
        const stats = await statOrNull(path.join(index.dir, relative));
        return { relative, mtime: stats?.isFile() ? stats.mtimeMs : -1 };
      }),
    );
    return timed
      .filter((file) => file.mtime >= 0)
      .sort((a, b) => b.mtime - a.mtime || (a.relative < b.relative ? -1 : 1))
      .map((file) => file.relative);
  }

  function toMatch(root: IndexRoot, relative: string, highlights: number[]): FileMatch {
    const directory = relative.endsWith("/");
    const trimmed = directory ? relative.slice(0, -1) : relative;
    return {
      path: path.join(root.logical, ...trimmed.split("/")),
      relativePath: relative,
      kind: directory ? "directory" : "file",
      highlights,
    };
  }

  /** The list for an empty query: recently changed files, then the top level. */
  async function startingList(
    root: IndexRoot,
    index: BuiltIndex,
    entry: CacheEntry,
    limit: number,
  ): Promise<FileMatch[]> {
    entry.changed ??= changedFiles(index);
    const changed = await entry.changed;
    const chosen: string[] = [];
    const taken = new Set<string>();
    const take = (relative: string) => {
      if (!index.paths.has(relative) || taken.has(relative)) return;
      taken.add(relative);
      chosen.push(relative);
    };
    // What the watcher saw change while the app ran is the freshest, newest first.
    const watched = [...entry.recent.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
    for (const relative of [...watched, ...changed]) {
      if (chosen.length >= Math.min(MAX_RECENT, limit)) break;
      take(relative);
    }
    for (const item of index.topLevel) {
      if (chosen.length >= limit) break;
      take(item.text);
    }
    return chosen.map((relative) => toMatch(root, relative, []));
  }

  /** Whether the reported changes could have added or removed paths. */
  async function listingMayHaveChanged(
    entry: CacheEntry,
    index: BuiltIndex,
    relatives: readonly string[],
  ): Promise<boolean> {
    const checks = await Promise.all(
      relatives.map(async (relative) => {
        const base = relative.slice(relative.lastIndexOf("/") + 1);
        if (IGNORE_FILES.has(base)) return true;
        const stats = await statOrNull(path.join(index.dir, relative));
        if (stats?.isFile()) {
          entry.recent.set(relative, now());
          return !index.paths.has(relative);
        }
        if (stats?.isDirectory()) return !index.paths.has(`${relative}/`);
        // Gone: it matters only if the index listed it.
        entry.recent.delete(relative);
        return index.paths.has(relative) || index.paths.has(`${relative}/`);
      }),
    );
    return checks.some(Boolean);
  }

  function invalidate(entry: CacheEntry): void {
    entry.stale = true;
    entry.generation++;
    entry.changed = null;
  }

  return {
    async find(root, query, limit) {
      if (disposed) throw new Error("The file index has stopped.");
      const index = await current(root.real);
      const entry = entryFor(root.real);
      if (normalizeQuery(query) === "") {
        return {
          matches: await startingList(root, index, entry, limit),
          truncated: index.truncated,
        };
      }
      const matches = index.fuzzy
        .search(query, limit)
        .map((match) => toMatch(root, match.target.text, match.positions));
      return { matches, truncated: index.truncated };
    },

    async changed(root, paths) {
      const entry = entries.get(root.real);
      if (!entry) return;
      // The recent list is refreshed whatever happens to the listing.
      entry.changed = null;
      const index = entry.index;
      if (!index || paths.length === 0) {
        invalidate(entry);
        return;
      }
      const relatives: string[] = [];
      for (const changed of paths) {
        const relative = path.relative(root.logical, changed);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        relatives.push(toSlashes(relative));
      }
      if (relatives.length === 0) return;
      const generation = entry.generation;
      try {
        const changed = await listingMayHaveChanged(entry, index, relatives);
        if (changed && entry.generation === generation) invalidate(entry);
      } catch {
        invalidate(entry);
      }
    },

    release(realDir) {
      entries.delete(realDir);
    },

    peek(realDir) {
      return entries.get(realDir)?.index ?? null;
    },

    dispose() {
      disposed = true;
      entries.clear();
    },
  };
}
