/**
 * Which search service WebSearch uses, and where its settings come from.
 *
 * - The choice of service, and a SearXNG address, are plain settings in `<data root>/web-search.json`
 *   (`{ "provider": "brave", "searxngUrl": null }`); the app's Settings → Web writes it.
 * - A key is a secret and never goes in that file. The app keeps it in the Keychain and hands it
 *   to its engine host directly. The command line reads it from `DAWG_SEARCH_API_KEY`.
 * - On the command line, `DAWG_SEARCH_PROVIDER` and `DAWG_SEARXNG_URL` override the file.
 *
 * There is no default service: with none configured, WebSearch is not offered at all.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchProvider } from "../../contracts/web.ts";
import { createBraveProvider } from "./providers/brave.ts";
import type { FetchLike } from "./providers/http.ts";
import { createSearxngProvider } from "./providers/searxng.ts";
import { createTavilyProvider } from "./providers/tavily.ts";

export type SearchProviderId = "brave" | "tavily" | "searxng";

export interface SearchProviderInfo {
  id: SearchProviderId;
  label: string;
  /** The service needs an API key. */
  needsKey: boolean;
  /** The service needs an address (SearXNG). */
  needsUrl: boolean;
  /** Where a person gets a key or learns more. */
  site: string;
}

export const SEARCH_PROVIDERS: readonly SearchProviderInfo[] = [
  {
    id: "brave",
    label: "Brave Search",
    needsKey: true,
    needsUrl: false,
    site: "https://brave.com/search/api/",
  },
  { id: "tavily", label: "Tavily", needsKey: true, needsUrl: false, site: "https://tavily.com" },
  {
    id: "searxng",
    label: "SearXNG",
    needsKey: false,
    needsUrl: true,
    site: "https://docs.searxng.org",
  },
];

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return value === "brave" || value === "tavily" || value === "searxng";
}

export interface SearchConfig {
  provider: SearchProviderId;
  apiKey?: string;
  /** SearXNG's address. */
  url?: string;
}

/** The environment variables the command line reads. */
export const SEARCH_ENV = {
  provider: "DAWG_SEARCH_PROVIDER",
  apiKey: "DAWG_SEARCH_API_KEY",
  searxngUrl: "DAWG_SEARXNG_URL",
} as const;

export const SEARCH_SETTINGS_FILE = "web-search.json";

/** What `web-search.json` holds. Never a key. */
export interface SearchFileSettings {
  provider: SearchProviderId | null;
  searxngUrl: string | null;
}

export const NO_SEARCH_SETTINGS: SearchFileSettings = { provider: null, searxngUrl: null };

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** What is missing or wrong in a configuration, as a sentence, or null when it is usable. */
export function searchConfigProblem(config: SearchConfig): string | null {
  const info = SEARCH_PROVIDERS.find((p) => p.id === config.provider);
  if (info === undefined) return `There is no search service called ${config.provider}.`;
  if (info.needsKey && (config.apiKey === undefined || config.apiKey.trim() === "")) {
    return `${info.label} needs an API key.`;
  }
  if (info.needsUrl && (config.url === undefined || !httpUrl(config.url))) {
    return `${info.label} needs the address of an instance, starting with http:// or https://.`;
  }
  return null;
}

/** The provider for a configuration. Throws when `searchConfigProblem` has something to say. */
export function createSearchProvider(config: SearchConfig, fetch?: FetchLike): SearchProvider {
  const problem = searchConfigProblem(config);
  if (problem !== null) throw new Error(problem);
  switch (config.provider) {
    case "brave":
      return createBraveProvider((config.apiKey as string).trim(), fetch);
    case "tavily":
      return createTavilyProvider((config.apiKey as string).trim(), fetch);
    case "searxng":
      return createSearxngProvider(config.url as string, fetch);
  }
}

/** Parses `web-search.json`'s content; anything unexpected reads as "not configured". */
export function parseSearchSettings(value: unknown): SearchFileSettings {
  if (typeof value !== "object" || value === null) return NO_SEARCH_SETTINGS;
  const record = value as Record<string, unknown>;
  const provider = isSearchProviderId(record.provider) ? record.provider : null;
  const url =
    typeof record.searxngUrl === "string" && httpUrl(record.searxngUrl) ? record.searxngUrl : null;
  return { provider, searxngUrl: url };
}

/** Reads `<dataRoot>/web-search.json`. A missing or unreadable file means nothing configured. */
export async function readSearchSettings(dataRoot: string): Promise<SearchFileSettings> {
  try {
    const text = await readFile(path.join(dataRoot, SEARCH_SETTINGS_FILE), "utf8");
    return parseSearchSettings(JSON.parse(text));
  } catch {
    return NO_SEARCH_SETTINGS;
  }
}

/**
 * The command line's configuration: the environment first, then the file. `problem` explains a
 * provider that was asked for but cannot be used (a missing key), for a warning.
 */
export function searchConfigFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  file: SearchFileSettings,
): { config: SearchConfig | null; problem: string | null } {
  const raw = env[SEARCH_ENV.provider]?.trim().toLowerCase() ?? "";
  if (raw !== "" && !isSearchProviderId(raw)) {
    return {
      config: null,
      problem: `${SEARCH_ENV.provider}="${raw}" is not a search service dawg knows: use brave, tavily or searxng.`,
    };
  }
  const apiKey = env[SEARCH_ENV.apiKey]?.trim();
  // A key with no service named is for Brave Search, the service dawg suggests.
  const provider =
    raw !== "" ? (raw as SearchProviderId) : (file.provider ?? (apiKey ? "brave" : null));
  if (provider === null) return { config: null, problem: null };
  const url = env[SEARCH_ENV.searxngUrl]?.trim() || file.searxngUrl || undefined;
  const config: SearchConfig = {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(url ? { url } : {}),
  };
  const problem = searchConfigProblem(config);
  if (problem !== null) {
    const hint =
      SEARCH_PROVIDERS.find((p) => p.id === provider)?.needsKey === true
        ? ` Set ${SEARCH_ENV.apiKey}.`
        : ` Set ${SEARCH_ENV.searxngUrl}.`;
    return { config: null, problem: `Web search is off: ${problem}${hint}` };
  }
  return { config, problem: null };
}
