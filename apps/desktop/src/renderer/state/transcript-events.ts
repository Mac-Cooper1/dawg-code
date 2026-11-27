/**
 * How events become transcript items. Called by the reducer once an event has passed the
 * high-water check, with the session already writable.
 *
 * Ordering rules (the transcript is in display order):
 * - Items are appended in event order, with two exceptions that keep a call next to its card:
 *   a permission item goes directly before its tool item, and a tool item whose permission
 *   arrived first goes directly after that permission item.
 * - A message's reasoning item sits directly before its text item. Both are created by their
 *   first delta with visible text (no empty bubbles), or by `message.finished` when a replay left
 *   the deltas out.
 * - The turn summary, interruption note or turn error is the last item of its turn.
 * Item ids are derived from protocol ids, so a replay rebuilds the same keys.
 */
import type { EventPayload } from "@dawg/protocol";
import {
  type Draft,
  type MutableSession,
  readItems,
  readPending,
  setPending,
  writeItems,
} from "./draft.ts";
import type { UsageTotals } from "./internals.ts";
import { findItemIndex, findPermissionIndex, itemsMoved } from "./item-index.ts";
import type {
  AssistantTextItem,
  CompactionItem,
  ErrorItem,
  NoteItem,
  PendingRef,
  PermissionItem,
  PlanItem,
  QuestionItem,
  ReasoningItem,
  TasksItem,
  ToolCallItem,
  TranscriptItem,
  TurnSummaryItem,
  UserMessageItem,
} from "./types.ts";

/** Calls shown by another item: the tasks item, the question card, the plan card. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
]);

/** The note a turn the person interrupted ends with. The selector says "by you" for this client. */
export const INTERRUPTED_NOTE = "Interrupted · the transcript keeps every finished call";
export const INTERRUPTED_BY_YOU_NOTE =
  "Interrupted by you · the transcript keeps every finished call";

export const itemIds = {
  user: (turnId: string) => `user:${turnId}`,
  reasoning: (messageId: string) => `reasoning:${messageId}`,
  assistant: (messageId: string) => `assistant:${messageId}`,
  tool: (toolCallId: string) => `tool:${toolCallId}`,
  tasks: (turnId: string) => `tasks:${turnId}`,
  permission: (requestId: string) => `permission:${requestId}`,
  question: (requestId: string) => `question:${requestId}`,
  plan: (requestId: string) => `plan:${requestId}`,
  compaction: (compactionId: string) => `compaction:${compactionId}`,
  error: (seq: number) => `error:${seq}`,
  turnError: (turnId: string) => `error:turn:${turnId}`,
  note: (turnId: string) => `note:${turnId}`,
  summary: (turnId: string) => `summary:${turnId}`,
} as const;

const ZERO_TOTALS: UsageTotals = Object.freeze({ requests: 0, promptTokens: 0, cachedTokens: 0 });

// --- Lookup helpers ----------------------------------------------------------------------------

/** Searches from the end: the items an event touches are almost always the latest ones. */
export function lastIndexWhere(
  items: readonly TranscriptItem[],
  predicate: (item: TranscriptItem) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item && predicate(item)) return index;
  }
  return -1;
}

/** Like `lastIndexWhere` on the id, through an index (item-index.ts): replays stay linear. */
export function indexOfId(items: readonly TranscriptItem[], id: string): number {
  return findItemIndex(items, id);
}

function toolIndex(items: readonly TranscriptItem[], toolCallId: string): number {
  return indexOfId(items, itemIds.tool(toolCallId));
}

function permissionIndexForCall(items: readonly TranscriptItem[], toolCallId: string): number {
  return findPermissionIndex(items, toolCallId);
}

function hasVisibleText(text: string): boolean {
  return text.trim() !== "";
}

function addPending(draft: Draft, sessionId: string, ref: PendingRef): void {
  const refs = readPending(draft, sessionId);
  if (refs.some((existing) => existing.requestId === ref.requestId)) return;
  setPending(draft, sessionId, [...refs, ref]);
}

function removePending(draft: Draft, sessionId: string, requestId: string): void {
  const refs = readPending(draft, sessionId);
  if (!refs.some((ref) => ref.requestId === requestId)) return;
  setPending(
    draft,
    sessionId,
    refs.filter((ref) => ref.requestId !== requestId),
  );
}

// --- Turns -------------------------------------------------------------------------------------

export function turnStarted(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"turn.started">,
): void {
  const items = writeItems(draft, session.id);
  const id = itemIds.user(p.turnId);
  if (indexOfId(items, id) !== -1) return;
  const text = p.prompt.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  const images = p.prompt.content.flatMap((part) =>
    part.type === "image" ? [{ mediaType: part.mediaType, data: part.data }] : [],
  );
  const item: UserMessageItem = {
    kind: "user",
    id,
    turnId: p.turnId,
    seq: p.seq,
    text,
    images,
    mentions: p.prompt.mentions,
    command: p.command,
  };
  items.push(item);
}

/**
 * Closes whatever a turn left open: streaming text and reasoning, running calls (marked
 * interrupted), pending cards (cancelled). The protocol closes all of these itself before
 * `turn.finished`; this keeps a lossy stream or a dead engine from leaving spinners behind.
 */
export function closeTurnItems(
  draft: Draft,
  session: MutableSession,
  turnId: string,
  time: number,
): void {
  const items = readItems(draft, session.id);
  const userId = itemIds.user(turnId);
  let writable: TranscriptItem[] | null = null;
  const replace = (index: number, item: TranscriptItem) => {
    writable ??= writeItems(draft, session.id);
    writable[index] = item;
  };
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item) continue;
    if (item.id === userId) break;
    if (item.turnId !== turnId) continue;
    switch (item.kind) {
      case "assistant":
        if (item.streaming) replace(index, { ...item, streaming: false });
        break;
      case "reasoning":
        if (item.streaming || item.durationMs === null) {
          replace(index, {
            ...item,
            streaming: false,
            durationMs: item.durationMs ?? Math.max(0, time - item.startedAt),
          });
        }
        break;
      case "tool":
        if (item.state === "running") {
          replace(index, {
            ...item,
            state: "interrupted",
            durationMs: Math.max(0, time - item.startedAt),
          });
        }
        break;
      case "permission":
      case "question":
      case "plan":
        if (item.state === "pending") {
          replace(index, { ...item, state: "cancelled" });
          removePending(draft, session.id, item.requestId);
        }
        break;
      default:
        break;
    }
  }
  for (const ref of readPending(draft, session.id)) {
    if (ref.turnId === turnId) removePending(draft, session.id, ref.requestId);
  }
}

export function turnFinished(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"turn.finished">,
): void {
  closeTurnItems(draft, session, p.turnId, p.time);
  const items = writeItems(draft, session.id);
  switch (p.stopReason) {
    case "completed":
    case "turn_limit": {
      const id = itemIds.summary(p.turnId);
      if (indexOfId(items, id) !== -1) return;
      const start = session.internals.turnStart;
      const end = session.internals.eventTotals ?? ZERO_TOTALS;
      let modelRequests: number | null = null;
      let cachedPercent: number | null = null;
      if (start) {
        const requests = end.requests - start.requests;
        const prompt = end.promptTokens - start.promptTokens;
        const cached = end.cachedTokens - start.cachedTokens;
        modelRequests = requests >= 0 ? requests : null;
        if (prompt > 0 && cached >= 0) {
          cachedPercent = Math.min(100, Math.round((cached / prompt) * 100));
        }
      }
      const item: TurnSummaryItem = {
        kind: "turn-summary",
        id,
        turnId: p.turnId,
        seq: p.seq,
        stopReason: p.stopReason,
        durationMs: p.durationMs,
        modelRequests,
        cachedPercent,
      };
      items.push(item);
      return;
    }
    case "interrupted": {
      const id = itemIds.note(p.turnId);
      if (indexOfId(items, id) !== -1) return;
      const item: NoteItem = {
        kind: "note",
        id,
        turnId: p.turnId,
        seq: p.seq,
        text: INTERRUPTED_NOTE,
        tone: "neutral",
      };
      items.push(item);
      return;
    }
    case "error": {
      const turnHasError =
        lastIndexWhere(items, (item) => item.kind === "error" && item.turnId === p.turnId) !== -1;
      if (turnHasError) return;
      const item: ErrorItem = {
        kind: "error",
        id: itemIds.turnError(p.turnId),
        turnId: p.turnId,
        seq: p.seq,
        error: p.error ?? {
          kind: "other",
          message: "The turn failed.",
          detail: null,
          retryable: false,
        },
      };
      items.push(item);
      return;
    }
  }
}

// --- Messages ----------------------------------------------------------------------------------

export function reasoningDelta(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"reasoning.delta">,
): void {
  const id = itemIds.reasoning(p.messageId);
  const index = indexOfId(readItems(draft, session.id), id);
  if (index === -1) {
    if (!hasVisibleText(p.text)) return;
    const item: ReasoningItem = {
      kind: "reasoning",
      id,
      turnId: p.turnId,
      seq: p.seq,
      messageId: p.messageId,
      text: p.text,
      streaming: true,
      startedAt: p.time,
      durationMs: null,
    };
    writeItems(draft, session.id).push(item);
    return;
  }
  const items = writeItems(draft, session.id);
  const item = items[index] as ReasoningItem;
  items[index] = { ...item, text: item.text + p.text };
}

export function messageDelta(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"message.delta">,
): void {
  const id = itemIds.assistant(p.messageId);
  const index = indexOfId(readItems(draft, session.id), id);
  if (index !== -1) {
    const items = writeItems(draft, session.id);
    const item = items[index] as AssistantTextItem;
    items[index] = { ...item, text: item.text + p.text };
    return;
  }
  if (!hasVisibleText(p.text)) return;
  const items = writeItems(draft, session.id);
  // The first visible text ends the reasoning.
  const reasoningIndex = indexOfId(items, itemIds.reasoning(p.messageId));
  const reasoning = items[reasoningIndex];
  if (reasoning?.kind === "reasoning" && reasoning.durationMs === null) {
    items[reasoningIndex] = {
      ...reasoning,
      streaming: false,
      durationMs: Math.max(0, p.time - reasoning.startedAt),
    };
  }
  const item: AssistantTextItem = {
    kind: "assistant",
    id,
    turnId: p.turnId,
    seq: p.seq,
    messageId: p.messageId,
    text: p.text,
    streaming: true,
  };
  items.push(item);
}

/** Rule 7: the finished message replaces what the deltas built, text and reasoning alike. */
export function messageFinished(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"message.finished">,
): void {
  const start =
    session.internals.messageStart?.messageId === p.messageId
      ? session.internals.messageStart
      : null;
  session.internals.messageStart = null;
  const reasoningId = itemIds.reasoning(p.messageId);
  const assistantId = itemIds.assistant(p.messageId);
  const current = readItems(draft, session.id);
  const reasoningText = p.reasoning ?? "";
  const hasReasoning = hasVisibleText(reasoningText);
  const hasText = hasVisibleText(p.text);
  if (
    !hasReasoning &&
    !hasText &&
    indexOfId(current, reasoningId) === -1 &&
    indexOfId(current, assistantId) === -1
  ) {
    return;
  }
  const items = writeItems(draft, session.id);

  const reasoningIndex = indexOfId(items, reasoningId);
  if (hasReasoning) {
    const existing = items[reasoningIndex];
    if (existing?.kind === "reasoning") {
      items[reasoningIndex] = {
        ...existing,
        text: reasoningText,
        streaming: false,
        durationMs: existing.durationMs ?? Math.max(0, p.time - existing.startedAt),
      };
    } else {
      // A replay without deltas: time it from the message's start.
      const startedAt = start?.time ?? p.time;
      const item: ReasoningItem = {
        kind: "reasoning",
        id: reasoningId,
        turnId: p.turnId,
        seq: p.seq,
        messageId: p.messageId,
        text: reasoningText,
        streaming: false,
        startedAt,
        durationMs: Math.max(0, p.time - startedAt),
      };
      const assistantIndex = indexOfId(items, assistantId);
      if (assistantIndex === -1) items.push(item);
      else {
        items.splice(assistantIndex, 0, item);
        itemsMoved(items);
      }
    }
  } else if (reasoningIndex !== -1) {
    items.splice(reasoningIndex, 1);
    itemsMoved(items);
  }

  const assistantIndex = indexOfId(items, assistantId);
  if (hasText) {
    const existing = items[assistantIndex];
    if (existing?.kind === "assistant") {
      items[assistantIndex] = { ...existing, text: p.text, streaming: false };
    } else {
      const item: AssistantTextItem = {
        kind: "assistant",
        id: assistantId,
        turnId: p.turnId,
        seq: p.seq,
        messageId: p.messageId,
        text: p.text,
        streaming: false,
      };
      items.push(item);
    }
  } else if (assistantIndex !== -1) {
    items.splice(assistantIndex, 1);
    itemsMoved(items);
  }
}

// --- Tools -------------------------------------------------------------------------------------

function insertToolItem(items: TranscriptItem[], item: ToolCallItem): void {
  const permissionIndex = permissionIndexForCall(items, item.toolCallId);
  if (permissionIndex === -1) {
    items.push(item);
    return;
  }
  const permission = items[permissionIndex] as PermissionItem;
  items.splice(permissionIndex + 1, 0, { ...item, permissionRequestId: permission.requestId });
  itemsMoved(items);
}

export function toolStarted(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"tool.started">,
): void {
  if (HIDDEN_TOOLS.has(p.toolName)) {
    session.internals.hiddenCalls = {
      ...session.internals.hiddenCalls,
      [p.toolCallId]: {
        turnId: p.turnId,
        messageId: p.messageId,
        toolName: p.toolName,
        input: p.input,
        time: p.time,
        seq: p.seq,
      },
    };
    return;
  }
  if (toolIndex(readItems(draft, session.id), p.toolCallId) !== -1) return;
  insertToolItem(writeItems(draft, session.id), {
    kind: "tool",
    id: itemIds.tool(p.toolCallId),
    turnId: p.turnId,
    seq: p.seq,
    toolCallId: p.toolCallId,
    messageId: p.messageId,
    toolName: p.toolName,
    input: p.input,
    state: "running",
    output: [],
    statusLine: null,
    content: null,
    display: null,
    startedAt: p.time,
    durationMs: null,
    permissionRequestId: null,
  });
}

export function toolProgress(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"tool.progress">,
): void {
  const index = toolIndex(readItems(draft, session.id), p.toolCallId);
  if (index === -1) return;
  const items = writeItems(draft, session.id);
  const item = items[index] as ToolCallItem;
  const { progress } = p;
  if (progress.kind === "status") {
    items[index] = { ...item, statusLine: progress.message };
    return;
  }
  if (progress.text === "") return;
  // Consecutive chunks of one stream are merged, so the list stays short for chatty commands.
  const last = item.output[item.output.length - 1];
  const output =
    last && last.stream === progress.stream
      ? [...item.output.slice(0, -1), { stream: last.stream, text: last.text + progress.text }]
      : [...item.output, { stream: progress.stream, text: progress.text }];
  items[index] = { ...item, output };
}

/** Whether a hidden call is shown by its own item, so it needs no tool item. */
function shownElsewhere(
  items: readonly TranscriptItem[],
  p: EventPayload<"tool.finished">,
): boolean {
  switch (p.toolName) {
    case "TodoWrite":
      return p.outcome === "success";
    case "AskUserQuestion":
      return (
        lastIndexWhere(
          items,
          (item) => item.kind === "question" && item.toolCallId === p.toolCallId,
        ) !== -1
      );
    case "ExitPlanMode":
      return (
        lastIndexWhere(
          items,
          (item) => item.kind === "plan" && item.toolCallId === p.toolCallId,
        ) !== -1
      );
    default:
      return false;
  }
}

export function toolFinished(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"tool.finished">,
): void {
  const hidden = session.internals.hiddenCalls[p.toolCallId];
  if (hidden) {
    const { [p.toolCallId]: _finished, ...rest } = session.internals.hiddenCalls;
    session.internals.hiddenCalls = rest;
  }
  const current = readItems(draft, session.id);
  const index = toolIndex(current, p.toolCallId);
  if (index !== -1) {
    const items = writeItems(draft, session.id);
    const item = items[index] as ToolCallItem;
    items[index] = {
      ...item,
      state: p.outcome,
      content: p.content,
      display: p.display,
      durationMs: p.durationMs,
    };
    return;
  }
  if (HIDDEN_TOOLS.has(p.toolName) && shownElsewhere(current, p)) return;
  // A hidden call that failed, or a call whose start the stream lost: show it now.
  insertToolItem(writeItems(draft, session.id), {
    kind: "tool",
    id: itemIds.tool(p.toolCallId),
    turnId: p.turnId,
    seq: hidden?.seq ?? p.seq,
    toolCallId: p.toolCallId,
    messageId: hidden?.messageId ?? "",
    toolName: p.toolName,
    input: hidden?.input ?? {},
    state: p.outcome,
    output: [],
    statusLine: null,
    content: p.content,
    display: p.display,
    startedAt: hidden?.time ?? p.time - (p.durationMs ?? 0),
    durationMs: p.durationMs,
    permissionRequestId: null,
  });
}

// --- Decisions ---------------------------------------------------------------------------------

export function permissionRequested(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"permission.requested">,
): void {
  const { request } = p;
  const id = itemIds.permission(request.requestId);
  if (indexOfId(readItems(draft, session.id), id) === -1) {
    const items = writeItems(draft, session.id);
    const item: PermissionItem = {
      kind: "permission",
      id,
      turnId: p.turnId,
      seq: p.seq,
      requestId: request.requestId,
      request,
      state: "pending",
      response: null,
    };
    const index = toolIndex(items, request.toolCallId);
    const tool = items[index];
    if (tool?.kind === "tool") {
      items.splice(index, 0, item);
      itemsMoved(items);
      items[index + 1] = { ...tool, permissionRequestId: request.requestId };
    } else {
      items.push(item);
    }
  }
  addPending(draft, session.id, {
    kind: "permission",
    requestId: request.requestId,
    turnId: p.turnId,
  });
}

export function questionAsked(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"question.asked">,
): void {
  const id = itemIds.question(p.requestId);
  if (indexOfId(readItems(draft, session.id), id) === -1) {
    const item: QuestionItem = {
      kind: "question",
      id,
      turnId: p.turnId,
      seq: p.seq,
      requestId: p.requestId,
      toolCallId: p.toolCallId,
      questions: p.questions,
      state: "pending",
      response: null,
    };
    writeItems(draft, session.id).push(item);
  }
  addPending(draft, session.id, { kind: "question", requestId: p.requestId, turnId: p.turnId });
}

export function planProposed(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"plan.proposed">,
): void {
  const id = itemIds.plan(p.requestId);
  if (indexOfId(readItems(draft, session.id), id) === -1) {
    const item: PlanItem = {
      kind: "plan",
      id,
      turnId: p.turnId,
      seq: p.seq,
      requestId: p.requestId,
      toolCallId: p.toolCallId,
      plan: p.plan,
      planPath: p.planPath,
      state: "pending",
      response: null,
      modeBeforePlan: p.modeBeforePlan,
    };
    writeItems(draft, session.id).push(item);
  }
  addPending(draft, session.id, { kind: "plan", requestId: p.requestId, turnId: p.turnId });
}

export function requestResolved(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"request.resolved">,
): void {
  removePending(draft, session.id, p.requestId);
  const state = p.outcome === "answered" ? "answered" : "cancelled";
  const index = indexOfId(readItems(draft, session.id), `${p.kind}:${p.requestId}`);
  if (index === -1) return;
  const items = writeItems(draft, session.id);
  const item = items[index];
  if (item?.kind === "permission" && p.kind === "permission") {
    items[index] = { ...item, state, response: p.response };
  } else if (item?.kind === "question" && p.kind === "question") {
    items[index] = { ...item, state, response: p.response };
  } else if (item?.kind === "plan" && p.kind === "plan") {
    items[index] = { ...item, state, response: p.response };
  }
}

// --- Tasks, compaction, errors -----------------------------------------------------------------

export function tasksUpdated(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"tasks.updated">,
): void {
  const turnId = session.activeTurnId;
  if (turnId === null) return;
  const id = itemIds.tasks(turnId);
  const items = writeItems(draft, session.id);
  const index = indexOfId(items, id);
  const existing = items[index];
  if (existing?.kind === "tasks") {
    items[index] = { ...existing, tasks: p.tasks };
    return;
  }
  const item: TasksItem = { kind: "tasks", id, turnId, seq: p.seq, tasks: p.tasks };
  items.push(item);
}

export function compactionStarted(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"compaction.started">,
): void {
  const id = itemIds.compaction(p.compactionId);
  if (indexOfId(readItems(draft, session.id), id) !== -1) return;
  const item: CompactionItem = {
    kind: "compaction",
    id,
    turnId: p.turnId,
    seq: p.seq,
    compactionId: p.compactionId,
    trigger: p.trigger,
    state: "running",
    contextBefore: p.contextUsed,
    contextAfter: null,
    summary: null,
    error: null,
  };
  writeItems(draft, session.id).push(item);
}

export function compactionFinished(
  draft: Draft,
  session: MutableSession,
  p: EventPayload<"compaction.finished">,
): void {
  const id = itemIds.compaction(p.compactionId);
  const items = writeItems(draft, session.id);
  const index = indexOfId(items, id);
  const existing = items[index];
  const fields = {
    state: p.outcome,
    contextBefore: p.contextBefore,
    contextAfter: p.contextAfter,
    summary: p.summary,
    error: p.error,
  } as const;
  if (existing?.kind === "compaction") {
    items[index] = { ...existing, ...fields };
    return;
  }
  const item: CompactionItem = {
    kind: "compaction",
    id,
    turnId: null,
    seq: p.seq,
    compactionId: p.compactionId,
    trigger: "auto",
    ...fields,
  };
  items.push(item);
}

export function errorRaised(draft: Draft, session: MutableSession, p: EventPayload<"error">): void {
  const id = itemIds.error(p.seq);
  const items = writeItems(draft, session.id);
  if (indexOfId(items, id) !== -1) return;
  const item: ErrorItem = { kind: "error", id, turnId: p.turnId, seq: p.seq, error: p.error };
  items.push(item);
}
