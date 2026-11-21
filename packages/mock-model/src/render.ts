import type { ScriptReply, ScriptToolCall } from "./types.ts";

/**
 * Turns a scripted reply into the wire shapes llama-server b12359 produces (see
 * `__fixtures__/llama-server/`): the chunk layout, field order, the role-only first chunk,
 * `timings`, `prompt_progress`, and the separate usage chunk with an empty `choices` list.
 */

export interface RenderContext {
  flavor: "llama.cpp" | "openai";
  model: string;
  /** Chat request number, used for ids. */
  requestNumber: number;
  promptTokens: number;
  cachedTokens: number;
  includeUsage: boolean;
  timingsPerToken: boolean;
  returnProgress: boolean;
  promptTokensPerSecond: number;
  completionTokensPerSecond: number;
  progressBatch: number;
  countTokens: (text: string) => number;
}

type Json = Record<string, unknown>;

const DEFAULT_CHUNK = 16;
const DEFAULT_ARGUMENT_CHUNK = 8;
/** A fixed timestamp keeps the mock's output deterministic. */
const CREATED = 1_700_000_000;

/** Splits by code points so a chunk never ends inside a surrogate pair. */
export function splitText(text: string | string[] | undefined, size: number): string[] {
  if (text === undefined) return [];
  if (Array.isArray(text)) return text.filter((piece) => piece.length > 0);
  const points = Array.from(text);
  const pieces: string[] = [];
  for (let i = 0; i < points.length; i += size) pieces.push(points.slice(i, i + size).join(""));
  return pieces;
}

export function argumentsText(call: ScriptToolCall): string {
  const args = call.arguments;
  if (args === undefined) return "{}";
  if (typeof args === "string") return args;
  if (Array.isArray(args)) return args.join("");
  return JSON.stringify(args);
}

function argumentPieces(call: ScriptToolCall, size: number): string[] {
  if (Array.isArray(call.arguments)) return [...call.arguments];
  return splitText(argumentsText(call), size);
}

export function callId(reply: ScriptReply, ctx: RenderContext, index: number): string {
  const given = reply.toolCalls?.[index]?.id;
  return given ?? `call_${ctx.requestNumber}_${index}`;
}

export function finishReason(reply: ScriptReply): string {
  return reply.finishReason ?? ((reply.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop");
}

export function completionTokens(reply: ScriptReply, ctx: RenderContext): number {
  if (reply.usage?.completionTokens !== undefined) return reply.usage.completionTokens;
  const joined = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("") : (v ?? ""));
  const calls = (reply.toolCalls ?? []).map((c) => c.name + argumentsText(c)).join("");
  return ctx.countTokens(joined(reply.reasoning) + joined(reply.text) + calls);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function timings(ctx: RenderContext, processed: number, predicted: number): Json {
  const promptN = Math.max(0, processed - ctx.cachedTokens);
  const promptMs = promptN > 0 ? round3((promptN / ctx.promptTokensPerSecond) * 1000) : 0;
  const predictedMs =
    predicted > 0 ? round3((predicted / ctx.completionTokensPerSecond) * 1000) : 0;
  return {
    cache_n: ctx.cachedTokens,
    prompt_n: promptN,
    prompt_ms: promptMs,
    prompt_per_token_ms: promptN > 0 ? promptMs / promptN : 0,
    prompt_per_second: promptN > 0 ? ctx.promptTokensPerSecond : 0,
    predicted_n: predicted,
    predicted_ms: predictedMs,
    predicted_per_token_ms: predicted > 0 ? predictedMs / predicted : 0,
    predicted_per_second: predicted > 0 ? ctx.completionTokensPerSecond : 0,
  };
}

function usage(ctx: RenderContext, completion: number): Json {
  return {
    completion_tokens: completion,
    prompt_tokens: ctx.promptTokens,
    total_tokens: ctx.promptTokens + completion,
    prompt_tokens_details: { cached_tokens: ctx.cachedTokens },
  };
}

function meta(ctx: RenderContext, object: string): Json {
  return {
    created: CREATED + ctx.requestNumber,
    id: `chatcmpl-mock-${ctx.requestNumber}`,
    model: ctx.model,
    system_fingerprint: ctx.flavor === "llama.cpp" ? "b12359-mock" : "fp_mock",
    object,
  };
}

/** The data payloads of a streamed reply, in order, ending with "[DONE]". */
export function streamEvents(reply: ScriptReply, ctx: RenderContext): (Json | "[DONE]")[] {
  const events: (Json | "[DONE]")[] = [];
  const llama = ctx.flavor === "llama.cpp";
  const size = reply.pacing?.chunkSize ?? DEFAULT_CHUNK;
  const argSize = reply.pacing?.argumentChunkSize ?? DEFAULT_ARGUMENT_CHUNK;
  const style = reply.pacing?.toolCallStyle ?? "split";
  const totalCompletion = completionTokens(reply, ctx);
  const roleDelta = { role: "assistant", content: null };
  const chunk = (delta: Json, finish: string | null = null): Json => ({
    choices: [{ finish_reason: finish, index: 0, delta }],
    ...meta(ctx, "chat.completion.chunk"),
  });

  if (llama && ctx.returnProgress) {
    let processed = Math.min(ctx.cachedTokens, ctx.promptTokens);
    const steps: number[] = [processed];
    while (processed < ctx.promptTokens) {
      processed = Math.min(ctx.promptTokens, processed + ctx.progressBatch);
      steps.push(processed);
    }
    for (const done of steps) {
      const t = timings(ctx, done, 0);
      events.push({
        ...chunk(roleDelta),
        timings: t,
        prompt_progress: {
          total: ctx.promptTokens,
          cache: ctx.cachedTokens,
          processed: done,
          time_ms: Math.round(Number(t.prompt_ms)),
        },
      });
    }
  }
  events.push(chunk(roleDelta));

  const deltas: Json[] = [];
  for (const piece of splitText(reply.reasoning, size)) deltas.push({ reasoning_content: piece });
  for (const piece of splitText(reply.text, size)) deltas.push({ content: piece });
  (reply.toolCalls ?? []).forEach((call, index) => {
    const id = callId(reply, ctx, index);
    const head = (args: string): Json => {
      const entry: Json = {};
      if (style !== "no-index") entry.index = index;
      if (style !== "no-id" && id !== "") entry.id = id;
      entry.type = "function";
      entry.function = { name: call.name, arguments: args };
      return entry;
    };
    if (style === "whole") {
      deltas.push({ tool_calls: [head(argumentsText(call))] });
      return;
    }
    const pieces = argumentPieces(call, argSize);
    deltas.push({ tool_calls: [head(pieces[0] ?? "")] });
    for (const piece of pieces.slice(1)) {
      const entry: Json = style === "no-index" ? {} : { index };
      entry.function = { arguments: piece };
      deltas.push({ tool_calls: [entry] });
    }
  });
  deltas.forEach((delta, i) => {
    const event = chunk(delta);
    if (llama && ctx.timingsPerToken) {
      const predicted = Math.max(1, Math.round(((i + 1) / deltas.length) * totalCompletion));
      event.timings = timings(ctx, ctx.promptTokens, predicted);
    }
    events.push(event);
  });

  const finish = chunk({}, finishReason(reply));
  if (ctx.includeUsage) {
    events.push(finish);
    const last: Json = { choices: [], ...meta(ctx, "chat.completion.chunk") };
    last.usage = usage(ctx, totalCompletion);
    if (llama) last.timings = timings(ctx, ctx.promptTokens, totalCompletion);
    events.push(last);
  } else {
    if (llama) finish.timings = timings(ctx, ctx.promptTokens, totalCompletion);
    events.push(finish);
  }
  events.push("[DONE]");
  return events;
}

/** The body of a non-streamed chat completion. */
export function completionBody(reply: ScriptReply, ctx: RenderContext): Json {
  const joined = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("") : (v ?? ""));
  const message: Json = { role: "assistant", content: joined(reply.text) };
  const reasoning = joined(reply.reasoning);
  if (reasoning) message.reasoning_content = reasoning;
  const calls = reply.toolCalls ?? [];
  if (calls.length > 0) {
    message.tool_calls = calls.map((call, index) => {
      const id = callId(reply, ctx, index);
      return {
        type: "function",
        function: { name: call.name, arguments: argumentsText(call) },
        ...(id === "" ? {} : { id }),
      };
    });
  }
  const completion = completionTokens(reply, ctx);
  const { object: _object, ...rest } = meta(ctx, "chat.completion");
  const body: Json = {
    choices: [{ finish_reason: finishReason(reply), index: 0, message }],
    created: rest.created,
    model: rest.model,
    system_fingerprint: rest.system_fingerprint,
    object: "chat.completion",
    usage: usage(ctx, completion),
    id: rest.id,
  };
  if (ctx.flavor === "llama.cpp") body.timings = timings(ctx, ctx.promptTokens, completion);
  return body;
}

/** Wraps one payload as an SSE event. */
export function sseEvent(payload: Json | "[DONE]", lineEnding: "lf" | "crlf", comment: boolean) {
  const eol = lineEnding === "crlf" ? "\r\n" : "\n";
  const data = payload === "[DONE]" ? "[DONE]" : JSON.stringify(payload);
  return `${comment ? `: keep-alive${eol}` : ""}data: ${data}${eol}${eol}`;
}

/** llama-server's error body: `{"error": {"code", "message", "type"}}` plus any extra fields. */
export function errorBody(status: number, message: string, type?: string, extra: Json = {}): Json {
  return { error: { code: status, message, type: type ?? errorType(status), ...extra } };
}

function errorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 501) return "not_supported_error";
  if (status === 503) return "unavailable_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "server_error";
}

export function overflowBody(promptTokens: number, contextWindow: number): Json {
  return errorBody(
    400,
    `request (${promptTokens} tokens) exceeds the available context size (${contextWindow} tokens), try increasing it`,
    "exceed_context_size_error",
    { n_prompt_tokens: promptTokens, n_ctx: contextWindow },
  );
}
