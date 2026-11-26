/**
 * UI state that follows from a reducer batch: seen marks, "Stopped by you", the turns that ended
 * (the store sends or holds queued messages for those), and sessions that were deleted (their UI
 * state is dropped; the store picks another selection). Pure: compares the sessions before and
 * after the batch, so a replayed or duplicate event that changes nothing triggers nothing.
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
  /** Sessions that left the state in this batch (deleted). */
  removed: SessionId[];
}

function without<T>(record: Record<string, T>, ids: readonly string[]): Record<string, T> {
  if (!ids.some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

/** Drops everything the UI keeps for these sessions: drafts, images, queued messages, marks. */
export function forgetSessions(ui: UiState, ids: readonly SessionId[]): UiState {
  if (ids.length === 0) return ui;
  const next: UiState = {
    ...ui,
    drafts: without(ui.drafts, ids),
    attachments: without(ui.attachments, ids),
    mentionPaths: without(ui.mentionPaths, ids),
    queues: without(ui.queues, ids),
    openItems: without(ui.openItems, ids),
    shownAgain: without(ui.shownAgain, ids),
    seenSeq: without(ui.seenSeq, ids),
    markedUnread: without(ui.markedUnread, ids),
    stoppedByUser: without(ui.stoppedByUser, ids),
  };
  const keys = Object.keys(next) as (keyof UiState)[];
  return keys.every((key) => next[key] === ui[key]) ? ui : next;
}

export function followUps(
  prev: Pick<AppState, "sessions" | "ui" | "layout">,
  next: EngineSlice,
): FollowUps {
  const ended: TurnEnded[] = [];
  const removed: SessionId[] = [];
  if (next.sessions === prev.sessions) return { ui: prev.ui, ended, removed };
  for (const id of Object.keys(prev.sessions)) {
    if (!(id in next.sessions)) removed.push(id);
  }
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

  const ui =
    seenSeq === prev.ui.seenSeq && stoppedByUser === prev.ui.stoppedByUser
      ? prev.ui
      : { ...prev.ui, seenSeq, stoppedByUser };
  return { ui: forgetSessions(ui, removed), ended, removed };
}
