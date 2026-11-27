/**
 * Settings → Web without main, for the in-memory bridge (the browser preview) and the page's
 * tests. It follows main's rules (src/main/web/service.ts): a service that takes a key needs one
 * stored or given, SearXNG needs an address, removing the key of the service in use turns web
 * search off, and keys are never handed back. "Check it works" answers without the network:
 * a key or address containing "bad" fails the way a refused key does.
 */
import {
  type DawgBridge,
  type KeyedSearchProvider,
  KeyedSearchProviderSchema,
  type SearchProviderId,
  WebCheckInputSchema,
  type WebCheckResult,
  WebSettingsInputSchema,
  type WebSettingsState,
} from "../../shared/bridge.ts";
import { validate } from "./validate.ts";

const LABELS: Record<SearchProviderId, string> = {
  brave: "Brave Search",
  tavily: "Tavily",
  searxng: "SearXNG",
};

export interface FakeWebOptions {
  provider?: SearchProviderId | null;
  searxngUrl?: string | null;
  /** Keys stored, by service. */
  keys?: Partial<Record<KeyedSearchProvider, string>>;
  keychainAvailable?: boolean;
}

export interface FakeWeb {
  readonly api: DawgBridge["web"];
  /** What is stored, keys included, for tests. */
  readonly stored: {
    provider: SearchProviderId | null;
    searxngUrl: string | null;
    keys: Partial<Record<KeyedSearchProvider, string>>;
  };
  /** Every "Check it works", in order. */
  readonly checks: { provider: SearchProviderId; apiKey?: string; searxngUrl?: string }[];
}

const isKeyed = (p: SearchProviderId): p is KeyedSearchProvider => p === "brave" || p === "tavily";

export function createFakeWeb(options: FakeWebOptions = {}): FakeWeb {
  const stored = {
    provider: options.provider ?? null,
    searxngUrl: options.searxngUrl ?? null,
    keys: { ...options.keys },
  };
  const keychainAvailable = options.keychainAvailable ?? true;
  const checks: FakeWeb["checks"] = [];

  const state = (): WebSettingsState => ({
    provider: stored.provider,
    searxngUrl: stored.searxngUrl,
    keys: { brave: stored.keys.brave !== undefined, tavily: stored.keys.tavily !== undefined },
    keychainAvailable,
  });

  const api: DawgBridge["web"] = {
    read: async () => state(),
    write: async (input) => {
      const valid = validate(WebSettingsInputSchema, input, "web settings");
      const provider = valid.provider;
      const url = valid.searxngUrl === undefined ? stored.searxngUrl : valid.searxngUrl;
      if (provider !== null) {
        if (
          isKeyed(provider) &&
          valid.apiKey === undefined &&
          stored.keys[provider] === undefined
        ) {
          throw new Error(`${LABELS[provider]} needs an API key.`);
        }
        if (provider === "searxng" && url === null) {
          throw new Error(`${LABELS[provider]} needs the address of an instance.`);
        }
        if (isKeyed(provider) && valid.apiKey !== undefined) {
          if (!keychainAvailable) {
            throw new Error(
              "Keys cannot be stored safely on this Mac: the Keychain is not available.",
            );
          }
          stored.keys[provider] = valid.apiKey;
        }
      }
      stored.provider = provider;
      stored.searxngUrl = url;
      return state();
    },
    removeKey: async (provider) => {
      const valid = validate(KeyedSearchProviderSchema, provider, "search service");
      delete stored.keys[valid];
      if (stored.provider === valid) stored.provider = null;
      return state();
    },
    check: async (input): Promise<WebCheckResult> => {
      const valid = validate(WebCheckInputSchema, input, "web settings");
      checks.push({ ...valid });
      const label = LABELS[valid.provider];
      if (isKeyed(valid.provider)) {
        const key = valid.apiKey ?? stored.keys[valid.provider];
        if (key === undefined) return { ok: false, message: `${label} needs an API key.` };
        if (key.includes("bad")) return { ok: false, message: `${label} refused the key (401).` };
      } else {
        const url = valid.searxngUrl ?? stored.searxngUrl;
        if (url === null)
          return { ok: false, message: `${label} needs the address of an instance.` };
        if (url.includes("bad")) return { ok: false, message: `${label} could not be reached.` };
      }
      return { ok: true, message: `${label} answered with 5 results.` };
    },
  };

  return { api, stored, checks };
}
