/**
 * Runs one `http` hook handler (code.claude.com/docs/en/hooks, "HTTP hook fields" and "HTTP
 * response handling"): the hook input is POSTed as JSON to the handler's URL, and the answer is
 * read by status and body.
 *
 * - 2xx: the body is read like a command's standard output on exit 0 (empty, or a JSON object);
 *   anything else in it is a non-blocking error (`interpretHandler`).
 * - Any other status, a connection that fails, or a redirect: a non-blocking error. Redirects
 *   are not followed, so `allowedHttpHookUrls` holds for the address the event reaches.
 * - The timeout cancels the request.
 *
 * Local addresses are allowed: the URL comes from a settings file the person (or, with consent,
 * the project) wrote, never from the model.
 */
import type { HandlerRun } from "./output.ts";

export interface HttpHookSpec {
  url: string;
  /** Extra headers, variables already put in. */
  headers: Readonly<Record<string, string>>;
  /** The hook input as JSON. */
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** For tests. Default the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Most characters of a response body read. */
const MAX_BODY_CHARS = 1024 * 1024;

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** Reads a body up to the cap, so a server that sends without end cannot hold the hook. */
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, MAX_BODY_CHARS);
}

export async function runHttpHook(spec: HttpHookSpec): Promise<HandlerRun> {
  const now = spec.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), Math.max(1, spec.timeoutMs));
  timeout.unref?.();
  const signal =
    spec.signal === undefined ? timer.signal : AbortSignal.any([timer.signal, spec.signal]);
  try {
    const response = await (spec.fetch ?? fetch)(spec.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...spec.headers },
      body: spec.body,
      redirect: "manual",
      signal,
    });
    const body = await readBody(response);
    if (response.status >= 200 && response.status < 300) {
      return { kind: "output", from: "http", text: body, durationMs: elapsed() };
    }
    const said = body.replace(/\s+/g, " ").trim().slice(0, 300);
    const what =
      response.status >= 300 && response.status < 400
        ? `It answered with a redirect (status ${response.status}), which hooks do not follow.`
        : `It answered with status ${response.status}${said === "" ? "." : `: ${said}`}`;
    return { kind: "failed", outcome: "error", detail: what, durationMs: elapsed() };
  } catch (error) {
    if (spec.signal?.aborted === true) return { kind: "aborted", durationMs: elapsed() };
    if (timer.signal.aborted) {
      return {
        kind: "failed",
        outcome: "timeout",
        detail: `It did not answer within ${seconds(spec.timeoutMs)}.`,
        durationMs: elapsed(),
      };
    }
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "failed",
      outcome: "error",
      detail: `It could not be reached: ${message}`,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
