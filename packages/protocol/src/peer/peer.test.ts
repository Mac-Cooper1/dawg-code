import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { eventSamples, methodSamples, snapshot } from "../__fixtures__/samples.ts";
import { PROTOCOL_VERSION } from "../common.ts";
import type { EngineEvent } from "../events.ts";
import { ErrorCodes, makeRequest, RpcError } from "../jsonrpc.ts";
import { createMemoryTransportPair } from "../transport/memory.ts";
import { createNdjsonTransport } from "../transport/ndjson.ts";
import type { Transport } from "../transport/types.ts";
import { type ClientProtocolProblem, createClient } from "./client.ts";
import { createServer, type Handlers, type ServerOptions } from "./server.ts";

const clientInfo = { client: { name: "test", version: "0.0.0" }, capabilities: {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function setup(handlers: Partial<Handlers> = {}, serverOptions: ServerOptions = {}) {
  const [clientEnd, serverEnd] = createMemoryTransportPair();
  const problems: ClientProtocolProblem[] = [];
  const server = createServer(
    serverEnd,
    { initialize: () => methodSamples.initialize.result, ...handlers },
    serverOptions,
  );
  const client = createClient(clientEnd, { onProblem: (problem) => problems.push(problem) });
  cleanups.push(() => client.close());
  return { client, server, clientEnd, serverEnd, problems };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    return error as RpcError;
  }
  throw new Error("Expected the promise to reject");
}

describe("initialize", () => {
  test("negotiates the version and opens the other methods", async () => {
    const { client, server } = setup({
      "session.list": () => ({ sessions: [], nextCursor: null }),
    });
    expect((await rejection(client.request("session.list", {}))).code).toBe(
      ErrorCodes.NotInitialized,
    );
    const result = await client.initialize(clientInfo);
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(server.initialized).toBe(true);
    await expect(client.request("session.list", {})).resolves.toEqual({
      sessions: [],
      nextCursor: null,
    });
    expect((await rejection(client.initialize(clientInfo))).code).toBe(ErrorCodes.InvalidState);
  });

  test("refuses an unsupported version with the supported list", async () => {
    const handler = vi.fn(() => methodSamples.initialize.result);
    const { client, server } = setup({ initialize: handler });
    const error = await rejection(client.initialize({ ...clientInfo, protocolVersion: 99 }));
    expect(error.code).toBe(ErrorCodes.UnsupportedProtocolVersion);
    expect(error.data).toEqual({ requested: 99, supported: [PROTOCOL_VERSION] });
    expect(handler).not.toHaveBeenCalled();
    expect(server.initialized).toBe(false);
  });

  test("the client refuses an engine that answers with another version", async () => {
    const { client } = setup({
      initialize: () => ({ ...methodSamples.initialize.result, protocolVersion: 7 }),
    });
    const error = await rejection(client.initialize(clientInfo));
    expect(error.code).toBe(ErrorCodes.UnsupportedProtocolVersion);
  });
});

describe("requests", () => {
  test("handlers get parsed params with defaults filled and unknown fields stripped", async () => {
    const seen: unknown[] = [];
    const { client } = setup({
      "session.command": (params) => {
        seen.push(params);
        return methodSamples["session.command"].result;
      },
    });
    await client.initialize(clientInfo);
    await client.request("session.command", {
      sessionId: "s1",
      name: "help",
      extra: true,
    } as never);
    expect(seen).toEqual([{ sessionId: "s1", name: "help", args: "" }]);
  });

  test("every method round-trips its sample through client and server", async () => {
    const handlers = Object.fromEntries(
      Object.entries(methodSamples).map(([name, sample]) => [name, () => sample.result]),
    ) as Partial<Handlers>;
    const { client } = setup(handlers);
    await client.initialize(clientInfo);
    for (const [name, sample] of Object.entries(methodSamples)) {
      if (name === "initialize") continue;
      await expect(
        client.request(name as "session.list", sample.params as never),
        name,
      ).resolves.toBeDefined();
    }
  });

  test("unknown and unimplemented methods answer MethodNotFound", async () => {
    const { client, clientEnd } = setup();
    await client.initialize(clientInfo);
    expect((await rejection(client.request("session.list", {}))).code).toBe(
      ErrorCodes.MethodNotFound,
    );
    const answers: unknown[] = [];
    clientEnd.onMessage((message) => answers.push(message));
    clientEnd.send(makeRequest(99, "no.such.method", {}));
    await tick();
    expect(answers).toContainEqual(
      expect.objectContaining({ id: 99, error: expect.objectContaining({ code: -32601 }) }),
    );
  });

  test("invalid params answer InvalidParams with the issues", async () => {
    const handler = vi.fn();
    const [clientEnd, serverEnd] = createMemoryTransportPair();
    createServer(serverEnd, { "session.setMode": handler }, { requireInitialize: false });
    const client = createClient(clientEnd, { validateParams: false });
    cleanups.push(() => client.close());
    const error = await rejection(
      client.request("session.setMode", { sessionId: "s1", mode: "yolo" as never }),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect(error.data).toMatchObject({ issues: [{ path: ["mode"] }] });
    expect(handler).not.toHaveBeenCalled();
  });

  test("the client checks params before sending by default", async () => {
    const handler = vi.fn();
    const { client } = setup({ "session.setMode": handler });
    const error = await rejection(
      client.request("session.setMode", { sessionId: "s1", mode: "yolo" as never }),
    );
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect(handler).not.toHaveBeenCalled();
  });

  test("thrown RpcErrors keep their code; other throws become InternalError", async () => {
    const { client } = setup({
      "session.resume": () => {
        throw new RpcError(ErrorCodes.SessionNotFound, "No session s9", { sessionId: "s9" });
      },
      "session.prompt": async () => {
        throw new Error("disk full");
      },
    });
    await client.initialize(clientInfo);
    const notFound = await rejection(client.request("session.resume", { sessionId: "s9" }));
    expect(notFound).toMatchObject({
      code: -32001,
      message: "No session s9",
      data: { sessionId: "s9" },
    });
    const internal = await rejection(
      client.request("session.prompt", {
        sessionId: "s1",
        prompt: { content: [{ type: "text", text: "x" }] },
      }),
    );
    expect(internal).toMatchObject({ code: ErrorCodes.InternalError, message: "disk full" });
  });

  test("an invalid result is caught by the server in development", async () => {
    const problems: unknown[] = [];
    const { client } = setup(
      { "session.interrupt": () => ({ interrupted: "yes" }) as never },
      { onProblem: (problem) => problems.push(problem) },
    );
    await client.initialize(clientInfo);
    const error = await rejection(client.request("session.interrupt", { sessionId: "s1" }));
    expect(error.code).toBe(ErrorCodes.InternalError);
    expect(problems).toContainEqual(expect.objectContaining({ kind: "invalid_result" }));
  });

  test("with server checks off, the client still rejects an invalid result", async () => {
    const { client } = setup(
      { "session.interrupt": () => ({ interrupted: "yes" }) as never },
      { validateOutgoing: false },
    );
    await client.initialize(clientInfo);
    const error = await rejection(client.request("session.interrupt", { sessionId: "s1" }));
    expect(error.code).toBe(ErrorCodes.InternalError);
    expect(error.message).toContain("Invalid result");
  });

  test("responses that arrive out of order reach the right callers", async () => {
    const { client } = setup({
      "session.setEffort": async (params) => {
        await new Promise((resolve) => setTimeout(resolve, params.effort === "slow" ? 30 : 1));
        return { effort: params.effort };
      },
    });
    await client.initialize(clientInfo);
    const order: string[] = [];
    const slow = client
      .request("session.setEffort", { sessionId: "s1", effort: "slow" })
      .then((r) => {
        order.push(r.effort ?? "");
        return r;
      });
    const fast = client
      .request("session.setEffort", { sessionId: "s1", effort: "fast" })
      .then((r) => {
        order.push(r.effort ?? "");
        return r;
      });
    await expect(slow).resolves.toEqual({ effort: "slow" });
    await expect(fast).resolves.toEqual({ effort: "fast" });
    expect(order).toEqual(["fast", "slow"]);
  });
});

describe("timeouts, cancellation and closing", () => {
  function hangingSetup() {
    let signal: AbortSignal | undefined;
    const ctx = setup({
      "session.list": (_params, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    return { ...ctx, signal: () => signal };
  }

  test("a request times out and the server is told to stop", async () => {
    const { client, signal, problems } = hangingSetup();
    await client.initialize(clientInfo);
    const error = await rejection(client.request("session.list", {}, { timeoutMs: 20 }));
    expect(error.code).toBe(ErrorCodes.RequestTimeout);
    await tick();
    expect(signal()?.aborted).toBe(true);
    expect(client.pendingCount).toBe(0);
    // The server answers the cancel at once, though its handler never finishes; the client
    // notes the late answer and nothing else.
    await tick();
    expect(problems.map((problem) => problem.kind)).toEqual(["unexpected_response"]);
  });

  test("an AbortSignal cancels the request", async () => {
    const { client, signal } = hangingSetup();
    await client.initialize(clientInfo);
    const controller = new AbortController();
    const pending = client.request("session.list", {}, { signal: controller.signal, timeoutMs: 0 });
    await tick();
    controller.abort();
    expect((await rejection(pending)).code).toBe(ErrorCodes.RequestCancelled);
    await tick();
    expect(signal()?.aborted).toBe(true);
    const already = await rejection(
      client.request("session.list", {}, { signal: controller.signal }),
    );
    expect(already.code).toBe(ErrorCodes.RequestCancelled);
  });

  test("a handler that finishes after a cancel sends no second answer", async () => {
    const { client, problems } = setup({
      "session.list": async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { sessions: [], nextCursor: null };
      },
    });
    await client.initialize(clientInfo);
    const controller = new AbortController();
    const pending = client.request("session.list", {}, { signal: controller.signal });
    await tick();
    controller.abort();
    expect((await rejection(pending)).code).toBe(ErrorCodes.RequestCancelled);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(problems.map((problem) => problem.kind)).toEqual(["unexpected_response"]);
  });

  test("closing the transport rejects pending requests and aborts handlers", async () => {
    const { client, serverEnd, signal } = hangingSetup();
    await client.initialize(clientInfo);
    const one = client.request("session.list", {}, { timeoutMs: 0 });
    const two = client.request("session.list", {}, { timeoutMs: 0 });
    await tick();
    serverEnd.close();
    expect((await rejection(one)).code).toBe(ErrorCodes.ConnectionClosed);
    expect((await rejection(two)).code).toBe(ErrorCodes.ConnectionClosed);
    expect(signal()?.aborted).toBe(true);
    expect((await rejection(client.request("session.list", {}))).code).toBe(
      ErrorCodes.ConnectionClosed,
    );
  });

  test("closing the client side rejects at once", async () => {
    const { client } = hangingSetup();
    await client.initialize(clientInfo);
    const pending = client.request("session.list", {}, { timeoutMs: 0 });
    client.close();
    expect((await rejection(pending)).code).toBe(ErrorCodes.ConnectionClosed);
    expect(client.closed).toBe(true);
  });
});

describe("events", () => {
  test("typed subscriptions and the all-events feed see every sample event in order", async () => {
    const { client, server } = setup();
    const all: EngineEvent[] = [];
    const deltas: string[] = [];
    client.onEvent((event) => all.push(event));
    const stop = client.on("message.delta", (payload) => deltas.push(payload.text));
    for (const [name, sample] of Object.entries(eventSamples)) {
      server.notify(name as "error", sample.payload as never);
    }
    await tick();
    expect(all.map((event) => event.event)).toEqual(Object.keys(eventSamples));
    expect(deltas).toEqual(["Hel"]);
    stop();
    server.notify("message.delta", eventSamples["message.delta"].payload);
    await tick();
    expect(deltas).toEqual(["Hel"]);
  });

  test("unknown events are ignored; invalid known events are dropped and reported", async () => {
    const { client, clientEnd, serverEnd, problems } = setup();
    const all: EngineEvent[] = [];
    client.onEvent((event) => all.push(event));
    serverEnd.send({ jsonrpc: "2.0", method: "future.thing", params: { sessionId: "s1" } });
    serverEnd.send({ jsonrpc: "2.0", method: "message.delta", params: { sessionId: "s1" } });
    await tick();
    expect(all).toEqual([]);
    expect(problems.map((problem) => problem.kind)).toEqual(["invalid_event"]);
    expect(clientEnd.closed).toBe(false);
  });

  test("notify checks payloads in development and reports a closed connection", async () => {
    const { server, serverEnd } = setup();
    expect(() => server.notify("message.delta", { text: "x" } as never)).toThrow(RpcError);
    serverEnd.close();
    expect(server.notify("message.delta", eventSamples["message.delta"].payload)).toBe(false);
  });

  test("the server ignores unknown notifications from the client", async () => {
    const { client, clientEnd } = setup({
      "session.list": () => ({ sessions: [], nextCursor: null }),
    });
    await client.initialize(clientInfo);
    clientEnd.send({ jsonrpc: "2.0", method: "client.whatever", params: {} });
    await expect(client.request("session.list", {})).resolves.toBeDefined();
  });
});

describe("garbage on the wire", () => {
  test("the server answers invalid JSON with ParseError and bad envelopes with InvalidRequest", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const serverEnd: Transport = createNdjsonTransport({ input, output });
    createServer(serverEnd, {});
    const lines: unknown[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line) lines.push(JSON.parse(line));
    });
    input.write("this is not json\n");
    input.write('{"jsonrpc":"2.0","id":5}\n');
    input.write('{"jsonrpc":"2.0","id":6,"method":"session.list"}\n');
    await tick();
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: ErrorCodes.ParseError }) },
      {
        jsonrpc: "2.0",
        id: 5,
        error: expect.objectContaining({ code: ErrorCodes.InvalidRequest }),
      },
      {
        jsonrpc: "2.0",
        id: 6,
        error: expect.objectContaining({ code: ErrorCodes.MethodNotFound }),
      },
    ]);
    serverEnd.close();
  });

  test("client and server talk over ndjson streams end to end", async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const server = createServer(createNdjsonTransport({ input: toServer, output: toClient }), {
      initialize: () => methodSamples.initialize.result,
      "session.create": () => snapshot,
    });
    const client = createClient(createNdjsonTransport({ input: toClient, output: toServer }));
    await client.initialize(clientInfo);
    const created = await client.request("session.create", { cwd: "/tmp/project" });
    expect(created.session.id).toBe("s1");
    const statuses: string[] = [];
    client.on("session.status", (payload) => statuses.push(payload.status));
    server.notify("session.status", eventSamples["session.status"].payload);
    await tick();
    expect(statuses).toEqual(["waiting"]);
    client.close();
    await tick();
    expect(server.closed).toBe(true);
  });
});
