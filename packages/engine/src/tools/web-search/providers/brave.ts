/**
 * Brave Search's Web Search API, with the person's own subscription key.
 *
 * From Brave's public documentation (api-dashboard.search.brave.com, "Web search: get started"):
 * `GET https://api.search.brave.com/res/v1/web/search` with `q` and `count` (at most 20), the key
 * in `X-Subscription-Token`; results are `web.results[]` with `title`, `url` and `description`.
 * `site:` and `-site:` work inside `q`.
 *
 * Terms (api-dashboard.search.brave.com/terms-of-service): results may be used in the person's
 * own application, not stored beyond what operating it needs, and not used to train or evaluate
 * models. dawg never caches search results; they live only in the session that asked.
 */
import type { SearchProvider, SearchQuery, SearchResult } from "../../../contracts/web.ts";
import { arr, type FetchLike, plainSnippet, requestJson, str } from "./http.ts";

export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Brave's query with its own operators narrowing to the domains asked for. */
export function braveQuery(query: SearchQuery): string {
  let q = query.query.trim();
  if (query.allowedDomains.length === 1) q += ` site:${query.allowedDomains[0]}`;
  for (const domain of query.blockedDomains.slice(0, 10)) q += ` -site:${domain}`;
  return q;
}

export function createBraveProvider(
  apiKey: string,
  fetch: FetchLike = globalThis.fetch,
): SearchProvider {
  return {
    id: "brave",
    label: "Brave Search",
    async search(query, signal): Promise<SearchResult[]> {
      const filtered = query.allowedDomains.length > 0 || query.blockedDomains.length > 0;
      const params = new URLSearchParams({
        q: braveQuery(query),
        // With filters, ask for the most Brave gives so filtering leaves enough.
        count: String(Math.min(20, filtered ? 20 : query.maxResults)),
      });
      const body = await requestJson({
        service: "Brave Search",
        url: `${BRAVE_ENDPOINT}?${params}`,
        headers: { "x-subscription-token": apiKey },
        signal,
        fetch,
      });
      const web =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>).web : null;
      return arr(web, "results").map((r) => ({
        title: plainSnippet(str(r, "title")),
        url: str(r, "url"),
        snippet: plainSnippet(str(r, "description")),
      }));
    },
  };
}
