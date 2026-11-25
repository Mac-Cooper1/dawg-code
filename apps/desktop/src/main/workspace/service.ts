/**
 * The workspace service behind the Changes and Files panes (`workspace` in the bridge).
 *
 * A window tracks each session it shows. Main then answers for that session only, and only for
 * paths inside the session's folders (its working directory and additional directories), after
 * resolving symlinks. Git runs through `execFile` with literal pathspecs. Base commits are kept in
 * `<data root>/workspace.json` (see `store.ts`).
 */
import { lstat, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { z } from "zod";
import type {
  ChangedFile,
  ChangeSet,
  DirEntry,
  FileContent,
  FileDiff,
  FileRef,
  RevertInput,
  TrackSessionInputSchema,
  Unsubscribe,
  WorkspaceChangedEvent,
  WorkspaceInfo,
  WorktreeInfo,
  WriteFileInput,
} from "../../shared/bridge.ts";
import {
  countFileLines,
  joinRelative,
  mapLimited,
  type RelativeChange,
  trackedChanges,
  untrackedFiles,
} from "./changes.ts";
import {
  currentBranch,
  describeBaseObject,
  emptyTree,
  objectType,
  readBlob,
  resolveCommit,
  runGit,
  splitNul,
  topLevelOf,
} from "./git.ts";
import { isInside, type Root, realPathOf, resolveInside, toLogical } from "./paths.ts";
import type { WorkspaceStore } from "./store.ts";
import { decodeText, MAX_TEXT_BYTES, parseUnifiedDiff, revertHunk, splitText } from "./text.ts";
import {
  createBatcher,
  isNoise,
  type Watcher,
  type WatchFactory,
  watchRecursive,
} from "./watcher.ts";

/** `track`'s input after validation (additional directories filled in). */
export type ParsedTrackInput = z.output<typeof TrackSessionInputSchema>;

/** The Changes pane lists at most this many files. */
export const MAX_CHANGED_FILES = 2000;

export interface WorkspaceServiceOptions {
  store: WorkspaceStore;
  log: (message: string) => void;
  watch?: WatchFactory;
  /** Quiet time before changed files are reported (about 250 ms). */
  debounceMs?: number;
  /** Longest a report waits while changes keep coming. */
  maxWaitMs?: number;
}

export interface WorkspaceService {
  /** Registers (or updates) a session for a window; `owner` names the window. */
  track(input: ParsedTrackInput, owner: string): Promise<WorkspaceInfo>;
  untrack(sessionId: string, owner: string): Promise<void>;
  /** A window closed: untracks everything it tracked. */
  releaseOwner(owner: string): void;
  changes(sessionId: string): Promise<ChangeSet>;
  fileDiff(ref: FileRef): Promise<FileDiff>;
  revert(input: RevertInput): Promise<void>;
  listDirectory(ref: FileRef): Promise<DirEntry[]>;
  readFile(ref: FileRef): Promise<FileContent>;
  writeFile(input: WriteFileInput): Promise<{ mtimeMs: number }>;
  onChanged(listener: (event: WorkspaceChangedEvent) => void): Unsubscribe;
  /** A folder inside a tracked session's folders, for a terminal to start in. */
  resolveDirectory(sessionId: string, dir: string): Promise<{ real: string; logical: string }>;
  /** Stops every watcher (the app is quitting). */
  dispose(): void;
}

interface GitState {
  root: Root;
  baseCommit: string;
  baseLabel: string;
  worktree: WorktreeInfo | null;
}

interface Session {
  id: string;
  cwd: string;
  roots: Root[];
  git: GitState | null;
  owners: Set<string>;
  watchers: Watcher[];
  batch: ReturnType<typeof createBatcher>;
}

const MB = 1024 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatOrNull(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

/** A path relative to the repository's top level, with "/" separators; null when outside it. */
function repoRelative(git: GitState, real: string): string | null {
  if (!isInside(real, git.root.real) || real === git.root.real) return null;
  return path.relative(git.root.real, real).split(path.sep).join("/");
}

export function createWorkspaceService(options: WorkspaceServiceOptions): WorkspaceService {
  const { store, log } = options;
  const watchFactory = options.watch ?? watchRecursive;
  const debounceMs = options.debounceMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 1000;
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: WorkspaceChangedEvent) => void>();
  /** Tracks of one session run one after another. */
  const trackQueue = new Map<string, Promise<unknown>>();

  function emit(event: WorkspaceChangedEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log(`A workspace listener failed: ${messageOf(error)}`);
      }
    }
  }

  function need(sessionId: string): Session {
    const session = sessions.get(sessionId);
    if (!session)
      throw new Error(`Session ${sessionId} is not tracked. Call workspace.track first.`);
    return session;
  }

  function needGit(session: Session): GitState {
    if (!session.git) {
      throw new Error(
        "This session is not in a git repository, so there is no base to compare with.",
      );
    }
    return session.git;
  }

  function stopWatching(session: Session): void {
    for (const watcher of session.watchers) watcher.close();
    session.watchers = [];
    session.batch.cancel();
  }

  function startWatching(session: Session): void {
    for (const root of session.roots) {
      try {
        const watcher = watchFactory(
          root.real,
          (relative) => {
            if (relative !== null && isNoise(relative)) return;
            session.batch.add(relative === null ? null : path.join(root.logical, relative));
          },
          (error) => {
            log(`Stopped watching ${root.real}: ${error.message}`);
            watcher.close();
          },
        );
        session.watchers.push(watcher);
      } catch (error) {
        log(`Could not watch ${root.real}: ${messageOf(error)}`);
      }
    }
  }

  async function gitStateFor(sessionId: string, realCwd: string, roots: Root[]) {
    const top = await topLevelOf(realCwd);
    if (top === null) return null;
    const realTop = await realPathOf(top);
    const root: Root = { real: realTop, logical: toLogical(roots, realTop) };

    const worktreeRecord = await store.worktree(realCwd);
    if (worktreeRecord && (await resolveCommit(realTop, worktreeRecord.baseCommit)) !== null) {
      const { path: wtPath, branch, base, baseCommit } = worktreeRecord;
      return {
        root,
        baseCommit,
        baseLabel: base,
        worktree: { path: wtPath, branch, base, baseCommit },
      } satisfies GitState;
    }

    // Recorded the first time; a repository with no commits yet compares with the empty tree.
    const recorded = await store.session(sessionId);
    let baseCommit: string | null = null;
    let baseType: string | null = null;
    if (recorded && recorded.root === realTop) {
      baseType = await objectType(realTop, recorded.baseCommit);
      if (baseType === "commit" || baseType === "tree") baseCommit = recorded.baseCommit;
      else log(`Session ${sessionId}'s base ${recorded.baseCommit} is gone; using HEAD.`);
    }
    if (baseCommit === null) {
      const head = await resolveCommit(realTop, "HEAD");
      baseCommit = head ?? (await emptyTree(realTop));
      baseType = head === null ? "tree" : "commit";
      await store.setSession(sessionId, { root: realTop, baseCommit, recordedAt: Date.now() });
    }
    const short = baseType === "tree" ? "no commits yet" : baseCommit.slice(0, 7);
    return {
      root,
      baseCommit,
      baseLabel: `where the session started (${short})`,
      worktree: null,
    } satisfies GitState;
  }

  async function doTrack(input: ParsedTrackInput, owner: string): Promise<WorkspaceInfo> {
    let realCwd: string;
    try {
      realCwd = await realPathOf(input.cwd);
      if (!(await stat(realCwd)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new Error(`The session's folder ${input.cwd} does not exist.`);
    }
    const roots: Root[] = [{ logical: path.resolve(input.cwd), real: realCwd }];
    for (const dir of input.additionalDirectories) {
      try {
        const real = await realPathOf(dir);
        if ((await stat(real)).isDirectory()) roots.push({ logical: path.resolve(dir), real });
      } catch {
        log(`Session ${input.sessionId}: skipping the missing folder ${dir}.`);
      }
    }
    const git = await gitStateFor(input.sessionId, realCwd, roots);

    const existing = sessions.get(input.sessionId);
    const owners = existing?.owners ?? new Set<string>();
    owners.add(owner);
    if (existing) stopWatching(existing);
    const session: Session = {
      id: input.sessionId,
      cwd: roots[0]?.logical ?? input.cwd,
      roots,
      git,
      owners,
      watchers: [],
      batch: createBatcher(
        (paths) => {
          if (sessions.get(input.sessionId) === session)
            emit({ sessionId: input.sessionId, paths });
        },
        debounceMs,
        maxWaitMs,
      ),
    };
    sessions.set(input.sessionId, session);
    startWatching(session);

    return {
      sessionId: session.id,
      cwd: session.cwd,
      git: git && {
        root: git.root.logical,
        branch: await currentBranch(realCwd),
        baseCommit: git.baseCommit,
        baseLabel: git.baseLabel,
        worktree: git.worktree,
      },
    };
  }

  function forget(session: Session): void {
    stopWatching(session);
    if (sessions.get(session.id) === session) sessions.delete(session.id);
  }

  async function resolve(session: Session, input: string) {
    return resolveInside(session.roots, input);
  }

  /** The base version's bytes, or why there are none. */
  async function baseContent(git: GitState, relative: string) {
    const object = await describeBaseObject(git.root.real, git.baseCommit, relative);
    if (object.kind !== "blob") return { kind: object.kind } as const;
    if (object.size > MAX_TEXT_BYTES) return { kind: "tooLarge" } as const;
    return { kind: "bytes", bytes: await readBlob(git.root.real, object.hash) } as const;
  }

  /** The working-tree version's bytes, as git sees them (a link is its target). */
  async function workingContent(real: string) {
    const stats = await lstatOrNull(real);
    if (stats === null) return { kind: "missing" } as const;
    if (stats.isSymbolicLink()) {
      return { kind: "bytes", bytes: Buffer.from(await readlink(real), "utf8") } as const;
    }
    if (stats.isDirectory()) return { kind: "other" } as const;
    if (stats.size > MAX_TEXT_BYTES) return { kind: "tooLarge" } as const;
    return { kind: "bytes", bytes: await readFile(real) } as const;
  }

  /** Hunks between two texts, from `git diff --no-index` on temporary copies. */
  async function diffTexts(original: string, modified: string) {
    if (original === modified) return [];
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-diff-"));
    try {
      await Promise.all([
        writeFile(path.join(dir, "a"), original),
        writeFile(path.join(dir, "b"), modified),
      ]);
      const { stdout } = await runGit(
        [
          "-c",
          "diff.suppressBlankEmpty=false",
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--inter-hunk-context=0",
          "-U3",
          "--",
          "a",
          "b",
        ],
        { cwd: dir, okCodes: [0, 1] },
      );
      return parseUnifiedDiff(stdout.toString("utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function revertWholeFile(git: GitState, real: string, relative: string): Promise<void> {
    const tracked = await trackedChanges(git.root.real, git.baseCommit);
    const rename = tracked.find(
      (change) => change.path === relative && change.status === "renamed",
    );
    // The index too, so git agrees the file is back (a new file leaves the index as well).
    const restore = async (target: string) => {
      await runGit(
        [
          "--literal-pathspecs",
          "restore",
          `--source=${git.baseCommit}`,
          "--staged",
          "--worktree",
          "--",
          target,
        ],
        { cwd: git.root.real },
      );
    };
    const inBase =
      (await describeBaseObject(git.root.real, git.baseCommit, relative)).kind !== "missing";
    const inIndex =
      (
        await runGit(["--literal-pathspecs", "ls-files", "-z", "--", relative], {
          cwd: git.root.real,
        })
      ).stdout.length > 0;
    if (inBase || inIndex) await restore(relative);
    if (!inBase) await rm(real, { force: true });
    if (rename?.oldPath) await restore(rename.oldPath);
  }

  async function revertOneHunk(
    git: GitState,
    real: string,
    relative: string,
    hunk: NonNullable<RevertInput["hunk"]>,
  ): Promise<void> {
    const working = await workingContent(real);
    const current = working.kind === "bytes" ? decodeText(working.bytes) : null;
    if (current === null) {
      throw new Error("This change no longer matches the file. Refresh the diff and try again.");
    }
    const base = await baseContent(git, relative);
    const baseText = base.kind === "bytes" ? decodeText(base.bytes) : null;
    const baseFinalNewline = baseText === null ? null : splitText(baseText).finalNewline;
    await writeFile(real, revertHunk(current, hunk, baseFinalNewline), "utf8");
  }

  function toChangedFile(session: Session, git: GitState, change: RelativeChange): ChangedFile {
    const logical = (relative: string) =>
      toLogical(session.roots, joinRelative(git.root.real, relative));
    return {
      path: logical(change.path),
      oldPath: change.oldPath === null ? null : logical(change.oldPath),
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      binary: change.binary,
    };
  }

  return {
    track(input, owner) {
      const previous = trackQueue.get(input.sessionId) ?? Promise.resolve();
      const run = previous.catch(() => {}).then(() => doTrack(input, owner));
      const settled = run.catch(() => {});
      trackQueue.set(input.sessionId, settled);
      void settled.then(() => {
        if (trackQueue.get(input.sessionId) === settled) trackQueue.delete(input.sessionId);
      });
      return run;
    },

    async untrack(sessionId, owner) {
      await trackQueue.get(sessionId);
      const session = sessions.get(sessionId);
      if (!session) return;
      session.owners.delete(owner);
      if (session.owners.size === 0) forget(session);
    },

    releaseOwner(owner) {
      for (const session of [...sessions.values()]) {
        session.owners.delete(owner);
        if (session.owners.size === 0) forget(session);
      }
    },

    async changes(sessionId) {
      const session = need(sessionId);
      const git = session.git;
      if (!git) return { baseCommit: null, files: [], truncated: false };
      const [tracked, untracked] = await Promise.all([
        trackedChanges(git.root.real, git.baseCommit),
        untrackedFiles(git.root.real),
      ]);
      const inside = (relative: string) =>
        session.roots.some((root) => isInside(joinRelative(git.root.real, relative), root.real));

      const byPath = new Map<string, RelativeChange>();
      for (const change of tracked) {
        if (inside(change.path) || (change.oldPath !== null && inside(change.oldPath))) {
          byPath.set(change.path, change);
        }
      }
      const ordered: { key: string; change: RelativeChange; count: boolean }[] = [];
      for (const relative of untracked) {
        if (!inside(relative)) continue;
        const shadowed = byPath.get(relative);
        if (shadowed?.status === "deleted") {
          // In the base, out of the index, still on disk: rewritten rather than new.
          shadowed.status = "modified";
          byPath.delete(relative);
          ordered.push({ key: relative, change: shadowed, count: true });
        } else {
          const change: RelativeChange = {
            path: relative,
            oldPath: null,
            status: "untracked",
            additions: 0,
            deletions: 0,
            binary: false,
          };
          ordered.push({ key: relative, change, count: true });
        }
      }
      for (const change of byPath.values())
        ordered.push({ key: change.path, change, count: false });
      ordered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const kept = ordered.slice(0, MAX_CHANGED_FILES);

      const files = await mapLimited(kept, 16, async ({ key, change, count }) => {
        if (count) {
          const counted = await countFileLines(joinRelative(git.root.real, key));
          change.additions = counted.additions;
          change.binary = counted.binary;
        }
        return toChangedFile(session, git, change);
      });
      return {
        baseCommit: git.baseCommit,
        files,
        truncated: ordered.length > MAX_CHANGED_FILES,
      };
    },

    async fileDiff(ref) {
      const session = need(ref.sessionId);
      const git = needGit(session);
      const { real, logical } = await resolve(session, ref.path);
      const relative = repoRelative(git, real);
      if (relative === null) throw new Error(`${ref.path} is not in the session's repository.`);
      const [base, working] = await Promise.all([baseContent(git, relative), workingContent(real)]);
      const empty = { path: logical, original: null, modified: null, hunks: [] };
      if (base.kind === "tooLarge" || working.kind === "tooLarge") {
        return { ...empty, binary: false, tooLarge: true };
      }
      const original = base.kind === "bytes" ? decodeText(base.bytes) : null;
      const modified = working.kind === "bytes" ? decodeText(working.bytes) : null;
      const binary =
        (base.kind === "bytes" && original === null) ||
        (working.kind === "bytes" && modified === null) ||
        base.kind === "other" ||
        working.kind === "other";
      if (binary) return { ...empty, binary: true, tooLarge: false };
      return {
        path: logical,
        original,
        modified,
        binary: false,
        tooLarge: false,
        hunks: await diffTexts(original ?? "", modified ?? ""),
      };
    },

    async revert(input) {
      const session = need(input.sessionId);
      const git = needGit(session);
      const { real } = await resolve(session, input.path);
      const relative = repoRelative(git, real);
      if (relative === null) throw new Error(`${input.path} is not in the session's repository.`);
      if ((await lstatOrNull(real))?.isDirectory()) throw new Error(`${input.path} is a folder.`);
      if (input.hunk) await revertOneHunk(git, real, relative, input.hunk);
      else await revertWholeFile(git, real, relative);
    },

    async listDirectory(ref) {
      const session = need(ref.sessionId);
      const { real, logical } = await resolve(session, ref.path);
      const dirStats = await stat(real).catch(() => null);
      if (!dirStats?.isDirectory()) throw new Error(`${ref.path} is not a folder.`);
      const dirents = await readdir(real, { withFileTypes: true });

      const ignored = new Set<string>([".git"]);
      if (dirents.length > 0) {
        try {
          const { stdout } = await runGit(["check-ignore", "-z", "--stdin"], {
            cwd: real,
            input: dirents.map((entry) => `${entry.name}\0`).join(""),
            okCodes: [0, 1],
          });
          for (const name of splitNul(stdout)) ignored.add(name);
        } catch {
          // Not in a repository (or inside a submodule): nothing is ignored.
        }
      }

      const entries = await mapLimited(dirents, 32, async (entry): Promise<DirEntry> => {
        const kind = entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : "file";
        let size: number | null = null;
        if (kind === "file") size = (await lstatOrNull(path.join(real, entry.name)))?.size ?? null;
        return {
          name: entry.name,
          path: path.join(logical, entry.name),
          kind,
          ignored: ignored.has(entry.name),
          size,
        };
      });
      const rank = (entry: DirEntry) =>
        (entry.ignored ? 2 : 0) + (entry.kind === "directory" ? 0 : 1);
      return entries.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
    },

    async readFile(ref) {
      const session = need(ref.sessionId);
      const { real, logical } = await resolve(session, ref.path);
      const stats = await stat(real).catch(() => null);
      if (stats === null) throw new Error(`${ref.path} does not exist.`);
      if (!stats.isFile()) throw new Error(`${ref.path} is not a file.`);
      const base = { path: logical, size: stats.size, mtimeMs: stats.mtimeMs };
      if (stats.size > MAX_TEXT_BYTES) {
        return { ...base, content: null, binary: false, tooLarge: true };
      }
      const content = decodeText(await readFile(real));
      return { ...base, content, binary: content === null, tooLarge: false };
    },

    async writeFile(input) {
      const session = need(input.sessionId);
      const { real } = await resolve(session, input.path);
      if (Buffer.byteLength(input.content, "utf8") > MAX_TEXT_BYTES) {
        throw new Error(`The file is over ${MAX_TEXT_BYTES / MB} MB, so it was not saved.`);
      }
      const before = await stat(real).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (before?.isDirectory()) throw new Error(`${input.path} is a folder.`);
      if (input.expectedMtimeMs !== undefined) {
        if (before === null) {
          throw new Error("The file was deleted on disk after it was opened, so it was not saved.");
        }
        if (before.mtimeMs !== input.expectedMtimeMs) {
          throw new Error(
            "The file changed on disk after it was opened, so it was not saved. Reload it to see the change.",
          );
        }
      }
      await writeFile(real, input.content, "utf8");
      return { mtimeMs: (await stat(real)).mtimeMs };
    },

    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async resolveDirectory(sessionId, dir) {
      const session = need(sessionId);
      const resolved = await resolve(session, dir);
      const stats = await stat(resolved.real).catch(() => null);
      if (!stats?.isDirectory()) throw new Error(`${dir} is not a folder.`);
      return resolved;
    },

    dispose() {
      for (const session of sessions.values()) stopWatching(session);
      sessions.clear();
      listeners.clear();
    },
  };
}
