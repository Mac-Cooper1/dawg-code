/**
 * Hand-built event streams for the reducer tests. Every event goes through `parseEvent`, so a
 * stream that would not pass the protocol's schemas fails the test that builds it.
 */
import {
  type EngineEvent,
  type EventName,
  type EventPayloadInput,
  type ModelInfo,
  parseEvent,
  type SessionSnapshot,
  type SessionSummary,
  type Usage,
} from "@dawg/protocol";
import { reduceAll } from "../reducer.ts";
import type { EngineSlice, ReducerInput, TranscriptItem } from "../types.ts";

export const T0 = 1_763_800_000_000;
export const HOME = "/Users/you";
export const PROJECT = "/Users/you/code/tally";

type Fields<E extends EventName> = Omit<EventPayloadInput<E>, "sessionId" | "seq" | "time">;

export function makeEvent<E extends EventName>(
  event: E,
  payload: EventPayloadInput<E>,
): EngineEvent {
  const parsed = parseEvent(event, payload);
  if (!parsed.ok) {
    throw new Error(
      `Invalid ${event} in a test stream: ${parsed.reason === "invalid" ? parsed.error.message : parsed.reason}`,
    );
  }
  return parsed.event;
}

export interface Stream {
  readonly sessionId: string;
  readonly events: EngineEvent[];
  /** Appends an event with the next seq; `dt` ms after the previous one (default 100). */
  emit<E extends EventName>(event: E, fields: Fields<E>, dt?: number): EngineEvent;
  readonly seq: number;
  readonly time: number;
}

export function createStream(
  sessionId = "s1",
  options: { seq?: number; time?: number } = {},
): Stream {
  let seq = options.seq ?? 0;
  let time = options.time ?? T0;
  const events: EngineEvent[] = [];
  return {
    sessionId,
    events,
    emit(event, fields, dt = 100) {
      seq += 1;
      time += dt;
      const built = makeEvent(event, {
        ...fields,
        sessionId,
        seq,
        time,
      } as EventPayloadInput<typeof event>);
      events.push(built);
      return built;
    },
    get seq() {
      return seq;
    },
    get time() {
      return time;
    },
  };
}

export const MODEL_INFO: ModelInfo = {
  id: "qwen3.8-27b-q8",
  contextWindow: 204_800,
  vision: true,
  reasoning: true,
  effortLevels: ["low", "medium", "high", "xhigh"],
};

export function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `Session ${id}`,
    cwd: PROJECT,
    projectDir: PROJECT,
    createdAt: T0 - 60_000,
    lastActivityAt: T0,
    status: "idle",
    mode: "default",
    model: MODEL_INFO.id,
    effort: null,
    archived: false,
    forkedFrom: null,
    lastSeq: 0,
    ...overrides,
  };
}

export function makeSnapshot(
  summary: SessionSummary,
  overrides: Partial<Omit<SessionSnapshot, "session">> = {},
): SessionSnapshot {
  return {
    session: summary,
    modelInfo: MODEL_INFO,
    additionalDirectories: [],
    tasks: [],
    usage: null,
    pending: [],
    activeTurnId: null,
    commands: [
      { name: "compact", description: "Summarise the conversation", argumentHint: "[focus]" },
      { name: "help", description: "Show help", argumentHint: null },
    ],
    ...overrides,
  };
}

export function makeUsage(
  totals: { requests: number; promptTokens: number; cachedTokens: number },
  contextUsed = 74_200,
): Usage {
  return {
    contextWindow: 204_800,
    contextUsed,
    last: {
      promptTokens: 18_000,
      completionTokens: 400,
      cachedTokens: 16_000,
      promptTokensPerSecond: 900,
      completionTokensPerSecond: 41,
    },
    totals: { ...totals, completionTokens: totals.requests * 300, malformedToolCalls: 0 },
  };
}

/** Events the engine leaves out of a replay of finished messages and tools. */
const STREAMING = new Set(["message.delta", "reasoning.delta", "tool.progress", "prompt.progress"]);

export function withoutStreaming(events: readonly EngineEvent[]): EngineEvent[] {
  return events.filter((event) => !STREAMING.has(event.event));
}

/** A fresh slice with the session open (as after `session.resume`). */
export function openSession(
  summary: SessionSummary,
  overrides: Partial<Omit<SessionSnapshot, "session">> = {},
): EngineSlice {
  return reduceAll({ projects: {}, sessions: {}, transcripts: {}, pending: {} }, [
    { type: "snapshot", snapshot: makeSnapshot(summary, overrides) },
  ]);
}

/** Applies events one at a time as live events. */
export function applyLive(state: EngineSlice, events: readonly EngineEvent[]): EngineSlice {
  let next = state;
  for (const event of events) next = reduceAll(next, [{ type: "event", event }]);
  return next;
}

/** Applies events as replay pages of `pageSize`, the last one marked done. */
export function applyReplay(
  state: EngineSlice,
  sessionId: string,
  events: readonly EngineEvent[],
  pageSize = 50,
): EngineSlice {
  const inputs: ReducerInput[] = [];
  for (let start = 0; start < events.length; start += pageSize) {
    inputs.push({
      type: "replay",
      sessionId,
      events: events.slice(start, start + pageSize),
      done: start + pageSize >= events.length,
    });
  }
  if (inputs.length === 0) inputs.push({ type: "replay", sessionId, events: [], done: true });
  let next = state;
  for (const input of inputs) next = reduceAll(next, [input]);
  return next;
}

/**
 * Items with the fields that depend on streamed deltas removed: which event created a text or
 * reasoning item, reasoning timing, and live tool output. Everything else must match between a
 * live stream and a replay that dropped the deltas.
 */
export function comparable(items: readonly TranscriptItem[]): unknown[] {
  return items.map((item) => {
    switch (item.kind) {
      case "assistant": {
        const { seq: _seq, ...rest } = item;
        return rest;
      }
      case "reasoning": {
        const { seq: _seq, startedAt: _startedAt, durationMs: _durationMs, ...rest } = item;
        return rest;
      }
      case "tool": {
        const { output: _output, statusLine: _statusLine, ...rest } = item;
        return rest;
      }
      default:
        return item;
    }
  });
}
