/**
 * Copy-on-write working state for one batch of reducer inputs.
 *
 * While streaming, a frame carries dozens of events for the same session. Copying the session
 * map, the session and its transcript array for every event would be quadratic in the length of
 * the transcript, so a batch copies each container at most once, on first write, and mutates its
 * own copies afterwards. The input state is never mutated; anything a batch does not touch keeps
 * its object identity, which is what lets selectors and components skip work.
 */
import type { SessionId } from "@dawg/protocol";
import type { EngineSlice, PendingRef, Project, SessionView, TranscriptItem } from "./types.ts";

/** A session the batch owns: a copy, with its own copy of `internals`, safe to mutate. */
export type MutableSession = SessionView;

export interface Draft {
  readonly base: EngineSlice;
  projects: Record<string, Project>;
  sessions: Record<SessionId, SessionView>;
  transcripts: Record<SessionId, TranscriptItem[]>;
  pending: Record<SessionId, PendingRef[]>;
  owned: { projects: boolean; sessions: boolean; transcripts: boolean; pending: boolean };
  ownSessions: Set<SessionId>;
  ownTranscripts: Set<SessionId>;
  ownPending: Set<SessionId>;
}

export function createDraft(base: EngineSlice): Draft {
  return {
    base,
    projects: base.projects,
    sessions: base.sessions,
    transcripts: base.transcripts,
    pending: base.pending,
    owned: { projects: false, sessions: false, transcripts: false, pending: false },
    ownSessions: new Set(),
    ownTranscripts: new Set(),
    ownPending: new Set(),
  };
}

/** The resulting slice; the base itself when the batch changed nothing. */
export function finishDraft(draft: Draft): EngineSlice {
  const { base, owned } = draft;
  if (!owned.projects && !owned.sessions && !owned.transcripts && !owned.pending) return base;
  return {
    projects: draft.projects,
    sessions: draft.sessions,
    transcripts: draft.transcripts,
    pending: draft.pending,
  };
}

// --- Sessions --------------------------------------------------------------------------------

export function readSession(draft: Draft, id: SessionId): SessionView | undefined {
  return draft.sessions[id];
}

function sessionsMap(draft: Draft): Record<SessionId, SessionView> {
  if (!draft.owned.sessions) {
    draft.sessions = { ...draft.sessions };
    draft.owned.sessions = true;
  }
  return draft.sessions;
}

/** The session, writable. Undefined when it does not exist. */
export function writeSession(draft: Draft, id: SessionId): MutableSession | undefined {
  const current = draft.sessions[id];
  if (!current) return undefined;
  if (draft.ownSessions.has(id)) return current;
  const copy: MutableSession = { ...current, internals: { ...current.internals } };
  sessionsMap(draft)[id] = copy;
  draft.ownSessions.add(id);
  return copy;
}

/** Adds or replaces a whole session. */
export function putSession(draft: Draft, session: MutableSession): void {
  sessionsMap(draft)[session.id] = session;
  draft.ownSessions.add(session.id);
}

// --- Transcripts -----------------------------------------------------------------------------

const NO_ITEMS: readonly TranscriptItem[] = Object.freeze([]);

export function readItems(draft: Draft, id: SessionId): readonly TranscriptItem[] {
  return draft.transcripts[id] ?? NO_ITEMS;
}

/** The session's transcript, writable (created empty when missing). */
export function writeItems(draft: Draft, id: SessionId): TranscriptItem[] {
  if (!draft.owned.transcripts) {
    draft.transcripts = { ...draft.transcripts };
    draft.owned.transcripts = true;
  }
  if (!draft.ownTranscripts.has(id)) {
    draft.transcripts[id] = [...(draft.transcripts[id] ?? [])];
    draft.ownTranscripts.add(id);
  }
  return draft.transcripts[id] as TranscriptItem[];
}

/** Replaces the whole transcript. */
export function setItems(draft: Draft, id: SessionId, items: TranscriptItem[]): void {
  if (!draft.owned.transcripts) {
    draft.transcripts = { ...draft.transcripts };
    draft.owned.transcripts = true;
  }
  draft.transcripts[id] = items;
  draft.ownTranscripts.add(id);
}

// --- Pending requests ------------------------------------------------------------------------

const NO_PENDING: readonly PendingRef[] = Object.freeze([]);

export function readPending(draft: Draft, id: SessionId): readonly PendingRef[] {
  return draft.pending[id] ?? NO_PENDING;
}

export function setPending(draft: Draft, id: SessionId, refs: PendingRef[]): void {
  if (!draft.owned.pending) {
    draft.pending = { ...draft.pending };
    draft.owned.pending = true;
  }
  draft.pending[id] = refs;
  draft.ownPending.add(id);
}

// --- Projects --------------------------------------------------------------------------------

export function ensureProject(draft: Draft, dir: string, name: string): void {
  const current = draft.projects[dir];
  if (current && current.name === name) return;
  if (!draft.owned.projects) {
    draft.projects = { ...draft.projects };
    draft.owned.projects = true;
  }
  draft.projects[dir] = { dir, name };
}
