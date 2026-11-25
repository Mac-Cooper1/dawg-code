import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEngine,
  errorInfoFrom,
  type ModelClient,
  type ModelConnection,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
  RuntimeError,
} from "@dawg/engine";
import type { Endpoint } from "@dawg/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostToMain, ModelGrant } from "../shared/engine-host-messages.ts";
import {
  createParentModelProvider,
  DEFAULT_GRANT_TIMEOUT_MS,
  type ParentModelProvider,
} from "./model-provider.ts";

// ---------------------------------------------------------------------------------------------
// A fake main on the other end of the parent port, and fake model clients
// ---------------------------------------------------------------------------------------------

type Request = Extract<HostToMain, { type: "model-request" }>;

interface Sent {
  endpoint: Endpoint;
  request: ModelRequest;
}

interface Fixture {
  provider: ParentModelProvider;
  /** Every `model-request` the provider posted, in order. */
  requests: Request[];
  /** Every request a model client sent, with the endpoint it went to. */
  sent: Sent[];
  /** Waits for the provider's next `model-request`. */
  nextRequest(): Promise<Request>;
  grant(request: Request, grant: Partial<ModelGrant> & { modelId: string }): void;
  refuse(request: Request, message: string, retryable?: boolean): void;
  /** Makes the next stream fail as if the server were gone. */
  failNextStream(error: ModelError): void;
  /** While set, streams wait for `release()` before replying. */
  hold(): { release(): void };
  logs: string[];
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    kind: "bundled",
    baseUrl: "http://127.0.0.1:41001/v1",
    model: "server-name",
    contextWindow: 32_768,
    capabilities: { tools: true, vision: false, reasoning: true, cacheControl: true },
    ...overrides,
  };
}

function finished(text: string): ModelStreamEvent {
  return {
    type: "finished",
    reply: {
      content: text,
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 2,
        cachedTokens: null,
        promptTokensPerSecond: null,
        completionTokensPerSecond: null,
        promptMs: null,
        completionMs: null,
      },
      model: null,
    },
  };
}

function fixture(options: { grantTimeoutMs?: number } = {}): Fixture {
  const requests: Request[] = [];
  const sent: Sent[] = [];
  const logs: string[] = [];
  const failures: ModelError[] = [];
  let gate: Promise<void> | null = null;
  let waiter: ((request: Request) => void) | null = null;
  let seen = 0;

  const createClient = (target: Endpoint): ModelClient => ({
    endpoint: target,
    async *stream(request) {
      sent.push({ endpoint: target, request });
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      if (gate !== null) await gate;
      yield { type: "text_delta", text: "Done." };
      yield finished("Done.");
    },
    countTokens: async () => 7,
  });

  const provider = createParentModelProvider({
    send: (message) => {
      if (message.type !== "model-request") return;
      requests.push(message);
      waiter?.(message);
    },
    log: (line) => logs.push(line),
    createClient,
    ...(options.grantTimeoutMs === undefined ? {} : { grantTimeoutMs: options.grantTimeoutMs }),
  });

  return {
    provider,
    requests,
    sent,
    logs,
    nextRequest() {
      const ready = requests[seen];
      if (ready !== undefined) {
        seen += 1;
        return Promise.resolve(ready);
      }
      return new Promise<Request>((resolve) => {
        waiter = (request) => {
          waiter = null;
          seen += 1;
          resolve(request);
        };
      });
    },
    grant(request, grant) {
      provider.receive({
        type: "model-grant",
        requestId: request.requestId,
        grant: { endpoint: endpoint(), generation: 1, ...grant },
      });
    },
    refuse(request, message, retryable = false) {
      provider.receive({ type: "model-refused", requestId: request.requestId, message, retryable });
    },
    failNextStream(error) {
      failures.push(error);
    },
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return { release: () => release() };
    },
  };
}

const BUNDLED_SLOTS = { conversation: [0], utility: [1] };

function ask(text: string): ModelRequest {
  return {
    messages: [{ role: "user", kind: "prompt", content: [{ type: "text", text }] }],
    tools: [],
  };
}

async function drain(client: ModelClient, request: ModelRequest): Promise<string> {
  let text = "";
  for await (const event of client.stream(request)) {
    if (event.type === "text_delta") text += event.text;
  }
  return text;
}

/** Connects, answering the model request with `grant`. */
async function connectWith(
  f: Fixture,
  modelId: string | null,
  grant: Partial<ModelGrant> & { modelId: string },
): Promise<ModelConnection> {
  const connecting = f.provider.connect(modelId);
  f.grant(await f.nextRequest(), grant);
  return connecting;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------

describe("the model provider", () => {
  it("asks main for the default model and keeps the id the grant names", async () => {
    const f = fixture();
    const connecting = f.provider.connect(null);
    const request = await f.nextRequest();
    expect(request).toEqual({
      type: "model-request",
      requestId: expect.any(String),
      modelId: null,
    });
    f.grant(request, {
      modelId: "remote:1f3a9c/gpt-oss-120b",
      endpoint: endpoint({
        kind: "remote",
        baseUrl: "https://user:secret@models.example.com/v1?token=x",
        model: "gpt-oss-120b",
        apiKey: "sk-test",
      }),
    });
    const connection = await connecting;

    // The engine reads the session's model from the client; requests carry the server's name.
    expect(connection.client.endpoint.model).toBe("remote:1f3a9c/gpt-oss-120b");
    expect(await drain(connection.client, ask("hi"))).toBe("Done.");
    expect(f.sent[0]?.endpoint).toMatchObject({ model: "gpt-oss-120b", apiKey: "sk-test" });

    expect(f.provider.describe("remote:1f3a9c/gpt-oss-120b")).toEqual({
      kind: "remote",
      url: "https://models.example.com/v1",
    });
    expect(f.provider.serverName("remote:1f3a9c/gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(f.logs.join("\n")).not.toContain("sk-test");

    // A model with a current grant needs no round trip; the default is always asked for, since
    // the person may have chosen another one.
    await f.provider.connect("remote:1f3a9c/gpt-oss-120b");
    expect(f.requests).toHaveLength(1);
    const again = f.provider.connect(null);
    f.grant(await f.nextRequest(), { modelId: "qwen3.8-27b-q8", generation: 1 });
    expect((await again).client.endpoint.model).toBe("qwen3.8-27b-q8");
  });

  it("gives a server's model no slot pool", async () => {
    const f = fixture();
    const connection = await connectWith(f, "ollama/qwen3:32b", {
      modelId: "ollama/qwen3:32b",
      endpoint: endpoint({ kind: "ollama", model: "qwen3:32b" }),
    });
    expect(connection.pool).toBeUndefined();
    expect(connection.utility).toBeUndefined();
  });

  it("hands every session on the bundled runtime the same two pools", async () => {
    const f = fixture();
    const first = await connectWith(f, null, { modelId: "qwen3.8-27b-q8", slots: BUNDLED_SLOTS });
    const second = await f.provider.connect("qwen3.8-27b-q8");
    const other = await connectWith(f, "gpt-oss-20b-q4", {
      modelId: "gpt-oss-20b-q4",
      slots: BUNDLED_SLOTS,
      generation: 2,
    });
    expect(first.pool).toEqual({ slots: [0] });
    expect(first.utility?.pool).toEqual({ slots: [1] });
    for (const connection of [second, other]) {
      expect(connection.pool).toBe(first.pool);
      expect(connection.utility?.pool).toBe(first.utility?.pool);
      expect(connection.utility?.client).toBe(connection.client);
    }
    expect(second.client).toBe(first.client);
  });

  it("fails connect with main's words when main refuses", async () => {
    const f = fixture();
    const connecting = f.provider.connect(null);
    f.refuse(
      await f.nextRequest(),
      "No model is installed yet. Download one in Settings → Models.",
    );
    const error = await connecting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({
      code: "InvalidState",
      message: "No model is installed yet. Download one in Settings → Models.",
    });
    // Nothing is remembered from a refusal: the next attempt asks again.
    const again = f.provider.connect(null);
    f.grant(await f.nextRequest(), { modelId: "qwen3.8-27b-q8" });
    await expect(again).resolves.toBeDefined();
  });

  it("waits through a long load and gives up only after the limit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const loading = f.provider.connect("qwen3.8-27b-q8");
    const request = await f.nextRequest();
    let settled = false;
    void loading.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_GRANT_TIMEOUT_MS - 60_000);
    expect(settled).toBe(false);
    f.grant(request, { modelId: "qwen3.8-27b-q8", slots: BUNDLED_SLOTS });
    await expect(loading).resolves.toMatchObject({ pool: { slots: [0] } });

    const stuck = f.provider.connect("gpt-oss-20b-q4");
    const stuckRequest = await f.nextRequest();
    const outcome = stuck.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(DEFAULT_GRANT_TIMEOUT_MS);
    expect(await outcome).toMatchObject({
      code: "InvalidState",
      message: expect.stringContaining("within 15 minutes"),
    });
    // A late answer is still kept: the next connect needs no round trip.
    f.grant(stuckRequest, { modelId: "gpt-oss-20b-q4" });
    await f.provider.connect("gpt-oss-20b-q4");
    expect(f.requests).toHaveLength(2);
  });

  it("asks again after models-changed, by the model's id, and follows the runtime", async () => {
    const f = fixture();
    const connection = await connectWith(f, null, {
      modelId: "qwen3.8-27b-q8",
      slots: BUNDLED_SLOTS,
    });
    await drain(connection.client, ask("one"));
    expect(f.requests).toHaveLength(1);

    f.provider.receive({ type: "models-changed" });
    const streaming = drain(connection.client, ask("two"));
    const request = await f.nextRequest();
    expect(request.modelId).toBe("qwen3.8-27b-q8");
    f.grant(request, {
      modelId: "qwen3.8-27b-q8",
      endpoint: endpoint({ baseUrl: "http://127.0.0.1:41002/v1", contextWindow: 65_536 }),
      slots: BUNDLED_SLOTS,
      generation: 2,
    });
    await streaming;
    expect(f.sent.map((s) => s.endpoint.baseUrl)).toEqual([
      "http://127.0.0.1:41001/v1",
      "http://127.0.0.1:41002/v1",
    ]);
    expect(connection.client.endpoint.contextWindow).toBe(65_536);
  });

  it("asks again when another grant shows its generation is out of date", async () => {
    const f = fixture();
    const first = await connectWith(f, "qwen3.8-27b-q8", {
      modelId: "qwen3.8-27b-q8",
      generation: 4,
    });
    // Loading another model into the runtime moves the generation on.
    await connectWith(f, "gpt-oss-20b-q4", { modelId: "gpt-oss-20b-q4", generation: 5 });
    const streaming = drain(first.client, ask("again"));
    const request = await f.nextRequest();
    expect(request.modelId).toBe("qwen3.8-27b-q8");
    f.grant(request, { modelId: "qwen3.8-27b-q8", generation: 6 });
    await streaming;
    // Current again: the next request goes straight out.
    await drain(first.client, ask("and again"));
    expect(f.requests).toHaveLength(3);
  });

  it("asks again after a request could not reach the server", async () => {
    const f = fixture();
    const connection = await connectWith(f, null, { modelId: "qwen3.8-27b-q8" });
    f.failNextStream(new ModelError("connection", "cannot reach the server", { retryable: true }));
    await expect(drain(connection.client, ask("one"))).rejects.toMatchObject({
      kind: "connection",
    });
    const retry = drain(connection.client, ask("two"));
    f.grant(await f.nextRequest(), { modelId: "qwen3.8-27b-q8", generation: 2 });
    await expect(retry).resolves.toBe("Done.");
  });

  it("turns a refusal during a turn into a model error carrying main's words", async () => {
    const f = fixture();
    const connection = await connectWith(f, null, { modelId: "qwen3.8-27b-q8" });
    f.provider.receive({ type: "models-changed" });
    const streaming = drain(connection.client, ask("hi")).catch((caught: unknown) => caught);
    f.refuse(await f.nextRequest(), "The runtime is restarting.", true);
    const error = await streaming;
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      kind: "unavailable",
      message: "The runtime is restarting.",
      retryable: true,
    });
    // The person sees main's sentence itself.
    expect(errorInfoFrom(error)).toEqual({
      kind: "model_unavailable",
      message: "The runtime is restarting.",
      detail: null,
      retryable: true,
    });
  });

  it("stops waiting for main when the request is interrupted", async () => {
    const f = fixture();
    const connection = await connectWith(f, null, { modelId: "qwen3.8-27b-q8" });
    f.provider.receive({ type: "models-changed" });
    const controller = new AbortController();
    const streaming = drain(connection.client, { ...ask("hi"), signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    await f.nextRequest();
    controller.abort();
    expect(await streaming).toMatchObject({ kind: "aborted" });
  });

  it("counts tokens only with a current grant", async () => {
    const f = fixture();
    const connection = await connectWith(f, null, { modelId: "qwen3.8-27b-q8" });
    expect(await connection.client.countTokens({ messages: [], tools: [] })).toBe(7);
    f.provider.receive({ type: "models-changed" });
    expect(await connection.client.countTokens({ messages: [], tools: [] })).toBeNull();
    expect(f.requests).toHaveLength(1);
  });

  it("ends every wait when closed", async () => {
    const f = fixture();
    const connecting = f.provider.connect(null);
    await f.nextRequest();
    f.provider.close();
    await expect(connecting).rejects.toMatchObject({ message: "The engine is stopping." });
    await expect(f.provider.connect(null)).rejects.toBeInstanceOf(RuntimeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the engine: two sessions on the bundled runtime take turns on its slot
// ---------------------------------------------------------------------------------------------

describe("the model provider in the engine", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dawg-provider-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("queues a second session's request behind the first on the shared pool", async () => {
    const f = fixture();
    // Main answers every request at once with the bundled runtime's grant.
    const answer = async () => {
      for (;;) {
        const request = await f.nextRequest();
        f.grant(request, { modelId: "qwen3.8-27b-q8", slots: BUNDLED_SLOTS });
      }
    };
    void answer();
    const engine = createEngine({
      storeRoot: path.join(root, "store"),
      homeDir: root,
      models: f.provider,
      generateTitles: false,
      environment: async () => ({
        cwd: root,
        additionalDirectories: [],
        platform: "darwin",
        osVersion: "test",
        shell: "zsh",
        date: "2026-11-24",
        git: null,
      }),
    });
    try {
      const a = await engine.createSession({ cwd: root });
      const b = await engine.createSession({ cwd: root });
      expect(a.summary().model).toBe("qwen3.8-27b-q8");
      expect(a.modelInfo().id).toBe("qwen3.8-27b-q8");

      const held = f.hold();
      await a.prompt({ content: [{ type: "text", text: "first" }] });
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      await b.prompt({ content: [{ type: "text", text: "second" }] });
      await vi.waitFor(() => expect(b.summary().queuePosition).toBe(1));
      expect(b.summary().status).toBe("working");
      // Both use the conversation slot, one after the other.
      held.release();
      const [ra, rb] = await Promise.all([a.waitForIdle(), b.waitForIdle()]);
      expect(ra?.finalText).toBe("Done.");
      expect(rb?.finalText).toBe("Done.");
      expect(f.sent.map((s) => s.request.slot)).toEqual([0, 0]);
      // One request per new session (for the default model); the turns needed none.
      expect(f.requests).toHaveLength(2);
    } finally {
      await engine.close();
      f.provider.close();
    }
  });

  it("ends a turn in main's words when main refuses the model", async () => {
    const f = fixture();
    const engine = createEngine({
      storeRoot: path.join(root, "store"),
      homeDir: root,
      models: f.provider,
      generateTitles: false,
      limits: { retryDelayMs: 0 },
      environment: async () => ({
        cwd: root,
        additionalDirectories: [],
        platform: "darwin",
        osVersion: "test",
        shell: "zsh",
        date: "2026-11-24",
        git: null,
      }),
    });
    try {
      const creating = engine.createSession({ cwd: root });
      f.grant(await f.nextRequest(), { modelId: "qwen3.8-27b-q8", slots: BUNDLED_SLOTS });
      const session = await creating;
      // The model is removed while the session is open.
      f.provider.receive({ type: "models-changed" });
      const running = session.run({ content: [{ type: "text", text: "hi" }] });
      f.refuse(
        await f.nextRequest(),
        "No model is installed yet. Download one in Settings → Models.",
      );
      const outcome = await running;
      expect(outcome.stopReason).toBe("error");
      expect(outcome.error).toEqual({
        kind: "model_unavailable",
        message: "No model is installed yet. Download one in Settings → Models.",
        detail: null,
        retryable: false,
      });
      expect(f.sent).toHaveLength(0);
    } finally {
      await engine.close();
      f.provider.close();
    }
  });
});
