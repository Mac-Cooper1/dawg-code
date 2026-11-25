/**
 * What the sidebar says about a session: its status mark and the line under its title.
 *
 * Precedence, highest first: needs you (a pending card) → queued for the model → working →
 * error → done, unread → idle. A queued session is "working" with a `queuePosition`; the engine's
 * status message is its own wording and is not read.
 */
import { permissionNeed, toolActivity } from "../lib/tools.ts";
import { indexOfId, itemIds } from "./transcript-events.ts";
import type { PendingRef, SessionView, SidebarMark, TranscriptItem } from "./types.ts";

export const MARK_LABELS: Record<SidebarMark, string> = {
  working: "Working",
  "needs-you": "Needs you",
  unread: "Done, unread",
  queued: "Queued",
  error: "Error",
  idle: "Idle",
};

export interface MarkInput {
  session: SessionView;
  pending: readonly PendingRef[];
  items: readonly TranscriptItem[];
  /** `ui.seenSeq` for the session; undefined before the store has seen it. */
  seenSeq: number | undefined;
  markedUnread: boolean;
  stoppedByUser: boolean;
  selected: boolean;
  /** Sessions waiting for the model, this one included. Above 1, a queued row shows its place. */
  queuedCount?: number;
}

export interface MarkInfo {
  mark: SidebarMark;
  subtitle: string | null;
}

export function isQueuedForModel(session: SessionView): boolean {
  return session.status === "working" && session.queuePosition !== null;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 23 → "23rd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * "Queued: waits for the model", or its place in line when several sessions wait:
 * "Queued: next in line for the model", "Queued: 2nd in line for the model".
 */
export function queuedSubtitle(position: number | null, queuedCount = 1): string {
  if (position === null || (position === 1 && queuedCount <= 1)) {
    return "Queued: waits for the model";
  }
  if (position === 1) return "Queued: next in line for the model";
  return `Queued: ${ordinal(position)} in line for the model`;
}

export function isWorking(session: SessionView): boolean {
  return session.status === "working" || session.activeTurnId !== null;
}

/** "The model stopped responding." → "the model stopped responding" (acronyms keep their case). */
export function sentenceFragment(message: string): string {
  const trimmed = message.trim().replace(/(?<!\.)\.$/, "");
  const first = trimmed.charAt(0);
  const second = trimmed.charAt(1);
  if (second !== "" && second === second.toUpperCase() && second !== second.toLowerCase()) {
    return trimmed;
  }
  return first.toLowerCase() + trimmed.slice(1);
}

function needSubtitle(
  ref: PendingRef | undefined,
  items: readonly TranscriptItem[],
  waitingOn: SessionView["waitingOn"],
): string {
  const kind = ref?.kind ?? waitingOn;
  switch (kind) {
    case "question":
      return "Needs you: answer a question";
    case "plan":
      return "Needs you: approve a plan";
    case "permission": {
      const item = ref ? items[indexOfId(items, itemIds.permission(ref.requestId))] : undefined;
      return item?.kind === "permission"
        ? `Needs you: ${permissionNeed(item.request)}`
        : "Needs you";
    }
    default:
      return "Needs you";
  }
}

/** The latest call still running in the current turn. */
function runningTool(session: SessionView, items: readonly TranscriptItem[]) {
  const turnId = session.activeTurnId;
  if (turnId === null) return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "user" && item.turnId === turnId) break;
    if (item.kind === "tool" && item.state === "running" && item.turnId === turnId) return item;
  }
  return null;
}

function lastErrorMessage(session: SessionView, items: readonly TranscriptItem[]): string | null {
  if (session.lastTurn?.error) return session.lastTurn.error.message;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind === "error") return item.error.message;
    if (item?.kind === "user") break;
  }
  return session.statusMessage;
}

/** A turn finished after the person last looked (or the session is marked by hand). */
export function isUnread(input: MarkInput): boolean {
  if (input.selected) return false;
  if (input.markedUnread) return true;
  const seen = input.seenSeq;
  if (seen === undefined) return false;
  const { session } = input;
  const finished = session.lastTurn?.finishedSeq;
  if (finished !== undefined && finished !== null) return finished > seen;
  // Not replayed yet: anything newer than the seen mark in a settled session is a finished turn.
  return session.lastTurn === null && session.status === "idle" && session.summary.lastSeq > seen;
}

export function sessionMark(input: MarkInput): MarkInfo {
  const { session, pending, items } = input;
  if (pending.length > 0 || session.status === "waiting") {
    return { mark: "needs-you", subtitle: needSubtitle(pending[0], items, session.waitingOn) };
  }
  if (isQueuedForModel(session)) {
    return { mark: "queued", subtitle: queuedSubtitle(session.queuePosition, input.queuedCount) };
  }
  if (isWorking(session)) {
    const tool = runningTool(session, items);
    const subtitle = tool
      ? `Working: ${toolActivity(tool.toolName, tool.input)}`
      : (session.statusMessage ?? "Working");
    return { mark: "working", subtitle };
  }
  if (session.status === "error") {
    const message = lastErrorMessage(session, items);
    return {
      mark: "error",
      subtitle: message ? `Error: ${sentenceFragment(message)}` : "Error: the last turn failed",
    };
  }
  if (isUnread(input)) return { mark: "unread", subtitle: "Done, not opened yet" };
  return { mark: "idle", subtitle: input.stoppedByUser ? "Stopped by you" : null };
}
