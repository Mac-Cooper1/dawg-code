import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { chatOnce, EndpointError } from "./chat.ts";
import {
  connectRemote,
  detectLocalServers,
  probeLmStudio,
  probeOllama,
  toEndpoint,
} from "./detect.ts";

/**
 * Fake Ollama, LM Studio and remote servers. Response shapes follow each project's public API
 * documentation; they have not been checked against the real applications (see the report).
 */

type Handler = (
  req: IncomingMessage,
  body: unknown,
) => { status?: number; body: unknown } | undefined;

const servers: (Server | TcpServer)[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function jsonServer(routes: Record<string, Handler>): Promise<number> {
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const route = routes[`${req.method} ${req.url}`];
    const out = route?.(req, text ? JSON.parse(text) : undefined);
    if (!out) {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Unexpected endpoint or method." }));
      return;
    }
    res
      .writeHead(out.status ?? 200, { "content-type": "application/json" })
      .end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise((r) => server.close(r));
  return port;
}

async function blackHole(): Promise<number> {
  // Accepts connections and never answers.
  const server = createTcpServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

const ollamaShow: Record<string, unknown> = {
  "qwen3:8b": {
    parameters: "temperature 0.6\nnum_ctx 8192",
    model_info: { "general.architecture": "qwen3", "qwen3.context_length": 40960 },
    capabilities: ["completion", "tools", "thinking"],
  },
  "llama3.2:3b": {
    parameters: "",
    model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
    capabilities: ["completion", "tools"],
  },
  "gemma3:4b": {
    parameters: "num_ctx 200000",
    model_info: { "gemma3.context_length": 131072 },
    capabilities: ["completion", "vision"],
  },
  "nomic-embed-text:latest": { capabilities: ["embedding"] },
};

function ollama(): Promise<number> {
  return jsonServer({
    "GET /api/version": () => ({ body: { version: "0.13.0" } }),
    "GET /api/tags": () => ({
      body: { models: Object.keys(ollamaShow).map((name) => ({ name, model: name, size: 1 })) },
    }),
    "GET /api/ps": () => ({
      body: { models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length: 16384 }] },
    }),
    "POST /api/show": (_req, body) => {
      const show = ollamaShow[(body as { model: string }).model];
      return show ? { body: show } : { status: 404, body: { error: "model not found" } };
    },
    "POST /v1/chat/completions": (_req, body) => ({
      body: {
        model: (body as { model: string }).model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "hi there", reasoning: "thinking..." },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    }),
  });
}

describe("probeOllama", () => {
  test("lists chat models with their real or configured context and capabilities", async () => {
    const port = await ollama();
    const server = await probeOllama({ port });
    expect(server).not.toBeNull();
    expect(server?.kind).toBe("ollama");
    expect(server?.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    expect(server?.version).toBe("0.13.0");
    expect(server?.models).toEqual([
      {
        id: "qwen3:8b",
        contextWindow: 16384,
        contextSource: "loaded",
        maxContext: 40960,
        capabilities: { tools: true, vision: false, reasoning: true },
        capabilitiesSource: "reported",
        loaded: true,
      },
      {
        id: "llama3.2:3b",
        contextWindow: 4096,
        contextSource: "fallback",
        maxContext: 131072,
        capabilities: { tools: true, vision: false, reasoning: false },
        capabilitiesSource: "reported",
        loaded: false,
      },
      {
        id: "gemma3:4b",
        contextWindow: 131072, // num_ctx capped by the model's own maximum
        contextSource: "configured",
        maxContext: 131072,
        capabilities: { tools: false, vision: true, reasoning: false },
        capabilitiesSource: "reported",
        loaded: false,
      },
    ]);
  });

  test("the endpoint defaults to the loaded model and has no cache control", async () => {
    const port = await ollama();
    const server = await probeOllama({ port });
    const endpoint = toEndpoint(server as NonNullable<typeof server>);
    expect(endpoint).toEqual({
      kind: "ollama",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "qwen3:8b",
      contextWindow: 16384,
      capabilities: { tools: true, vision: false, reasoning: true, cacheControl: false },
    });
    const reply = await chatOnce(endpoint, "hello");
    expect(reply).toMatchObject({
      content: "hi there",
      reasoning: "thinking...",
      finishReason: "stop",
      model: "qwen3:8b",
    });
    expect(() => toEndpoint(server as NonNullable<typeof server>, "nope")).toThrow(/no model nope/);
  });

  test("returns null fast when nothing listens", async () => {
    const started = Date.now();
    expect(await probeOllama({ port: await closedPort() })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("returns null within the timeout when the port never answers", async () => {
    const started = Date.now();
    expect(await probeOllama({ port: await blackHole(), timeoutMs: 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("returns null for something that is not Ollama", async () => {
    const port = await jsonServer({ "GET /api/version": () => ({ body: { name: "other" } }) });
    expect(await probeOllama({ port })).toBeNull();
  });
});

describe("probeLmStudio", () => {
  test("reads the v1 REST API (loaded context, capabilities), skipping embeddings", async () => {
    const port = await jsonServer({
      "GET /api/v1/models": () => ({
        body: {
          models: [
            {
              type: "llm",
              key: "qwen/qwen3-coder-30b",
              max_context_length: 262144,
              loaded_instances: [{ id: "qwen/qwen3-coder-30b", config: { context_length: 32768 } }],
              capabilities: { vision: false, trained_for_tool_use: true },
            },
            { type: "embedding", key: "text-embedding-nomic-embed-text-v1.5" },
            {
              type: "llm",
              key: "google/gemma-3-12b",
              max_context_length: 131072,
              loaded_instances: [],
              capabilities: { vision: true, trained_for_tool_use: false },
            },
          ],
        },
      }),
    });
    const server = await probeLmStudio({ port });
    expect(server?.kind).toBe("lmstudio");
    expect(
      server?.models.map((m) => [m.id, m.contextWindow, m.contextSource, m.capabilities]),
    ).toEqual([
      ["qwen/qwen3-coder-30b", 32768, "loaded", { tools: true, vision: false, reasoning: false }],
      ["google/gemma-3-12b", 4096, "fallback", { tools: false, vision: true, reasoning: false }],
    ]);
    expect(toEndpoint(server as NonNullable<typeof server>).model).toBe("qwen/qwen3-coder-30b");
  });

  test("falls back to the v0 REST API of older versions", async () => {
    const port = await jsonServer({
      "GET /api/v0/models": () => ({
        body: {
          object: "list",
          data: [
            {
              id: "qwen2.5-7b-instruct",
              type: "llm",
              state: "loaded",
              max_context_length: 32768,
              loaded_context_length: 8192,
              capabilities: ["tool_use"],
            },
            {
              id: "qwen2-vl-7b-instruct",
              type: "vlm",
              state: "not-loaded",
              max_context_length: 2048,
            },
            { id: "nomic-embed", type: "embeddings", state: "not-loaded" },
          ],
        },
      }),
    });
    const server = await probeLmStudio({ port });
    expect(
      server?.models.map((m) => [
        m.id,
        m.contextWindow,
        m.contextSource,
        m.capabilities.tools,
        m.capabilities.vision,
      ]),
    ).toEqual([
      ["qwen2.5-7b-instruct", 8192, "loaded", true, false],
      ["qwen2-vl-7b-instruct", 2048, "fallback", false, true],
    ]);
  });

  test("returns null fast when nothing listens, and for other servers", async () => {
    const started = Date.now();
    expect(await probeLmStudio({ port: await closedPort() })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    const other = await jsonServer({ "GET /v1/models": () => ({ body: { data: [] } }) });
    expect(await probeLmStudio({ port: other })).toBeNull();
    expect(await probeLmStudio({ port: await blackHole(), timeoutMs: 300 })).toBeNull();
  });
});

describe("detectLocalServers", () => {
  test("finds what is running and ignores what is not", async () => {
    const port = await ollama();
    const found = await detectLocalServers({
      ollama: { port },
      lmstudio: { port: await closedPort() },
    });
    expect(found.map((s) => s.kind)).toEqual(["ollama"]);
  });
});

describe("connectRemote", () => {
  const key = "sk-test";
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${key}`;

  test("reads vLLM's max_model_len and sends the key", async () => {
    const port = await jsonServer({
      "GET /v1/models": (req) =>
        authorized(req)
          ? {
              body: {
                object: "list",
                data: [{ id: "Qwen/Qwen3-32B", owned_by: "vllm", max_model_len: 32768 }],
              },
            }
          : { status: 401, body: { error: { message: "Invalid API key" } } },
    });
    const result = await connectRemote({ url: `http://127.0.0.1:${port}/v1/`, apiKey: key });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const endpoint = toEndpoint(result.server);
    expect(endpoint).toEqual({
      kind: "remote",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: key,
      model: "Qwen/Qwen3-32B",
      contextWindow: 32768,
      capabilities: { tools: true, vision: false, reasoning: false, cacheControl: false },
    });
    expect(result.server.models[0]?.capabilitiesSource).toBe("assumed");

    const bad = await connectRemote({ url: `http://127.0.0.1:${port}/v1`, apiKey: "wrong" });
    expect(bad).toEqual({ ok: false, error: "Invalid API key", status: 401 });
  });

  test("reads OpenRouter-style context_length and supported parameters", async () => {
    const port = await jsonServer({
      "GET /api/v1/models": () => ({
        body: {
          data: [
            {
              id: "qwen/qwen3-coder",
              context_length: 262144,
              supported_parameters: ["tools", "reasoning", "temperature"],
              architecture: { input_modalities: ["text", "image"] },
            },
          ],
        },
      }),
    });
    const result = await connectRemote({ url: `http://127.0.0.1:${port}/api/v1` });
    expect(result.ok && result.server.models[0]).toMatchObject({
      contextWindow: 262144,
      contextSource: "reported",
      capabilities: { tools: true, vision: true, reasoning: true },
      capabilitiesSource: "reported",
    });
  });

  test("asks a remote llama-server for its real per-slot window", async () => {
    const port = await jsonServer({
      "GET /v1/models": () => ({
        body: { data: [{ id: "m.gguf", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }] },
      }),
      "GET /props": () => ({
        body: { default_generation_settings: { n_ctx: 16384 }, total_slots: 2 },
      }),
    });
    const result = await connectRemote({ url: `http://127.0.0.1:${port}/v1` });
    expect(result.ok && result.server.models[0]).toMatchObject({
      contextWindow: 16384,
      maxContext: 32768,
    });
  });

  test("takes vision from a remote llama-server's /props modalities", async () => {
    const port = await jsonServer({
      "GET /v1/models": () => ({ body: { data: [{ id: "vlm.gguf", owned_by: "llamacpp" }] } }),
      "GET /props": () => ({
        body: {
          default_generation_settings: { n_ctx: 8192 },
          modalities: { vision: true, audio: false },
        },
      }),
    });
    const vision = await connectRemote({ url: `http://127.0.0.1:${port}/v1` });
    expect(vision.ok && vision.server.models[0]).toMatchObject({
      capabilities: { vision: true },
      capabilitiesSource: "reported",
    });

    const textOnly = await jsonServer({
      "GET /v1/models": () => ({ body: { data: [{ id: "lm.gguf", owned_by: "llamacpp" }] } }),
      "GET /props": () => ({
        body: { default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } },
      }),
    });
    const text = await connectRemote({ url: `http://127.0.0.1:${textOnly}/v1` });
    expect(text.ok && text.server.models[0]).toMatchObject({ capabilities: { vision: false } });
  });

  test("falls back to the configured, then a conservative, window", async () => {
    const port = await jsonServer({ "GET /v1/models": () => ({ body: { data: [{ id: "x" }] } }) });
    const configured = await connectRemote({
      url: `http://127.0.0.1:${port}/v1`,
      contextWindow: 65536,
    });
    expect(configured.ok && configured.server.models[0]).toMatchObject({
      contextWindow: 65536,
      contextSource: "configured",
    });
    const unknown = await connectRemote({ url: `http://127.0.0.1:${port}/v1` });
    expect(unknown.ok && unknown.server.models[0]).toMatchObject({
      contextWindow: 8192,
      contextSource: "fallback",
    });
  });

  test("reports bad URLs and unreachable servers without throwing", async () => {
    expect(await connectRemote({ url: "not a url" })).toEqual({
      ok: false,
      error: "not a valid URL",
    });
    expect(await connectRemote({ url: "file:///etc/passwd" })).toMatchObject({ ok: false });
    const down = await connectRemote({ url: `http://127.0.0.1:${await closedPort()}/v1` });
    expect(down.ok).toBe(false);
    const empty = await jsonServer({ "GET /v1/models": () => ({ body: { data: [] } }) });
    expect(await connectRemote({ url: `http://127.0.0.1:${empty}/v1` })).toEqual({
      ok: false,
      error: "the server lists no models",
    });
  });
});

describe("chatOnce", () => {
  test("surfaces HTTP errors with their status", async () => {
    const port = await jsonServer({
      "POST /v1/chat/completions": () => ({
        status: 400,
        body: { error: { message: "bad model" } },
      }),
    });
    const endpoint = {
      kind: "remote" as const,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m",
      contextWindow: 1,
      capabilities: { tools: false, vision: false, reasoning: false, cacheControl: false },
    };
    const error = await chatOnce(endpoint, "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EndpointError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining("bad model") });
  });
});
