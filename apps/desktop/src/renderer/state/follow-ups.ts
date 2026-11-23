/**
 * UI state that follows from a reducer batch: seen marks, "Stopped by you", and the turns that
 * ended (the store sends or holds queued messages for those). Pure: compares the sessions before
 * and after the batch, so a replayed or duplicate event that changes nothing triggers nothing.
 */
import type { SessionId, StopReason } from "@dawg/protocol";
import type { AppState, EngineSlice, UiState } from "./types.ts";

export interface TurnEnded {
  sessionId: SessionId;
  turnId: string;
  stopReason: StopReason;
}

export interface FollowUps {
  /** The new UI state; the previous object when nothing changed. */
  ui: UiState;
  /** Turns that ended in this batch, leaving their session idle. */
  ended: TurnEnded[];
}

export function followUps(
  prev: Pick<AppState, "sessions" | "ui" | "layout">,
  next: EngineSlice,
): FollowUps {
  const ended: TurnEnded[] = [];
  if (next.sessions === prev.sessions) return { ui: prev.ui, ended };
  let seenSeq = prev.ui.seenSeq;
  let stoppedByUser = prev.ui.stoppedByUser;
  const selected = prev.layout.selectedSessionId;

  for (const [id, session] of Object.entries(next.sessions)) {
    const before = prev.sessions[id];
    if (before === session) continue;
    const latest = Math.max(session.highWaterSeq, session.summary.lastSeq);
    if (!before) {
      // First sight: everything up to now counts as seen, so a fresh install starts with
      // nothing unread and only turns that finish while the app is open show "Done, unread".
      if (seenSeq[id] === undefined) seenSeq = { ...seenSeq, [id]: latest };
    } else if (session.highWaterSeq < before.highWaterSeq) {
      // The engine restarted from scratch and the transcript is being rebuilt.
      seenSeq = { ...seenSeq, [id]: session.summary.lastSeq };
    }
    if (id === selected && (seenSeq[id] ?? 0) < session.highWaterSeq) {
      seenSeq = { ...seenSeq, [id]: session.highWaterSeq };
    }
    if (session.activeTurnId !== null && session.activeTurnId !== before?.activeTurnId) {
      if (stoppedByUser[id]) {
        const { [id]: _cleared, ...rest } = stoppedByUser;
        stoppedByUser = rest;
      }
    }
    const turn = session.lastTurn;
    // Only once loaded: a replay walking through history must not send queued messages.
    if (
      before &&
      session.loaded &&
      turn !== null &&
      turn.stopReason !== null &&
      turn.finishedSeq !== null &&
      turn.finishedSeq !== before.lastTurn?.finishedSeq &&
      session.activeTurnId === null
    ) {
      ended.push({ sessionId: id, turnId: turn.turnId, stopReason: turn.stopReason });
    }
  }

  if (seenSeq === prev.ui.seenSeq && stoppedByUser === prev.ui.stoppedByUser) {
    return { ui: prev.ui, ended };
  }
  return { ui: { ...prev.ui, seenSeq, stoppedByUser }, ended };
}
