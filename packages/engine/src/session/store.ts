/**
 * The session store: create, open for append, read, list, fork, rename, archive, delete, export.
 * Sessions are addressed by their project path (the directory they were started in) and id.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, open, rm, stat, truncate, unlink } from "node:fs/promises";
import path from "node:path";
import type { SessionStatus } from "@dawg/protocol";
import type { Message } from "../contracts/index.ts";
import { SessionStoreError } from "./errors.ts";
import { type ExportOptions, renderMarkdown } from "./export.ts";
import { type ReadOptions, type ReadProblem, readSessionFile } from "./file.ts";
import {
  refreshIndex,
  removeIndexEntry,
  type SessionSummary,
  updateIndexEntry,
} from "./listing.ts";
import { acquireLock } from "./lock.ts";
import {
  isErrno,
  newSessionId,
  resolveDawgHome,
  resolveProjectDir,
  type SessionPaths,
  sessionPaths,
  sessionsDir,
} from "./paths.ts";
import {
  CURRENT_PROTOCOL_VERSION,
  type MetaRecord,
  MetaRecordSchema,
  SESSION_FORMAT_VERSION,
  type SessionRecord,
  type StateChanges,
} from "./records.ts";
import { replay, type SessionSnapshot } from "./replay.ts";
import { type Durability, SessionWriter } from "./writer.ts";

export interface SessionStoreOptions {
  /** The data root. Defaults to `$DAWG_HOME`, else `~/.dawg`. Tests always pass one. */
  root?: string;
  /** Environment used to find the default root. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Clock for record times. */
  now?: () => Date;
  /** Session id generator. Ids must sort by creation time. */
  newId?: () => string;
  /** When appends are flushed to the drive; see writer.ts. Default "batched". */
  durability?: Durability;
  /** For "batched": the longest a written record waits for a flush. Default 1000 ms. */
  flushDelayMs?: number;
}

export interface CreateSessionOptions {
  /** The session's primary working directory; also the project it is filed under. */
  cwd: string;
  title?: string | null;
  /** Initial state, written as the first `state` record when any is given. */
  initialState?: StateChanges;
  /**
   * Messages that start the model's view, such as the session context message. Written as
   * `note` records (or `user`, for a prompt) right after the meta and state records.
   */
  initialMessages?: Message[];
}

export interface ForkOptions {
  /** The last record of the parent to copy. Defaults to the parent's last record. */
  atSeq?: number;
  /** A title for the fork, recorded as a `state` change after the copied records. */
  title?: string | null;
}

export interface LoadedSession {
  snapshot: SessionSnapshot;
  records: SessionRecord[];
  /** Lines skipped when reading with `onCorrupt: "skip"`. */
  problems: ReadProblem[];
  /** True when the file ended in an incomplete line, which was ignored. */
  tornTail: boolean;
}

export interface ListOptions {
  /** Include archived sessions. Default false. */
  includeArchived?: boolean;
}

export interface DeleteResult {
  /**
   * Sessions forked (directly or through other forks) from the deleted one. Their copied records
   * may name files in its `tool-results/` folder, so that folder is kept while any exist.
   */
  dependents: string[];
  keptToolResults: boolean;
}

export class SessionStore {
  readonly root: string;
  #now: () => Date;
  #newId: () => string;
  #durability: Durability;
  #flushDelayMs: number;
  /** Writers open in this process, by transcript path. */
  #open = new Map<string, SessionWriter>();

  constructor(options: SessionStoreOptions = {}) {
    this.root = options.root ?? resolveDawgHome(options.env ? { env: options.env } : {});
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => newSessionId(this.#now().getTime()));
    this.#durability = options.durability ?? "batched";
    this.#flushDelayMs = options.flushDelayMs ?? 1000;
  }

  /** The folder holding a project's sessions, claiming one if `create`. */
  projectDir(cwd: string, create = false): Promise<string> {
    return resolveProjectDir(this.root, cwd, { create });
  }

  /** Where a session's files are. They may not exist. */
  async paths(cwd: string, sessionId: string): Promise<SessionPaths> {
    return sessionPaths(await this.projectDir(cwd), sessionId);
  }

  /** Creates a session and returns it open for appending. */
  async create(options: CreateSessionOptions): Promise<SessionWriter> {
    const cwd = path.resolve(options.cwd);
    const projectDir = await this.projectDir(cwd, true);
    await mkdir(sessionsDir(projectDir), { recursive: true });
    const id = this.#newId();
    const paths = sessionPaths(projectDir, id);
    const lock = await acquireLock(paths.lock, `Session ${id}`);
    try {
      const meta: MetaRecord = {
        type: "meta",
        v: SESSION_FORMAT_VERSION,
        seq: 0,
        time: this.#now().toISOString(),
        sessionId: id,
        cwd,
        title: options.title ?? null,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        forkedFrom: null,
      };
      MetaRecordSchema.parse(meta);
      await this.#createFile(paths.file, [meta]);
      const writer = await this.#openWriter(projectDir, paths, replay([meta]), lock);
      if (options.initialState && Object.keys(options.initialState).length > 0) {
        await writer.setState(options.initialState);
      }
      for (const message of options.initialMessages ?? []) await writer.appendMessage(message);
      await writer.setStatus("idle");
      return writer;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /**
   * Opens an existing session for appending (resume). Fails with "locked" when another writer,
   * in this process or another, has it open. A torn last line is cut off before the first append.
   */
  async open(cwd: string, sessionId: string): Promise<SessionWriter> {
    const projectDir = await this.projectDir(cwd);
    const paths = sessionPaths(projectDir, sessionId);
    if (this.#open.has(paths.file)) {
      throw new SessionStoreError(
        "locked",
        `Session ${sessionId} is already open in this process.`,
        {
          file: paths.file,
          lockFile: paths.lock,
        },
      );
    }
    await this.#assertExists(paths.file, sessionId, cwd);
    const lock = await acquireLock(paths.lock, `Session ${sessionId}`);
    try {
      // Read only once the lock is held, so no other writer can append behind our back.
      const contents = await readSessionFile(paths.file);
      if (contents.tornBytes > 0) await truncate(paths.file, contents.committedBytes);
      return await this.#openWriter(projectDir, paths, replay(contents.records), lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** Reads a session without opening it for writing. Safe while another process writes it. */
  async read(cwd: string, sessionId: string, options: ReadOptions = {}): Promise<LoadedSession> {
    const { file } = await this.paths(cwd, sessionId);
    const contents = await readSessionFile(file, options);
    return {
      snapshot: replay(contents.records),
      records: contents.records,
      problems: contents.problems,
      tornTail: contents.tornBytes > 0,
    };
  }

  /** Sessions of a project, most recently active first. */
  async list(cwd: string, options: ListOptions = {}): Promise<SessionSummary[]> {
    const projectDir = await this.projectDir(cwd);
    const all = await refreshIndex(projectDir);
    return all
      .filter((s) => options.includeArchived || !s.archived)
      .sort((a, b) =>
        a.lastActivity === b.lastActivity
          ? b.id.localeCompare(a.id)
          : b.lastActivity.localeCompare(a.lastActivity),
      );
  }

  /**
   * Copies the parent's records up to `atSeq` into a new session whose meta names the parent and
   * the fork point. Records are copied unchanged, so the fork's history is byte-identical to the
   * parent's at that point (and the model's prompt cache still matches it). Paths inside them
   * that name the parent's `tool-results/` files keep doing so; see `delete`.
   */
  async fork(cwd: string, sessionId: string, options: ForkOptions = {}): Promise<string> {
    const projectDir = await this.projectDir(cwd, true);
    const parent = await readSessionFile(sessionPaths(projectDir, sessionId).file);
    const parentMeta = parent.records[0] as MetaRecord;
    const lastSeq = parent.records[parent.records.length - 1]?.seq ?? 0;
    const atSeq = options.atSeq ?? lastSeq;
    if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq > lastSeq) {
      throw new SessionStoreError(
        "invalid-argument",
        `Cannot fork session ${sessionId} at record ${atSeq}: it has records 0 to ${lastSeq}.`,
      );
    }
    const id = this.#newId();
    const paths = sessionPaths(projectDir, id);
    const meta: MetaRecord = {
      type: "meta",
      v: SESSION_FORMAT_VERSION,
      seq: 0,
      time: this.#now().toISOString(),
      sessionId: id,
      cwd: parentMeta.cwd,
      title: parentMeta.title,
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      forkedFrom: { sessionId, seq: atSeq },
    };
    const copied = parent.records.filter((r) => r.type !== "meta" && r.seq <= atSeq);
    const records: SessionRecord[] = [meta, ...copied];
    const inherited = replay(records);
    const changes: StateChanges = {};
    if (options.title !== undefined) changes.title = options.title;
    // A fork is new work; it does not start out archived because its parent was.
    if (inherited.state.archived) changes.archived = false;
    if (Object.keys(changes).length > 0) {
      records.push({
        type: "state",
        v: SESSION_FORMAT_VERSION,
        seq: (copied[copied.length - 1]?.seq ?? 0) + 1,
        time: this.#now().toISOString(),
        changes,
      });
    }
    await this.#createFile(paths.file, records);
    await updateIndexEntry(projectDir, replay(records), "idle").catch(() => {});
    return id;
  }

  /** Records a new title. Uses the session's open writer in this process when there is one. */
  rename(cwd: string, sessionId: string, title: string | null): Promise<void> {
    return this.#withWriter(cwd, sessionId, async (w) => {
      await w.setState({ title });
    });
  }

  archive(cwd: string, sessionId: string, archived = true): Promise<void> {
    return this.#withWriter(cwd, sessionId, async (w) => {
      await w.setState({ archived });
    });
  }

  /**
   * Deletes a session's transcript and side files. Refused while any writer has it open. The
   * `tool-results/` folder is kept while forks of it exist (see `DeleteResult`).
   */
  async delete(cwd: string, sessionId: string): Promise<DeleteResult> {
    const projectDir = await this.projectDir(cwd);
    const paths = sessionPaths(projectDir, sessionId);
    if (this.#open.has(paths.file)) {
      throw new SessionStoreError("locked", `Session ${sessionId} is open in this process.`, {
        file: paths.file,
        lockFile: paths.lock,
      });
    }
    await this.#assertExists(paths.file, sessionId, cwd);
    const lock = await acquireLock(paths.lock, `Session ${sessionId}`);
    try {
      const summaries = await refreshIndex(projectDir);
      const parentOf = new Map(summaries.map((s) => [s.id, s.forkedFrom?.sessionId ?? null]));
      const dependents = summaries
        .filter((s) => {
          let ancestor = parentOf.get(s.id) ?? null;
          const seen = new Set<string>();
          while (ancestor !== null && !seen.has(ancestor)) {
            if (ancestor === sessionId) return true;
            seen.add(ancestor);
            ancestor = parentOf.get(ancestor) ?? null;
          }
          return false;
        })
        .map((s) => s.id);

      await unlink(paths.file);
      const keptToolResults = dependents.length > 0;
      if (!keptToolResults) {
        await rm(paths.dir, { recursive: true, force: true });
      }
      await removeIndexEntry(projectDir, sessionId);
      return { dependents, keptToolResults };
    } finally {
      await lock.release();
    }
  }

  /** The session as Markdown, for `/export`. */
  async exportMarkdown(
    cwd: string,
    sessionId: string,
    options: ExportOptions & ReadOptions = {},
  ): Promise<string> {
    const { records } = await this.read(cwd, sessionId, {
      onCorrupt: options.onCorrupt ?? "throw",
    });
    return renderMarkdown(records, options);
  }

  async #assertExists(file: string, sessionId: string, cwd: string): Promise<void> {
    try {
      await stat(file);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new SessionStoreError("not-found", `No session ${sessionId} for ${cwd}.`, { file });
      }
      throw error;
    }
  }

  async #withWriter(
    cwd: string,
    sessionId: string,
    action: (writer: SessionWriter) => Promise<void>,
  ): Promise<void> {
    const { file } = await this.paths(cwd, sessionId);
    const live = this.#open.get(file);
    if (live) return action(live);
    const writer = await this.open(cwd, sessionId);
    try {
      await action(writer);
    } finally {
      await writer.close();
    }
  }

  async #openWriter(
    projectDir: string,
    paths: SessionPaths,
    snapshot: SessionSnapshot,
    lock: Awaited<ReturnType<typeof acquireLock>>,
  ): Promise<SessionWriter> {
    const handle = await open(paths.file, "a");
    const writer = new SessionWriter({
      file: paths.file,
      toolResultsDir: paths.toolResults,
      handle,
      lock,
      snapshot,
      host: {
        now: this.#now,
        durability: this.#durability,
        flushDelayMs: this.#flushDelayMs,
        updateIndex: (snap, status?: SessionStatus) => updateIndexEntry(projectDir, snap, status),
        onClose: () => {
          if (this.#open.get(paths.file) === writer) this.#open.delete(paths.file);
        },
      },
    });
    this.#open.set(paths.file, writer);
    return writer;
  }

  /** Writes a complete new session file, all at once: it appears whole or not at all. */
  async #createFile(file: string, records: readonly SessionRecord[]): Promise<void> {
    const body = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(body, "utf8");
      if (this.#durability !== "none") await handle.datasync();
    } finally {
      await handle.close();
    }
    try {
      await link(tmp, file);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SessionStoreError(
          "invalid-argument",
          `A session file already exists at ${file}.`,
          {
            file,
          },
        );
      }
      throw error;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
}
