/**
 * The per-project listing cache, `sessions/index.json`.
 *
 * It is only a cache. Each entry remembers the size and modification time of the session file it
 * was built from; listing compares those with a `stat` of every file and re-reads only the files
 * that changed (sessions are append-only, so any change alters the size). Entries for deleted
 * files are dropped and new files are added. A missing, unreadable or outdated index is rebuilt
 * from the files. The file is replaced atomically (write a temporary file, then rename).
 *
 * The one thing the files cannot tell us is the live status (working, waiting) of a session open
 * in some process; writers report it here. A status other than "idle" or "error" from a session
 * that no live process holds is shown as "idle". Two processes updating the index at the same
 * moment can lose one update; every field but the status is then repaired on the next listing.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { type SessionStatus, SessionStatusSchema } from "@dawg/protocol";
import { z } from "zod";
import { readSessionFile } from "./file.ts";
import { isLocked } from "./lock.ts";
import { isErrno, sessionPaths, sessionsDir } from "./paths.ts";
import { ForkPointSchema } from "./records.ts";
import { replay, type SessionSnapshot } from "./replay.ts";

const INDEX_VERSION = 1;

export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: SessionStatusSchema,
  /** The session's primary working directory. Null when the file could not be read. */
  cwd: z.string().nullable(),
  createdAt: z.string(),
  /** Time of the latest record. */
  lastActivity: z.string(),
  /** Prompts plus replies. */
  messageCount: z.number().int().nonnegative(),
  archived: z.boolean(),
  forkedFrom: ForkPointSchema.nullable(),
  /** Set when the file could not be read; says why. */
  damaged: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

const IndexEntrySchema = SessionSummarySchema.extend({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
});
type IndexEntry = z.infer<typeof IndexEntrySchema>;

const IndexFileSchema = z.object({
  v: z.literal(INDEX_VERSION),
  sessions: z.array(IndexEntrySchema),
});

export function indexPath(projectDir: string): string {
  return path.join(sessionsDir(projectDir), "index.json");
}

/** Reads the index, or an empty one when it is missing, damaged or from another version. */
export async function readIndex(projectDir: string): Promise<Map<string, IndexEntry>> {
  let text: string;
  try {
    text = await readFile(indexPath(projectDir), "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return new Map();
    throw error;
  }
  try {
    const parsed = IndexFileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return new Map(parsed.data.sessions.map((e) => [e.id, e]));
  } catch {
    // Damaged: rebuilt from the files below.
  }
  return new Map();
}

async function writeIndex(projectDir: string, entries: Map<string, IndexEntry>): Promise<void> {
  const file = indexPath(projectDir);
  const sessions = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  const body = `${JSON.stringify({ v: INDEX_VERSION, sessions }, null, 1)}\n`;
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  // Not flushed: the index is a cache, and a lost update is repaired from the files.
  await writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

// Index updates from one process run one at a time, so they never overwrite each other.
const queues = new Map<string, Promise<unknown>>();

async function withIndex<T>(
  projectDir: string,
  update: (entries: Map<string, IndexEntry>) => Promise<{ changed: boolean; result: T }>,
): Promise<T> {
  const key = indexPath(projectDir);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const entries = await readIndex(projectDir);
    const { changed, result } = await update(entries);
    if (changed) await writeIndex(projectDir, entries);
    return result;
  });
  const settled = run.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

function entryFromSnapshot(
  snapshot: SessionSnapshot,
  status: SessionStatus,
  size: number,
  mtimeMs: number,
): IndexEntry {
  return {
    id: snapshot.meta.sessionId,
    title: snapshot.state.title,
    status,
    cwd: snapshot.meta.cwd,
    createdAt: snapshot.meta.time,
    lastActivity: snapshot.lastTime,
    messageCount: snapshot.messageCount,
    archived: snapshot.state.archived,
    forkedFrom: snapshot.meta.forkedFrom,
    damaged: null,
    size,
    mtimeMs,
  };
}

/** Records a writer's view of its session. `status` defaults to what the index already says. */
export async function updateIndexEntry(
  projectDir: string,
  snapshot: SessionSnapshot,
  status?: SessionStatus,
): Promise<void> {
  const { file } = sessionPaths(projectDir, snapshot.meta.sessionId);
  await withIndex(projectDir, async (entries) => {
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(file);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { changed: false, result: undefined };
      throw error;
    }
    const previous = entries.get(snapshot.meta.sessionId);
    const next = entryFromSnapshot(
      snapshot,
      status ?? previous?.status ?? "idle",
      info.size,
      info.mtimeMs,
    );
    entries.set(next.id, next);
    return { changed: true, result: undefined };
  });
}

export async function removeIndexEntry(projectDir: string, sessionId: string): Promise<void> {
  await withIndex(projectDir, async (entries) => ({
    changed: entries.delete(sessionId),
    result: undefined,
  }));
}

async function summariseFile(
  projectDir: string,
  id: string,
  previous: IndexEntry | undefined,
  size: number,
  mtimeMs: number,
): Promise<IndexEntry> {
  const { file } = sessionPaths(projectDir, id);
  try {
    const { records } = await readSessionFile(file);
    return entryFromSnapshot(replay(records), previous?.status ?? "idle", size, mtimeMs);
  } catch (error) {
    const time = new Date(mtimeMs).toISOString();
    return {
      id,
      title: null,
      status: "error",
      cwd: null,
      createdAt: time,
      lastActivity: time,
      messageCount: 0,
      archived: false,
      forkedFrom: null,
      damaged: (error as Error).message,
      size,
      mtimeMs,
    };
  }
}

const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/;

/** Brings the index in line with the session files and returns every entry. */
export async function refreshIndex(projectDir: string): Promise<SessionSummary[]> {
  return withIndex(projectDir, async (entries) => {
    let names: string[];
    try {
      names = await readdir(sessionsDir(projectDir));
    } catch (error) {
      if (isErrno(error, "ENOENT")) names = [];
      else throw error;
    }
    let changed = false;
    const seen = new Set<string>();
    for (const name of names) {
      const match = SESSION_FILE.exec(name);
      if (!match?.[1]) continue;
      const id = match[1];
      let info: { size: number; mtimeMs: number };
      try {
        info = await stat(path.join(sessionsDir(projectDir), name));
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue; // Deleted while we looked.
        throw error;
      }
      seen.add(id);
      const previous = entries.get(id);
      if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) continue;
      entries.set(id, await summariseFile(projectDir, id, previous, info.size, info.mtimeMs));
      changed = true;
    }
    for (const id of [...entries.keys()]) {
      if (!seen.has(id)) {
        entries.delete(id);
        changed = true;
      }
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries.values()) {
      const { size: _size, mtimeMs: _mtime, ...summary } = entry;
      if (
        (summary.status === "working" || summary.status === "waiting") &&
        !(await isLocked(sessionPaths(projectDir, summary.id).lock))
      ) {
        summary.status = "idle";
      }
      summaries.push(summary);
    }
    return { changed, result: summaries };
  });
}
