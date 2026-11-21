import type { TimingsRecord, UsageRecord } from "./record.ts";
import { emptyUsage } from "./record.ts";
import type { RawToolCall } from "./tool-validation.ts";

/**
 * Reconstructs the assistant turn from an OpenAI Chat Completions response, streamed or not.
 *
 * Wire format: https://platform.openai.com/docs/api-reference/chat/object and
 * https://platform.openai.com/docs/api-reference/chat-streaming (chunks carry `choices[].delta`;
 * tool calls arrive as `delta.tool_calls[]` fragments keyed by `index`; usage arrives in a final
 * chunk with empty `choices` when `stream_options.include_usage` is set).
 * llama-server adds `timings` (usually on the last chunk) and `reasoning_content`:
 * https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 *
 * Only choice 0 is tracked (agents do not ask for n > 1).
 */
export class ChatAccumulator {
  content = "";
  reasoning = "";
  finishReason: string | null = null;
  model: string | null = null;
  id: string | null = null;
  usage: UsageRecord = emptyUsage();
  timings: TimingsRecord | null = null;
  /** Set when the upstream reported an error inside a 200 response or stream. */
  error: string | null = null;
  readonly #tools = new Map<number, { id: string | null; name: string; arguments: string }>();
  #lastToolIndex = -1;

  /** Apply one parsed `chat.completion.chunk`. */
  applyChunk(chunk: unknown): void {
    if (!isRecord(chunk)) return;
    this.#applyCommon(chunk);
    const choice = firstChoice(chunk.choices);
    if (!choice) return;
    const delta = choice.delta;
    if (isRecord(delta)) {
      if (typeof delta.content === "string") this.content += delta.content;
      const reasoning = reasoningText(delta);
      if (reasoning) this.reasoning += reasoning;
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) this.#applyToolFragment(fragment);
      }
      // Deprecated single function_call form.
      if (isRecord(delta.function_call)) {
        this.#applyToolFragment({ index: 0, function: delta.function_call });
      }
    }
    if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
  }

  /** Apply a whole non-streamed `chat.completion` object. */
  applyCompletion(body: unknown): void {
    if (!isRecord(body)) return;
    this.#applyCommon(body);
    const choice = firstChoice(body.choices);
    if (!choice) return;
    const message = choice.message;
    if (isRecord(message)) {
      if (typeof message.content === "string") this.content += message.content;
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isRecord(part) && typeof part.text === "string") this.content += part.text;
        }
      }
      const reasoning = reasoningText(message);
      if (reasoning) this.reasoning += reasoning;
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach((call, i) => {
          if (!isRecord(call)) return;
          const fn = isRecord(call.function) ? call.function : {};
          this.#tools.set(i, {
            id: typeof call.id === "string" ? call.id : null,
            name: typeof fn.name === "string" ? fn.name : "",
            arguments: argumentsText(fn.arguments),
          });
        });
      } else if (isRecord(message.function_call)) {
        const fn = message.function_call;
        this.#tools.set(0, {
          id: null,
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: argumentsText(fn.arguments),
        });
      }
    }
    if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
  }

  /** Tool calls in index order. */
  toolCalls(): RawToolCall[] {
    return [...this.#tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  }

  /** Tool indices currently known, in order. */
  toolIndices(): number[] {
    return [...this.#tools.keys()].sort((a, b) => a - b);
  }

  #applyCommon(obj: Record<string, unknown>): void {
    if (typeof obj.model === "string" && obj.model) this.model = obj.model;
    if (typeof obj.id === "string" && obj.id && !this.id) this.id = obj.id;
    if (isRecord(obj.usage)) this.usage = usageFrom(obj.usage, this.usage);
    if (isRecord(obj.timings)) this.timings = timingsFrom(obj.timings);
    if (obj.error !== undefined && obj.error !== null) this.error = errorText(obj.error);
  }

  #applyToolFragment(fragment: unknown): void {
    if (!isRecord(fragment)) return;
    const id = typeof fragment.id === "string" && fragment.id ? fragment.id : null;
    let index: number;
    if (typeof fragment.index === "number") {
      index = fragment.index;
    } else {
      // Some servers omit `index`: a new id starts a new call, otherwise continue the last one.
      const last = this.#tools.get(this.#lastToolIndex);
      if (this.#lastToolIndex < 0 || (id !== null && last && last.id !== null && last.id !== id)) {
        index = this.#lastToolIndex + 1;
      } else {
        index = this.#lastToolIndex;
      }
    }
    this.#lastToolIndex = index;
    let call = this.#tools.get(index);
    if (!call) {
      call = { id: null, name: "", arguments: "" };
      this.#tools.set(index, call);
    }
    if (id !== null && call.id === null) call.id = id;
    const fn = isRecord(fragment.function) ? fragment.function : null;
    if (fn) {
      if (typeof fn.name === "string" && fn.name) {
        // OpenAI sends the name once; tolerate servers that repeat it on every fragment.
        if (call.name === "") call.name = fn.name;
        else if (call.name !== fn.name) call.name += fn.name;
      }
      if (typeof fn.arguments === "string") call.arguments += fn.arguments;
      else if (fn.arguments !== undefined && fn.arguments !== null) {
        call.arguments += argumentsText(fn.arguments);
      }
    }
  }
}

/** `reasoning_content` (llama-server, DeepSeek, vLLM) or `reasoning` (some other servers). */
function reasoningText(obj: Record<string, unknown>): string {
  if (typeof obj.reasoning_content === "string") return obj.reasoning_content;
  if (typeof obj.reasoning === "string") return obj.reasoning;
  return "";
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  // Some servers send already-parsed objects; record them as their JSON text.
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function firstChoice(choices: unknown): Record<string, unknown> | null {
  if (!Array.isArray(choices)) return null;
  for (const choice of choices) {
    if (isRecord(choice) && (choice.index === undefined || choice.index === 0)) return choice;
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function usageFrom(usage: Record<string, unknown>, previous: UsageRecord): UsageRecord {
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  return {
    prompt_tokens: num(usage.prompt_tokens) ?? previous.prompt_tokens,
    completion_tokens: num(usage.completion_tokens) ?? previous.completion_tokens,
    cached_tokens: (details ? num(details.cached_tokens) : null) ?? previous.cached_tokens,
  };
}

export function timingsFrom(t: Record<string, unknown>): TimingsRecord {
  return {
    cache_n: num(t.cache_n),
    prompt_n: num(t.prompt_n),
    prompt_per_second: num(t.prompt_per_second),
    predicted_n: num(t.predicted_n),
    predicted_per_second: num(t.predicted_per_second),
    prompt_ms: num(t.prompt_ms),
    predicted_ms: num(t.predicted_ms),
  };
}

/** Readable text for an `error` member of an upstream body. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return "upstream error";
    }
  }
  return String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
