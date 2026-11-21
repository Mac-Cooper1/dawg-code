/**
 * OpenAI Chat Completions stream → Anthropic Messages SSE stream.
 *
 * Event flow, per https://platform.claude.com/docs/en/build-with-claude/streaming:
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)* →
 *   message_delta (stop_reason, cumulative usage) → message_stop, with `ping` events anywhere and
 *   `error` events for failures after the 200 response has started.
 * Delta types used: text_delta, thinking_delta, input_json_delta.
 *
 * Blocks are emitted one at a time with increasing indices. Text and reasoning stream as they
 * arrive (a switch between them closes one block and opens the next). Tool calls are buffered and
 * emitted after the upstream stream ends, each as one tool_use block whose input_json_delta is the
 * complete, validated JSON: the client never receives malformed partial JSON even when the model
 * produced malformed arguments (those become `{}` and are recorded as invalid).
 */

import { ChatAccumulator, errorText, isRecord } from "../chat-accumulator.ts";
import { formatSse } from "../sse.ts";
import {
  anthropicUsage,
  mapStopReason,
  messageId,
  sanitizeToolId,
  toolInput,
} from "./translate-response.ts";

type OpenBlock = "text" | "thinking" | null;

export class AnthropicStreamTranslator {
  readonly accumulator = new ChatAccumulator();
  readonly #write: (text: string) => void;
  readonly #model: string;
  readonly #estimatedInputTokens: number;
  #nextIndex = 0;
  #open: OpenBlock = null;
  #started = false;
  #finished = false;
  #lastWriteAt = Date.now();

  constructor(options: {
    model: string;
    estimatedInputTokens: number;
    write: (text: string) => void;
  }) {
    this.#model = options.model;
    this.#estimatedInputTokens = options.estimatedInputTokens;
    this.#write = options.write;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** ms since the last event was written. */
  idleMs(): number {
    return Date.now() - this.#lastWriteAt;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#emit("message_start", {
      type: "message_start",
      message: {
        id: messageId(),
        type: "message",
        role: "assistant",
        model: this.#model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        // The upstream reports usage only at the end; this is an estimate. message_delta carries
        // the real (cumulative) numbers.
        usage: { input_tokens: this.#estimatedInputTokens, output_tokens: 0 },
      },
    });
    this.ping();
  }

  ping(): void {
    if (this.#finished) return;
    this.#emit("ping", { type: "ping" });
  }

  /**
   * Apply one parsed OpenAI chunk. Returns an error message when the chunk carried an upstream
   * error (the caller should then call `fail`).
   */
  onChunk(chunk: unknown): string | null {
    if (this.#finished) return null;
    this.start();
    this.accumulator.applyChunk(chunk);
    if (!isRecord(chunk)) return null;
    if (chunk.error !== undefined && chunk.error !== null) return errorText(chunk.error);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices.find(
      (c): c is Record<string, unknown> => isRecord(c) && (c.index === undefined || c.index === 0),
    );
    const delta = choice && isRecord(choice.delta) ? choice.delta : null;
    if (!delta) return null;
    const reasoning =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (reasoning) {
      this.#ensureOpen("thinking");
      this.#emit("content_block_delta", {
        type: "content_block_delta",
        index: this.#nextIndex - 1,
        delta: { type: "thinking_delta", thinking: reasoning },
      });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.#ensureOpen("text");
      this.#emit("content_block_delta", {
        type: "content_block_delta",
        index: this.#nextIndex - 1,
        delta: { type: "text_delta", text: delta.content },
      });
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // Tool blocks are emitted at the end; close any open text/thinking block now so indices
      // follow the order the model produced them in.
      this.#closeOpen();
    }
    return null;
  }

  /** Close everything and end the message. */
  finish(): void {
    if (this.#finished) return;
    this.start();
    this.#closeOpen();
    const calls = this.accumulator.toolCalls();
    for (const call of calls) {
      const index = this.#nextIndex++;
      this.#emit("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: sanitizeToolId(call.id),
          name: call.name,
          input: {},
        },
      });
      this.#emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(toolInput(call.arguments)),
        },
      });
      this.#emit("content_block_stop", { type: "content_block_stop", index });
    }
    this.#emit("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(this.accumulator.finishReason, calls.length > 0),
        stop_sequence: null,
      },
      usage: anthropicUsage(this.accumulator),
    });
    this.#emit("message_stop", { type: "message_stop" });
    this.#finished = true;
  }

  /** End the stream with an `error` event. */
  fail(type: string, message: string): void {
    if (this.#finished) return;
    this.#emit("error", { type: "error", error: { type, message } });
    this.#finished = true;
  }

  #ensureOpen(kind: "text" | "thinking"): void {
    if (this.#open === kind) return;
    this.#closeOpen();
    const index = this.#nextIndex++;
    const block =
      kind === "text"
        ? { type: "text", text: "" }
        : { type: "thinking", thinking: "", signature: "" };
    this.#emit("content_block_start", { type: "content_block_start", index, content_block: block });
    this.#open = kind;
  }

  #closeOpen(): void {
    if (this.#open === null) return;
    this.#emit("content_block_stop", { type: "content_block_stop", index: this.#nextIndex - 1 });
    this.#open = null;
  }

  #emit(event: string, data: unknown): void {
    this.#lastWriteAt = Date.now();
    this.#write(formatSse(event, data));
  }
}
