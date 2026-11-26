/**
 * Notifications and the Dock badge, from the window's side (spec: "Notifications and dock").
 *
 * The watcher follows the store. Per session it derives what the sidebar shows
 * (session-marks.ts) and asks main for a notification on live transitions only:
 * - into "Needs you" (a permission, question or plan waits), or on to a newer decision;
 * - into "Finished": a turn completed (the sidebar's "Done, unread" case);
 * - into "The turn failed": a turn ended in error, or the session went into error.
 * A stopped turn is the person's own doing and says nothing; neither does a finished one with a
 * queued message about to go.
 *
 * Only batches of live events count (`liveBatches`, bumped by the store). What the window catches
 * up on (the session list at startup, a snapshot, a replay, the resume after an engine restart)
 * never notifies. Nor does a session the person is looking at: selected, in the sessions view of
 * a focused window. Main shows nothing while any dawg window is focused, or with notifications
 * turned off in Settings → General.
 *
 * The text is the sidebar's wording ("Needs you: run a command", "Finished", "The turn failed")
 * under the session's title. Never model output: a notification can show on a locked screen.
 *
 * The Dock badge is the number of sessions that need the person (archived ones left out, as in
 * the sidebar), sent at most once per `badgeDelayMs` with the latest count, and only when it
 * changed. Clicking a notification (`onOpenSession`) selects the session, leaving Settings; first
 * run stays until a model runs, with the session selected behind it.
 */
import type { SessionId } from "@dawg/protocol";
import type { StoreApi } from "zustand";
import type { AttentionReason, DawgBridge, NotifyInput } from "../../shared/bridge.ts";
import { sessionMark } from "./session-marks.ts";
import type { AppStore, PendingRef, SessionView, TranscriptItem } from "./types.ts";

export const ATTENTION_BODY = {
  finished: "Finished",
  failed: "The turn failed",
} as const;

/** The title main is given when a session has none yet, as the sidebar shows it. */
export const UNTITLED = "New session";

/** Longest title `NotifyInputSchema` takes. */
const MAX_TITLE = 200;

/** A session waiting on the person before the request itself has arrived. */
const WAITING = "waiting";

export const DEFAULT_BADGE_DELAY_MS = 250;

const EMPTY_PENDING: readonly PendingRef[] = Object.freeze([]);
const EMPTY_ITEMS: readonly TranscriptItem[] = Object.freeze([]);

export interface AttentionWatcherDeps {
  store: Pick<StoreApi<AppStore>, "getState" | "subscribe">;
  notifications: DawgBridge["notifications"];
  /** True while this window has focus (`document.hasFocus()`). */
  isWindowFocused(): boolean;
  /** How long a changed badge count waits before it is sent. Default 250 ms. */
  badgeDelayMs?: number;
}

export interface AttentionWatcher {
  /** Stops watching; a badge count still waiting is dropped. */
  dispose(): void;
}

/** What the watcher remembers of a session between store updates. */
interface Seen {
  session: SessionView;
  pending: readonly PendingRef[];
  live: number;
  /** While it needs the person: the oldest pending request, or `WAITING`. Else null. */
  need: string | null;
  error: boolean;
  finishedSeq: number | null;
  /** The turn a failure was last reported for, so its end and the error status say it once. */
  failedTurn: string | null;
}

function needOf(session: SessionView, pending: readonly PendingRef[]): string | null {
  const first = pending[0];
  if (first) return first.requestId;
  return session.status === "waiting" ? WAITING : null;
}

/** Sessions that need the person: what the Dock badge counts. */
export function countNeedingYou(state: Pick<AppStore, "sessions" | "pending">): number {
  let count = 0;
  for (const session of Object.values(state.sessions)) {
    if (session.summary.archived) continue;
    if ((state.pending[session.id]?.length ?? 0) > 0 || session.status === "waiting") count++;
  }
  return count;
}

export function createAttentionWatcher(deps: AttentionWatcherDeps): AttentionWatcher {
  const { store, notifications } = deps;
  const delay = deps.badgeDelayMs ?? DEFAULT_BADGE_DELAY_MS;
  const seen = new Map<SessionId, Seen>();
  let badgeSent: number | null = null;
  let badgeTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function observe(state: AppStore, session: SessionView, before: Seen | undefined): Seen {
    const pending = state.pending[session.id] ?? EMPTY_PENDING;
    return {
      session,
      pending,
      live: state.liveBatches[session.id] ?? 0,
      need: needOf(session, pending),
      error: session.status === "error",
      finishedSeq: session.lastTurn?.finishedSeq ?? null,
      failedTurn: before?.failedTurn ?? null,
    };
  }

  /** Selected, in the sessions view (not Settings or first run), in a focused window. */
  function isLooking(state: AppStore, id: SessionId): boolean {
    if (state.layout.selectedSessionId !== id || state.layout.view !== "sessions") return false;
    if (state.onboarding !== null && state.modelsState !== null) return false;
    return deps.isWindowFocused();
  }

  /** What a live batch did to the session that the person should hear about, if anything. */
  function reasonFor(state: AppStore, before: Seen, now: Seen): AttentionReason | null {
    if (now.need !== null) {
      const entered = before.need === null;
      // A newer decision replaced the one the person was told about.
      const newer =
        before.need !== null &&
        before.need !== WAITING &&
        now.need !== WAITING &&
        before.need !== now.need;
      return entered || newer ? "needs-you" : null;
    }
    const turn = now.session.lastTurn;
    // The turn that ended in this batch, if one did.
    const ended = now.finishedSeq !== null && now.finishedSeq !== before.finishedSeq ? turn : null;
    if (ended?.stopReason === "error") return "failed";
    const reported = turn !== null && turn.turnId === now.failedTurn;
    if (now.error && !before.error && !reported) return "failed";
    if (ended === null || (ended.stopReason !== "completed" && ended.stopReason !== "turn_limit")) {
      return null;
    }
    if (now.session.activeTurnId !== null || now.error) return null;
    // The person queued a follow-up: it goes next, so the work is not done.
    const queued = state.ui.queues[now.session.id]?.some((message) => message.state === "queued");
    return queued ? null : "finished";
  }

  function bodyFor(state: AppStore, reason: AttentionReason, session: SessionView): string {
    if (reason !== "needs-you") return ATTENTION_BODY[reason];
    const { subtitle } = sessionMark({
      session,
      pending: state.pending[session.id] ?? EMPTY_PENDING,
      items: state.transcripts[session.id] ?? EMPTY_ITEMS,
      seenSeq: undefined,
      markedUnread: false,
      stoppedByUser: false,
      selected: false,
    });
    return subtitle ?? "Needs you";
  }

  function notify(state: AppStore, reason: AttentionReason, session: SessionView): void {
    const input: NotifyInput = {
      sessionId: session.id,
      reason,
      title: (session.summary.title?.trim() || UNTITLED).slice(0, MAX_TITLE),
      body: bodyFor(state, reason, session),
    };
    // Main says why it showed nothing (focus, settings) only by answering false; a failure is
    // not worth more than that either.
    void notifications.show(input).catch(() => false);
  }

  function scheduleBadge(): void {
    if (badgeTimer !== null || disposed) return;
    // Not reset by later changes: a session streaming tokens changes the store every frame.
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      const count = Math.min(countNeedingYou(store.getState()), 9999);
      if (count === badgeSent) return;
      badgeSent = count;
      void notifications.setBadge(count).catch(() => {
        // Sent again with the next change.
        if (badgeSent === count) badgeSent = null;
      });
    }, delay);
  }

  function update(state: AppStore): void {
    for (const session of Object.values(state.sessions)) {
      const before = seen.get(session.id);
      const pending = state.pending[session.id] ?? EMPTY_PENDING;
      const live = state.liveBatches[session.id] ?? 0;
      if (before && before.session === session && before.pending === pending) {
        if (before.live !== live) before.live = live;
        continue;
      }
      const now = observe(state, session, before);
      if (before && now.live !== before.live && !session.summary.archived) {
        const reason = reasonFor(state, before, now);
        if (reason === "failed") now.failedTurn = session.lastTurn?.turnId ?? null;
        if (reason !== null && !isLooking(state, session.id)) notify(state, reason, session);
      }
      seen.set(session.id, now);
    }
    if (seen.size > Object.keys(state.sessions).length) {
      for (const id of [...seen.keys()]) if (!(id in state.sessions)) seen.delete(id);
    }
  }

  // What the store holds now is where the watcher starts: none of it notifies.
  const initial = store.getState();
  for (const session of Object.values(initial.sessions)) {
    seen.set(session.id, observe(initial, session, undefined));
  }
  scheduleBadge();

  /** A clicked notification's session, while the window is still loading the session list. */
  let wanted: SessionId | null = null;

  function select(sessionId: SessionId): void {
    wanted = null;
    // Outside the store's listeners, which this may run in.
    queueMicrotask(() => {
      if (!disposed) store.getState().actions.selectSession(sessionId);
    });
  }

  function followWanted(state: AppStore): void {
    if (wanted === null) return;
    if (wanted in state.sessions) select(wanted);
    // Connected and still unknown: deleted meanwhile.
    else if (state.connection.phase === "ready") wanted = null;
  }

  const unsubscribe = store.subscribe((state, prev) => {
    followWanted(state);
    if (
      state.sessions === prev.sessions &&
      state.pending === prev.pending &&
      state.liveBatches === prev.liveBatches
    ) {
      return;
    }
    update(state);
    scheduleBadge();
  });

  const stopOpening = notifications.onOpenSession((sessionId) => {
    const state = store.getState();
    if (sessionId in state.sessions) select(sessionId);
    else if (state.connection.phase !== "ready") wanted = sessionId;
    // Otherwise it was deleted: main brought the window forward, which is all there is to do.
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopOpening();
      if (badgeTimer !== null) clearTimeout(badgeTimer);
      badgeTimer = null;
    },
  };
}
