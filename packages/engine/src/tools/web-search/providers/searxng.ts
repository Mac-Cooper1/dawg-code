/**
 * A SearXNG instance the person runs or chooses, at the address they give.
 *
 * From SearXNG's documentation (docs.searxng.org, "Search API"): `GET <instance>/search` with `q`
 * and `format=json`; the JSON format must be switched on by the instance's administrator
 * (`search.formats` in settings.yml), or the instance answers 403. Results are `results[]` with
 * `url`, `title` and `content` (docs.searxng.org, "Result types").
 *
 * The address comes from the person's configuration, never from the model, so it may be on their
 * own machine (the usual way to run SearXNG); WebFetch's private-address rule is about addresses
 * the model chooses.
 */
import type { SearchProvider, SearchResult } from "../../../contracts/web.ts";
import { arr, type FetchLike, plainSnippet, requestJson, str } from "./http.ts";

/** The instance's search endpoint for a configured address ("http://localhost:8888"). */
export function searxngEndpoint(address: string): string {
  const url = new URL(address);
  let base = url.pathname.replace(/\/+$/, "");
  if (base.endsWith("/search")) base = base.slice(0, -"/search".length);
  url.pathname = `${base}/search`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function createSearxngProvider(
  address: string,
  fetch: FetchLike = globalThis.fetch,
): SearchProvider {
  const endpoint = searxngEndpoint(address);
  return {
    id: "searxng",
    label: "SearXNG",
    async search(query, signal): Promise<SearchResult[]> {
      let q = query.query.trim();
      if (query.allowedDomains.length === 1) q += ` site:${query.allowedDomains[0]}`;
      const params = new URLSearchParams({ q, format: "json", pageno: "1" });
      const body = await requestJson({
        service: "SearXNG",
        url: `${endpoint}?${params}`,
        signal,
        fetch,
        forbidden:
          "The SearXNG instance refused JSON results (403). Its administrator must add json to search.formats in settings.yml.",
      });
      return arr(body, "results").map((r) => ({
        title: plainSnippet(str(r, "title")),
        url: str(r, "url"),
        snippet: plainSnippet(str(r, "content")),
      }));
    },
  };
}
