import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

/** Hop-by-hop headers (RFC 9110 section 7.6.1) plus a few a proxy must not forward. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers that carry credentials. Never written to records, bodies or logs. */
export const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

function connectionTokens(value: string | string[] | undefined): Set<string> {
  const tokens = new Set<string>();
  const values = Array.isArray(value) ? value : value ? [value] : [];
  for (const v of values) {
    for (const token of v.split(",")) {
      const t = token.trim().toLowerCase();
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

export interface ForwardHeaderOptions {
  /** Real upstream key; when set it replaces whatever credentials the client sent. */
  upstreamKey: string | null;
}

/**
 * Request headers to send upstream for a pass-through request. Drops hop-by-hop headers, `host`,
 * `content-length` (recomputed from the body actually sent) and `expect`.
 */
export function forwardRequestHeaders(
  headers: IncomingHttpHeaders,
  options: ForwardHeaderOptions,
): OutgoingHttpHeaders {
  const drop = connectionTokens(headers.connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    if (lower === "host" || lower === "content-length" || lower === "expect") continue;
    if (options.upstreamKey !== null && CREDENTIAL_HEADERS.has(lower) && lower !== "cookie") {
      continue;
    }
    out[lower] = value;
  }
  if (options.upstreamKey !== null) out.authorization = `Bearer ${options.upstreamKey}`;
  return out;
}

/**
 * Response headers to return to the client, as a flat raw list (keeps duplicates and casing).
 * Drops hop-by-hop headers; Node sets its own framing.
 */
export function forwardResponseHeaders(rawHeaders: string[]): string[] {
  const connection: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "connection") connection.push(rawHeaders[i + 1] ?? "");
  }
  const drop = connectionTokens(connection);
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? "";
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    out.push(name, rawHeaders[i + 1] ?? "");
  }
  return out;
}

/**
 * The client's credentials, as an `Authorization` value for an OpenAI-style upstream. Used for
 * translated Anthropic requests when no upstream key is configured: the client's Authorization is
 * forwarded, or its x-api-key turned into a bearer token.
 */
export function clientAuthorization(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string" && auth) return auth;
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return `Bearer ${apiKey}`;
  return null;
}

/** Copy of headers safe to write to disk: credential values replaced. */
export function redactHeaders(
  headers: IncomingHttpHeaders | OutgoingHttpHeaders | Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = CREDENTIAL_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
}

/** Flat raw header list → object, with credentials redacted. */
export function redactRawHeaders(rawHeaders: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? "").toLowerCase();
    const value = CREDENTIAL_HEADERS.has(name) ? "[REDACTED]" : (rawHeaders[i + 1] ?? "");
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}
