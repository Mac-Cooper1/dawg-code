/**
 * The event reducer: protocol events, snapshots and request results in, engine state out.
 *
 * Pure. `reduceAll` applies a batch with copy-on-write (see draft.ts), so everything the batch
 * did not touch keeps its object identity. Live events and replays take the same path; any event
 * whose `seq` is not above the session's high-water mark is ignored, which makes duplicates and
 * overlapping replays harmless. Events for a session the state does not know, or live events for
 * a session that is not open, are dropped: the connection holds them back until the session's
 * snapshot and replay are in (the protocol does not order a response against its events).
 */
import type {
  BackgroundTask,
  EngineEvent,
  PendingRequest,
  SessionId,
  SessionSnapshot,
  SessionSummary,
  SubagentInfo,
} from "@dawg/protocol";
import { basename } from "../lib/format.ts";
import {
  createDraft,
  type Draft,
  ensureProject,
  finishDraft,
  type MutableSession,
  putSession,
  readItems,
  readSession,
  removeSession,
  setItems,
  setPending,
  writeItems,
  writeSession,
} from "./draft.ts";
import { emptyInternals } from "./internals.ts";
import * as items from "./transcript-events.ts";
import type { CommandOutputItem, EngineSlice, PendingRef, Reducer, ReducerInput } from "./types.ts";

export function emptyEngineSlice(): EngineSlice {
  return { projects: {}, sessions: {}, transcripts: {}, pending: {} };
}

/** Applies one input. */
export const reduce: Reducer = (state, input) => reduceAll(state, [input]);

/** Applies a batch of inputs in order, copying each touched container once. */
export function reduceAll(state: EngineSlice, inputs: readonly ReducerInput[]): EngineSlice {
  const draft = createDraft(state);
  for (const input of inputs) applyInput(draft, input);
  return finishDraft(draft);
}

function applyInput(draft: Draft, input: ReducerInput): void {
  switch (input.type) {
    case "event":
      applyEvent(draft, input.event, true);
      return;
    case "snapshot":
      applySnapshot(draft, input.snapshot);
      return;
    case "summaries":
      for (const summary of input.sessions) applySummary(draft, summary);
      return;
    case "replay": {
      for (const event of input.events) {
        if (event.payload.sessionId === input.sessionId) applyEvent(draft, event, false);
      }
      if (input.done) {
        const session = readSession(draft, input.sessionId);
        if (session && !session.loaded) {
          const writable = writeSession(draft, input.sessionId);
          if (writable) writable.loaded = true;
        }
      }
      return;
    }
    case "deleted":
      removeSession(draft, input.sessionId);
      return;
    case "command-output":
      applyCommandOutput(draft, input.sessionId, input.command, input.output);
      return;
    case "disconnected":
      for (const session of Object.values(draft.sessions)) {
        if (!session.open) continue;
        const writable = writeSession(draft, session.id);
        if (!writable) continue;
        writable.open = false;
        writable.promptProgress = null;
        writable.internals.progressStart = null;
      }
      return;
  }
}

// --- Sessions ----------------------------------------------------------------------------------

function newSession(summary: SessionSummary, open: boolean): MutableSession {
  return {
    id: summary.id,
    summary,
    open,
    loaded: false,
    status: summary.status,
    waitingOn: null,
    statusMessage: null,
    queuePosition: summary.queuePosition,
    modelInfo: null,
    additionalDirectories: [],
    tasks: [],
    background: [],
    subagents: [],
    usage: null,
    commands: [],
    activeTurnId: null,
    promptProgress: null,
    compactionId: null,
    lastTurn: null,
    highWaterSeq: 0,
    internals: emptyInternals(),
  };
}

function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.cwd === b.cwd &&
    a.projectDir === b.projectDir &&
    a.createdAt === b.createdAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.status === b.status &&
    a.queuePosition === b.queuePosition &&
    a.mode === b.mode &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.archived === b.archived &&
    a.lastSeq === b.lastSeq &&
    JSON.stringify(a.forkedFrom) === JSON.stringify(b.forkedFrom)
  );
}

function addProject(draft: Draft, summary: SessionSummary): void {
  ensureProject(draft, summary.projectDir, basename(summary.projectDir));
}

/** A `session.list` row. Open sessions are kept current by their events, so they are skipped. */
function applySummary(draft: Draft, summary: SessionSummary): void {
  addProject(draft, summary);
  const existing = readSession(draft, summary.id);
  if (!existing) {
    putSession(draft, newSession(summary, false));
    return;
  }
  if (existing.open || sameSummary(existing.summary, summary)) return;
  const session = writeSession(draft, summary.id);
  if (!session) return;
  session.summary = summary;
  session.status = summary.status;
  session.waitingOn = null;
  session.statusMessage = null;
  session.queuePosition = summary.queuePosition;
}

function pendingRef(request: PendingRequest): PendingRef {
  switch (request.kind) {
    case "permission":
      return { kind: "permission", requestId: request.request.requestId, turnId: request.turnId };
    case "question":
      return { kind: "question", requestId: request.requestId, turnId: request.turnId };
    case "plan":
      return { kind: "plan", requestId: request.requestId, turnId: request.turnId };
    case "elicitation":
      return { kind: "elicitation", requestId: request.requestId, turnId: request.turnId };
  }
}

/**
 * The result of create, resume or fork. Sets everything the snapshot knows and opens the
 * session, but leaves the high-water mark alone: the replay that follows fills the transcript.
 * When the engine reports fewer events than were already applied, it restarted from scratch
 * (the mock engine does): the transcript is dropped and rebuilt from a replay from 0.
 */
function applySnapshot(draft: Draft, snapshot: SessionSnapshot): void {
  const summary = snapshot.session;
  addProject(draft, summary);
  const existing = readSession(draft, summary.id);
  const reset = existing !== undefined && summary.lastSeq < existing.highWaterSeq;
  let session: MutableSession;
  if (!existing || reset) {
    session = newSession(summary, true);
    putSession(draft, session);
    if (reset) setItems(draft, summary.id, []);
  } else {
    const writable = writeSession(draft, summary.id);
    if (!writable) return;
    session = writable;
    // A turn the engine no longer runs ended while this client was away.
    if (session.activeTurnId !== null && session.activeTurnId !== snapshot.activeTurnId) {
      items.closeTurnItems(draft, session, session.activeTurnId, summary.lastActivityAt);
    }
    if (session.status !== summary.status) session.statusMessage = null;
    session.summary = summary;
    session.open = true;
  }
  const refs = snapshot.pending.map(pendingRef);
  session.status = summary.status;
  session.queuePosition = summary.queuePosition;
  session.waitingOn = summary.status === "waiting" ? (refs[0]?.kind ?? null) : null;
  session.modelInfo = snapshot.modelInfo;
  session.additionalDirectories = snapshot.additionalDirectories;
  session.tasks = snapshot.tasks;
  session.background = snapshot.background;
  session.usage = snapshot.usage;
  session.commands = snapshot.commands;
  session.activeTurnId = snapshot.activeTurnId;
  if (snapshot.activeTurnId === null) {
    session.promptProgress = null;
    session.compactionId = null;
  }
  setPending(draft, summary.id, refs);
}

function applyCommandOutput(
  draft: Draft,
  sessionId: SessionId,
  command: string,
  output: string,
): void {
  const session = readSession(draft, sessionId);
  if (!session) return;
  const count = readItems(draft, sessionId).filter((item) => item.kind === "command-output").length;
  const item: CommandOutputItem = {
    kind: "command-output",
    id: `command-output:${session.highWaterSeq}:${count}`,
    turnId: null,
    seq: session.highWaterSeq,
    command,
    output,
  };
  writeItems(draft, sessionId).push(item);
}

// --- Events ------------------------------------------------------------------------------------

/** Keeps the sidebar's sort order current: activity moves a session up. */
function touch(session: MutableSession, time: number): void {
  if (time > session.summary.lastActivityAt) {
    session.summary = { ...session.summary, lastActivityAt: time };
  }
}

function applyEvent(draft: Draft, event: EngineEvent, live: boolean): void {
  const { sessionId, seq } = event.payload;
  // The session's last event, whether or not it is open here: it is gone.
  if (event.event === "session.deleted") {
    removeSession(draft, sessionId);
    return;
  }
  const current = readSession(draft, sessionId);
  if (!current) return;
  if (live && !current.open) return;
  if (seq <= current.highWaterSeq) return;
  const session = writeSession(draft, sessionId);
  if (!session) return;
  session.highWaterSeq = seq;

  switch (event.event) {
    case "session.status": {
      const p = event.payload;
      session.status = p.status;
      session.waitingOn = p.waitingOn;
      session.statusMessage = p.message;
      session.queuePosition = p.queuePosition;
      session.summary = {
        ...session.summary,
        status: p.status,
        queuePosition: p.queuePosition,
        lastActivityAt: Math.max(session.summary.lastActivityAt, p.time),
      };
      return;
    }
    case "session.updated": {
      const p = event.payload;
      session.summary = {
        ...session.summary,
        title: p.title,
        mode: p.mode,
        model: p.model,
        effort: p.effort,
        archived: p.archived,
      };
      session.modelInfo = p.modelInfo;
      session.additionalDirectories = p.additionalDirectories;
      return;
    }
    case "turn.started": {
      const p = event.payload;
      session.activeTurnId = p.turnId;
      session.lastTurn = { turnId: p.turnId, stopReason: null, error: null, finishedSeq: null };
      session.promptProgress = null;
      session.internals.progressStart = null;
      session.internals.turnStart = session.internals.eventTotals ?? {
        requests: 0,
        promptTokens: 0,
        cachedTokens: 0,
      };
      touch(session, p.time);
      items.turnStarted(draft, session, p);
      return;
    }
    case "turn.finished": {
      const p = event.payload;
      items.turnFinished(draft, session, p);
      session.activeTurnId = null;
      session.lastTurn = {
        turnId: p.turnId,
        stopReason: p.stopReason,
        error: p.error,
        finishedSeq: p.seq,
      };
      session.promptProgress = null;
      session.internals.progressStart = null;
      session.internals.messageStart = null;
      touch(session, p.time);
      return;
    }
    case "message.started":
      session.internals.messageStart = {
        messageId: event.payload.messageId,
        time: event.payload.time,
      };
      clearPromptProgress(session);
      return;
    case "message.delta":
      clearPromptProgress(session);
      items.messageDelta(draft, session, event.payload);
      return;
    case "reasoning.delta":
      clearPromptProgress(session);
      items.reasoningDelta(draft, session, event.payload);
      return;
    case "message.finished":
      clearPromptProgress(session);
      items.messageFinished(draft, session, event.payload);
      return;
    case "tool.started":
      clearPromptProgress(session);
      items.toolStarted(draft, session, event.payload);
      return;
    case "tool.progress":
      items.toolProgress(draft, session, event.payload);
      return;
    case "tool.finished":
      items.toolFinished(draft, session, event.payload);
      return;
    case "permission.requested":
      touch(session, event.payload.time);
      items.permissionRequested(draft, session, event.payload);
      return;
    case "question.asked":
      touch(session, event.payload.time);
      items.questionAsked(draft, session, event.payload);
      return;
    case "plan.proposed":
      touch(session, event.payload.time);
      items.planProposed(draft, session, event.payload);
      return;
    case "elicitation.requested":
      touch(session, event.payload.time);
      items.elicitationRequested(draft, session, event.payload);
      return;
    case "request.resolved":
      items.requestResolved(draft, session, event.payload);
      return;
    case "tasks.updated":
      session.tasks = event.payload.tasks;
      items.tasksUpdated(draft, session, event.payload);
      return;
    case "background.updated":
      session.background = withBackgroundTask(session.background, event.payload.task);
      return;
    case "subagent.updated":
      session.subagents = withSubagent(session.subagents, event.payload.agent);
      items.subagentUpdated(draft, session, event.payload);
      return;
    case "usage.updated": {
      const { usage } = event.payload;
      session.usage = usage;
      session.internals.eventTotals = {
        requests: usage.totals.requests,
        promptTokens: usage.totals.promptTokens,
        cachedTokens: usage.totals.cachedTokens,
      };
      return;
    }
    case "prompt.progress":
      applyPromptProgress(session, event.payload);
      return;
    case "compaction.started":
      session.compactionId = event.payload.compactionId;
      touch(session, event.payload.time);
      items.compactionStarted(draft, session, event.payload);
      return;
    case "compaction.finished":
      if (session.compactionId === event.payload.compactionId) session.compactionId = null;
      touch(session, event.payload.time);
      items.compactionFinished(draft, session, event.payload);
      return;
    case "error":
      touch(session, event.payload.time);
      items.errorRaised(draft, session, event.payload);
      return;
    case "hook.ran":
      items.hookRan(draft, session, event.payload);
      return;
    case "hook.skipped":
      items.hookSkipped(draft, session, event.payload);
      return;
  }
}

/**
 * The list with `task` in it: replacing the command with the same id where it is, or added last
 * (the list is oldest first). The latest event for a command is its state.
 */
function withBackgroundTask(list: BackgroundTask[], task: BackgroundTask): BackgroundTask[] {
  const index = list.findIndex((candidate) => candidate.taskId === task.taskId);
  if (index === -1) return [...list, task];
  return list.map((candidate, i) => (i === index ? task : candidate));
}

/** The list with `agent` in it, as `withBackgroundTask` does for commands (by `agentId`). */
function withSubagent(list: SubagentInfo[], agent: SubagentInfo): SubagentInfo[] {
  const index = list.findIndex((candidate) => candidate.agentId === agent.agentId);
  if (index === -1) return [...list, agent];
  return list.map((candidate, i) => (i === index ? agent : candidate));
}

function clearPromptProgress(session: MutableSession): void {
  if (session.promptProgress !== null) session.promptProgress = null;
  if (session.internals.progressStart !== null) session.internals.progressStart = null;
}

/**
 * How far the model has read the prompt. The read rate counts only the uncached part, measured
 * from the first sample of the request, so the cache's instant jump does not inflate it.
 */
function applyPromptProgress(
  session: MutableSession,
  p: { turnId: string; total: number; cached: number; processed: number; time: number },
): void {
  if (p.total === 0 || p.processed >= p.total) {
    clearPromptProgress(session);
    return;
  }
  let start = session.internals.progressStart;
  if (
    !start ||
    start.turnId !== p.turnId ||
    start.total !== p.total ||
    p.processed < start.processed
  ) {
    start = { turnId: p.turnId, total: p.total, time: p.time, processed: p.processed };
    session.internals.progressStart = start;
  }
  const from = Math.max(start.processed, p.cached);
  const read = p.processed - from;
  const seconds = (p.time - start.time) / 1000;
  const tokensPerSecond = seconds > 0 && read > 0 ? Math.round(read / seconds) : null;
  const secondsLeft =
    tokensPerSecond !== null && tokensPerSecond > 0
      ? Math.ceil((p.total - p.processed) / tokensPerSecond)
      : null;
  session.promptProgress = {
    turnId: p.turnId,
    total: p.total,
    cached: p.cached,
    processed: p.processed,
    tokensPerSecond,
    secondsLeft,
  };
}
