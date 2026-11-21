import type { ErrorInfo, EventName, EventPayloadInput, StopReason } from "@dawg/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event's payload without the fields every event gets from the session (id, seq, time). */
export type EventFields<E extends EventName> = DistributiveOmit<
  EventPayloadInput<E>,
  "sessionId" | "seq" | "time"
>;

/** Emits one event for the session. Synchronous: events go out in the order emitted. */
export type Emit = <E extends EventName>(event: E, fields: EventFields<E>) => void;

/** What an id is for, so a generator can make readable ids in tests. */
export type IdKind = "message" | "request" | "call" | "compaction";

export interface LoopLimits {
  /** Model requests in one turn before it stops with "turn_limit". */
  maxRequestsPerTurn: number;
  /** Pause before retrying a request that failed in a way that may pass. */
  retryDelayMs: number;
  /** The same call with the same result this many times running adds a "repeating" note. */
  repeatNoteAt: number;
  /** ... and this many times running stops the turn. */
  repeatStopAt: number;
  /** Replies cut off by the output limit in a row, with nothing usable, before the turn stops. */
  maxCutOffInARow: number;
  /** A tool result longer than this (characters of text) is saved to a file and summarised. */
  maxResultChars: number;
  /** How much of a saved result the model still sees inline. */
  resultPreviewChars: number;
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxRequestsPerTurn: 200,
  retryDelayMs: 500,
  repeatNoteAt: 3,
  repeatStopAt: 5,
  maxCutOffInARow: 3,
  maxResultChars: 100_000,
  resultPreviewChars: 2_000,
};

/** How a turn ended, as the loop reports it. */
export interface LoopResult {
  stopReason: StopReason;
  /** Text of the turn's last assistant message, when it had any. */
  finalText: string | null;
  error: ErrorInfo | null;
}
