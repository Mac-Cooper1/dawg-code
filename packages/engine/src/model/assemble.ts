import type {
  FinishReason,
  ModelReply,
  ModelStreamEvent,
  ModelUsage,
  RawToolCall,
} from "../contracts/model.ts";

/**
 * Folds chat-completion chunks into stream events and a final reply.
 *
 * Tool calls are assembled by `index`. Servers differ, so the assembler also copes with:
 * a whole call in one delta; deltas without an index (matched by id, else a delta that names a
 * tool starts a new call and one that does not continues the last); deltas without an id; and
 * servers that reuse index 0 for every call but give each a new id. A call is announced with
 * `tool_call_started` once its name is known; argument text that arrives before the name is held
 * back until then.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface CallState {
  /** Position in the reply's tool-call list: the `index` of the events. */
  ordinal: number;
  serverIndex: number | null;
  id: string;
  name: string;
  arguments: string;
  started: boolean;
  /** Argument text received before the name. */
  held: string;
}

export class ChunkError extends Error {
  readonly data: unknown;
  constructor(message: string, data: unknown) {
    super(message);
    this.name = "ChunkError";
    this.data = data;
  }
}

const FINISH: Record<string, FinishReason> = {
  stop: "stop",
  end_turn: "stop",
  eos: "stop",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  length: "length",
  max_tokens: "length",
  content_filter: "content_filter",
};

export class ReplyAssembler {
  private content = "";
  private reasoning = "";
  private readonly calls: CallState[] = [];
  private finish: string | null = null;
  private usage: Json | null = null;
  private timings: Json | null = null;
  private model: string | null = null;

  /** A finish reason has been seen. */
  get finished(): boolean {
    return this.finish !== null;
  }

  /**
   * Takes one parsed chunk and returns the events it produces. Throws `ChunkError` for an error
   * object, and for anything that is not a chat-completion chunk.
   */
  accept(chunk: unknown): ModelStreamEvent[] {
    if (!isObject(chunk)) throw new ChunkError("a stream event is not a JSON object", chunk);
    if (chunk.error !== undefined) throw new ChunkError("error", chunk);
    const known =
      Array.isArray(chunk.choices) ||
      isObject(chunk.usage) ||
      isObject(chunk.timings) ||
      isObject(chunk.prompt_progress);
    if (!known) throw new ChunkError("a stream event is not a chat-completion chunk", chunk);

    const events: ModelStreamEvent[] = [];
    if (this.model === null && typeof chunk.model === "string" && chunk.model) {
      this.model = chunk.model;
    }
    if (isObject(chunk.usage)) this.usage = chunk.usage;
    if (isObject(chunk.timings)) this.timings = chunk.timings;
    const progress = chunk.prompt_progress;
    if (isObject(progress)) {
      const total = num(progress.total);
      const processed = num(progress.processed);
      if (total !== null && processed !== null) {
        events.push({
          type: "prompt_progress",
          processed,
          total,
          cached: num(progress.cache) ?? 0,
        });
      }
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices.filter(isObject) : [];
    const choice = choices.find((c) => c.index === 0 || c.index === undefined) ?? choices[0];
    if (!choice) return events;
    const delta = isObject(choice.delta)
      ? choice.delta
      : isObject(choice.message)
        ? choice.message
        : {};
    this.applyDelta(delta, events);
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      this.finish = choice.finish_reason;
    }
    return events;
  }

  private applyDelta(delta: Json, events: ModelStreamEvent[]): void {
    const thought =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (thought) {
      this.reasoning += thought;
      events.push({ type: "reasoning_delta", text: thought });
    }
    if (typeof delta.content === "string" && delta.content) {
      this.content += delta.content;
      events.push({ type: "text_delta", text: delta.content });
    }
    const entries: Json[] = Array.isArray(delta.tool_calls)
      ? delta.tool_calls.filter(isObject)
      : [];
    if (entries.length === 0 && isObject(delta.function_call)) {
      // The pre-tools "function_call" form: one call per reply.
      entries.push({ index: 0, function: delta.function_call });
    }
    for (const entry of entries) this.applyToolDelta(entry, events);
  }

  private applyToolDelta(entry: Json, events: ModelStreamEvent[]): void {
    const fn = isObject(entry.function) ? entry.function : {};
    const index = num(entry.index);
    const id = typeof entry.id === "string" ? entry.id : "";
    const name = typeof fn.name === "string" ? fn.name : "";
    const rawArgs = fn.arguments;
    const args =
      typeof rawArgs === "string"
        ? rawArgs
        : rawArgs === undefined || rawArgs === null
          ? ""
          : JSON.stringify(rawArgs);

    let call: CallState | undefined;
    if (index !== null) {
      call = this.calls.filter((c) => c.serverIndex === index).at(-1);
      // Some servers number every call 0 and tell them apart only by id.
      if (call && id && call.id && call.id !== id) call = undefined;
    } else if (id) {
      call = this.calls.find((c) => c.id === id);
    } else {
      const last = this.calls.at(-1);
      call = name && last?.name ? undefined : last;
    }
    if (!call) {
      call = {
        ordinal: this.calls.length,
        serverIndex: index,
        id: "",
        name: "",
        arguments: "",
        started: false,
        held: "",
      };
      this.calls.push(call);
    }
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    if (!call.started && call.name) {
      call.started = true;
      events.push({ type: "tool_call_started", index: call.ordinal, id: call.id, name: call.name });
      if (call.held) {
        events.push({ type: "tool_call_delta", index: call.ordinal, arguments: call.held });
        call.held = "";
      }
    }
    if (args) {
      call.arguments += args;
      if (call.started) {
        events.push({ type: "tool_call_delta", index: call.ordinal, arguments: args });
      } else {
        call.held += args;
      }
    }
  }

  /** Whatever has arrived so far, or null when nothing has. */
  partial(): Pick<ModelReply, "content" | "reasoning" | "toolCalls"> | null {
    if (!this.content && !this.reasoning && this.calls.length === 0) return null;
    return { content: this.content, reasoning: this.reasoning, toolCalls: this.toolCalls() };
  }

  private toolCalls(): RawToolCall[] {
    return this.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
  }

  /** Closing events for calls never announced (no name arrived), then the final reply. */
  complete(): { events: ModelStreamEvent[]; reply: ModelReply } {
    const events: ModelStreamEvent[] = [];
    for (const call of this.calls) {
      if (call.started) continue;
      call.started = true;
      events.push({ type: "tool_call_started", index: call.ordinal, id: call.id, name: call.name });
      if (call.held) {
        events.push({ type: "tool_call_delta", index: call.ordinal, arguments: call.held });
        call.held = "";
      }
    }
    const reply: ModelReply = {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls: this.toolCalls(),
      finishReason: this.finish === null ? "unknown" : (FINISH[this.finish] ?? "unknown"),
      usage: toUsage(this.usage, this.timings),
      model: this.model,
    };
    return { events, reply };
  }
}

/**
 * `ModelUsage` from an OpenAI `usage` object and llama-server's `timings` block. On llama-server
 * `usage.prompt_tokens` counts the whole prompt, `timings.cache_n` the part reused from the cache
 * and `timings.prompt_n` the part processed now. Speeds are null when nothing was processed.
 */
export function toUsage(usage: Json | null, timings: Json | null): ModelUsage {
  const details =
    usage && isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const promptN = timings ? num(timings.prompt_n) : null;
  const cacheN = timings ? num(timings.cache_n) : null;
  const predictedN = timings ? num(timings.predicted_n) : null;
  const usagePrompt = usage ? num(usage.prompt_tokens) : null;
  const usageCompletion = usage ? num(usage.completion_tokens) : null;
  return {
    promptTokens: usagePrompt ?? (promptN !== null ? promptN + (cacheN ?? 0) : null),
    completionTokens: usageCompletion ?? predictedN,
    cachedTokens: cacheN ?? (details ? num(details.cached_tokens) : null),
    promptTokensPerSecond:
      timings && promptN !== null && promptN > 0 ? num(timings.prompt_per_second) : null,
    completionTokensPerSecond:
      timings && predictedN !== null && predictedN > 0 ? num(timings.predicted_per_second) : null,
    promptMs: timings ? num(timings.prompt_ms) : null,
    completionMs: timings ? num(timings.predicted_ms) : null,
  };
}

/**
 * Checks that a whole (non-streamed) body is a chat completion, and returns its first choice's
 * message, or null.
 */
export function completionMessage(body: unknown): Json | null {
  if (!isObject(body) || !Array.isArray(body.choices)) return null;
  const choice = body.choices.find(isObject);
  if (!choice || !isObject(choice.message)) return null;
  return choice.message;
}
