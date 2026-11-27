/**
 * A turn that was waiting on the person when its session stopped (the app quit, or the process
 * ended), found again when the session opens.
 *
 * Phase 3 asks that quitting mid-turn and launching again bring back the pending prompts, and
 * that answering one carries the turn on. So when a session stops while its turn waits on the
 * person, nothing is ended: the event log still shows the turn open with its requests, and the
 * transcript ends with the assistant message whose calls have no results yet. On opening, this
 * module checks that the stopped state is exactly that, and nothing else, and describes it so
 * the session can raise the same requests again and, once answered, run the remaining calls and
 * go on with the turn.
 *
 * Anything else left open (a reply that was streaming, a tool that was running, a compaction)
 * cannot be carried on: those are closed as interrupted, as before (`closeUnfinished`).
 */
import { type ClientCapabilities, type PendingRequest, PendingRequestSchema } from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { ToolSchema } from "../contracts/model.ts";
import type { ReadyCall } from "../toolcall/index.ts";
import { findUnfinished, type LoggedEvent } from "./event-log.ts";
import { danglingCalls, promptSeqOf } from "./transcript.ts";

export interface WaitingTurn {
  turnId: string;
  /** The prompt record's sequence number. */
  promptSeq: number;
  /** Time of `turn.started`. */
  startedAt: number;
  /** The assistant message that made the calls. */
  messageId: string;
  /** Its calls that have no result yet, in call order, ready to run. */
  calls: ReadyCall[];
  /** Of those, the calls whose `tool.started` went out before the session stopped. */
  started: Set<string>;
  /** The requests still waiting, oldest first, as they were raised. */
  requests: PendingRequest[];
  /** The text of the turn's latest assistant message, for the turn's final text. */
  lastText: string | null;
}

/** The tool call a request is about. */
export function requestCallId(request: PendingRequest): string {
  return request.kind === "permission" ? request.request.toolCallId : request.toolCallId;
}

export function requestIdOf(request: PendingRequest): string {
  return request.kind === "permission" ? request.request.requestId : request.requestId;
}

function allowed(kind: PendingRequest["kind"], capabilities: ClientCapabilities): boolean {
  switch (kind) {
    case "permission":
      return capabilities.permissionPrompts;
    case "question":
      return capabilities.questions;
    case "plan":
      return capabilities.planApproval;
  }
}

/** The request an event raised, or null when the event raises none (or does not parse). */
function raised(event: LoggedEvent): PendingRequest | null {
  const kind =
    event.event === "permission.requested"
      ? "permission"
      : event.event === "question.asked"
        ? "question"
        : event.event === "plan.proposed"
          ? "plan"
          : null;
  if (kind === null) return null;
  const parsed = PendingRequestSchema.safeParse({ ...event.payload, kind });
  return parsed.success ? parsed.data : null;
}

function plainObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The turn the log shows waiting on the person, when that is all that was going on and the turn
 * can be carried on; otherwise null.
 */
export function findWaitingTurn(
  events: readonly LoggedEvent[],
  view: readonly Message[],
  tools: readonly ToolSchema[],
  capabilities: ClientCapabilities,
): WaitingTurn | null {
  const open = findUnfinished(events);
  if (open.turn === null || open.requests.length === 0) return null;
  // A reply that was streaming or a compaction cannot be picked up again.
  if (open.messages.length > 0 || open.compaction !== null) return null;
  const turnId = open.turn.turnId;
  const promptSeq = promptSeqOf(turnId);
  if (promptSeq === null) return null;

  const openIds = new Set(open.requests.map((r) => r.requestId));
  const requests: PendingRequest[] = [];
  const started = new Set<string>();
  const finished = new Set<string>();
  /** The message that made each call, from `message.finished`. */
  const messageOf = new Map<string, string>();
  for (const event of events) {
    const p = event.payload;
    if (p.turnId !== turnId) continue;
    if (event.event === "tool.started") started.add(String(p.toolCallId));
    else if (event.event === "tool.finished") finished.add(String(p.toolCallId));
    else if (event.event === "message.finished") {
      for (const call of (p.toolCalls as { toolCallId: string }[] | undefined) ?? []) {
        messageOf.set(call.toolCallId, String(p.messageId));
      }
    } else {
      const request = raised(event);
      if (request !== null && openIds.has(requestIdOf(request))) requests.push(request);
    }
  }
  if (requests.length !== openIds.size) return null;
  // Someone must be there to answer each request, or the turn would wait for nobody.
  if (!requests.every((r) => allowed(r.kind, capabilities))) return null;

  const dangling = danglingCalls(view);
  if (dangling.length === 0) return null;
  const asked = new Set(requests.map(requestCallId));
  const danglingIds = new Set(dangling.map((c) => c.id));
  if (![...asked].every((id) => danglingIds.has(id))) return null;
  for (const call of dangling) {
    // A result the clients saw but history did not get, or a call that was running rather than
    // waiting: running it again would do its work twice.
    if (finished.has(call.id)) return null;
    if (started.has(call.id) && !asked.has(call.id)) return null;
  }
  const messageId = messageOf.get(dangling[0]?.id ?? "");
  if (messageId === undefined || !dangling.every((c) => messageOf.get(c.id) === messageId)) {
    return null;
  }

  const calls: ReadyCall[] = [];
  for (const call of dangling) {
    const tool = tools.find((t) => t.name === call.name);
    const input = plainObject(call.arguments);
    if (tool === undefined || input === null) return null;
    calls.push({
      status: "ready",
      call,
      tool,
      input,
      fixes: { repairs: [], coercions: [], nameCorrectedFrom: null, proseFormat: null },
      malformed: false,
    });
  }

  let lastText: string | null = null;
  for (let i = view.length - 1; i >= 0; i--) {
    const message = view[i] as Message;
    if (message.role !== "assistant") continue;
    lastText = message.content.trim() === "" ? null : message.content;
    break;
  }

  return {
    turnId,
    promptSeq,
    startedAt: open.turn.startedAt,
    messageId,
    calls,
    started: new Set([...started].filter((id) => danglingIds.has(id))),
    requests,
    lastText,
  };
}
