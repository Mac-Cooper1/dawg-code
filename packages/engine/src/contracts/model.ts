/**
 * The seam between the turn loop and whatever serves the model.
 * See docs/specs/phase-2-engine-core.md, "Model client".
 */
import type { Endpoint } from "@dawg/models";
import type { Message } from "./messages.ts";

/** A JSON Schema document. Tool schemas use an object schema at the top level. */
export type JsonSchema = { readonly [key: string]: unknown };

/** A tool as the model sees it. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** Sampler settings, normally taken from the model's profile. Unset fields use server defaults. */
export interface SamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}

export interface ModelRequest {
  messages: readonly Message[];
  tools: readonly ToolSchema[];
  toolChoice?: "auto" | "none" | "required";
  maxOutputTokens?: number;
  sampling?: SamplingParams;
  /** Sent only when the endpoint's template supports effort levels. */
  reasoningEffort?: string;
  /** Sent only when the endpoint's template supports parallel calls. */
  parallelToolCalls?: boolean;
  /** Bundled runtime only: the slot this agent is pinned to. */
  slot?: number;
  /** Extra top-level body fields, merged last. For grammars and template options. */
  extraBody?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

/** A tool call exactly as the model streamed it. `arguments` may not be valid JSON. */
export interface RawToolCall {
  /** Empty when the endpoint gave none. */
  id: string;
  name: string;
  arguments: string;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

/** Numbers the endpoint reported for one request. Null where it reported nothing. */
export interface ModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Prompt tokens reused from the cache rather than processed again. */
  cachedTokens: number | null;
  promptTokensPerSecond: number | null;
  completionTokensPerSecond: number | null;
  promptMs: number | null;
  completionMs: number | null;
}

export interface ModelReply {
  content: string;
  /** Empty when the model produced no reasoning. */
  reasoning: string;
  toolCalls: RawToolCall[];
  finishReason: FinishReason;
  usage: ModelUsage;
  /** The model name the endpoint reported, when it reported one. */
  model: string | null;
}

export type ModelStreamEvent =
  /** How much of the prompt has been read. Bundled runtime only. */
  | { type: "prompt_progress"; processed: number; total: number; cached: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; arguments: string }
  /** Always the last event of a successful stream. */
  | { type: "finished"; reply: ModelReply };

export interface ModelClient {
  readonly endpoint: Endpoint;
  /**
   * Sends one request and streams the reply. The iterator ends after a "finished" event, or
   * throws a `ModelError`. Aborting `request.signal` makes it throw a `ModelError` of kind
   * "aborted" promptly.
   */
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  /** An exact prompt token count where the endpoint offers one, otherwise null. */
  countTokens(request: Pick<ModelRequest, "messages" | "tools">): Promise<number | null>;
}

export type ModelErrorKind =
  /** The caller aborted. */
  | "aborted"
  /** Could not connect, or the connection failed before any reply arrived. */
  | "connection"
  /** The stream ended or broke part-way through a reply. */
  | "stream_interrupted"
  /** The endpoint answered with an HTTP error status. */
  | "http"
  /** The prompt does not fit the model's context window. */
  | "context_overflow"
  /** The endpoint answered with something that is not a chat completion. */
  | "invalid_response"
  | "timeout";

export interface ModelErrorOptions {
  status?: number;
  /** Whether sending the same request again could succeed. */
  retryable?: boolean;
  /** Whatever had been received before the failure. */
  partial?: Pick<ModelReply, "content" | "reasoning" | "toolCalls">;
  /** For "context_overflow", when the endpoint reported them: the prompt's size and the window. */
  promptTokens?: number;
  contextWindow?: number;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly partial: Pick<ModelReply, "content" | "reasoning" | "toolCalls"> | null;
  readonly promptTokens: number | null;
  readonly contextWindow: number | null;

  constructor(kind: ModelErrorKind, message: string, options: ModelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.partial = options.partial ?? null;
    this.promptTokens = options.promptTokens ?? null;
    this.contextWindow = options.contextWindow ?? null;
  }
}
