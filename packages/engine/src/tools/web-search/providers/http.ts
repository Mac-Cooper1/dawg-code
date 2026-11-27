/**
 * The one way providers call their service: JSON over HTTP with the provider's own headers,
 * failures turned into `SearchError`s a person can act on. `fetch` is injectable so adapters are
 * tested against recorded responses, never the live services.
 *
 * Requests go to the address the person configured (a fixed https endpoint, or their SearXNG
 * address, which is often on their own machine). The model chooses only the query text, which
 * is sent URL- or JSON-encoded, never the address.
 */
import { SearchError } from "../../../contracts/web.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonRequest {
  /** "Brave Search": used in messages. */
  service: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  fetch: FetchLike;
  /** A sentence to use for a 403 instead of the default (SearXNG's JSON switch). */
  forbidden?: string;
}

const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;

export async function requestJson(request: JsonRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await request.fetch(request.url, {
      method: request.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...request.headers,
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "error",
      signal: request.signal,
    });
  } catch (error) {
    request.signal.throwIfAborted();
    const reason =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : String(error);
    throw new SearchError("unavailable", `${request.service} could not be reached: ${reason}.`);
  }
  if (response.status === 401 || (response.status === 403 && request.forbidden === undefined)) {
    throw new SearchError(
      "auth",
      `${request.service} refused the key (${response.status}). Check the key in Settings → Web, or DAWG_SEARCH_API_KEY.`,
    );
  }
  if (response.status === 403) throw new SearchError("unavailable", request.forbidden as string);
  if (response.status === 429) {
    throw new SearchError(
      "rate",
      `${request.service} says too many searches were made (429). Wait a little, or check the plan's limits.`,
    );
  }
  if (!response.ok) {
    throw new SearchError("unavailable", `${request.service} answered ${response.status}.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new SearchError("unavailable", `${request.service} sent an answer too large to read.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SearchError("unavailable", `${request.service} did not answer with JSON.`);
  }
}

/** A string field of an object, or "". */
export function str(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

/** An array field of an object, or []. */
export function arr(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

/** Snippets from search services often carry a little HTML (`<strong>`); keep the words. */
export function plainSnippet(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, e: string) =>
      e === "amp"
        ? "&"
        : e === "lt"
          ? "<"
          : e === "gt"
            ? ">"
            : e === "quot"
              ? '"'
              : e === "nbsp"
                ? " "
                : "'",
    )
    .replace(/\s+/g, " ")
    .trim();
}
