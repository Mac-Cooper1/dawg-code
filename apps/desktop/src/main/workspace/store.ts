/**
 * `<data root>/workspace.json`: what the Changes pane compares with, kept across relaunches.
 *
 * - `sessions`: each session's base commit, recorded the first time the session was tracked.
 * - `worktrees`: the worktrees dawg made, by resolved path, with the ref and commit each started
 *   from (so a worktree session compares with its base, and cleanup knows what "merged" means).
 */
import { z } from "zod";
import { WorktreeInfoSchema } from "../../shared/bridge.ts";
import { createJsonFile, type Logger } from "../json-file.ts";

const SessionRecordSchema = z.object({
  /** The repository's top level (resolved) when the base was recorded. */
  root: z.string(),
  baseCommit: z.string(),
  recordedAt: z.number(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

const WorktreeRecordSchema = WorktreeInfoSchema.extend({
  projectDir: z.string(),
  createdAt: z.number(),
});
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;

/** Old sessions are forgotten past this many, oldest first. */
const MAX_SESSIONS = 5000;

export interface WorkspaceStore {
  session(sessionId: string): Promise<SessionRecord | null>;
  setSession(sessionId: string, record: SessionRecord): Promise<void>;
  worktree(realPath: string): Promise<WorktreeRecord | null>;
  setWorktree(realPath: string, record: WorktreeRecord): Promise<void>;
  deleteWorktree(realPath: string): Promise<void>;
}

/** Keeps the entries that parse and drops the rest, so one bad entry costs only itself. */
function parseRecords<T>(raw: unknown, schema: z.ZodType<T>): Record<string, T> {
  const out: Record<string, T> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

export function createWorkspaceStore(file: string, log: Logger): WorkspaceStore {
  const json = createJsonFile(file, log);
  let loaded: Promise<{
    sessions: Record<string, SessionRecord>;
    worktrees: Record<string, WorktreeRecord>;
  }> | null = null;

  function load() {
    loaded ??= json.read().then((result) => {
      if (result.kind === "unreadable") log(`Could not read ${file}: ${result.reason}`);
      const value = result.kind === "ok" ? result.value : {};
      return {
        sessions: parseRecords(value.sessions, SessionRecordSchema),
        worktrees: parseRecords(value.worktrees, WorktreeRecordSchema),
      };
    });
    return loaded;
  }

  async function save(): Promise<void> {
    const data = await load();
    try {
      const saved = await json.update((current) => ({
        ...current,
        sessions: data.sessions,
        worktrees: data.worktrees,
      }));
      if (saved) return;
    } catch (error) {
      log(`Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    log(`Did not save ${file}; what it records is kept in memory until the app quits.`);
  }

  return {
    async session(sessionId) {
      return (await load()).sessions[sessionId] ?? null;
    },
    async setSession(sessionId, record) {
      const data = await load();
      data.sessions[sessionId] = record;
      const ids = Object.keys(data.sessions);
      if (ids.length > MAX_SESSIONS) {
        const oldest = ids
          .sort((a, b) => (data.sessions[a]?.recordedAt ?? 0) - (data.sessions[b]?.recordedAt ?? 0))
          .slice(0, ids.length - MAX_SESSIONS);
        for (const id of oldest) delete data.sessions[id];
      }
      await save();
    },
    async worktree(realPath) {
      return (await load()).worktrees[realPath] ?? null;
    },
    async setWorktree(realPath, record) {
      (await load()).worktrees[realPath] = record;
      await save();
    },
    async deleteWorktree(realPath) {
      const data = await load();
      if (!(realPath in data.worktrees)) return;
      delete data.worktrees[realPath];
      await save();
    },
  };
}
