import type { EndpointKind } from "@dawg/models";

/**
 * The script format. Everything except function matchers is plain JSON, so a script can live in
 * a file (see README.md).
 */

/** A tool call the mock streams back. */
export interface ScriptToolCall {
  /** Defaults to "call_<request>_<n>". Set to "" to stream a call with no id. */
  id?: string;
  name: string;
  /**
   * The arguments text. An object is serialised with JSON.stringify; a string is sent as is
   * (so it can be invalid JSON); an array of strings gives the exact argument chunks.
   */
  arguments?: string | string[] | Record<string, unknown>;
}

/** How a streamed reply is cut into chunks and paced. */
export interface Pacing {
  /** Characters per text or reasoning chunk, when the text is not already given as chunks. Default 16. */
  chunkSize?: number;
  /** Characters per tool-argument chunk, when not given as chunks. Default 8. */
  argumentChunkSize?: number;
  /** Delay before the first event, in milliseconds. */
  firstEventDelayMs?: number;
  /** Delay between events, in milliseconds. */
  delayMs?: number;
  /**
   * How tool calls are streamed:
   * - "split": like llama-server, the first delta carries index, id, type and name, later deltas
   *   carry argument pieces (default);
   * - "whole": each call arrives complete in one delta;
   * - "no-index": like "split" but no delta carries an index;
   * - "no-id": like "split" but no delta carries an id.
   */
  toolCallStyle?: "split" | "whole" | "no-index" | "no-id";
}

/** Byte-level shaping of a streamed reply, for testing stream readers. */
export interface WireOptions {
  /** Write the stream in pieces of this many bytes (splitting events and characters). */
  bytesPerWrite?: number;
  /** "crlf" ends every SSE line with \r\n. Default "lf". */
  lineEnding?: "lf" | "crlf";
  /** Put a comment line (": keep-alive") before every event. */
  comments?: boolean;
}

/** Numbers to report instead of the mock's estimates. */
export interface ScriptUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}

export type Fault =
  /** Destroy the socket after this many events (0: right after the response headers). */
  | { type: "drop"; afterEvents?: number }
  /** Send this many events, then nothing: the response never ends. */
  | { type: "stall"; afterEvents?: number }
  /** Answer with an HTTP error status. `body` defaults to an OpenAI-style error object. */
  | { type: "http"; status: number; body?: unknown; message?: string }
  /** The real server's "request exceeds the available context size" error (HTTP 400). */
  | { type: "context_overflow"; promptTokens?: number; contextWindow?: number }
  /** Answer a streaming request with a plain JSON chat completion. */
  | { type: "non_streaming" }
  /**
   * After this many events, send llama-server's mid-stream error event
   * (`data: {"error": {...}}`) and end the response without [DONE].
   */
  | { type: "stream_error"; afterEvents?: number; status?: number; message?: string }
  /** Answer with a 200 response that is not a chat completion. */
  | { type: "invalid"; contentType?: string; body?: string };

/** One scripted answer to one chat request. */
export interface ScriptReply {
  /** Visible text. An array gives the exact chunks. */
  text?: string | string[];
  /** Reasoning text, streamed before the text as `reasoning_content`. An array gives the chunks. */
  reasoning?: string | string[];
  toolCalls?: ScriptToolCall[];
  /** Defaults to "tool_calls" when there are tool calls, else "stop". */
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | (string & {});
  usage?: ScriptUsage;
  pacing?: Pacing;
  wire?: WireOptions;
  fault?: Fault;
  /** A label shown in errors and in `assertDone` reports. */
  label?: string;
}

/** Declarative request matcher. Every field given must match. */
export interface RequestMatcher {
  /** Substring of the first system message. */
  system?: string;
  /** Substring of the text of the last user message. */
  lastUser?: string;
  /** Substring anywhere in the raw request body. */
  bodyIncludes?: string;
  /** true: the request offers tools; false: it offers none. */
  hasTools?: boolean;
  /** The request's max_tokens is set and at most this. */
  maxTokensAtMost?: number;
}

export type MatchSpec = RequestMatcher | ((request: RecordedRequest) => boolean);

export interface LaneSpec {
  /** Which chat requests this lane answers. Lanes are tried in declaration order. */
  match: MatchSpec;
  replies?: ScriptReply[];
}

/** A whole script: replies for the main lane, plus optional named lanes. */
export interface Script {
  replies?: ScriptReply[];
  lanes?: Record<string, LaneSpec>;
}

export interface RecordedRequest {
  /** Order of arrival over all requests, from 0. */
  index: number;
  method: string;
  /** Path including any query string. */
  path: string;
  /** Lower-case header names; authorization headers are left out. */
  headers: Record<string, string>;
  /** The parsed JSON body, the raw text when it is not JSON, or undefined when empty. */
  body: unknown;
  rawBody: string;
  /** Chat requests only: the lane that answered, and the position of the reply within it. */
  lane?: string;
  replyIndex?: number;
}

export interface TemplateCaps {
  supports_tools?: boolean;
  supports_tool_calls?: boolean;
  supports_parallel_tool_calls?: boolean;
  supports_reasoning_effort?: boolean;
  supports_preserve_reasoning?: boolean;
  supports_system_role?: boolean;
  supports_object_arguments?: boolean;
  supports_string_content?: boolean;
  supports_typed_content?: boolean;
  reasoning_effort_levels?: string[];
}

export interface MockModelOptions {
  script?: Script | ScriptReply[];
  /** The `Endpoint.kind` reported. Default "bundled". */
  kind?: EndpointKind;
  /**
   * Which server to imitate. "llama.cpp" adds `timings`, progress chunks, /props and the
   * token-count endpoint; "openai" leaves them out. Default: "llama.cpp" for the bundled kind,
   * "openai" otherwise.
   */
  flavor?: "llama.cpp" | "openai";
  /** The model id. Default "mock-model". */
  model?: string;
  /** Context window per slot, reported in /props and /v1/models. Default 8192. */
  contextWindow?: number;
  /** Answer every request whose estimated prompt exceeds the window with the overflow error. */
  enforceContextWindow?: boolean;
  totalSlots?: number;
  templateCaps?: TemplateCaps;
  chatTemplate?: string;
  capabilities?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  /** When set, requests other than /health need `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** 0 (default) picks a free port. The mock always listens on 127.0.0.1. */
  port?: number;
  /** Exact token count for the token-count endpoint and usage. Default: characters / 4. */
  countTokens?: (text: string) => number;
  /** Speeds used to make `timings`. Defaults 1000 and 50 tokens per second. */
  promptTokensPerSecond?: number;
  completionTokensPerSecond?: number;
  /** Prompt tokens per progress chunk when `return_progress` is set. Default 512. */
  progressBatch?: number;
  /** GET /health answers 503 "Loading model" while this is true. */
  loading?: boolean;
}
