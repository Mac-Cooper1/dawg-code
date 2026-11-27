/**
 * Tavily's Search API, with the person's own key.
 *
 * From Tavily's public API reference (docs.tavily.com, "Search"): `POST https://api.tavily.com/search`
 * with a JSON body (`query`, `max_results` up to 20, `include_domains`, `exclude_domains`,
 * `search_depth`, `topic`) and `Authorization: Bearer <key>`; results are `results[]` with
 * `title`, `url` and `content`.
 *
 * Terms (tavily.com/terms): use from the person's own applications with their own key, kept to
 * themselves; Tavily is made for agents that hand results to a model.
 */
import type { SearchProvider, SearchResult } from "../../../contracts/web.ts";
import { arr, type FetchLike, plainSnippet, requestJson, str } from "./http.ts";

export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export function createTavilyProvider(
  apiKey: string,
  fetch: FetchLike = globalThis.fetch,
): SearchProvider {
  return {
    id: "tavily",
    label: "Tavily",
    async search(query, signal): Promise<SearchResult[]> {
      const body = await requestJson({
        service: "Tavily",
        url: TAVILY_ENDPOINT,
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: {
          query: query.query.trim(),
          max_results: Math.min(20, query.maxResults),
          search_depth: "basic",
          topic: "general",
          ...(query.allowedDomains.length > 0 ? { include_domains: query.allowedDomains } : {}),
          ...(query.blockedDomains.length > 0 ? { exclude_domains: query.blockedDomains } : {}),
        },
        signal,
        fetch,
      });
      return arr(body, "results").map((r) => ({
        title: plainSnippet(str(r, "title")),
        url: str(r, "url"),
        snippet: plainSnippet(str(r, "content")),
      }));
    },
  };
}
