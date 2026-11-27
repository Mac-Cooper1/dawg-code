/**
 * Checkpoints (Phase 4 spec, "Checkpoints and rewind"): the files a session's file tools changed,
 * as they were before each prompt, so a rewind can put them back.
 *
 * A checkpoint opens when a prompt is written (one per turn, named by the turn's id). The first
 * time a file tool is about to change a file within it, the file's content is saved, or the fact
 * that it did not exist, so a rewind can delete a file made since. After every change the engine
 * notes the file's new content (a hash), so a rewind can tell when a file changed outside the
 * file tools since: by the person, another program or a shell command. Shell commands are not
 * tracked, as in Claude Code.
 *
 * On disk, beside the session's other side files:
 *
 *   <session dir>/file-history/checkpoints.jsonl   one record per line, appended in time order
 *   <session dir>/file-history/blobs/<sha-256>     saved contents, stored once however often used
 *
 * Records:
 *
 *   {"type":"checkpoint","key":"<session id>:<turn id>","turnId":"turn-7","time":…,"hidden":false}
 *   {"type":"backup","key":"…","path":"/abs/file","blob":"<sha-256>"|null,"mode":420|null}
 *   {"type":"state","path":"/abs/file","hash":"<sha-256>"|null}
 *
 * A fork copies its parent's file history. Checkpoints of turns the fork did not copy come along
 * `hidden`: never listed, but restoring files to an earlier checkpoint still undoes what they
 * changed, because restoring goes by when changes happened, not by which conversation made them.
 * Only the latest `retention` checkpoints are kept; older ones are dropped with every saved
 * content no other checkpoint uses. Restoring to a checkpoint never needs an older one.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../tools/files/atomic-write.ts";

/** Claude Code keeps the 100 most recent checkpoints of a session; so do we. */
export const DEFAULT_CHECKPOINT_RETENTION = 100;

const MANIFEST = "checkpoints.jsonl";
const BLOBS = "blobs";

/** A file's content as a hash, `null` when it does not exist, or "other" (a folder, a device). */
export type Present = string | null | "other";

interface Backup {
  /** The saved content's hash; null when the file did not exist. */
  blob: string | null;
  /** Permission bits, to write it back with. */
  mode: number | null;
  /**
   * When it was saved, as a running count across the whole history. A subagent started by an
   * earlier turn can save into that turn's checkpoint after later ones did, so restoring goes by
   * this, not by checkpoint order.
   */
  order: number;
}

/** A subagent that changed a file within a checkpoint (`SubagentLabel` in the protocol). */
export interface AgentMark {
  agentId: string;
  sessionId: string;
  agentType: string;
  description: string;
}

interface Entry {
  /** `<session id>:<turn id>`, unique across forks. */
  key: string;
  turnId: string;
  time: number;
  /** A turn this conversation does not have (inherited by a fork). Never listed. */
  hidden: boolean;
  /** Each file's content before this checkpoint first changed it, in the order first changed. */
  backups: Map<string, Backup>;
  /** The subagents started by this checkpoint's turn that changed each file, in order. */
  agents: Map<string, AgentMark[]>;
}

type ManifestRecord =
  | { type: "checkpoint"; key: string; turnId: string; time: number; hidden: boolean }
  | { type: "backup"; key: string; path: string; blob: string | null; mode: number | null }
  | { type: "state"; path: string; hash: string | null }
  | { type: "agent"; key: string; path: string; agent: AgentMark };

/** One step of a restore: what it would do to a file. */
export interface PlannedRestore {
  path: string;
  action: "write" | "delete";
  changedOutside: boolean;
  /** The content to write (`write`). */
  blob: string | null;
  mode: number | null;
}

export interface CheckpointFiles {
  /** Whether this turn's checkpoint is kept. False after retention dropped it, or before checkpoints. */
  tracked: boolean;
  /** Files the turn changed, with whether each was created and which of its subagents did. */
  files: { path: string; change: "created" | "modified"; agents: AgentMark[] }[];
}

export interface RestoreOutcome {
  outcome: "done" | "conflicts";
  conflicts: string[];
  restored: string[];
  deleted: string[];
  skipped: { path: string; reason: string }[];
}

export interface CheckpointStoreOptions {
  /** `<session dir>/file-history`. Created on first write. */
  dir: string;
  sessionId: string;
  /** How many of the latest checkpoints keep their files. */
  retention?: number;
  clock?: () => number;
  /** Told about a failure to save; the store goes on (a file change is never held up by it). */
  onError?: (message: string, error: unknown) => void;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** What is at a path now, following symbolic links as the file tools do. */
async function presentState(file: string): Promise<{ state: Present; bytes: Buffer | null }> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { state: null, bytes: null };
    return { state: "other", bytes: null };
  }
  if (!info.isFile()) return { state: "other", bytes: null };
  try {
    const bytes = await readFile(file);
    return { state: sha256(bytes), bytes };
  } catch {
    return { state: "other", bytes: null };
  }
}

export class CheckpointStore {
  readonly dir: string;
  readonly sessionId: string;
  readonly retention: number;
  readonly #clock: () => number;
  readonly #onError: (message: string, error: unknown) => void;
  /** In time order. */
  #entries: Entry[] = [];
  /** What each file held when the engine last changed or restored it. */
  #states = new Map<string, string | null>();
  /** Writes happen one at a time, in call order. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The next backup's `order`. */
  #order = 0;

  private constructor(options: CheckpointStoreOptions) {
    this.dir = options.dir;
    this.sessionId = options.sessionId;
    this.retention = Math.max(1, Math.floor(options.retention ?? DEFAULT_CHECKPOINT_RETENTION));
    this.#clock = options.clock ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  /** Opens a session's file history, reading what is on disk (nothing, for a new session). */
  static async open(options: CheckpointStoreOptions): Promise<CheckpointStore> {
    const store = new CheckpointStore(options);
    const records = await readManifest(options.dir);
    store.#load(records);
    return store;
  }

  #load(records: readonly ManifestRecord[]): void {
    const byKey = new Map<string, Entry>();
    for (const record of records) {
      if (record.type === "checkpoint") {
        if (byKey.has(record.key)) continue;
        const entry: Entry = {
          key: record.key,
          turnId: record.turnId,
          time: record.time,
          hidden: record.hidden,
          backups: new Map(),
          agents: new Map(),
        };
        byKey.set(record.key, entry);
        this.#entries.push(entry);
      } else if (record.type === "backup") {
        const entry = byKey.get(record.key);
        if (entry !== undefined && !entry.backups.has(record.path)) {
          const order = this.#order++;
          entry.backups.set(record.path, { blob: record.blob, mode: record.mode, order });
        }
      } else if (record.type === "agent") {
        const entry = byKey.get(record.key);
        if (entry !== undefined) addAgent(entry, record.path, record.agent);
      } else {
        this.#states.set(record.path, record.hash);
      }
    }
  }

  /** Resolves once every write asked for so far has been made. */
  idle(): Promise<void> {
    return this.#queue.then(
      () => {},
      () => {},
    );
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** The checkpoint this conversation has for a turn, if it is kept. */
  #visible(turnId: string): Entry | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as Entry;
      if (!entry.hidden && entry.turnId === turnId) return entry;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  /** Opens the checkpoint for a turn, just after its prompt was written. Never throws. */
  open(turnId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#visible(turnId) !== undefined) return;
      const entry: Entry = {
        key: `${this.sessionId}:${turnId}`,
        turnId,
        time: this.#clock(),
        hidden: false,
        backups: new Map(),
        agents: new Map(),
      };
      this.#entries.push(entry);
      try {
        await this.#append([
          { type: "checkpoint", key: entry.key, turnId, time: entry.time, hidden: false },
        ]);
        if (this.#entries.length > this.retention) await this.#prune();
      } catch (error) {
        this.#onError("The checkpoint for this prompt could not be saved.", error);
      }
    });
  }

  /**
   * Saves the files a call is about to change, each the first time this turn changes it. A
   * turn with no open checkpoint (one that began before checkpoints were kept) gets one now.
   * `agent`: the change is a subagent's, started by that turn; null `turnId` (an agent started
   * outside a turn) goes to the latest checkpoint. Never throws: a failure is reported and the
   * change goes ahead.
   */
  beforeChange(
    turnId: string | null,
    paths: readonly string[],
    agent: AgentMark | null = null,
  ): Promise<void> {
    return this.#enqueue(async () => {
      if (turnId === null) {
        const latest = this.#entries.findLast((e) => !e.hidden);
        if (latest === undefined) return;
        turnId = latest.turnId;
      }
      let entry = this.#visible(turnId);
      const records: ManifestRecord[] = [];
      if (entry === undefined) {
        entry = {
          key: `${this.sessionId}:${turnId}`,
          turnId,
          time: this.#clock(),
          hidden: false,
          backups: new Map(),
          agents: new Map(),
        };
        this.#entries.push(entry);
        records.push({
          type: "checkpoint",
          key: entry.key,
          turnId,
          time: entry.time,
          hidden: false,
        });
      }
      for (const file of new Set(paths.map((p) => path.resolve(p)))) {
        if (agent !== null && addAgent(entry, file, agent)) {
          records.push({ type: "agent", key: entry.key, path: file, agent });
        }
        if (entry.backups.has(file)) continue;
        try {
          const { state, bytes } = await presentState(file);
          if (state === "other") continue;
          let mode: number | null = null;
          if (state !== null && bytes !== null) {
            await this.#saveBlob(state, bytes);
            mode = (await stat(file)).mode & 0o7777;
          }
          entry.backups.set(file, { blob: state, mode, order: this.#order++ });
          records.push({ type: "backup", key: entry.key, path: file, blob: state, mode });
          // A file never changed by the engine before is taken as it is now.
          if (!this.#states.has(file)) {
            this.#states.set(file, state);
            records.push({ type: "state", path: file, hash: state });
          }
        } catch (error) {
          this.#onError(`A checkpoint copy of ${file} could not be saved.`, error);
        }
      }
      try {
        await this.#append(records);
      } catch (error) {
        this.#onError("The checkpoint could not be saved.", error);
      }
    });
  }

  /** Notes what the files hold now that a file tool has run on them. Never throws. */
  afterChange(paths: readonly string[]): Promise<void> {
    return this.#enqueue(async () => {
      const records: ManifestRecord[] = [];
      for (const file of new Set(paths.map((p) => path.resolve(p)))) {
        const { state } = await presentState(file);
        if (state === "other") continue;
        if (this.#states.get(file) === state && this.#states.has(file)) continue;
        this.#states.set(file, state);
        records.push({ type: "state", path: file, hash: state });
      }
      try {
        await this.#append(records);
      } catch (error) {
        this.#onError("The checkpoint could not be saved.", error);
      }
    });
  }

  async #append(records: readonly ManifestRecord[]): Promise<void> {
    if (records.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    await appendFile(
      path.join(this.dir, MANIFEST),
      records.map((r) => `${JSON.stringify(r)}\n`).join(""),
      "utf8",
    );
  }

  async #saveBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const dir = path.join(this.dir, BLOBS);
    const file = path.join(dir, hash);
    try {
      await stat(file);
      return;
    } catch {
      // Not saved yet.
    }
    await mkdir(dir, { recursive: true });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, bytes, { flag: "wx" });
    await rename(temp, file);
  }

  /** Drops the oldest checkpoints past the retention limit, and contents nothing else uses. */
  async #prune(): Promise<void> {
    const drop = this.#entries.length - this.retention;
    if (drop <= 0) return;
    this.#entries = this.#entries.slice(drop);
    await this.#rewrite();
    await this.#collectBlobs();
  }

  /** Writes the manifest afresh from memory, replacing the old one in one rename. */
  async #rewrite(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const lines = manifestOf(this.#entries, this.#states);
    const file = path.join(this.dir, MANIFEST);
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, lines, "utf8");
    await rename(temp, file);
  }

  async #collectBlobs(): Promise<void> {
    const used = new Set<string>();
    for (const entry of this.#entries) {
      for (const backup of entry.backups.values()) if (backup.blob !== null) used.add(backup.blob);
    }
    const dir = path.join(this.dir, BLOBS);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => !used.has(name))
        .map((name) => rm(path.join(dir, name), { force: true }).catch(() => {})),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  /** What a turn's checkpoint holds: the files it changed. */
  filesOf(turnId: string): CheckpointFiles {
    const entry = this.#visible(turnId);
    if (entry === undefined) return { tracked: false, files: [] };
    return {
      tracked: true,
      files: [...entry.backups].map(([file, backup]) => ({
        path: file,
        change: backup.blob === null ? "created" : "modified",
        agents: [...(entry.agents.get(file) ?? [])],
      })),
    };
  }

  /**
   * What restoring files to a turn's checkpoint would do: for every file changed from that
   * checkpoint on, in this conversation or a hidden one, the content it had then. Files already
   * as they were are left out. Empty when the checkpoint is not kept.
   */
  async plan(turnId: string, seen: Map<string, Present> = new Map()): Promise<PlannedRestore[]> {
    const entry = this.#visible(turnId);
    if (entry === undefined) return [];
    const from = this.#entries.indexOf(entry);
    // The content before the first change made from this checkpoint on, by time.
    const earliest = new Map<string, Backup>();
    for (const later of this.#entries.slice(from)) {
      for (const [file, backup] of later.backups) {
        const seen = earliest.get(file);
        if (seen === undefined || backup.order < seen.order) earliest.set(file, backup);
      }
    }
    const ordered = [...earliest].sort((a, b) => a[1].order - b[1].order);
    const steps: PlannedRestore[] = [];
    for (const [file, backup] of ordered) {
      let state = seen.get(file);
      if (state === undefined) {
        state = (await presentState(file)).state;
        seen.set(file, state);
      }
      if (state === backup.blob) continue;
      const known = this.#states.has(file) ? this.#states.get(file) : state;
      steps.push({
        path: file,
        action: backup.blob === null ? "delete" : "write",
        changedOutside: state === "other" || state !== known,
        blob: backup.blob,
        mode: backup.mode,
      });
    }
    return steps;
  }

  /**
   * Puts files back as they were at a turn's checkpoint. With files changed outside the file
   * tools since, and no `overwrite`, changes nothing and reports them.
   */
  restore(turnId: string, options: { overwrite: boolean }): Promise<RestoreOutcome> {
    return this.#enqueue(async () => {
      const steps = await this.plan(turnId);
      const conflicts = steps.filter((s) => s.changedOutside).map((s) => s.path);
      const outcome: RestoreOutcome = {
        outcome: "done",
        conflicts: [],
        restored: [],
        deleted: [],
        skipped: [],
      };
      if (conflicts.length > 0 && !options.overwrite) {
        return { ...outcome, outcome: "conflicts", conflicts };
      }
      const records: ManifestRecord[] = [];
      for (const step of steps) {
        try {
          const done = await this.#apply(step);
          if (typeof done === "string") {
            outcome.skipped.push({ path: step.path, reason: done });
            continue;
          }
          (step.action === "delete" ? outcome.deleted : outcome.restored).push(step.path);
          this.#states.set(step.path, step.blob);
          records.push({ type: "state", path: step.path, hash: step.blob });
        } catch (error) {
          outcome.skipped.push({ path: step.path, reason: describeError(error) });
        }
      }
      try {
        await this.#append(records);
      } catch (error) {
        this.#onError("The checkpoint could not be updated after the restore.", error);
      }
      return outcome;
    });
  }

  /** Makes one step; a string says why it was skipped. */
  async #apply(step: PlannedRestore): Promise<true | string> {
    const info = await lstat(step.path).catch(() => null);
    if (info?.isDirectory()) return "it is a folder now";
    if (step.action === "delete") {
      if (info === null) return true;
      if (!info.isFile()) return "it is not a regular file now";
      await unlink(step.path);
      return true;
    }
    if (info !== null && !info.isFile() && !info.isSymbolicLink()) {
      return "it is not a regular file now";
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(this.dir, BLOBS, step.blob as string));
    } catch {
      return "its saved copy is gone";
    }
    await mkdir(path.dirname(step.path), { recursive: true });
    await atomicWriteFile(step.path, bytes, step.mode === null ? {} : { mode: step.mode });
    return true;
  }

  /** Every checkpoint kept, in time order, for tests and forks. */
  entries(): readonly { key: string; turnId: string; hidden: boolean; files: string[] }[] {
    return this.#entries.map((e) => ({
      key: e.key,
      turnId: e.turnId,
      hidden: e.hidden,
      files: [...e.backups.keys()],
    }));
  }

  /**
   * Copies a session's file history to a fork of it. `copied(turnId)` says whether the fork has
   * that turn; the others come along hidden. Saved contents are hard-linked where possible.
   */
  static async copy(
    fromDir: string,
    toDir: string,
    copied: (turnId: string) => boolean,
  ): Promise<void> {
    const records = await readManifest(fromDir);
    if (records.length === 0) return;
    const out = records.map((record) =>
      record.type === "checkpoint"
        ? { ...record, hidden: record.hidden || !copied(record.turnId) }
        : record,
    );
    await mkdir(path.join(toDir, BLOBS), { recursive: true });
    const blobs = await readdir(path.join(fromDir, BLOBS)).catch(() => [] as string[]);
    for (const name of blobs) {
      if (name.endsWith(".tmp")) continue;
      const source = path.join(fromDir, BLOBS, name);
      const target = path.join(toDir, BLOBS, name);
      try {
        await link(source, target);
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        await copyFile(source, target).catch(() => {});
      }
    }
    await writeFile(
      path.join(toDir, MANIFEST),
      out.map((r) => `${JSON.stringify(r)}\n`).join(""),
      "utf8",
    );
  }
}

/**
 * The manifest from memory: every checkpoint, then every backup in the order it was saved (which
 * reading back relies on), then the subagent marks and the files' last known contents.
 */
function manifestOf(entries: readonly Entry[], states: ReadonlyMap<string, string | null>): string {
  const lines: string[] = [];
  const backups: { order: number; line: string }[] = [];
  const agents: string[] = [];
  for (const entry of entries) {
    lines.push(
      JSON.stringify({
        type: "checkpoint",
        key: entry.key,
        turnId: entry.turnId,
        time: entry.time,
        hidden: entry.hidden,
      } satisfies ManifestRecord),
    );
    for (const [file, backup] of entry.backups) {
      const line = JSON.stringify({
        type: "backup",
        key: entry.key,
        path: file,
        blob: backup.blob,
        mode: backup.mode,
      } satisfies ManifestRecord);
      backups.push({ order: backup.order, line });
    }
    for (const [file, marks] of entry.agents) {
      for (const agent of marks) {
        agents.push(
          JSON.stringify({
            type: "agent",
            key: entry.key,
            path: file,
            agent,
          } satisfies ManifestRecord),
        );
      }
    }
  }
  backups.sort((a, b) => a.order - b.order);
  lines.push(...backups.map((b) => b.line), ...agents);
  for (const [file, hash] of states) {
    lines.push(JSON.stringify({ type: "state", path: file, hash } satisfies ManifestRecord));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Notes that an agent changed a file in a checkpoint; false when it was noted already. */
function addAgent(entry: Entry, file: string, agent: AgentMark): boolean {
  const marks = entry.agents.get(file) ?? [];
  if (marks.some((m) => m.agentId === agent.agentId)) return false;
  entry.agents.set(file, [...marks, agent]);
  return true;
}

/** The manifest's records; a torn or unknown line (a crash mid-append) is skipped. */
async function readManifest(dir: string): Promise<ManifestRecord[]> {
  let text: string;
  try {
    text = await readFile(path.join(dir, MANIFEST), "utf8");
  } catch {
    return [];
  }
  const out: ManifestRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = parseRecord(JSON.parse(line));
      if (record !== null) out.push(record);
    } catch {
      // A torn last line.
    }
  }
  return out;
}

function parseRecord(value: unknown): ManifestRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const hashOrNull = (v: unknown) =>
    v === null || (typeof v === "string" && /^[0-9a-f]{64}$/.test(v));
  if (r.type === "checkpoint") {
    if (typeof r.key !== "string" || typeof r.turnId !== "string") return null;
    return {
      type: "checkpoint",
      key: r.key,
      turnId: r.turnId,
      time: typeof r.time === "number" ? r.time : 0,
      hidden: r.hidden === true,
    };
  }
  if (r.type === "backup") {
    if (typeof r.key !== "string" || typeof r.path !== "string" || !hashOrNull(r.blob)) return null;
    return {
      type: "backup",
      key: r.key,
      path: r.path,
      blob: r.blob as string | null,
      mode: typeof r.mode === "number" ? r.mode : null,
    };
  }
  if (r.type === "agent") {
    const a = r.agent as Record<string, unknown> | null;
    if (
      typeof r.key !== "string" ||
      typeof r.path !== "string" ||
      typeof a !== "object" ||
      a === null
    ) {
      return null;
    }
    if (typeof a.agentId !== "string" || typeof a.agentType !== "string") return null;
    return {
      type: "agent",
      key: r.key,
      path: r.path,
      agent: {
        agentId: a.agentId,
        sessionId: typeof a.sessionId === "string" ? a.sessionId : "",
        agentType: a.agentType,
        description: typeof a.description === "string" ? a.description : "",
      },
    };
  }
  if (r.type === "state") {
    if (typeof r.path !== "string" || !hashOrNull(r.hash)) return null;
    return { type: "state", path: r.path, hash: r.hash as string | null };
  }
  return null;
}

function describeError(error: unknown): string {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission was refused";
  return error instanceof Error ? error.message : String(error);
}
