/**
 * What the model has seen of each file in this session, so `Write` and `Edit` can insist that
 * changes are based on the file's current contents.
 *
 * A record describes one version of a file (its content hash) and which of its lines the model
 * was shown. Reading a different version starts a fresh record. Writes made by our own tools
 * record the new version, so a following edit needs no new read.
 */
import { createHash } from "node:crypto";
import type { SessionStateBag } from "../../contracts/index.ts";

/** One version of a file on disk. */
export interface FileVersion {
  /** sha256 of the raw bytes, hex. */
  hash: string;
  size: number;
  mtimeMs: number;
  /** Lines in the decoded text (see `countLines`). */
  totalLines: number;
}

export type FileViewSource = "read" | "write" | "edit";

export interface FileRecord extends FileVersion {
  /** Absolute path. */
  readonly path: string;
  /** Merged, sorted, 1-based inclusive line ranges the model was shown of this version. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  /** The model has seen every line of this version (or wrote it). */
  readonly whole: boolean;
  /** When this version was last read or written, in ms since the epoch. */
  readonly at: number;
  readonly via: FileViewSource;
}

export type Freshness =
  /** The model has seen the current version. */
  | { status: "current"; record: FileRecord }
  /** The model has never seen this file in this session. */
  | { status: "unread" }
  /** The file changed after the model last saw it. */
  | { status: "stale"; record: FileRecord };

const STATE_KEY = "dawg.files.tracker";

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FileStateTracker {
  readonly #records = new Map<string, FileRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get(filePath: string): FileRecord | undefined {
    return this.#records.get(filePath);
  }

  /**
   * Records that the model was shown lines `start`..`end` (1-based, inclusive) of `version`.
   * Pass `null` for a view that has no lines, such as an image or an empty file.
   */
  recordRead(
    filePath: string,
    version: FileVersion,
    range: { start: number; end: number } | null,
  ): FileRecord {
    const previous = this.#records.get(filePath);
    const sameVersion = previous !== undefined && previous.hash === version.hash;
    let ranges: Array<[number, number]> = sameVersion
      ? previous.ranges.map((r) => [r[0], r[1]])
      : [];
    if (range !== null && range.end >= range.start) ranges.push([range.start, range.end]);
    ranges = mergeRanges(ranges);
    const whole =
      (sameVersion && previous.whole) || range === null || covers(ranges, version.totalLines);
    const record: FileRecord = {
      ...version,
      path: filePath,
      ranges,
      whole,
      at: this.#now(),
      via: "read",
    };
    this.#records.set(filePath, record);
    return record;
  }

  /**
   * Records a version our own tools just wrote. `whole` says whether the model now knows the
   * whole file: true after `Write`, and after `Edit` only if it had seen the whole file before.
   */
  recordWrite(
    filePath: string,
    version: FileVersion,
    via: "write" | "edit",
    whole: boolean,
  ): FileRecord {
    const ranges: Array<[number, number]> =
      whole && version.totalLines > 0 ? [[1, version.totalLines]] : [];
    const record: FileRecord = {
      ...version,
      path: filePath,
      ranges,
      whole,
      at: this.#now(),
      via,
    };
    this.#records.set(filePath, record);
    return record;
  }

  forget(filePath: string): void {
    this.#records.delete(filePath);
  }

  /** Every record, most recently seen first. */
  list(): FileRecord[] {
    return [...this.#records.values()].sort((a, b) => b.at - a.at);
  }

  freshness(filePath: string, currentHash: string): Freshness {
    const record = this.#records.get(filePath);
    if (record === undefined) return { status: "unread" };
    return record.hash === currentHash
      ? { status: "current", record }
      : { status: "stale", record };
  }
}

/** The session's tracker, created on first use. */
export function fileTracker(state: SessionStateBag): FileStateTracker {
  return state.get(STATE_KEY, () => new FileStateTracker());
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    const last = out[out.length - 1];
    if (last !== undefined && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function covers(ranges: ReadonlyArray<readonly [number, number]>, totalLines: number): boolean {
  if (totalLines === 0) return true;
  const first = ranges[0];
  return ranges.length === 1 && first !== undefined && first[0] <= 1 && first[1] >= totalLines;
}

/** "lines 1-2000 and 2500-2600" */
export function describeRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  const parts = ranges.map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`));
  if (parts.length === 0) return "no lines";
  const label = parts.length === 1 && ranges[0]?.[0] === ranges[0]?.[1] ? "line" : "lines";
  if (parts.length === 1) return `${label} ${parts[0]}`;
  return `${label} ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
