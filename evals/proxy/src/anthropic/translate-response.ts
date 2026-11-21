/**
 * OpenAI Chat Completions response → Anthropic Messages response, and Anthropic error bodies.
 *
 * Sources:
 * - Message object, stop_reason values, usage fields:
 *   https://platform.claude.com/docs/en/api/messages
 * - Error shapes and types per status: https://platform.claude.com/docs/en/api/errors
 * - Chat completion object: https://platform.openai.com/docs/api-reference/chat/object
 */

import { randomBytes } from "node:crypto";
import type { ChatAccumulator } from "../chat-accumulator.ts";
import { isRecord } from "../chat-accumulator.ts";
import { parseArguments } from "../tool-validation.ts";

export function messageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

export function toolUseId(): string {
  return `toolu_${randomBytes(12).toString("hex")}`;
}

/** Anthropic tool_use ids must match ^[a-zA-Z0-9_-]+$. */
export function sanitizeToolId(id: string | null): string {
  if (!id) return toolUseId();
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean.length > 0 ? clean : toolUseId();
}

/** finish_reason → stop_reason. Tool calls in the turn always mean `tool_use`. */
export function mapStopReason(finishReason: string | null, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * Tool input for the Anthropic response: the parsed arguments when they are a JSON object,
 * otherwise `{}` so the response stays well-formed (the call is still recorded as invalid).
 */
export function toolInput(rawArguments: string): Record<string, unknown> {
  if (rawArguments.trim() === "") return {};
  const parsed = parseArguments(rawArguments);
  return parsed.ok && isRecord(parsed.value) ? parsed.value : {};
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * OpenAI prompt_tokens include cached tokens; Anthropic input_tokens exclude cache reads
 * (total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens).
 */
export function anthropicUsage(acc: ChatAccumulator): AnthropicUsage {
  const prompt = acc.usage.prompt_tokens ?? 0;
  const cached = acc.usage.cached_tokens ?? acc.timings?.cache_n ?? 0;
  const cacheRead = Math.max(0, Math.min(cached, prompt));
  return {
    input_tokens: Math.max(0, prompt - cacheRead),
    output_tokens: acc.usage.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
  };
}

/** Build a non-streamed Anthropic message from an accumulated completion. */
export function buildMessage(acc: ChatAccumulator, model: string): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (acc.reasoning) content.push({ type: "thinking", thinking: acc.reasoning, signature: "" });
  if (acc.content) content.push({ type: "text", text: acc.content });
  const calls = acc.toolCalls();
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: sanitizeToolId(call.id),
      name: call.name,
      input: toolInput(call.arguments),
    });
  }
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(acc.finishReason, calls.length > 0),
    stop_sequence: null,
    usage: anthropicUsage(acc),
  };
}

/** Error `type` for an HTTP status, per the Anthropic errors reference. */
export function errorTypeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 402:
      return "billing_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 409:
      return "conflict_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 503:
    case 529:
      return "overloaded_error";
    case 504:
      return "timeout_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

export function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}

/**
 * Turn an upstream error body into an Anthropic error. llama-server's context-overflow error is
 * reworded to the "prompt is too long" form Anthropic clients recognise.
 */
export function translateUpstreamError(
  status: number,
  bodyText: string,
): { status: number; body: Record<string, unknown>; message: string } {
  let message = bodyText.trim().slice(0, 4000) || `upstream returned HTTP ${status}`;
  let upstreamType: string | null = null;
  let promptTokens: number | null = null;
  let contextSize: number | null = null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      const err = isRecord(parsed.error) ? parsed.error : parsed;
      if (typeof err.message === "string" && err.message) message = err.message;
      else if (typeof parsed.error === "string") message = parsed.error;
      if (typeof err.type === "string") upstreamType = err.type;
      if (typeof err.n_prompt_tokens === "number") promptTokens = err.n_prompt_tokens;
      if (typeof err.n_ctx === "number") contextSize = err.n_ctx;
    }
  } catch {
    // not JSON; keep the text
  }
  let type = errorTypeForStatus(status);
  let outStatus = status;
  if (
    upstreamType === "exceed_context_size_error" ||
    /context (size|length|window)/i.test(message)
  ) {
    type = "invalid_request_error";
    outStatus = 400;
    // vLLM / OpenAI style: "maximum context length is 32768 tokens. However, you requested 40000"
    const openAiStyle = /maximum context length is (\d+) tokens.*?requested (\d+) tokens/is.exec(
      message,
    );
    if ((promptTokens === null || contextSize === null) && openAiStyle) {
      contextSize = Number(openAiStyle[1]);
      promptTokens = Number(openAiStyle[2]);
    }
    if (promptTokens !== null && contextSize !== null) {
      message = `prompt is too long: ${promptTokens} tokens > ${contextSize} maximum (${message})`;
    } else if (!/prompt is too long/i.test(message)) {
      message = `prompt is too long: ${message}`;
    }
  }
  return { status: outStatus, body: anthropicError(type, message), message };
}
