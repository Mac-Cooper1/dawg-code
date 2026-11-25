import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getModelProfile, type ModelClient, type ModelReply } from "@dawg/engine";
import { type Client, createClient, createMemoryTransportPair, RpcError } from "@dawg/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostToMain } from "../shared/engine-host-messages.ts";
import { bundledRipgrepPath, createRealEngine, type RealHostedEngine } from "./real-engine.ts";

type Request = Extract<HostToMain, { type: "model-request" }>;

const ENDPOINT = {
  kind: "remote" as const,
  baseUrl: "http://127.0.0.1:9/v1",
  model: "served-name",
  contextWindow: 131_072,
  capabilities: { tools: true, vision: false, reasoning: false, cacheControl: false },
};

function reply(text: string): ModelReply {
  return {
    content: text,
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: {
      promptTokens: 10,
      completionTokens: 1,
      cachedTokens: null,
      promptTokensPerSecond: null,
      completionTokensPerSecond: null,
      promptMs: null,
      completionMs: null,
    },
    model: null,
  };
}

let root: string;
let project: string;
let hosted: RealHostedEngine | null = null;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-real-engine-"));
  project = path.join(root, "project");
  await mkdir(project);
});

afterEach(async () => {
  await hosted?.dispose();
  hosted = null;
  await rm(root, { recursive: true, force: true });
});

function start(): { requests: Request[]; next(): Promise<Request> } {
  const requests: Request[] = [];
  let waiter: ((request: Request) => void) | null = null;
  hosted = createRealEngine({
    dataRoot: path.join(root, "data"),
    homeDir: root,
    ripgrepPath: null,
    send: (message) => {
      requests.push(message);
      waiter?.(message);
    },
    log: () => {},
  });
  let seen = 0;
  return {
    requests,
    next: () => {
      const ready = requests[seen];
      if (ready !== undefined) {
        seen += 1;
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => {
        waiter = (request) => {
          waiter = null;
          seen += 1;
          resolve(request);
        };
      });
    },
  };
}

async function client(): Promise<Client> {
  const [clientEnd, engineEnd] = createMemoryTransportPair();
  hosted?.connect(engineEnd);
  const connected = createClient(clientEnd);
  await connected.initialize({ client: { name: "test", version: "0" }, capabilities: {} });
  return connected;
}

describe("the real engine in the engine host", () => {
  it("refuses a new session in main's words, then opens one on the model main grants", async () => {
    const main = start();
    const c = await client();

    const refused = c.request("session.create", { cwd: project }).catch((e: unknown) => e);
    const first = await main.next();
    expect(first).toMatchObject({ type: "model-request", modelId: null });
    hosted?.receive({
      type: "model-refused",
      requestId: first.requestId,
      message: "No model is installed yet. Download one in Settings → Models.",
      retryable: false,
    });
    const error = await refused;
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toBe(
      "No model is installed yet. Download one in Settings → Models.",
    );

    const creating = c.request("session.create", { cwd: project });
    const second = await main.next();
    hosted?.receive({
      type: "model-grant",
      requestId: second.requestId,
      grant: {
        modelId: "remote:1f3a9c/served-name",
        endpoint: {
          kind: "remote",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "served-name",
          contextWindow: 16_384,
          capabilities: { tools: true, vision: false, reasoning: false, cacheControl: false },
        },
        generation: 1,
      },
    });
    const snapshot = await creating;
    expect(snapshot.session.model).toBe("remote:1f3a9c/served-name");
    expect(snapshot.modelInfo).toMatchObject({
      id: "remote:1f3a9c/served-name",
      contextWindow: 16_384,
    });
    expect(hosted?.models.describe("remote:1f3a9c/served-name")).toEqual({
      kind: "remote",
      url: "http://127.0.0.1:9/v1",
    });
    await c.close();
  });

  it("picks each session's profile from the grant, else from the model's family", async () => {
    const requests: { model: string; sampling: unknown }[] = [];
    const main: Request[] = [];
    hosted = createRealEngine({
      dataRoot: path.join(root, "data"),
      homeDir: root,
      ripgrepPath: null,
      send: (message) => main.push(message),
      log: () => {},
      createClient: (endpoint): ModelClient => ({
        endpoint,
        async *stream(request) {
          requests.push({ model: endpoint.model, sampling: request.sampling });
          yield { type: "finished", reply: reply("Done.") };
        },
        countTokens: async () => null,
      }),
    });
    const engine = hosted.engine;
    const grants: Record<string, { name: string; profile?: string }> = {
      "file:9f2c": { name: "my-model", profile: "gpt-oss" },
      "remote:1f3a9c/qwen3.8-27b": { name: "qwen3.8-27b" },
      "file:7a1b": { name: "Qwen3.6-35B-A3B-Q4", profile: "not-a-profile" },
    };
    for (const [modelId, { name, profile }] of Object.entries(grants)) {
      const creating = engine.createSession({ cwd: project, model: modelId });
      await vi.waitFor(() => expect(main.at(-1)?.modelId).toBe(modelId));
      hosted.receive({
        type: "model-grant",
        requestId: (main.at(-1) as Request).requestId,
        grant: {
          modelId,
          endpoint: { ...ENDPOINT, model: name },
          generation: 1,
          ...(profile === undefined ? {} : { profile }),
        },
      });
      const session = await creating;
      await session.run({ content: [{ type: "text", text: "hi" }] });
      await session.close();
    }
    const conversation = (name: string) => requests.find((r) => r.model === name)?.sampling;
    expect(conversation("my-model")).toEqual(getModelProfile("gpt-oss").sampling);
    expect(conversation("qwen3.8-27b")).toEqual(getModelProfile("qwen3.8").sampling);
    expect(conversation("Qwen3.6-35B-A3B-Q4")).toEqual(getModelProfile("qwen3.6").sampling);
  });

  it("fails to start, with the reason, when the data root cannot be made", async () => {
    const blocker = path.join(root, "a-file");
    await writeFile(blocker, "");
    expect(() =>
      createRealEngine({
        dataRoot: path.join(blocker, "data"),
        homeDir: root,
        ripgrepPath: null,
        send: () => {},
        log: () => {},
      }),
    ).toThrow(/The data folder .* cannot be created/);
  });

  it("finds the bundled ripgrep under the resources folder", () => {
    expect(bundledRipgrepPath("/Applications/dawg.app/Contents/Resources")).toBe(
      `/Applications/dawg.app/Contents/Resources/bin/${process.platform}-${process.arch}/rg`,
    );
  });
});
