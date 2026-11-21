import { ModelError, type ModelReply } from "../contracts/model.ts";

/**
 * Mapping of failures to `ModelError`. The client never retries; `retryable` only says whether
 * sending the same request again could succeed, and the turn loop decides what to do with it.
 */

type Partial = Pick<ModelReply, "content" | "reasoning" | "toolCalls"> | null;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Error types that always mean the prompt does not fit. */
const OVERFLOW_TYPES = new Set(["exceed_context_size_error", "context_length_exceeded"]);

/**
 * Wordings of "the prompt does not fit" from the servers we may meet: llama-server (current and
 * older builds), OpenAI, vLLM, LM Studio and others. Only consulted for 400, 413 and 422 answers
 * and for errors that arrive inside a stream.
 */
const OVERFLOW_TEXT = [
  /exceeds? (?:the )?(?:available |maximum )?context(?: size| length| window)?/i,
  /maximum context length/i,
  /context(?: length| window| size)? (?:limit )?(?:was |is |has been )?exceeded/i,
  /(?:prompt|input|request) is too long/i,
  /(?:prompt|input)[^.]{0,60}(?:longer|larger|more) than (?:the )?(?:model'?s? )?(?:maximum |max )?context/i,
  /context (?:length|window) of only \d+ tokens/i,
  /not enough (?:room|space) in the context/i,
];

/** 5xx answers that come from the request itself, so repeating it cannot help. */
const DETERMINISTIC_SERVER_ERRORS = [
  /image input is not supported/i,
  /failed to parse tool call arguments/i,
  /cannot use custom grammar constraints with tools/i,
];

export interface ErrorDetails {
  message: string | null;
  type: string | null;
  code: string | number | null;
}

/** Reads `{error: {message, type, code}}`, `{error: "text"}`, or vLLM's top-level `{message}`. */
export function errorDetails(data: unknown): ErrorDetails {
  const out: ErrorDetails = { message: null, type: null, code: null };
  if (!isObject(data)) return out;
  const error = data.error;
  const source = isObject(error) ? error : data;
  if (typeof error === "string") out.message = error;
  else if (typeof source.message === "string") out.message = source.message;
  else if (typeof source.detail === "string") out.message = source.detail;
  if (typeof source.type === "string") out.type = source.type;
  if (typeof source.code === "string" || typeof source.code === "number") out.code = source.code;
  return out;
}

export function isContextOverflow(details: ErrorDetails): boolean {
  if (details.type && OVERFLOW_TYPES.has(details.type)) return true;
  if (typeof details.code === "string" && OVERFLOW_TYPES.has(details.code)) return true;
  const message = details.message ?? "";
  return OVERFLOW_TEXT.some((pattern) => pattern.test(message));
}

/** The sizes llama-server reports with a context overflow (`n_prompt_tokens`, `n_ctx`). */
function overflowSizes(data: unknown): { promptTokens?: number; contextWindow?: number } {
  if (!isObject(data)) return {};
  const source = isObject(data.error) ? data.error : data;
  const out: { promptTokens?: number; contextWindow?: number } = {};
  if (typeof source.n_prompt_tokens === "number") out.promptTokens = source.n_prompt_tokens;
  if (typeof source.n_ctx === "number") out.contextWindow = source.n_ctx;
  return out;
}

function retryableStatus(status: number, message: string): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status < 500) return false;
  return !DETERMINISTIC_SERVER_ERRORS.some((pattern) => pattern.test(message));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** An HTTP error answer. `bodyText` is the raw body; its message is carried into the error. */
export function httpError(status: number, statusText: string, bodyText: string): ModelError {
  const data = parseJson(bodyText);
  const details = errorDetails(data);
  const message = details.message ?? (bodyText.trim().slice(0, 500) || statusText || "no message");
  if ([400, 413, 422].includes(status) && isContextOverflow(details)) {
    return new ModelError(
      "context_overflow",
      `the prompt does not fit the context window: ${message}`,
      {
        status,
        retryable: false,
        ...overflowSizes(data),
        cause: data ?? bodyText,
      },
    );
  }
  return new ModelError("http", `HTTP ${status}: ${message}`, {
    status,
    retryable: retryableStatus(status, message),
    cause: data ?? bodyText,
  });
}

/** An error object that arrived inside a stream (`data: {"error": {...}}`). */
export function streamErrorEvent(data: unknown, partial: Partial): ModelError {
  const details = errorDetails(data);
  const message = details.message ?? "the server reported an error";
  const status = typeof details.code === "number" ? details.code : undefined;
  if (isContextOverflow(details)) {
    return new ModelError(
      "context_overflow",
      `the prompt does not fit the context window: ${message}`,
      {
        status,
        retryable: false,
        partial: partial ?? undefined,
        ...overflowSizes(data),
        cause: data,
      },
    );
  }
  // Nothing was streamed yet: the server refused the request, it did not break off a reply.
  if (partial === null) {
    return new ModelError("http", `server error: ${message}`, {
      status,
      retryable: status === undefined || retryableStatus(status, message),
      cause: data,
    });
  }
  return new ModelError("stream_interrupted", `the reply broke off: ${message}`, {
    status,
    retryable: true,
    partial,
    cause: data,
  });
}

/** Text for a low-level network error, including the system error code when there is one. */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${error.message}: ${typeof code === "string" ? `${code} ` : ""}${cause.message}`.trim();
  }
  return error.message;
}
