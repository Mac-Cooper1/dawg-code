/**
 * Small JSON-over-HTTP helper shared by the endpoint probes and the runtime. It never throws:
 * every outcome, including "nothing is listening" and timeouts, comes back as a value.
 */

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  apiKey?: string;
  method?: "GET" | "POST";
  body?: unknown;
}

export type HttpResult =
  | { ok: true; status: number; data: unknown }
  | {
      ok: false;
      /** HTTP status, absent when no response arrived. */
      status?: number;
      /** "unreachable" (refused, reset, DNS), "timeout", "aborted", "http" or "invalid-json". */
      reason: "unreachable" | "timeout" | "aborted" | "http" | "invalid-json";
      message: string;
      data?: unknown;
    };

export async function requestJson(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
      redirect: "follow",
    });
  } catch (error) {
    if (options.signal?.aborted)
      return { ok: false, reason: "aborted", message: "request aborted" };
    if (timeout.aborted)
      return { ok: false, reason: "timeout", message: `no response from ${url}` };
    return { ok: false, reason: "unreachable", message: describe(error) };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (timeout.aborted)
      return { ok: false, reason: "timeout", message: `response from ${url} timed out` };
    return { ok: false, status: response.status, reason: "unreachable", message: describe(error) };
  }
  let data: unknown;
  try {
    data = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    if (!response.ok) {
      return { ok: false, status: response.status, reason: "http", message: text.slice(0, 500) };
    }
    return {
      ok: false,
      status: response.status,
      reason: "invalid-json",
      message: text.slice(0, 200),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: "http",
      message: errorMessage(data) ?? `HTTP ${response.status}`,
      data,
    };
  }
  return { ok: true, status: response.status, data };
}

/** The message from an OpenAI-style `{ error: { message } }` body, or a plain `{ error }` string. */
export function errorMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  const error = (data as { error: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
    return error.message;
  }
  return String(error);
}

/** Strips trailing slashes so paths can be appended. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
