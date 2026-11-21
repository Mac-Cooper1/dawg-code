/**
 * JSON-RPC 2.0 framing: envelopes, error codes and parsing helpers that never throw.
 *
 * Only single messages are used. Batches (arrays) are answered with an Invalid Request error.
 */
import { z } from "zod";

export const JSONRPC_VERSION = "2.0";

/** Request ids. Null appears only in error responses to messages whose id could not be read. */
export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

/** Our params are always objects; JSON-RPC also allows arrays, which no method here accepts. */
const ParamsSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: ParamsSchema.optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: ParamsSchema.optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: JsonRpcIdSchema,
    result: z.unknown(),
  })
  // `z.unknown()` accepts a missing key; a response must carry `result` even when it is null.
  .refine((value) => value.result !== undefined, { message: "Missing result", path: ["result"] });
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;

export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcIdSchema.nullable(),
  error: JsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------------------------

export const ErrorCodes = {
  // Standard JSON-RPC codes.
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // Application codes, sent by the engine. -32000 to -32099 is the range JSON-RPC leaves to us.
  /** No stored session has that id. */
  SessionNotFound: -32001,
  /** The session is running a turn and cannot take this request now. */
  SessionBusy: -32002,
  /** The request is well formed but not allowed in the current state, for example a session not open on this connection. */
  InvalidState: -32003,
  /** `initialize` asked for a protocol version the engine does not speak. */
  UnsupportedProtocolVersion: -32004,
  /** A request other than `initialize` arrived before `initialize` succeeded. */
  NotInitialized: -32005,
  /** A permission, question or plan request id is unknown or was already resolved. */
  RequestNotFound: -32006,
  /** The client cancelled the request (`rpc.cancel`) before it finished. */
  RequestCancelled: -32007,

  // Raised locally by the client; never sent over the wire.
  /** No response arrived within the request's timeout. */
  RequestTimeout: -32050,
  /** The transport closed before the response arrived. */
  ConnectionClosed: -32051,
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Notification a client sends to ask the server to abandon a request it no longer wants. */
export const CANCEL_METHOD = "rpc.cancel";
export const CancelParamsSchema = z.object({ id: JsonRpcIdSchema });
export type CancelParams = z.infer<typeof CancelParamsSchema>;

/**
 * An error with a JSON-RPC code. Handlers throw it to send a specific error; clients reject with
 * it for error responses, timeouts and closed connections.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  toJSON(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  static fromObject(error: JsonRpcErrorObject): RpcError {
    return new RpcError(error.code, error.message, error.data);
  }
}

export function isRpcError(value: unknown): value is RpcError {
  return value instanceof RpcError;
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

export function makeRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: JSONRPC_VERSION, id, method }
    : { jsonrpc: JSONRPC_VERSION, id, method, params: params as JsonRpcRequest["params"] };
}

export function makeNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: JSONRPC_VERSION, method }
    : { jsonrpc: JSONRPC_VERSION, method, params: params as JsonRpcNotification["params"] };
}

export function makeSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  // A void result still needs a value on the wire.
  return { jsonrpc: JSONRPC_VERSION, id, result: result === undefined ? null : result };
}

export function makeError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorObject =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** `JSON.parse` that reports failure instead of throwing. */
export function parseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type ParsedMessage =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "success"; message: JsonRpcSuccessResponse }
  | { kind: "error"; message: JsonRpcErrorResponse }
  /** Not a valid JSON-RPC message. `id` is recovered when the value had a usable one. */
  | { kind: "invalid"; id: JsonRpcId | null; error: JsonRpcErrorObject };

/** Classifies a decoded JSON value as a JSON-RPC message. Never throws. */
export function parseMessage(value: unknown): ParsedMessage {
  if (Array.isArray(value)) {
    return invalid(null, "Batch messages are not supported");
  }
  if (typeof value !== "object" || value === null) {
    return invalid(null, "A message must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const id = JsonRpcIdSchema.safeParse(record.id);
  const recoveredId = id.success ? id.data : null;

  if (record.jsonrpc !== JSONRPC_VERSION) {
    return invalid(recoveredId, 'The "jsonrpc" member must be "2.0"');
  }

  if ("method" in record) {
    if ("id" in record && record.id !== undefined) {
      const parsed = JsonRpcRequestSchema.safeParse(value);
      return parsed.success
        ? { kind: "request", message: parsed.data }
        : invalid(recoveredId, describeIssues(parsed.error));
    }
    const parsed = JsonRpcNotificationSchema.safeParse(value);
    return parsed.success
      ? { kind: "notification", message: parsed.data }
      : invalid(null, describeIssues(parsed.error));
  }

  if ("error" in record) {
    const parsed = JsonRpcErrorResponseSchema.safeParse(value);
    return parsed.success
      ? { kind: "error", message: parsed.data }
      : invalid(recoveredId, describeIssues(parsed.error));
  }

  if ("result" in record) {
    const parsed = JsonRpcSuccessResponseSchema.safeParse(value);
    return parsed.success
      ? { kind: "success", message: parsed.data }
      : invalid(recoveredId, describeIssues(parsed.error));
  }

  return invalid(recoveredId, "Not a request, notification or response");
}

function invalid(id: JsonRpcId | null, message: string): ParsedMessage {
  return {
    kind: "invalid",
    id,
    error: { code: ErrorCodes.InvalidRequest, message: `Invalid Request: ${message}` },
  };
}

/** One schema problem, in a JSON-plain form suitable for an error's `data`. */
export interface IssueSummary {
  path: (string | number)[];
  message: string;
}

export function summarizeIssues(error: z.ZodError): IssueSummary[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
    message: issue.message,
  }));
}

export function describeIssues(error: z.ZodError): string {
  return summarizeIssues(error)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}
