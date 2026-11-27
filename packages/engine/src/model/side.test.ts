import type { Endpoint } from "@dawg/models";
import { describe, expect, it } from "vitest";
import {
  type ModelClient,
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
} from "../contracts/model.ts";
import { sideClient } from "./side.ts";
import { SlotScheduler } from "./slots.ts";

function endpoint(model: string, contextWindow: number): Endpoint {
  return {
    kind: "bundled",
    baseUrl: `http://127.0.0.1/${model}/v1`,
    model,
    contextWindow,
    capabilities: { tools: false, vision: false, reasoning: true, cacheControl: true },
  };
}

const finished = (content: string): ModelStreamEvent => ({
  type: "finished",
  reply: {
    content,
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      cachedTokens: 0,
      promptTokensPerSecond: null,
      completionTokensPerSecond: null,
      promptMs: null,
      completionMs: null,
    },
    model: null,
  },
});

/** A client that records requests and plays a script of events, or fails as told. */
function fakeClient(
  name: string,
  behaviour: {
    events?: ModelStreamEvent[];
    failBefore?: ModelError;
    failAfter?: ModelError;
    hang?: boolean;
  } = {},
) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    endpoint: endpoint(name, name === "helper" ? 8_000 : 65_536),
    async *stream(request) {
      requests.push(request);
      if (behaviour.failBefore) throw behaviour.failBefore;
      if (behaviour.hang) {
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () =>
            reject(new ModelError("aborted", "stopped")),
          );
        });
      }
      for (const event of behaviour.events ?? [finished(`${name} answered`)]) yield event;
      if (behaviour.failAfter) throw behaviour.failAfter;
    },
    countTokens: async () => 7,
  };
  return { client, requests };
}

async function answer(client: ModelClient, request: Partial<ModelRequest> = {}): Promise<string> {
  let text = "";
  for await (const event of client.stream({ messages: [], tools: [], ...request })) {
    if (event.type === "finished") text = event.reply.content;
  }
  return text;
}

describe("sideClient", () => {
  it("sends side requests to the helper on its own slot, sized by its endpoint", async () => {
    const helper = fakeClient("helper");
    const main = fakeClient("main");
    const client = sideClient({
      routes: async () => ({
        helper: { client: helper.client, scheduler: new SlotScheduler([0]) },
        main: { client: main.client, scheduler: new SlotScheduler([1]) },
      }),
      endpoint: () => helper.client.endpoint,
    });
    expect(client.endpoint.contextWindow).toBe(8_000);
    expect(await answer(client, { slot: 5 })).toBe("helper answered");
    expect(helper.requests[0]?.slot).toBe(0);
    expect(main.requests).toEqual([]);
    expect(await client.countTokens({ messages: [], tools: [] })).toBeNull();
  });

  it("without a helper, uses the main model's side slot as before", async () => {
    const main = fakeClient("main");
    const client = sideClient({
      routes: async () => ({
        helper: null,
        main: { client: main.client, scheduler: new SlotScheduler([1]) },
      }),
      endpoint: () => main.client.endpoint,
    });
    expect(await answer(client)).toBe("main answered");
    expect(main.requests[0]?.slot).toBe(1);
    // A server: no scheduler, no slot.
    const server = fakeClient("server");
    const plain = sideClient({
      routes: async () => ({ helper: null, main: { client: server.client } }),
      endpoint: () => server.client.endpoint,
    });
    expect(await answer(plain, { slot: 3 })).toBe("server answered");
    expect(server.requests[0]?.slot).toBeUndefined();
  });

  it("falls back to the main model when the helper cannot be reached, and says why", async () => {
    const helper = fakeClient("helper", {
      failBefore: new ModelError("connection", "connect ECONNREFUSED 127.0.0.1:9123"),
    });
    const main = fakeClient("main");
    const problems: string[] = [];
    const client = sideClient({
      routes: async () => ({ helper: { client: helper.client }, main: { client: main.client } }),
      endpoint: () => helper.client.endpoint,
      onFallback: (problem) => problems.push(problem),
    });
    expect(await answer(client)).toBe("main answered");
    expect(problems).toEqual(["connect ECONNREFUSED 127.0.0.1:9123"]);
  });

  it("does not wait for ever on a helper that never answers", async () => {
    const helper = fakeClient("helper", { hang: true });
    const main = fakeClient("main");
    const problems: string[] = [];
    const client = sideClient({
      routes: async () => ({ helper: { client: helper.client }, main: { client: main.client } }),
      endpoint: () => helper.client.endpoint,
      onFallback: (problem) => problems.push(problem),
      firstEventTimeoutMs: 30,
    });
    expect(await answer(client)).toBe("main answered");
    expect(problems).toEqual(["no answer within 0 s"]);
  });

  it("keeps a helper that reports progress, and does not move a request it began answering", async () => {
    const progress: ModelStreamEvent = {
      type: "prompt_progress",
      processed: 1,
      total: 2,
      cached: 0,
    };
    const slow = fakeClient("helper", { events: [progress, finished("helper answered")] });
    const main = fakeClient("main");
    const ok = sideClient({
      routes: async () => ({ helper: { client: slow.client }, main: { client: main.client } }),
      endpoint: () => slow.client.endpoint,
      firstEventTimeoutMs: 1_000,
    });
    expect(await answer(ok)).toBe("helper answered");

    const broken = fakeClient("helper", {
      events: [{ type: "text_delta", text: "Half" }],
      failAfter: new ModelError("stream_interrupted", "the stream broke"),
    });
    const client = sideClient({
      routes: async () => ({ helper: { client: broken.client }, main: { client: main.client } }),
      endpoint: () => broken.client.endpoint,
    });
    await expect(answer(client)).rejects.toThrow("the stream broke");
    expect(main.requests).toEqual([]);
  });

  it("an aborted request is not sent to the main model", async () => {
    const helper = fakeClient("helper", { hang: true });
    const main = fakeClient("main");
    const controller = new AbortController();
    const client = sideClient({
      routes: async () => ({ helper: { client: helper.client }, main: { client: main.client } }),
      endpoint: () => helper.client.endpoint,
    });
    const pending = answer(client, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(ModelError);
    expect(main.requests).toEqual([]);
  });
});
