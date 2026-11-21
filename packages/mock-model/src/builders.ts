import type { Fault, ScriptReply, ScriptToolCall } from "./types.ts";

/** Small helpers that build `ScriptReply` objects. Each returns plain JSON-compatible data. */

type Extra = Omit<ScriptReply, "text" | "toolCalls" | "fault">;

/** A plain text reply. Pass an array to fix the exact chunks. */
export function text(content: string | string[], extra: Extra = {}): ScriptReply {
  return { ...extra, text: content };
}

/** A reply with reasoning, then text. */
export function reasoning(
  thoughts: string | string[],
  content: string | string[] = "",
  extra: Omit<Extra, "reasoning"> = {},
): ScriptReply {
  return { ...extra, reasoning: thoughts, text: content };
}

/** A reply with one tool call. */
export function toolCall(
  name: string,
  args: ScriptToolCall["arguments"] = {},
  extra: Extra & { id?: string; text?: string | string[] } = {},
): ScriptReply {
  const { id, ...rest } = extra;
  return { ...rest, toolCalls: [{ name, arguments: args, ...(id === undefined ? {} : { id }) }] };
}

/** A reply with several tool calls (and optional text before them). */
export function toolCalls(
  calls: ScriptToolCall[],
  extra: Extra & { text?: string | string[] } = {},
): ScriptReply {
  return { ...extra, toolCalls: calls };
}

/** A tool call whose arguments are sent exactly as given, typically not valid JSON. */
export function malformedToolCall(
  name: string,
  rawArguments: string,
  extra: Extra = {},
): ScriptReply {
  return { ...extra, toolCalls: [{ name, arguments: rawArguments }] };
}

/** A reply with no text and no tool calls. */
export function empty(extra: Extra = {}): ScriptReply {
  return { ...extra, text: "" };
}

/** The given reply (default: some text), cut off by destroying the socket after `afterEvents`. */
export function dropped(base: ScriptReply = text("partial reply"), afterEvents = 2): ScriptReply {
  return withFault(base, { type: "drop", afterEvents });
}

/** The given reply, stalled forever after `afterEvents`. */
export function stalled(base: ScriptReply = text("stalled reply"), afterEvents = 1): ScriptReply {
  return withFault(base, { type: "stall", afterEvents });
}

/** An HTTP error. `body` defaults to `{"error": {"code", "message", "type"}}`. */
export function httpError(status: number, message?: string, body?: unknown): ScriptReply {
  const fault: Fault = { type: "http", status };
  if (message !== undefined) fault.message = message;
  if (body !== undefined) fault.body = body;
  return { fault };
}

/** The real server's context-overflow error. */
export function contextOverflow(promptTokens?: number, contextWindow?: number): ScriptReply {
  const fault: Fault = { type: "context_overflow" };
  if (promptTokens !== undefined) fault.promptTokens = promptTokens;
  if (contextWindow !== undefined) fault.contextWindow = contextWindow;
  return { fault };
}

/** The given reply, sent as one JSON chat completion even when the request asked to stream. */
export function nonStreaming(base: ScriptReply = text("whole reply")): ScriptReply {
  return withFault(base, { type: "non_streaming" });
}

/** The given reply, broken by llama-server's mid-stream error event after `afterEvents`. */
export function streamError(
  base: ScriptReply = text("partial reply"),
  afterEvents = 2,
  message = "mock server error",
): ScriptReply {
  return withFault(base, { type: "stream_error", afterEvents, message });
}

/** A 200 response that is not a chat completion (an HTML page by default). */
export function invalidResponse(body?: string, contentType?: string): ScriptReply {
  const fault: Fault = { type: "invalid" };
  if (body !== undefined) fault.body = body;
  if (contentType !== undefined) fault.contentType = contentType;
  return { fault };
}

function withFault(base: ScriptReply, fault: Fault): ScriptReply {
  return { ...base, fault };
}
