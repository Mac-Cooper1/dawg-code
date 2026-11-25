/**
 * A session's events: numbering, fan-out to listeners, persistence, and replay.
 *
 * Numbering. `seq` starts at 1 and grows by exactly one per event, across resumes, and is never
 * reused (protocol README, "Ordering guarantees").
 *
 * Persistence. Events live in `<session dir>/events.jsonl`, beside the transcript. Every event is
 * written there except the streaming ones (`message.delta`, `reasoning.delta`, `tool.progress`,
 * `prompt.progress`): each `*.finished` event carries the whole fact, so a replay may leave them
 * out, and writing one line per streamed token would make the file grow by megabytes per session.
 * Lines are written synchronously as each event is emitted, so the file is in `seq` order and
 * survives the process being killed (it is in the operating system's cache once written).
 *
 * `session.deleted` is never written either: it is the session's last event, sent just before its
 * files are removed. Once it is emitted the log hands nothing more to listeners and writes nothing
 * more, not even the closed marker.
 *
 * Because streaming events are not written, a crash could lose the highest numbers handed out.
 * To keep them from being handed out again, the log reserves numbers in blocks: before emitting
 * an event above the reserved ceiling it writes `{"reserve": n}`. On a clean close it writes
 * `{"closed": lastSeq}`. Reopening continues after the closed marker, or after the highest
 * number written or reserved if the session did not close cleanly. A crash can therefore leave
 * a gap in `seq`, which the protocol allows in replays; a clean close never does.
 *
 * In memory the log keeps every written event plus the streaming events of messages and tools
 * that have not finished yet, which is exactly what `after()` replays.
 */
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { BackgroundTask, EventName } from "@dawg/protocol";
import type { EventFields } from "../loop/types.ts";

/** An event as stored and replayed: `{ event, payload }`, the payload carrying its `seq`. */
export interface LoggedEvent {
  event: EventName;
  payload: { sessionId: string; seq: number; time: number } & Record<string, unknown>;
}

export interface ReplayPage {
  events: LoggedEvent[];
  lastSeq: number;
  hasMore: boolean;
}

export type EventListener = (event: LoggedEvent) => void;

const STREAMING: ReadonlySet<string> = new Set([
  "message.delta",
  "reasoning.delta",
  "tool.progress",
  "prompt.progress",
]);

const RESERVE_BLOCK = 256;

export function isStreamingEvent(name: string): boolean {
  return STREAMING.has(name);
}

interface Loaded {
  events: LoggedEvent[];
  /** The next number to hand out, less one. */
  lastSeq: number;
  /** Bytes up to and including the last complete line. */
  committedBytes: number;
  exists: boolean;
}

function load(file: string): Loaded {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], lastSeq: 0, committedBytes: 0, exists: false };
    }
    throw error;
  }
  const end = buffer.lastIndexOf(0x0a) + 1;
  const text = buffer.subarray(0, end).toString("utf8");
  const events: LoggedEvent[] = [];
  let highest = 0;
  let reserved = 0;
  let closedAt: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.reserve === "number") {
      reserved = Math.max(reserved, record.reserve);
      closedAt = null;
      continue;
    }
    if (typeof record.closed === "number") {
      // Numbers reserved before a clean close were never handed out.
      closedAt = record.closed;
      reserved = record.closed;
      continue;
    }
    const payload = record.payload as LoggedEvent["payload"] | undefined;
    if (
      typeof record.event !== "string" ||
      payload === undefined ||
      typeof payload.seq !== "number"
    ) {
      continue;
    }
    events.push({ event: record.event as EventName, payload });
    highest = Math.max(highest, payload.seq);
    closedAt = null;
  }
  const lastSeq = closedAt ?? Math.max(highest, reserved);
  return { events, lastSeq, committedBytes: end, exists: true };
}

export class EventLog {
  readonly file: string;
  readonly sessionId: string;
  #now: () => number;
  #fd: number | null;
  #written: LoggedEvent[];
  /** Streaming events of messages and tools that have not finished. */
  #streaming: LoggedEvent[] = [];
  #lastSeq: number;
  #reserved: number;
  #listeners = new Set<EventListener>();
  #failed = false;
  /** Set once `session.deleted` has been emitted. */
  #ended = false;

  private constructor(
    file: string,
    sessionId: string,
    now: () => number,
    fd: number,
    loaded: Loaded,
  ) {
    this.file = file;
    this.sessionId = sessionId;
    this.#now = now;
    this.#fd = fd;
    this.#written = loaded.events;
    this.#lastSeq = loaded.lastSeq;
    this.#reserved = loaded.lastSeq;
  }

  /** Opens (creating when missing) a session's log for appending. */
  static open(file: string, sessionId: string, now: () => number): EventLog {
    mkdirSync(path.dirname(file), { recursive: true });
    const loaded = load(file);
    const fd = openSync(file, "a+");
    // A line cut short by a crash is dropped before anything is appended after it.
    if (loaded.exists && fstatSync(fd).size > loaded.committedBytes) {
      ftruncateSync(fd, loaded.committedBytes);
    }
    return new EventLog(file, sessionId, now, fd, loaded);
  }

  /** Whether a log file exists with at least one event in it. */
  static hasEvents(file: string): boolean {
    return load(file).events.length > 0;
  }

  /** Reads a stored log without opening it, for replaying a session that is not open. */
  static read(file: string, afterSeq: number, limit?: number): ReplayPage {
    const loaded = load(file);
    return page(loaded.events, afterSeq, loaded.lastSeq, limit);
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Every event that a replay from 0 would return. */
  all(): readonly LoggedEvent[] {
    return this.#written;
  }

  /** Emits one event: numbers it, stores it, and hands it to every listener. */
  emit<E extends EventName>(event: E, fields: EventFields<E>, time?: number): LoggedEvent {
    const seq = this.#lastSeq + 1;
    const payload = {
      sessionId: this.sessionId,
      seq,
      time: time ?? this.#now(),
      ...(fields as Record<string, unknown>),
    } as LoggedEvent["payload"];
    const logged: LoggedEvent = { event, payload };
    if (this.#ended) return logged;
    if (event === "session.deleted") {
      // Sent, never stored: the files it would go into are about to be removed.
      this.#ended = true;
    } else if (STREAMING.has(event)) {
      if (seq > this.#reserved) this.#reserve(seq);
      this.#streaming.push(logged);
    } else {
      this.#write(logged);
      this.#written.push(logged);
      this.#prune(logged);
    }
    this.#lastSeq = seq;
    for (const listener of this.#listeners) {
      try {
        listener(logged);
      } catch {
        // A failing listener must not stop the session or the other listeners.
      }
    }
    return logged;
  }

  /** Events with `seq > afterSeq`, ascending. */
  after(afterSeq: number, limit?: number): ReplayPage {
    const merged =
      this.#streaming.length === 0
        ? this.#written
        : [...this.#written, ...this.#streaming].sort((a, b) => a.payload.seq - b.payload.seq);
    return page(merged, afterSeq, this.#lastSeq, limit);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Marks a clean close, so the next open continues without a gap. */
  close(): void {
    if (this.#fd === null) return;
    if (!this.#ended) this.#append({ closed: this.#lastSeq });
    try {
      closeSync(this.#fd);
    } catch {
      // Nothing more to do with it.
    }
    this.#fd = null;
    this.#listeners.clear();
  }

  #reserve(seq: number): void {
    this.#reserved = seq + RESERVE_BLOCK;
    this.#append({ reserve: this.#reserved });
  }

  #write(event: LoggedEvent): void {
    this.#append(event);
    if (this.#reserved < event.payload.seq) this.#reserved = event.payload.seq;
  }

  #append(value: unknown): void {
    if (this.#fd === null || this.#failed) return;
    try {
      writeSync(this.#fd, `${JSON.stringify(value)}\n`);
    } catch {
      // Events are for display; the transcript is the record. A log that cannot be written stops
      // being written rather than stopping the session.
      this.#failed = true;
    }
  }

  /** Drops streaming events whose message, tool or turn has just finished. */
  #prune(finished: LoggedEvent): void {
    if (this.#streaming.length === 0) return;
    const p = finished.payload;
    let keep: (e: LoggedEvent) => boolean;
    switch (finished.event) {
      case "message.finished":
        keep = (e) => e.payload.messageId !== p.messageId;
        break;
      case "tool.finished":
        keep = (e) => e.event !== "tool.progress" || e.payload.toolCallId !== p.toolCallId;
        break;
      case "turn.finished":
        keep = (e) => e.payload.turnId !== p.turnId;
        break;
      default:
        return;
    }
    this.#streaming = this.#streaming.filter(keep);
  }
}

function page(
  events: readonly LoggedEvent[],
  afterSeq: number,
  lastSeq: number,
  limit?: number,
): ReplayPage {
  const after = events.filter((e) => e.payload.seq > afterSeq);
  if (limit === undefined || after.length <= limit)
    return { events: after, lastSeq, hasMore: false };
  return { events: after.slice(0, limit), lastSeq, hasMore: true };
}

/** Facts left open in a log when its session stopped without finishing them (a crash). */
export interface Unfinished {
  turn: { turnId: string; startedAt: number } | null;
  messages: { turnId: string; messageId: string }[];
  tools: { turnId: string; toolCallId: string; toolName: string }[];
  requests: { kind: "permission" | "question" | "plan"; turnId: string; requestId: string }[];
  compaction: { compactionId: string; contextUsed: number } | null;
  /** Background commands last reported running. */
  background: BackgroundTask[];
  /** The last status reported. */
  status: string | null;
}

export function findUnfinished(events: readonly LoggedEvent[]): Unfinished {
  let turn: Unfinished["turn"] = null;
  const messages = new Map<string, string>();
  const tools = new Map<string, { turnId: string; toolName: string }>();
  const requests = new Map<
    string,
    { kind: Unfinished["requests"][number]["kind"]; turnId: string }
  >();
  let compaction: Unfinished["compaction"] = null;
  const background = new Map<string, BackgroundTask>();
  let status: string | null = null;
  for (const { event, payload: p } of events) {
    switch (event) {
      case "turn.started":
        turn = { turnId: String(p.turnId), startedAt: p.time };
        break;
      case "turn.finished":
        turn = null;
        break;
      case "message.started":
        messages.set(String(p.messageId), String(p.turnId));
        break;
      case "message.finished":
        messages.delete(String(p.messageId));
        break;
      case "tool.started":
        tools.set(String(p.toolCallId), { turnId: String(p.turnId), toolName: String(p.toolName) });
        break;
      case "tool.finished":
        tools.delete(String(p.toolCallId));
        break;
      case "permission.requested": {
        const request = p.request as { requestId: string };
        requests.set(request.requestId, { kind: "permission", turnId: String(p.turnId) });
        break;
      }
      case "question.asked":
        requests.set(String(p.requestId), { kind: "question", turnId: String(p.turnId) });
        break;
      case "plan.proposed":
        requests.set(String(p.requestId), { kind: "plan", turnId: String(p.turnId) });
        break;
      case "request.resolved":
        requests.delete(String(p.requestId));
        break;
      case "compaction.started":
        compaction = { compactionId: String(p.compactionId), contextUsed: Number(p.contextUsed) };
        break;
      case "compaction.finished":
        compaction = null;
        break;
      case "background.updated": {
        const task = p.task as BackgroundTask;
        if (task.status === "running") background.set(task.taskId, task);
        else background.delete(task.taskId);
        break;
      }
      case "session.status":
        status = String(p.status);
        break;
      default:
        break;
    }
  }
  return {
    turn,
    messages: [...messages].map(([messageId, turnId]) => ({ messageId, turnId })),
    tools: [...tools].map(([toolCallId, t]) => ({ toolCallId, ...t })),
    requests: [...requests].map(([requestId, r]) => ({ requestId, ...r })),
    compaction,
    background: [...background.values()],
    status,
  };
}

/**
 * Emits the events that close whatever a crash left open, so every client sees each started
 * fact finish (protocol README, ordering rules 2 to 6).
 */
export function closeUnfinished(log: EventLog, now: number): void {
  const open = findUnfinished(log.all());
  for (const r of open.requests) {
    log.emit("request.resolved", {
      kind: r.kind,
      turnId: r.turnId,
      requestId: r.requestId,
      outcome: "cancelled",
      response: null,
    });
  }
  for (const t of open.tools) {
    log.emit("tool.finished", {
      turnId: t.turnId,
      toolCallId: t.toolCallId,
      toolName: t.toolName,
      outcome: "interrupted",
      content: [
        { type: "text", text: "Interrupted: the session stopped before this call finished." },
      ],
      display: null,
      durationMs: null,
    });
  }
  for (const m of open.messages) {
    log.emit("message.finished", {
      turnId: m.turnId,
      messageId: m.messageId,
      text: "",
      reasoning: null,
      toolCalls: [],
    });
  }
  if (open.compaction !== null) {
    log.emit("compaction.finished", {
      compactionId: open.compaction.compactionId,
      outcome: "interrupted",
      summary: null,
      contextBefore: Math.max(0, Math.floor(open.compaction.contextUsed)),
      contextAfter: null,
      error: null,
    });
  }
  if (open.turn !== null) {
    log.emit("turn.finished", {
      turnId: open.turn.turnId,
      stopReason: "interrupted",
      finalText: null,
      error: null,
      durationMs: Math.max(0, now - open.turn.startedAt),
    });
  }
  // The engine that watched them is gone; to clients they ended with the session.
  for (const task of open.background) {
    log.emit("background.updated", {
      task: {
        ...task,
        status: "stopped",
        stopReason: "session_end",
        endedAt: Math.max(now, task.startedAt),
      },
    });
  }
  if (open.status !== null && open.status !== "idle" && open.status !== "error") {
    log.emit("session.status", { status: "idle", waitingOn: null, message: null });
  }
}
