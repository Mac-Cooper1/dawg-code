/**
 * Web search: the WebSearch tool and the search services behind it. A service is anything that
 * implements `SearchProvider` (contracts/web.ts): the person's own Brave Search or Tavily key, or
 * a SearXNG address, this round; an MCP server that offers search next, by wrapping its tool in
 * the same one-method interface and handing it to the engine as `webSearch`.
 */
export {
  createSearchProvider,
  isSearchProviderId,
  NO_SEARCH_SETTINGS,
  parseSearchSettings,
  readSearchSettings,
  SEARCH_ENV,
  SEARCH_PROVIDERS,
  SEARCH_SETTINGS_FILE,
  type SearchConfig,
  type SearchFileSettings,
  type SearchProviderId,
  type SearchProviderInfo,
  searchConfigFromEnvironment,
  searchConfigProblem,
} from "./config.ts";
export { hostInDomain, normalizeDomain, normalizeDomains } from "./domains.ts";
export { BRAVE_ENDPOINT, createBraveProvider } from "./providers/brave.ts";
export type { FetchLike } from "./providers/http.ts";
export { createSearxngProvider, searxngEndpoint } from "./providers/searxng.ts";
export { createTavilyProvider, TAVILY_ENDPOINT } from "./providers/tavily.ts";
export {
  cleanResults,
  WEB_SEARCH_TOOL_NAME,
  type WebSearchInput,
  webSearchTool,
} from "./web-search.ts";
