/**
 * Appending to one session.
 *
 * Durability. Each record is written with its newline in a single append before `append`
 * resolves, so once it resolves the record survives the app crashing or being killed: it is in the
 * operating system's cache. Surviving a power cut or kernel panic needs a flush to the drive, and
 * on macOS Node flushes with F_FULLFSYNC, which measured about 20 ms per call here. Flushing every
 * record would add that to every tool result, so the default ("batched") flushes at most
 * `flushDelayMs` (1 s) after a write, again on `flush()` and on `close()`. A power cut can then
 * lose up to about a second of records; the torn-line rule keeps the file readable when it does.
 * "every-append" flushes before each append resolves; "none" never flushes (tests, bulk tools).
 *
 * Appends are queued, so concurrent calls get consecutive sequence numbers in call order. If a
 * write fails the writer stops accepting records, since it no longer knows where the file ends;
 * reopening the session repairs the tail.
 */
import type { FileHandle } from "node:fs/promises";
import type { SessionStatus, ToolDisplay } from "@dawg/protocol";
import type { Message } from "../contracts/index.ts";
import { SessionStoreError } from "./errors.ts";
import type { LockHandle } from "./lock.ts";
import {
  type CompactRecord,
  type RecordInput,
  type ReplyInfo,
  recordTypeForMessage,
  SESSION_FORMAT_VERSION,
  type SessionRecord,
  SessionRecordSchema,
  type StateChanges,
} from "./records.ts";
import { applyRecord, type SessionSnapshot } from "./replay.ts";
import { saveToolOutput } from "./tool-results.ts";

/** Extra facts stored beside a message. Each applies to one kind of record. */
export interface MessageExtras {
  /** Assistant replies: the model, finish reason and usage. */
  info?: ReplyInfo;
  /** Tool results: the structured view for clients. */
  display?: ToolDisplay;
  /** Tool results: how long the call took. */
  durationMs?: number;
}

export interface CompactInput {
  trigger: CompactRecord["trigger"];
  focus?: string;
  summary: string;
  /** The model's whole view after compaction. */
  messages: Message[];
  tokensBefore?: number | null;
  tokensAfter?: number | null;
}

export type Durability = "batched" | "every-append" | "none";

/** What the writer needs from the store. */
export interface WriterHost {
  now(): Date;
  durability: Durability;
  flushDelayMs: number;
  /** Called inside the append queue, so the file is exactly as `snapshot` describes it. */
  updateIndex(snapshot: SessionSnapshot, status?: SessionStatus): Promise<void>;
  /** Called once when the writer closes. */
  onClose(): void;
}

export interface WriterInit {
  file: string;
  toolResultsDir: string;
  handle: FileHandle;
  lock: LockHandle;
  snapshot: SessionSnapshot;
  host: WriterHost;
}

/** Records after which the listing is refreshed: they change what a listing shows. */
const INDEXED: ReadonlySet<SessionRecord["type"]> = new Set(["user", "state", "compact"]);

export class SessionWriter {
  readonly sessionId: string;
  /** The transcript file. */
  readonly file: string;
  /** Where `saveOutput` writes. */
  readonly toolResultsDir: string;
  #handle: FileHandle;
  #lock: LockHandle;
  #snapshot: SessionSnapshot;
  #host: WriterHost;
  #queue: Promise<unknown> = Promise.resolve();
  #failure: Error | null = null;
  #closed = false;
  /** Written but not yet flushed to the drive. */
  #dirty = false;
  #flushTimer: NodeJS.Timeout | null = null;

  constructor(init: WriterInit) {
    this.sessionId = init.snapshot.meta.sessionId;
    this.file = init.file;
    this.toolResultsDir = init.toolResultsDir;
    this.#handle = init.handle;
    this.#lock = init.lock;
    this.#snapshot = init.snapshot;
    this.#host = init.host;
  }

  /**
   * The session as replaying its file would give it, kept current with every append. Treat it as
   * read-only; it changes as records are appended.
   */
  get snapshot(): Readonly<SessionSnapshot> {
    return this.#snapshot;
  }

  get lastSeq(): number {
    return this.#snapshot.lastSeq;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Appends one record; `v`, `seq` and `time` are filled in. Resolves once the record is written
   * (and, with "every-append" durability, flushed to the drive).
   */
  append(input: RecordInput): Promise<SessionRecord> {
    return this.#enqueue(() => this.#write(input));
  }

  /** Appends a message to the model's view, choosing the record type from its role and kind. */
  appendMessage(message: Message, extras: MessageExtras = {}): Promise<SessionRecord> {
    const type = recordTypeForMessage(message);
    const misplaced =
      (extras.info !== undefined && type !== "assistant") ||
      ((extras.display !== undefined || extras.durationMs !== undefined) && type !== "tool_result");
    if (misplaced) {
      return Promise.reject(
        new SessionStoreError("invalid-argument", `Those extras do not apply to a ${type} record.`),
      );
    }
    const input = {
      type,
      message,
      ...(extras.info !== undefined ? { info: extras.info } : {}),
      ...(extras.display !== undefined ? { display: extras.display } : {}),
      ...(extras.durationMs !== undefined ? { durationMs: extras.durationMs } : {}),
    } as RecordInput;
    return this.append(input);
  }

  /** Records a change of mode, model, effort, title, archived flag, task list or directories. */
  setState(changes: StateChanges): Promise<SessionRecord> {
    return this.append({ type: "state", changes });
  }

  /** Writes a compaction boundary. The model's view becomes `input.messages`. */
  compact(input: CompactInput): Promise<SessionRecord> {
    return this.append({ type: "compact", ...input });
  }

  /** Reports the live status for listings. Not part of the transcript. */
  setStatus(status: SessionStatus): Promise<void> {
    return this.#enqueue(() => this.#host.updateIndex(this.#snapshot, status));
  }

  /** Flushes everything written so far to the drive. */
  flush(): Promise<void> {
    return this.#enqueue(() => this.#flushNow());
  }

  /** `ToolContext.saveOutput` for this session. */
  saveOutput(name: string, content: string | Uint8Array): Promise<string> {
    if (this.#closed) return Promise.reject(this.#closedError());
    return saveToolOutput(this.toolResultsDir, name, content);
  }

  /** Waits for pending appends, marks the session idle, closes the file and releases the lock. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue.catch(() => {});
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    try {
      if (this.#failure === null) {
        await this.#flushNow().catch(() => {});
        await this.#host.updateIndex(this.#snapshot, "idle").catch(() => {});
      }
    } finally {
      await this.#handle.close().catch(() => {});
      await this.#lock.release();
      this.#host.onClose();
    }
  }

  #closedError(): SessionStoreError {
    return new SessionStoreError(
      "closed",
      this.#failure
        ? `Session ${this.sessionId} stopped accepting records after a failed write: ${this.#failure.message}`
        : `Session ${this.sessionId} is closed.`,
      { file: this.file, cause: this.#failure ?? undefined },
    );
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#failure) return Promise.reject(this.#closedError());
    const run = this.#queue.then(() => {
      if (this.#failure) throw this.#closedError();
      return task();
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(input: RecordInput): Promise<SessionRecord> {
    const { type, ...rest } = input;
    const candidate = {
      type,
      v: SESSION_FORMAT_VERSION,
      seq: this.#snapshot.lastSeq + 1,
      time: this.#host.now().toISOString(),
      ...rest,
    };
    // Validated before anything touches the file: a bad record is the caller's bug and must not
    // stop the session.
    const checked = SessionRecordSchema.safeParse(candidate);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      throw new SessionStoreError(
        "invalid-argument",
        `Not a valid ${type} record${where}: ${issue?.message ?? "invalid"}`,
      );
    }
    const line = `${JSON.stringify(candidate)}\n`;
    const bytes = Buffer.from(line, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.#handle.write(bytes, offset, bytes.length - offset);
        offset += bytesWritten;
      }
      if (this.#host.durability === "every-append") await this.#handle.datasync();
    } catch (error) {
      this.#failure = error as Error;
      throw new SessionStoreError(
        "closed",
        `Could not write to session ${this.sessionId}: ${(error as Error).message}`,
        { file: this.file, cause: error },
      );
    }
    // The snapshot is advanced with the record as it reads back from the line, the same object
    // a later replay would produce.
    const written = JSON.parse(line) as SessionRecord;
    applyRecord(this.#snapshot, written);
    if (this.#host.durability === "batched") this.#scheduleFlush();
    if (INDEXED.has(written.type)) {
      await this.#host.updateIndex(this.#snapshot).catch(() => {});
    }
    return written;
  }

  #scheduleFlush(): void {
    this.#dirty = true;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      if (!this.#closed) this.flush().catch(() => {});
    }, this.#host.flushDelayMs);
    // A pending flush must not keep the process alive; close() flushes anyway.
    this.#flushTimer.unref();
  }

  async #flushNow(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    try {
      await this.#handle.datasync();
    } catch (error) {
      // After a failed flush the kernel may have dropped the unwritten pages, so what is on disk
      // is unknown; stop rather than carry on over a hole.
      this.#failure = error as Error;
      throw new SessionStoreError(
        "closed",
        `Could not flush session ${this.sessionId}: ${(error as Error).message}`,
        { file: this.file, cause: error },
      );
    }
  }
}
