/**
 * Settings → Web in main: which search service WebSearch uses, its key, and "Check it works".
 *
 * - The choice and a SearXNG address go in `<data root>/web-search.json`, the same file the
 *   command line reads (`readSearchSettings` in @dawg/engine). It never holds a key.
 * - Keys are encrypted with Electron's `safeStorage` (its key is in the macOS Keychain) in
 *   `<data root>/search-keys.json`, mode 0600, like remote model servers' keys. They go into
 *   main and never come back out to a window; only whether one is stored does.
 * - The engine host gets the service with its key in a `web-config` message (`hostConfig`),
 *   when it starts and after every change, as model grants carry servers' keys.
 *
 * Free of Electron so it is unit-tested: `index.ts` passes `safeStorage` in.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSearchProvider,
  type FetchLike,
  readSearchSettings,
  SEARCH_SETTINGS_FILE,
  type SearchConfig,
  type SearchFileSettings,
  searchConfigProblem,
} from "@dawg/engine";
import type { z } from "zod";
import type {
  KeyedSearchProvider,
  SearchProviderId,
  WebCheckInputSchema,
  WebCheckResult,
  WebSettingsInputSchema,
  WebSettingsState,
} from "../../shared/bridge.ts";
import type { WebSearchConfig } from "../../shared/engine-host-messages.ts";
import type { Logger } from "../json-file.ts";
import { createKeyStore, type Encryption } from "../models/keys.ts";

/** Where search keys are kept, apart from model servers' keys. */
export const SEARCH_KEYS_FILE = "search-keys.json";

/** How long "Check it works" waits for the service. */
export const CHECK_TIMEOUT_MS = 15_000;

/** What "Check it works" searches for: plain, harmless, and sure to find something. */
export const CHECK_QUERY = "open source code editor";

const KEYED: readonly KeyedSearchProvider[] = ["brave", "tavily"];
const LABELS: Record<SearchProviderId, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  searxng: "SearXNG",
};

function isKeyed(provider: SearchProviderId): provider is KeyedSearchProvider {
  return (KEYED as readonly string[]).includes(provider);
}

export interface WebSettingsService {
  /** Reads the file and the keys once, and works out what the engine host gets. */
  load(): Promise<void>;
  state(): Promise<WebSettingsState>;
  write(input: z.output<typeof WebSettingsInputSchema>): Promise<WebSettingsState>;
  removeKey(provider: KeyedSearchProvider): Promise<WebSettingsState>;
  check(input: z.output<typeof WebCheckInputSchema>): Promise<WebCheckResult>;
  /** The service for the engine host now, with its key; null when web search is off. */
  hostConfig(): WebSearchConfig | null;
  /** Called after every change to `hostConfig`. */
  onChange(listener: (config: WebSearchConfig | null) => void): () => void;
}

export interface WebSettingsOptions {
  dataRoot: string;
  encryption: Encryption;
  log: Logger;
  /** For tests: how "Check it works" reaches the service. */
  fetch?: FetchLike;
}

export function createWebSettingsService(options: WebSettingsOptions): WebSettingsService {
  const { dataRoot, encryption, log } = options;
  const keys = createKeyStore(dataRoot, encryption, log, SEARCH_KEYS_FILE);
  const file = path.join(dataRoot, SEARCH_SETTINGS_FILE);
  let settings: SearchFileSettings = { provider: null, searxngUrl: null };
  let current: WebSearchConfig | null = null;
  let loaded: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(config: WebSearchConfig | null) => void>();

  /** The configuration for a choice, with the stored key; null when it cannot be used. */
  async function configFor(
    provider: SearchProviderId,
    url: string | null,
    key?: string,
  ): Promise<SearchConfig | null> {
    const apiKey = isKeyed(provider) ? (key ?? (await keys.get(provider))) : undefined;
    const config: SearchConfig = {
      provider,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(provider === "searxng" && url !== null ? { url } : {}),
    };
    return searchConfigProblem(config) === null ? config : null;
  }

  async function refresh(): Promise<void> {
    const before = JSON.stringify(current);
    const config =
      settings.provider === null ? null : await configFor(settings.provider, settings.searxngUrl);
    current =
      config === null
        ? null
        : {
            provider: config.provider,
            ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
            ...(config.url === undefined ? {} : { url: config.url }),
          };
    if (JSON.stringify(current) === before) return;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        log(
          `A web settings listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function save(next: SearchFileSettings): Promise<void> {
    const run = queue.then(async () => {
      await mkdir(dataRoot, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temp, file);
    });
    queue = run.catch(() => {});
    await run;
    settings = next;
  }

  async function snapshot(): Promise<WebSettingsState> {
    return {
      provider: settings.provider,
      searxngUrl: settings.searxngUrl,
      keys: { brave: keys.has("brave"), tavily: keys.has("tavily") },
      keychainAvailable: encryption.isEncryptionAvailable(),
    };
  }

  const service: WebSettingsService = {
    load() {
      loaded ??= (async () => {
        await keys.load();
        settings = await readSearchSettings(dataRoot);
        await refresh();
      })();
      return loaded;
    },

    async state() {
      await service.load();
      return snapshot();
    },

    async write(input) {
      await service.load();
      const provider = input.provider;
      const url = input.searxngUrl === undefined ? settings.searxngUrl : input.searxngUrl;
      if (provider !== null) {
        const label = LABELS[provider];
        if (isKeyed(provider) && input.apiKey === undefined && !keys.has(provider)) {
          throw new Error(`${label} needs an API key.`);
        }
        if (provider === "searxng" && url === null) {
          throw new Error(`${label} needs the address of an instance.`);
        }
      }
      if (provider !== null && isKeyed(provider) && input.apiKey !== undefined) {
        await keys.set(provider, input.apiKey);
      }
      await save({ provider, searxngUrl: url });
      await refresh();
      return snapshot();
    },

    async removeKey(provider) {
      await service.load();
      await keys.delete(provider);
      if (settings.provider === provider) await save({ ...settings, provider: null });
      await refresh();
      return snapshot();
    },

    async check(input) {
      await service.load();
      const label = LABELS[input.provider];
      const config = await configFor(
        input.provider,
        input.searxngUrl ?? settings.searxngUrl,
        input.apiKey,
      );
      if (config === null) {
        return {
          ok: false,
          message: isKeyed(input.provider)
            ? `${label} needs an API key.`
            : `${label} needs the address of an instance.`,
        };
      }
      try {
        const provider = createSearchProvider(config, options.fetch);
        const results = await provider.search(
          { query: CHECK_QUERY, allowedDomains: [], blockedDomains: [], maxResults: 5 },
          AbortSignal.timeout(CHECK_TIMEOUT_MS),
        );
        return results.length === 0
          ? { ok: true, message: `${label} answered, with no results for a test search.` }
          : {
              ok: true,
              message: `${label} answered with ${results.length} result${results.length === 1 ? "" : "s"}.`,
            };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          return {
            ok: false,
            message: `${label} did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`,
          };
        }
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },

    hostConfig: () => current,

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return service;
}
