import type { Endpoint, EndpointKind, ModelCapabilities } from "../types.ts";
import { type HttpOptions, requestJson, trimSlash } from "./http.ts";

/**
 * Discovery of servers the user already runs (Ollama, LM Studio) and of a remote
 * OpenAI-compatible URL. Probes never throw and give up quickly when nothing is listening.
 *
 * What each server reports about context (from each project's public API docs):
 *
 * | Server    | Source, in order of preference                                         | Fallback |
 * | --------- | ---------------------------------------------------------------------- | -------- |
 * | Ollama    | /api/ps `context_length` of the loaded model; `num_ctx` in /api/show   | 4096     |
 * |           | `parameters`; both capped by `<arch>.context_length` in `model_info`   |          |
 * | LM Studio | loaded context (`loaded_context_length` in /api/v0/models, or          | 4096     |
 * |           | `loaded_instances[].config.context_length` in /api/v1/models)          |          |
 * | Remote    | `context_length`, `context_window`, `max_model_len`,                   | 8192     |
 * |           | `max_context_length`, `meta.n_ctx`, `top_provider.context_length` on   |          |
 * |           | the model object; llama.cpp `/props` when the server is llama-server    |          |
 *
 * Fallbacks are deliberately small: an unknown window should trigger compaction early, never
 * silent truncation. A model's maximum context is not used as its window, because neither
 * Ollama nor LM Studio loads a model at its maximum unless told to.
 */

export const OLLAMA_DEFAULT_PORT = 11434;
export const LMSTUDIO_DEFAULT_PORT = 1234;
export const OLLAMA_FALLBACK_CONTEXT = 4096;
export const LMSTUDIO_FALLBACK_CONTEXT = 4096;
export const REMOTE_FALLBACK_CONTEXT = 8192;

export type ContextSource = "loaded" | "configured" | "reported" | "fallback";

export interface DiscoveredModel {
  id: string;
  contextWindow: number;
  /** Where `contextWindow` came from: the running instance, model config, a listing, or a guess. */
  contextSource: ContextSource;
  /** The most the model supports, when reported. */
  maxContext?: number;
  capabilities: ModelCapabilities;
  /** "assumed" when the server says nothing about capabilities. */
  capabilitiesSource: "reported" | "assumed";
  loaded?: boolean;
}

export interface DiscoveredServer {
  kind: Exclude<EndpointKind, "bundled">;
  /** OpenAI-compatible root, including `/v1`. */
  baseUrl: string;
  apiKey?: string;
  version?: string;
  models: DiscoveredModel[];
}

export interface ProbeOptions {
  host?: string;
  port?: number;
  /** Timeout for the first request, which decides whether anything is there. Default 750 ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asPositive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

function http(options: ProbeOptions, timeoutMs: number): HttpOptions {
  return { fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs };
}

async function safely<T>(work: () => Promise<T | null>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

// --- Ollama -----------------------------------------------------------------------------------

export function probeOllama(options: ProbeOptions = {}): Promise<DiscoveredServer | null> {
  return safely(async () => {
    const origin = `http://${options.host ?? "127.0.0.1"}:${options.port ?? OLLAMA_DEFAULT_PORT}`;
    const version = await requestJson(
      `${origin}/api/version`,
      http(options, options.timeoutMs ?? 750),
    );
    if (!version.ok || !isObject(version.data) || typeof version.data.version !== "string")
      return null;
    const slow = http(options, 5_000);
    const [tags, ps] = await Promise.all([
      requestJson(`${origin}/api/tags`, slow),
      requestJson(`${origin}/api/ps`, slow),
    ]);
    if (!tags.ok || !isObject(tags.data)) return null;
    const loaded = new Map<string, number | undefined>();
    if (ps.ok && isObject(ps.data)) {
      for (const m of asArray(ps.data.models)) {
        if (!isObject(m)) continue;
        const name = asString(m.name) ?? asString(m.model);
        if (name) loaded.set(name, asPositive(m.context_length));
      }
    }
    const names = asArray(tags.data.models)
      .map((m) => (isObject(m) ? (asString(m.name) ?? asString(m.model)) : undefined))
      .filter((n): n is string => n !== undefined);
    const models = await Promise.all(
      names.map(async (name) => {
        const show = await requestJson(`${origin}/api/show`, { ...slow, body: { model: name } });
        return describeOllamaModel(name, show.ok ? show.data : undefined, loaded);
      }),
    );
    return {
      kind: "ollama",
      baseUrl: `${origin}/v1`,
      version: version.data.version,
      models: models.filter((m): m is DiscoveredModel => m !== null),
    };
  });
}

function describeOllamaModel(
  name: string,
  show: unknown,
  loaded: Map<string, number | undefined>,
): DiscoveredModel | null {
  const info = isObject(show) ? show : {};
  const caps = asArray(info.capabilities).filter((c): c is string => typeof c === "string");
  // Embedding-only models cannot chat.
  if (caps.length > 0 && !caps.includes("completion")) return null;
  let maxContext: number | undefined;
  if (isObject(info.model_info)) {
    for (const [key, value] of Object.entries(info.model_info)) {
      if (key.endsWith(".context_length")) maxContext = asPositive(value) ?? maxContext;
    }
  }
  const numCtx = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(asString(info.parameters) ?? "")?.[1];
  const loadedContext = loaded.get(name);
  let contextWindow: number;
  let contextSource: ContextSource;
  if (loadedContext !== undefined) {
    contextWindow = loadedContext;
    contextSource = "loaded";
  } else if (numCtx !== undefined) {
    contextWindow = Number(numCtx);
    contextSource = "configured";
  } else {
    contextWindow = OLLAMA_FALLBACK_CONTEXT;
    contextSource = "fallback";
  }
  if (maxContext !== undefined) contextWindow = Math.min(contextWindow, maxContext);
  return {
    id: name,
    contextWindow,
    contextSource,
    maxContext,
    capabilities:
      caps.length > 0
        ? {
            tools: caps.includes("tools"),
            vision: caps.includes("vision"),
            reasoning: caps.includes("thinking"),
          }
        : { tools: true, vision: false, reasoning: false },
    capabilitiesSource: caps.length > 0 ? "reported" : "assumed",
    loaded: loaded.has(name),
  };
}

// --- LM Studio --------------------------------------------------------------------------------

export function probeLmStudio(options: ProbeOptions = {}): Promise<DiscoveredServer | null> {
  return safely(async () => {
    const origin = `http://${options.host ?? "127.0.0.1"}:${options.port ?? LMSTUDIO_DEFAULT_PORT}`;
    const quick = http(options, options.timeoutMs ?? 750);
    // Newer builds serve /api/v1/models; 0.3.x serves /api/v0/models. Either identifies LM Studio.
    const v1 = await requestJson(`${origin}/api/v1/models`, quick);
    if (v1.ok && isObject(v1.data) && Array.isArray(v1.data.models)) {
      return {
        kind: "lmstudio",
        baseUrl: `${origin}/v1`,
        models: lmStudioV1Models(v1.data.models),
      };
    }
    if (
      !v1.ok &&
      (v1.reason === "unreachable" || v1.reason === "timeout" || v1.reason === "aborted")
    ) {
      return null;
    }
    const v0 = await requestJson(`${origin}/api/v0/models`, quick);
    if (v0.ok && isObject(v0.data) && Array.isArray(v0.data.data)) {
      return { kind: "lmstudio", baseUrl: `${origin}/v1`, models: lmStudioV0Models(v0.data.data) };
    }
    return null;
  });
}

function lmStudioV0Models(list: unknown[]): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const m of list) {
    if (!isObject(m) || m.type === "embeddings") continue;
    const id = asString(m.id);
    if (!id) continue;
    const maxContext = asPositive(m.max_context_length);
    const loadedContext = asPositive(m.loaded_context_length);
    const caps = asArray(m.capabilities);
    out.push({
      id,
      ...lmStudioContext(loadedContext, maxContext),
      maxContext,
      capabilities: {
        tools: caps.includes("tool_use"),
        vision: m.type === "vlm",
        reasoning: false,
      },
      capabilitiesSource: "reported",
      loaded: m.state === "loaded",
    });
  }
  return out;
}

function lmStudioV1Models(list: unknown[]): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const m of list) {
    if (!isObject(m) || m.type === "embedding" || m.type === "embeddings") continue;
    const id = asString(m.key) ?? asString(m.id);
    if (!id) continue;
    const maxContext = asPositive(m.max_context_length);
    const instances = asArray(m.loaded_instances).filter(isObject);
    const first = instances[0];
    const loadedContext =
      first && isObject(first.config) ? asPositive(first.config.context_length) : undefined;
    const caps = isObject(m.capabilities) ? m.capabilities : undefined;
    out.push({
      id,
      ...lmStudioContext(loadedContext, maxContext),
      maxContext,
      capabilities: {
        tools: caps?.trained_for_tool_use === true,
        vision: caps?.vision === true,
        reasoning: isObject(caps?.reasoning) || caps?.reasoning === true,
      },
      capabilitiesSource: caps ? "reported" : "assumed",
      loaded: instances.length > 0,
    });
  }
  return out;
}

function lmStudioContext(
  loadedContext: number | undefined,
  maxContext: number | undefined,
): { contextWindow: number; contextSource: ContextSource } {
  if (loadedContext !== undefined) return { contextWindow: loadedContext, contextSource: "loaded" };
  return {
    contextWindow: Math.min(LMSTUDIO_FALLBACK_CONTEXT, maxContext ?? LMSTUDIO_FALLBACK_CONTEXT),
    contextSource: "fallback",
  };
}

// --- Remote -----------------------------------------------------------------------------------

export interface RemoteOptions {
  /** OpenAI-compatible root, normally ending in `/v1`. */
  url: string;
  apiKey?: string;
  /** Used when the server does not report a context window. */
  contextWindow?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type RemoteResult =
  | { ok: true; server: DiscoveredServer }
  | { ok: false; error: string; status?: number };

/** Lists a remote server's models. Never throws; a bad URL or key comes back as `ok: false`. */
export async function connectRemote(options: RemoteOptions): Promise<RemoteResult> {
  let base: string;
  try {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "the URL must start with http:// or https://" };
    }
    base = trimSlash(parsed.toString());
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  const opts: HttpOptions = {
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
  const listing = await requestJson(`${base}/models`, opts);
  if (!listing.ok) {
    return { ok: false, error: listing.message, status: listing.status };
  }
  const data = isObject(listing.data) ? asArray(listing.data.data) : [];
  if (data.length === 0) return { ok: false, error: "the server lists no models" };

  // llama-server reports the real per-slot window in /props.
  let llamaContext: number | undefined;
  if (data.some((m) => isObject(m) && m.owned_by === "llamacpp")) {
    const props = await requestJson(`${base.replace(/\/v1$/, "")}/props`, opts);
    if (props.ok && isObject(props.data) && isObject(props.data.default_generation_settings)) {
      llamaContext = asPositive(props.data.default_generation_settings.n_ctx);
    }
  }
  const models: DiscoveredModel[] = [];
  for (const m of data) {
    if (!isObject(m)) continue;
    const id = asString(m.id);
    if (!id) continue;
    models.push(describeRemoteModel(id, m, llamaContext, options.contextWindow));
  }
  return { ok: true, server: { kind: "remote", baseUrl: base, apiKey: options.apiKey, models } };
}

function describeRemoteModel(
  id: string,
  m: Json,
  llamaContext: number | undefined,
  configured: number | undefined,
): DiscoveredModel {
  const meta = isObject(m.meta) ? m.meta : {};
  const topProvider = isObject(m.top_provider) ? m.top_provider : {};
  const reported =
    llamaContext ??
    asPositive(meta.n_ctx) ??
    asPositive(m.max_model_len) ??
    asPositive(m.context_length) ??
    asPositive(m.context_window) ??
    asPositive(m.max_context_length) ??
    asPositive(topProvider.context_length);
  const params = asArray(m.supported_parameters);
  const architecture = isObject(m.architecture) ? m.architecture : {};
  const inputs = asArray(architecture.input_modalities);
  const capsReported = params.length > 0 || inputs.length > 0;
  return {
    id,
    contextWindow: reported ?? configured ?? REMOTE_FALLBACK_CONTEXT,
    contextSource:
      reported !== undefined ? "reported" : configured !== undefined ? "configured" : "fallback",
    maxContext: asPositive(meta.n_ctx_train),
    capabilities: {
      tools: params.length > 0 ? params.includes("tools") : true,
      vision: inputs.includes("image"),
      reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    },
    capabilitiesSource: capsReported ? "reported" : "assumed",
  };
}

// --- shared -----------------------------------------------------------------------------------

/** Probes Ollama and LM Studio in parallel. Offered in settings; never chosen silently. */
export async function detectLocalServers(
  options: { ollama?: ProbeOptions; lmstudio?: ProbeOptions } = {},
): Promise<DiscoveredServer[]> {
  const found = await Promise.all([probeOllama(options.ollama), probeLmStudio(options.lmstudio)]);
  return found.filter((s): s is DiscoveredServer => s !== null);
}

/**
 * The endpoint for one model on a discovered server: the one named, else the first loaded one,
 * else the first listed. `cacheControl` is false: slots and cache files are bundled-only.
 */
export function toEndpoint(server: DiscoveredServer, modelId?: string): Endpoint {
  const model =
    (modelId === undefined
      ? (server.models.find((m) => m.loaded) ?? server.models[0])
      : server.models.find((m) => m.id === modelId)) ?? undefined;
  if (!model) {
    throw new Error(
      modelId === undefined ? "the server has no models" : `the server has no model ${modelId}`,
    );
  }
  return {
    kind: server.kind,
    baseUrl: server.baseUrl,
    ...(server.apiKey ? { apiKey: server.apiKey } : {}),
    model: model.id,
    contextWindow: model.contextWindow,
    capabilities: { ...model.capabilities, cacheControl: false },
  };
}
