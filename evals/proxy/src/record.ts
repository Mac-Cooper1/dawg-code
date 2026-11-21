import { z } from "zod";

/**
 * One line of the record file: one completed request through the proxy.
 *
 * The fields in the eval-runner contract are fixed (never rename or remove them). Fields marked
 * "added" are extras the contract allows.
 */

export const ApiKindSchema = z.enum(["openai.chat", "anthropic.messages", "other"]);
export type ApiKind = z.infer<typeof ApiKindSchema>;

export const ToolCallRecordSchema = z.object({
  name: z.string(),
  /** `arguments` parsed as JSON. */
  arguments_valid_json: z.boolean(),
  /** Validated against the tool's schema from the request; null when the tool is unknown, its
   * schema cannot be compiled, or the arguments are not valid JSON. */
  schema_valid: z.boolean().nullable(),
  /** Why the call is not valid (or could not be checked); null when everything checked out. */
  error: z.string().nullable(),
  /** added: the call id the model gave, if any. */
  id: z.string().nullable(),
  /** added: length of the raw `arguments` string, in UTF-8 bytes. */
  arguments_bytes: z.number().int(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const UsageRecordSchema = z.object({
  prompt_tokens: z.number().nullable(),
  completion_tokens: z.number().nullable(),
  cached_tokens: z.number().nullable(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** llama-server's `timings` block. */
export const TimingsRecordSchema = z.object({
  cache_n: z.number().nullable(),
  prompt_n: z.number().nullable(),
  prompt_per_second: z.number().nullable(),
  predicted_n: z.number().nullable(),
  predicted_per_second: z.number().nullable(),
  /** added */
  prompt_ms: z.number().nullable(),
  /** added */
  predicted_ms: z.number().nullable(),
});
export type TimingsRecord = z.infer<typeof TimingsRecordSchema>;

export const ProxyRecordSchema = z.object({
  /** 1-based, in order of arrival. Lines are appended on completion, so they can be out of order. */
  seq: z.number().int().positive(),
  started_at: z.string(),
  duration_ms: z.number(),
  api: ApiKindSchema,
  /** Path the client requested, without the query string. */
  path: z.string(),
  /** Model named in the client's request body; null when there was none. */
  model: z.string().nullable(),
  stream: z.boolean(),
  /** HTTP status sent to the client; null when none was sent (for example the client left first). */
  status: z.number().int().nullable(),
  request: z.object({
    /** Number of messages in the client's request (null when not a chat-style request). */
    messages: z.number().int().nullable(),
    /** Number of tools declared in the client's request (null when not a chat-style request). */
    tools: z.number().int().nullable(),
    /** Size of the client's request body as received. */
    body_bytes: z.number().int(),
  }),
  /** As reported by the upstream; nulls when it did not report them. */
  usage: UsageRecordSchema,
  timings: TimingsRecordSchema.nullable(),
  tool_calls: z.array(ToolCallRecordSchema),
  /** The upstream's finish_reason (OpenAI terms, also for translated Anthropic requests). */
  finish_reason: z.string().nullable(),
  /** Transport or upstream failure; null on success. */
  error: z.string().nullable(),
  /** added: HTTP method. */
  method: z.string(),
  /** added: the --label given to the proxy, or null. */
  label: z.string().nullable(),
  /** added: path requested from the upstream (after translation), or null if none was made. */
  upstream_path: z.string().nullable(),
  /** added: model sent to the upstream when it differs from `model` (see --upstream-model). */
  upstream_model: z.string().nullable(),
  /** added: ms from arrival until the upstream's response headers. */
  ttfb_ms: z.number().nullable(),
  /** added: true when the proxy added stream_options.include_usage to the request. */
  usage_injected: z.boolean(),
});
export type ProxyRecord = z.infer<typeof ProxyRecordSchema>;

export function emptyUsage(): UsageRecord {
  return { prompt_tokens: null, completion_tokens: null, cached_tokens: null };
}
