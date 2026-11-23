/**
 * The reducer's bookkeeping between events (`SessionView.internals`).
 *
 * The reducer must remember a few facts that no view model shows: when the message in flight
 * started (a replay drops the deltas that would time the reasoning), the first read-progress
 * sample of a request (for the read rate), the usage totals when a turn started (for the turn
 * summary), the mode before plan mode, and hidden tool calls (TodoWrite, AskUserQuestion,
 * ExitPlanMode) in case one finishes without its own item. Keeping them on the session keeps the
 * reducer `(EngineSlice, input) => EngineSlice`, and a replay rebuilds them like everything else.
 */
import type { PermissionMode } from "@dawg/protocol";

/** Session usage totals when a turn started, so its summary can count over the turn. */
export interface UsageTotals {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
}

/** A hidden tool call (no tool item while it runs), kept until it finishes. */
export interface HiddenCall {
  turnId: string;
  messageId: string;
  toolName: string;
  input: Record<string, unknown>;
  time: number;
  seq: number;
}

export interface SessionInternals {
  /** `message.started` of the message in flight. */
  messageStart: { messageId: string; time: number } | null;
  /** First `prompt.progress` sample of the request being read. */
  progressStart: { turnId: string; total: number; time: number; processed: number } | null;
  /** Usage totals when the running (or last) turn started; null before any turn was applied. */
  turnStart: UsageTotals | null;
  /**
   * Totals from the latest `usage.updated` applied. Kept apart from `SessionView.usage`, which a
   * snapshot sets to the current value while a replay is still walking through history.
   */
  eventTotals: UsageTotals | null;
  /** The mode as of the latest `session.updated` applied, or null before any. */
  eventMode: PermissionMode | null;
  /** The mode before the session last switched to plan mode. */
  modeBeforePlan: PermissionMode | null;
  hiddenCalls: Readonly<Record<string, HiddenCall>>;
}

/** Fresh bookkeeping for a new session (or one rebuilt from a replay from 0). */
export function emptyInternals(): SessionInternals {
  return {
    messageStart: null,
    progressStart: null,
    turnStart: null,
    eventTotals: null,
    eventMode: null,
    modeBeforePlan: null,
    hiddenCalls: {},
  };
}
