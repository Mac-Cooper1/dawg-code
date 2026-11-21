/**
 * Rebuilding a session from its records. The writer runs the same reducer on every record it
 * appends, so a live session and a resumed one cannot drift apart.
 */
import type { PermissionMode, TaskItem } from "@dawg/protocol";
import type { Message } from "../contracts/index.ts";
import { SessionStoreError } from "./errors.ts";
import type { MetaRecord, SessionRecord } from "./records.ts";

export interface SessionState {
  /** Null until a mode is recorded; the engine then uses its configured default. */
  mode: PermissionMode | null;
  model: string | null;
  effort: string | null;
  title: string | null;
  archived: boolean;
  tasks: TaskItem[];
  additionalDirectories: string[];
}

export interface SessionSnapshot {
  meta: MetaRecord;
  state: SessionState;
  /** The model's current view: everything after the latest compaction boundary. */
  view: Message[];
  lastSeq: number;
  /** Time of the latest record. */
  lastTime: string;
  /** Prompts plus replies over the whole transcript, compacted or not. */
  messageCount: number;
  compactions: number;
}

export function initialSnapshot(meta: MetaRecord): SessionSnapshot {
  return {
    meta,
    state: {
      mode: null,
      model: null,
      effort: null,
      title: meta.title,
      archived: false,
      tasks: [],
      additionalDirectories: [],
    },
    view: [],
    lastSeq: meta.seq,
    lastTime: meta.time,
    messageCount: 0,
    compactions: 0,
  };
}

/** Applies one record to a snapshot in place. Records must arrive in sequence order. */
export function applyRecord(snapshot: SessionSnapshot, record: SessionRecord): void {
  switch (record.type) {
    case "meta":
      throw new SessionStoreError("invalid-argument", "A meta record can only start a session.");
    case "user":
    case "assistant":
      snapshot.messageCount += 1;
      snapshot.view.push(record.message);
      break;
    case "note":
    case "tool_result":
      snapshot.view.push(record.message);
      break;
    case "state":
      Object.assign(snapshot.state, record.changes);
      break;
    case "compact":
      // A copy, so that messages appended later do not grow the record's own array.
      snapshot.view = record.messages.slice();
      snapshot.compactions += 1;
      break;
  }
  snapshot.lastSeq = record.seq;
  snapshot.lastTime = record.time;
}

/** Replays a session's records (as read from its file) into its current state. */
export function replay(records: readonly SessionRecord[]): SessionSnapshot {
  const [first, ...rest] = records;
  if (first === undefined || first.type !== "meta") {
    throw new SessionStoreError("invalid-argument", "A session's records must start with meta.");
  }
  const snapshot = initialSnapshot(first);
  for (const record of rest) applyRecord(snapshot, record);
  return snapshot;
}
