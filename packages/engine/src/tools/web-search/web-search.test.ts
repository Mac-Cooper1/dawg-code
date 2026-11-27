/**
 * The search services against recorded responses (`__fixtures__/`, in the shapes each service's
 * public documentation gives), and the WebSearch tool on top. No live network: every adapter
 * is handed a fake `fetch` that records the request and answers from a fixture.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SearchError, type SearchProvider, type SearchQuery } from "../../contracts/web.ts";
import { createTestToolContext } from "../../testing/context.ts";
import {
  createSearchProvider,
  NO_SEARCH_SETTINGS,
  readSearchSettings,
  SEARCH_SETTINGS_FILE,
  searchConfigFromEnvironment,
  searchConfigProblem,
} from "./config.ts";
import { hostInDomain, normalizeDomain, normalizeDomains } from "./domains.ts";
import { BRAVE_ENDPOINT, braveQuery } from "./providers/brave.ts";
import type { FetchLike } from "./providers/http.ts";
import { searxngEndpoint } from "./providers/searxng.ts";
import { TAVILY_ENDPOINT } from "./providers/tavily.ts";
import { webSearchTool } from "./web-search.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, body: string): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    },
  };
}

const QUERY: SearchQuery = {
  query: "vitest fake timers",
  allowedDomains: [],
  blockedDomains: [],
  maxResults: 10,
};
const signal = () => AbortSignal.timeout(5_000);

describe("Brave Search", () => {
  it("sends the documented request and reads web.results", async () => {
    const { fetch, calls } = fakeFetch(200, fixture("brave-web-search.json"));
    const provider = createSearchProvider({ provider: "brave", apiKey: " key-123 " }, fetch);
    const results = await provider.search(QUERY, signal());
    const url = new URL(calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(BRAVE_ENDPOINT);
    expect(url.searchParams.get("q")).toBe("vitest fake timers");
    expect(url.searchParams.get("count")).toBe("10");
    expect(calls[0]?.headers["x-subscription-token"]).toBe("key-123");
    expect(calls[0]?.method).toBe("GET");
    expect(results[0]).toEqual({
      title: "Timers | Vitest",
      url: "https://vitest.dev/guide/mocking/timers",
      snippet: "Use vi.useFakeTimers() to control time & dates in tests.",
    });
    expect(results).toHaveLength(4);
  });

  it("narrows with its own site: operators", () => {
    expect(braveQuery({ ...QUERY, allowedDomains: ["vitest.dev"] })).toBe(
      "vitest fake timers site:vitest.dev",
    );
    expect(braveQuery({ ...QUERY, blockedDomains: ["a.com", "b.com"] })).toBe(
      "vitest fake timers -site:a.com -site:b.com",
    );
  });

  it("says plainly when the key is refused or the limit is reached", async () => {
    const refused = createSearchProvider(
      { provider: "brave", apiKey: "bad" },
      fakeFetch(401, "{}").fetch,
    );
    await expect(refused.search(QUERY, signal())).rejects.toThrow(/refused the key \(401\)/);
    const limited = createSearchProvider(
      { provider: "brave", apiKey: "k" },
      fakeFetch(429, "{}").fetch,
    );
    const error = await limited.search(QUERY, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect((error as SearchError).kind).toBe("rate");
  });

  it("reports an answer that is not JSON", async () => {
    const provider = createSearchProvider(
      { provider: "brave", apiKey: "k" },
      fakeFetch(200, "<html>").fetch,
    );
    await expect(provider.search(QUERY, signal())).rejects.toThrow(/did not answer with JSON/);
  });

  it("reports a service that cannot be reached", async () => {
    const provider = createSearchProvider({ provider: "brave", apiKey: "k" }, async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    });
    await expect(provider.search(QUERY, signal())).rejects.toThrow(
      /could not be reached: getaddrinfo ENOTFOUND/,
    );
  });
});

describe("Tavily", () => {
  it("sends the documented request with the domain lists, and reads results", async () => {
    const { fetch, calls } = fakeFetch(200, fixture("tavily-search.json"));
    const provider = createSearchProvider({ provider: "tavily", apiKey: "tvly-abc" }, fetch);
    const results = await provider.search({ ...QUERY, blockedDomains: ["github.com"] }, signal());
    expect(calls[0]?.url).toBe(TAVILY_ENDPOINT);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.authorization).toBe("Bearer tvly-abc");
    expect(calls[0]?.body).toEqual({
      query: "vitest fake timers",
      max_results: 10,
      search_depth: "basic",
      topic: "general",
      exclude_domains: ["github.com"],
    });
    expect(results.map((r) => r.url)).toEqual([
      "https://vitest.dev/guide/mocking/timers",
      "https://github.com/vitest-dev/vitest/discussions/1234",
    ]);
    expect(results[0]?.snippet).toBe("Use vi.useFakeTimers() to control time in tests.");
  });
});

describe("SearXNG", () => {
  it("asks the configured instance for JSON", async () => {
    const { fetch, calls } = fakeFetch(200, fixture("searxng-search.json"));
    const provider = createSearchProvider(
      { provider: "searxng", url: "http://localhost:8888/" },
      fetch,
    );
    const results = await provider.search(QUERY, signal());
    const url = new URL(calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:8888/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("q")).toBe("vitest fake timers");
    expect(calls[0]?.headers["x-subscription-token"]).toBeUndefined();
    expect(results).toHaveLength(3);
  });

  it("finds the search endpoint from the address given", () => {
    expect(searxngEndpoint("https://search.example.org")).toBe("https://search.example.org/search");
    expect(searxngEndpoint("https://example.org/searx/")).toBe("https://example.org/searx/search");
    expect(searxngEndpoint("https://example.org/searx/search?q=x")).toBe(
      "https://example.org/searx/search",
    );
  });

  it("explains a 403 as the JSON format being off", async () => {
    const provider = createSearchProvider(
      { provider: "searxng", url: "http://localhost:8888" },
      fakeFetch(403, "").fetch,
    );
    await expect(provider.search(QUERY, signal())).rejects.toThrow(/add json to search.formats/);
  });
});

describe("configuration", () => {
  it("says what is missing", () => {
    expect(searchConfigProblem({ provider: "brave" })).toBe("Brave Search needs an API key.");
    expect(searchConfigProblem({ provider: "tavily", apiKey: "  " })).toBe(
      "Tavily needs an API key.",
    );
    expect(searchConfigProblem({ provider: "searxng", url: "ftp://x" })).toMatch(
      /needs the address/,
    );
    expect(searchConfigProblem({ provider: "searxng", url: "http://localhost:8888" })).toBeNull();
    expect(() => createSearchProvider({ provider: "brave" })).toThrow(/needs an API key/);
  });

  it("takes a key with no service named as a Brave Search key, the suggested service", () => {
    expect(
      searchConfigFromEnvironment({ DAWG_SEARCH_API_KEY: "brave-key" }, NO_SEARCH_SETTINGS),
    ).toEqual({ config: { provider: "brave", apiKey: "brave-key" }, problem: null });
    // The saved choice still wins over the default.
    expect(
      searchConfigFromEnvironment(
        { DAWG_SEARCH_API_KEY: "tv-key" },
        { provider: "tavily", searxngUrl: null },
      ).config,
    ).toEqual({ provider: "tavily", apiKey: "tv-key" });
  });

  it("reads the command line's variables over the settings file", () => {
    const file = { provider: "searxng" as const, searxngUrl: "http://localhost:8888" };
    expect(searchConfigFromEnvironment({}, NO_SEARCH_SETTINGS)).toEqual({
      config: null,
      problem: null,
    });
    expect(searchConfigFromEnvironment({}, file).config).toEqual({
      provider: "searxng",
      url: "http://localhost:8888",
    });
    expect(
      searchConfigFromEnvironment({ DAWG_SEARCH_PROVIDER: "Brave", DAWG_SEARCH_API_KEY: "k" }, file)
        .config,
    ).toEqual({ provider: "brave", apiKey: "k", url: "http://localhost:8888" });
    expect(
      searchConfigFromEnvironment({ DAWG_SEARCH_PROVIDER: "tavily" }, NO_SEARCH_SETTINGS),
    ).toEqual({
      config: null,
      problem: "Web search is off: Tavily needs an API key. Set DAWG_SEARCH_API_KEY.",
    });
    expect(
      searchConfigFromEnvironment({ DAWG_SEARCH_PROVIDER: "google" }, NO_SEARCH_SETTINGS).problem,
    ).toMatch(/not a search service dawg knows/);
    expect(
      searchConfigFromEnvironment({ DAWG_SEARXNG_URL: "http://127.0.0.1:9000" }, file).config?.url,
    ).toBe("http://127.0.0.1:9000");
  });

  it("reads the settings file, and treats anything odd as not configured", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-search-settings-"));
    try {
      expect(await readSearchSettings(dir)).toEqual(NO_SEARCH_SETTINGS);
      await writeFile(
        path.join(dir, SEARCH_SETTINGS_FILE),
        JSON.stringify({ provider: "tavily", apiKey: "never read" }),
      );
      expect(await readSearchSettings(dir)).toEqual({ provider: "tavily", searxngUrl: null });
      await writeFile(path.join(dir, SEARCH_SETTINGS_FILE), "{not json");
      expect(await readSearchSettings(dir)).toEqual(NO_SEARCH_SETTINGS);
      await writeFile(path.join(dir, SEARCH_SETTINGS_FILE), JSON.stringify({ provider: "bing" }));
      expect(await readSearchSettings(dir)).toEqual(NO_SEARCH_SETTINGS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("domains", () => {
  it("normalises what the model writes", () => {
    expect(normalizeDomain("https://Docs.Python.org/3/")).toBe("docs.python.org");
    expect(normalizeDomain("*.example.com")).toBe("example.com");
    expect(normalizeDomain("example.com:443")).toBe("example.com");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomains(["a.com", "A.com", "bad", "b.org"])).toEqual(["a.com", "b.org"]);
  });

  it("covers subdomains", () => {
    expect(hostInDomain("docs.example.com", "example.com")).toBe(true);
    expect(hostInDomain("example.com", "example.com")).toBe(true);
    expect(hostInDomain("notexample.com", "example.com")).toBe(false);
  });
});

describe("the WebSearch tool", () => {
  function provider(
    results: { title: string; url: string; snippet: string }[] | Error,
  ): SearchProvider & {
    queries: SearchQuery[];
  } {
    const queries: SearchQuery[] = [];
    return {
      id: "test",
      label: "Test Search",
      queries,
      search: async (query) => {
        queries.push(query);
        if (results instanceof Error) throw results;
        return results;
      },
    };
  }

  async function call(
    input: Parameters<typeof webSearchTool.execute>[0],
    search: SearchProvider | null,
  ) {
    const test = await createTestToolContext({ limits: { webSearchTimeoutMs: 500 } });
    try {
      const out = await webSearchTool.execute(input, {
        ...test.ctx,
        services: { searchProvider: search },
      });
      return { out, text: out.content.map((p) => (p.type === "text" ? p.text : "")).join("") };
    } finally {
      await test.cleanup();
    }
  }

  const RESULTS = [
    {
      title: "Vitest timers",
      url: "https://vitest.dev/guide/mocking/timers",
      snippet: "Fake timers.",
    },
    { title: "Jest timers", url: "https://jestjs.io/docs/timer-mocks", snippet: "Jest's." },
    { title: "Duplicate", url: "https://vitest.dev/guide/mocking/timers", snippet: "Again." },
    { title: "", url: "https://docs.vitest.dev/x", snippet: "" },
  ];

  it("is offered only while a search service is configured", () => {
    expect(webSearchTool.offered?.({ searchProvider: null })).toBe(false);
    expect(webSearchTool.offered?.({ searchProvider: provider([]) })).toBe(true);
  });

  it("lists titles, URLs and snippets, wrapped as untrusted, and asks for sources", async () => {
    const { out, text } = await call({ query: "vitest fake timers" }, provider(RESULTS));
    expect(out.isError).toBeUndefined();
    expect(text).toContain('3 results for "vitest fake timers" from Test Search.');
    expect(text).toContain("untrusted content");
    expect(text).toContain('end with a "Sources:" list');
    expect(text).toContain(
      '<web-content source="search">\n1. Vitest timers\n   https://vitest.dev/guide/mocking/timers\n   Fake timers.',
    );
    expect(text).toContain(
      "3. https://docs.vitest.dev/x\n   https://docs.vitest.dev/x\n</web-content>",
    );
    expect(out.display).toEqual({
      kind: "web-search",
      query: "vitest fake timers",
      provider: "Test Search",
      results: [
        {
          title: "Vitest timers",
          url: "https://vitest.dev/guide/mocking/timers",
          snippet: "Fake timers.",
        },
        { title: "Jest timers", url: "https://jestjs.io/docs/timer-mocks", snippet: "Jest's." },
        { title: "https://docs.vitest.dev/x", url: "https://docs.vitest.dev/x", snippet: "" },
      ],
    });
  });

  it("keeps only allowed domains, whatever the service returns", async () => {
    const search = provider(RESULTS);
    const { out } = await call(
      { query: "timers", allowed_domains: ["https://vitest.dev"] },
      search,
    );
    expect(search.queries[0]?.allowedDomains).toEqual(["vitest.dev"]);
    expect((out.display as { results: { url: string }[] }).results.map((r) => r.url)).toEqual([
      "https://vitest.dev/guide/mocking/timers",
      "https://docs.vitest.dev/x",
    ]);
  });

  it("drops blocked domains", async () => {
    const { out } = await call(
      { query: "timers", blocked_domains: ["vitest.dev"] },
      provider(RESULTS),
    );
    expect((out.display as { results: { url: string }[] }).results.map((r) => r.url)).toEqual([
      "https://jestjs.io/docs/timer-mocks",
    ]);
  });

  it("refuses both lists at once, as documented", async () => {
    const { out, text } = await call(
      { query: "x y", allowed_domains: ["a.com"], blocked_domains: ["b.com"] },
      provider([]),
    );
    expect(out.isError).toBe(true);
    expect(text).toMatch(/not both/);
  });

  it("says when nothing was found", async () => {
    const { out, text } = await call({ query: "nothing" }, provider([]));
    expect(out.isError).toBeUndefined();
    expect(text).toMatch(/No results for "nothing"/);
  });

  it("passes on the service's own words when it fails", async () => {
    const { out, text } = await call(
      { query: "x y" },
      provider(new SearchError("auth", "Test Search refused the key (401).")),
    );
    expect(out.isError).toBe(true);
    expect(text).toBe("Test Search refused the key (401).");
  });

  it("gives up on a service that does not answer in time", async () => {
    const slow: SearchProvider = {
      id: "slow",
      label: "Slow Search",
      search: (_q, s) =>
        new Promise((_resolve, reject) =>
          s.addEventListener("abort", () => reject(s.reason), { once: true }),
        ),
    };
    const { out, text } = await call({ query: "x y" }, slow);
    expect(out.isError).toBe(true);
    expect(text).toMatch(/did not answer within/);
  });

  it("explains a service removed while the session runs", async () => {
    const { out, text } = await call({ query: "x y" }, null);
    expect(out.isError).toBe(true);
    expect(text).toMatch(/no search service is configured/);
  });

  it("describes what the guidance promises", () => {
    expect(webSearchTool.description).toMatch(/read a page with WebFetch/);
    expect(webSearchTool.description).toMatch(/untrusted content/);
    expect(webSearchTool.description).toMatch(/not both/);
  });
});
