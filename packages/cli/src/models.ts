/**
 * Where the model comes from: a remote OpenAI-compatible endpoint (probed for its real context
 * window), or a local model file run by the bundled llama-server under the supervisor.
 *
 * The API key comes from `DAWG_API_KEY` only. It is handed to the HTTP client and nowhere else:
 * never printed, logged or written.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  createModelClient,
  type EndpointDescription,
  type ModelConnection,
  type ModelProvider,
  RuntimeError,
} from "@dawg/engine";
import {
  connectRemote,
  type DiscoveredModel,
  type DiscoveredServer,
  type Endpoint,
  probeLmStudio,
  probeOllama,
  RuntimeSupervisor,
  requestJson,
  resolveRuntimeBinary,
  RuntimeError as SupervisorError,
  toEndpoint,
} from "@dawg/models";

/** Why the model could not be set up: the person's input, or the model side. */
export class ModelSetupError extends Error {
  override name = "ModelSetupError";
  readonly kind: "usage" | "model";

  constructor(kind: "usage" | "model", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface ModelSetup {
  provider: ModelProvider;
  /** The model a session gets when it names none. */
  defaultModel: string;
  /** For `/status`: where a model's requests go. */
  describe(modelId: string): EndpointDescription | null;
  /** Stops the bundled runtime, if one was started. Safe to call more than once. */
  close(): Promise<void>;
}

export interface ModelSetupOptions {
  endpoint: string | null;
  modelFile: string | null;
  contextSize: number | null;
  model: string | null;
  env: NodeJS.ProcessEnv;
  /** The data root (`~/.dawg`): runtime logs and slot caches go under it. */
  dawgHome: string;
  log: (line: string) => void;
}

/** Default context window per conversation for `--model-file`. */
export const DEFAULT_CONTEXT_SIZE = 32_768;

export const NO_MODEL_MESSAGE =
  "No model to talk to. Pass --endpoint <url> (an OpenAI-compatible root such as " +
  "http://127.0.0.1:8080/v1; put the key, if any, in DAWG_API_KEY), set DAWG_ENDPOINT, or pass " +
  "--model-file <path.gguf> to run a local model with the bundled runtime.";

/** A URL for display: no credentials, no query. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}

export async function setupModels(options: ModelSetupOptions): Promise<ModelSetup> {
  if (options.modelFile !== null) return setupModelFile(options, options.modelFile);
  const url = options.endpoint ?? nonEmpty(options.env.DAWG_ENDPOINT);
  if (url === null) throw new ModelSetupError("usage", NO_MODEL_MESSAGE);
  return setupEndpoint(options, url);
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value.trim();
}

// ---------------------------------------------------------------------------------------------
// A remote endpoint
// ---------------------------------------------------------------------------------------------

async function listServer(url: string, apiKey: string | undefined): Promise<DiscoveredServer> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new ModelSetupError("usage", `--endpoint must be an http:// or https:// URL.`);
  }
  let result = await connectRemote({ url, ...(apiKey === undefined ? {} : { apiKey }) });
  // A root given without its /v1 segment is the commonest slip; try once with it.
  if (!result.ok && !/\/v1\/?$/.test(new URL(url).pathname)) {
    const withV1 = `${url.replace(/\/+$/, "")}/v1`;
    const retry = await connectRemote({ url: withV1, ...(apiKey === undefined ? {} : { apiKey }) });
    if (retry.ok) result = retry;
  }
  if (!result.ok) {
    const status = result.status === undefined ? "" : ` (HTTP ${result.status})`;
    const hint =
      result.status === 401 || result.status === 403
        ? apiKey === undefined
          ? " The server wants a key: set DAWG_API_KEY."
          : " The key in DAWG_API_KEY was refused."
        : "";
    throw new ModelSetupError(
      "model",
      `Could not list the models at ${safeUrl(url)}${status}: ${result.error}.${hint}`,
    );
  }
  return result.server;
}

function pickModel(server: DiscoveredServer, wanted: string | null): DiscoveredModel {
  const ids = server.models.map((m) => m.id);
  if (wanted !== null) {
    const found =
      server.models.find((m) => m.id === wanted) ??
      server.models.find((m) => m.id.toLowerCase() === wanted.toLowerCase());
    if (found !== undefined) return found;
    throw new ModelSetupError(
      "usage",
      `The endpoint has no model "${wanted}". It serves: ${preview(ids)}.`,
    );
  }
  const only = server.models.length === 1 ? server.models[0] : undefined;
  const loaded = server.models.filter((m) => m.loaded === true);
  const chosen = only ?? (loaded.length === 1 ? loaded[0] : undefined);
  if (chosen !== undefined) return chosen;
  throw new ModelSetupError(
    "usage",
    `The endpoint serves ${server.models.length} models; choose one with --model: ${preview(ids)}.`,
  );
}

function preview(ids: readonly string[]): string {
  return ids.length <= 12
    ? ids.join(", ")
    : `${ids.slice(0, 12).join(", ")} and ${ids.length - 12} more`;
}

/**
 * When a generic OpenAI listing gave no context window, the server may be Ollama or LM Studio,
 * whose own APIs report the window the model is actually loaded with.
 */
async function refine(
  server: DiscoveredServer,
  model: DiscoveredModel,
  apiKey: string | undefined,
): Promise<{ server: DiscoveredServer; model: DiscoveredModel }> {
  if (model.contextSource !== "fallback") return { server, model };
  const url = new URL(server.baseUrl);
  if (url.protocol !== "http:") return { server, model };
  const probe = { host: url.hostname, port: Number(url.port || 80), timeoutMs: 1_500 };
  for (const found of [await probeOllama(probe), await probeLmStudio(probe)]) {
    const match = found?.models.find((m) => m.id === model.id);
    if (found !== null && found !== undefined && match !== undefined) {
      return {
        server: { ...found, ...(apiKey === undefined ? {} : { apiKey }) },
        model: match,
      };
    }
  }
  return { server, model };
}

/** Template facts a llama-server reports in `/props`; nothing for other servers. */
async function templateFacts(
  server: DiscoveredServer,
  apiKey: string | undefined,
): Promise<Endpoint["template"] | undefined> {
  if (server.kind !== "remote") return undefined;
  const props = await requestJson(`${server.baseUrl.replace(/\/v1$/, "")}/props`, {
    ...(apiKey === undefined ? {} : { apiKey }),
    timeoutMs: 5_000,
  });
  if (!props.ok || typeof props.data !== "object" || props.data === null) return undefined;
  const caps = (props.data as { chat_template_caps?: unknown }).chat_template_caps;
  if (typeof caps !== "object" || caps === null) return undefined;
  const c = caps as { supports_parallel_tool_calls?: unknown; reasoning_effort_levels?: unknown };
  const levels = Array.isArray(c.reasoning_effort_levels)
    ? c.reasoning_effort_levels.filter((l): l is string => typeof l === "string")
    : [];
  return {
    parallelToolCalls: c.supports_parallel_tool_calls === true,
    reasoningEffortLevels: levels,
  };
}

async function endpointFor(
  url: string,
  wanted: string | null,
  apiKey: string | undefined,
): Promise<Endpoint> {
  const listed = await listServer(url, apiKey);
  const picked = pickModel(listed, wanted);
  const { server, model } = await refine(listed, picked, apiKey);
  const endpoint = toEndpoint(server, model.id);
  if (apiKey !== undefined) endpoint.apiKey = apiKey;
  const template = await templateFacts(server, apiKey);
  if (template !== undefined) endpoint.template = template;
  return endpoint;
}

async function setupEndpoint(options: ModelSetupOptions, url: string): Promise<ModelSetup> {
  const apiKey = nonEmpty(options.env.DAWG_API_KEY) ?? undefined;
  const first = await endpointFor(url, options.model, apiKey);
  if (options.log !== undefined) {
    options.log(
      `Model ${first.model} on ${first.kind} endpoint ${safeUrl(first.baseUrl)}, context window ${first.contextWindow} tokens.`,
    );
  }
  const endpoints = new Map<string, Endpoint>([[first.model, first]]);
  const connections = new Map<string, Promise<ModelConnection>>();
  // No slot pool: the server's slots are not ours to schedule (other programs may use them), so
  // requests go out at once and the server orders them.
  const connectionFor = (endpoint: Endpoint): ModelConnection => {
    const client = createModelClient(endpoint);
    return { client };
  };
  connections.set(first.model, Promise.resolve(connectionFor(first)));
  return {
    defaultModel: first.model,
    provider: {
      connect(modelId) {
        const id = modelId ?? first.model;
        let pending = connections.get(id);
        if (pending === undefined) {
          pending = endpointFor(url, id, apiKey).then(
            (endpoint) => {
              endpoints.set(endpoint.model, endpoint);
              return connectionFor(endpoint);
            },
            (error) => {
              connections.delete(id);
              throw new RuntimeError(
                "InvalidState",
                error instanceof ModelSetupError ? error.message : `Could not use model "${id}".`,
              );
            },
          );
          connections.set(id, pending);
        }
        return pending;
      },
    },
    describe(modelId) {
      const endpoint = endpoints.get(modelId);
      return endpoint === undefined
        ? null
        : { kind: endpoint.kind, url: safeUrl(endpoint.baseUrl) };
    },
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------------------------
// A local model file, run by the bundled runtime
// ---------------------------------------------------------------------------------------------

async function setupModelFile(options: ModelSetupOptions, file: string): Promise<ModelSetup> {
  const modelPath = path.resolve(file);
  const info = await stat(modelPath).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new ModelSetupError("usage", `--model-file: ${modelPath} is not a file.`);
  }
  let binary: string;
  try {
    binary = (await resolveRuntimeBinary({ env: options.env })).binary;
  } catch (error) {
    if (error instanceof SupervisorError) {
      throw new ModelSetupError(
        "usage",
        "The bundled runtime (llama-server) has not been fetched. From the repository root run " +
          "`pnpm fetch-runtime` (or `node scripts/fetch-runtime.ts`), or point DAWG_RUNTIME_BIN " +
          "at a llama-server binary.",
      );
    }
    throw error;
  }
  const window = options.contextSize ?? DEFAULT_CONTEXT_SIZE;
  const alias = options.model ?? path.basename(modelPath).replace(/\.gguf$/i, "");
  // Two slots: conversations, and side requests (titles) so they never evict a conversation's
  // cache. The server splits -c between slots; the real per-slot window is read back from /props.
  const supervisor = new RuntimeSupervisor({
    binary,
    model: { path: modelPath },
    contextSize: window * 2,
    slots: 2,
    settings: { cacheRamMiB: 4096, ctxCheckpoints: 8, checkpointMinStep: 256, alias },
    paths: {
      slotSaveDir: path.join(options.dawgHome, "runtime", "slots"),
      logDir: path.join(options.dawgHome, "logs"),
    },
  });
  let stopped: Promise<void> | null = null;
  const close = () => {
    stopped ??= supervisor.stop().catch(() => {});
    return stopped;
  };
  options.log(`Starting the bundled runtime with ${path.basename(modelPath)}...`);
  let endpoint: Endpoint;
  try {
    endpoint = await supervisor.start();
  } catch (error) {
    await close();
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new ModelSetupError(
      "model",
      `The bundled runtime did not start: ${reason}. Its log is in ${supervisor.logPath}.`,
    );
  }
  options.log(
    `Model ${endpoint.model} ready on the bundled runtime, context window ${endpoint.contextWindow} tokens.`,
  );
  const client = createModelClient(endpoint);
  // Every session gets these same two pools, so the engine schedules them: sessions running at
  // once take turns on the conversation slot, and the one waiting shows as queued. One
  // conversation slot keeps each session's whole window (the server divides -c by the slots)
  // and gives a running turn the full speed of the machine.
  const connection: ModelConnection = {
    client,
    pool: { slots: [0] },
    utility: { client, pool: { slots: [1] } },
  };
  return {
    defaultModel: endpoint.model,
    provider: {
      async connect(modelId) {
        if (modelId !== null && modelId !== endpoint.model) {
          throw new RuntimeError(
            "InvalidState",
            `Only ${endpoint.model} is loaded; start dawg with another --model-file to use a different model.`,
          );
        }
        return connection;
      },
    },
    describe: () => ({ kind: "bundled", url: safeUrl(endpoint.baseUrl) }),
    close,
  };
}
