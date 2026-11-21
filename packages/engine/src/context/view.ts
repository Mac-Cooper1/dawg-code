/**
 * The shape of the model's view (the messages after the system message) and the rules a chat
 * template needs it to keep:
 * - it starts with a user message;
 * - there is no system message in it;
 * - an assistant message's tool calls are answered by tool results that follow it directly, one
 *   result per call, before any other message;
 * - every tool result answers a call of the assistant message it follows.
 * These are the OpenAI Chat Completions rules, and the strictest the catalog's templates need.
 *
 * A turn starts at a message the user typed (`kind: "prompt"`) and runs to the next one. A step
 * starts at an assistant message and holds its results and any notes up to the next assistant
 * message or prompt.
 */
import type { AssistantMessage, Message, ToolResultMessage } from "../contracts/messages.ts";

/** Describes every way `messages` breaks the rules above. Empty when the view is valid. */
export function checkView(messages: readonly Message[]): string[] {
  const problems: string[] = [];
  const first = messages[0];
  if (first !== undefined && first.role !== "user") {
    problems.push(`message 0 is a ${first.role} message; the view must start with a user message`);
  }
  let i = 0;
  while (i < messages.length) {
    const message = messages[i] as Message;
    if (message.role === "system") {
      problems.push(`message ${i} is a system message; only the first request message may be one`);
      i++;
      continue;
    }
    if (message.role === "tool") {
      problems.push(`message ${i} is a tool result (${message.toolCallId}) with no call before it`);
      i++;
      continue;
    }
    if (message.role === "user" || message.toolCalls.length === 0) {
      i++;
      continue;
    }
    const pending = new Set(message.toolCalls.map((call) => call.id));
    if (pending.size !== message.toolCalls.length) {
      problems.push(`message ${i} has two tool calls with the same id`);
    }
    let j = i + 1;
    for (; j < messages.length; j++) {
      const next = messages[j] as Message;
      if (next.role !== "tool") break;
      if (!pending.delete(next.toolCallId)) {
        problems.push(
          `message ${j} is a tool result (${next.toolCallId}) that answers no open call of message ${i}`,
        );
      }
    }
    for (const id of pending) {
      problems.push(`tool call ${id} of message ${i} has no result directly after it`);
    }
    i = j;
  }
  return problems;
}

export interface Span {
  start: number;
  /** Exclusive. */
  end: number;
}

/** Turns of `messages[from..]`, each starting at a prompt. Messages before the first are left out. */
export function splitTurns(messages: readonly Message[], from = 0): Span[] {
  const starts: number[] = [];
  for (let i = from; i < messages.length; i++) {
    const m = messages[i] as Message;
    if (m.role === "user" && m.kind === "prompt") starts.push(i);
  }
  return starts.map((start, k) => ({ start, end: starts[k + 1] ?? messages.length }));
}

/** Steps of `messages[span]`, each starting at an assistant message. */
export function splitSteps(messages: readonly Message[], span: Span): Span[] {
  const starts: number[] = [];
  for (let i = span.start; i < span.end; i++) {
    if ((messages[i] as Message).role === "assistant") starts.push(i);
  }
  return starts.map((start, k) => ({ start, end: starts[k + 1] ?? span.end }));
}

/**
 * Puts a run of messages in a shape `checkView` accepts, changing as little as possible: each
 * assistant message's results are moved directly after it (in the order they came), a call with
 * no result gets one saying so, and a result that answers no call in its step is dropped.
 * Messages that already obey the rules come back unchanged and in order.
 */
export function normalizePairs(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  // Results seen before any assistant message have no call to answer and are dropped.
  while (i < messages.length) {
    const message = messages[i] as Message;
    if (message.role !== "assistant") {
      if (message.role !== "tool") out.push(message);
      i++;
      continue;
    }
    // The step: this assistant message up to the next assistant message or prompt.
    let end = i + 1;
    while (end < messages.length) {
      const m = messages[end] as Message;
      if (m.role === "assistant" || (m.role === "user" && m.kind === "prompt")) break;
      end++;
    }
    out.push(...normalizeStep(message, messages.slice(i + 1, end)));
    i = end;
  }
  return out;
}

function normalizeStep(assistant: AssistantMessage, rest: readonly Message[]): Message[] {
  const open = new Map(assistant.toolCalls.map((call) => [call.id, call.name]));
  const results: ToolResultMessage[] = [];
  const others: Message[] = [];
  for (const m of rest) {
    if (m.role === "tool") {
      if (open.delete(m.toolCallId)) results.push(m);
    } else {
      others.push(m);
    }
  }
  for (const [id, name] of open) {
    results.push({
      role: "tool",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: "No result was recorded for this call." }],
      isError: true,
    });
  }
  return [assistant, ...results, ...others];
}
