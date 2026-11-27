/**
 * The seams the web tools use: a search service for WebSearch, and the session's utility model
 * for WebFetch's question about a page. See docs/specs/phase-4-compatibility.md, "Web tools".
 */

/** What WebSearch asks a search service for. */
export interface SearchQuery {
  query: string;
  /** Only results from these domains (and their subdomains). Empty means no restriction. */
  allowedDomains: readonly string[];
  /** Never results from these domains (and their subdomains). */
  blockedDomains: readonly string[];
  /** Results wanted at most; a service may return fewer. */
  maxResults: number;
}

/** One search result: what the model sees, and what the transcript links to. */
export interface SearchResult {
  title: string;
  /** Absolute http(s) URL. */
  url: string;
  /** A short excerpt; may be empty. */
  snippet: string;
}

/**
 * A search service. There is no built-in one: the person configures a provider with their own
 * key (Brave Search, Tavily) or address (SearXNG), and later an MCP server that offers search
 * can stand behind the same interface. One method, so any of them fits.
 */
export interface SearchProvider {
  /** "brave", "tavily", "searxng", or `mcp:<server>` for an MCP server later. */
  readonly id: string;
  /** For people: "Brave Search". */
  readonly label: string;
  /**
   * Runs one search. Rejects with a `SearchError` whose message a person (and the model) can act
   * on: a refused key, a rate limit, an address that does not answer.
   */
  search(query: SearchQuery, signal: AbortSignal): Promise<SearchResult[]>;
}

/** A search that failed in a way worth saying plainly. */
export class SearchError extends Error {
  override name = "SearchError";
  /** "auth": the key was refused; "rate": too many requests; "unavailable": anything else. */
  readonly kind: "auth" | "rate" | "unavailable";
  constructor(kind: "auth" | "rate" | "unavailable", message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * One request to the session's utility model (the slot titles use), apart from the
 * conversation: its own messages, no tools, nothing added to history.
 */
export interface UtilityRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface UtilityModel {
  /** The model's context window in tokens, to size what is sent. */
  readonly contextWindow: number;
  /** Resolves to the reply's text. Rejects when the request fails or is aborted. */
  complete(request: UtilityRequest): Promise<string>;
}

/** Services the engine configures for all its sessions; the app can change them while it runs. */
export interface EngineServices {
  /** The search service WebSearch uses, or null when none is configured. */
  readonly searchProvider: SearchProvider | null;
}
