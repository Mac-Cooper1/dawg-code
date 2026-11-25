import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createClient, createMessagePortTransport, RpcError, type Transport } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type HostedEngine, parseEngineKind, parseSpeed } from "./engine.ts";
import { type ParentPortLike, startEngineHost } from "./host.ts";
import type { ModelMessage } from "./model-provider.ts";

type Listener = (event: { data: unknown; ports: MessagePort[] }) => void;

function fakeParent() {
  let listener: Listener | null = null;
  const toMain: unknown[] = [];
  const parent: ParentPortLike<MessagePort> = {
    on: (_event, next) => {
      listener = next;
    },
    postMessage: (message) => toMain.push(message),
  };
  const post = (data: unknown, ports: MessagePort[]) => listener?.({ data, ports });
  return { parent, post, toMain };
}

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

function channel() {
  const pair = new MessageChannel();
  opened.push(pair.port1, pair.port2);
  return pair;
}

describe("engine host", () => {
  it("serves each connect message's port with the engine", () => {
    const { parent, post } = fakeParent();
    const served: Transport[] = [];
    const engine: HostedEngine = {
      kind: "mock",
      connect: (t) => served.push(t),
      dispose: () => {},
    };
    const logs: string[] = [];
    startEngineHost(
      parent,
      () => engine,
      (line) => logs.push(line),
    );
    post({ type: "connect" }, [channel().port1]);
    post({ type: "other" }, [channel().port1]);
    post({ type: "connect" }, []);
    expect(served).toHaveLength(1);
    expect(logs).toEqual([
      "Serving the mock engine.",
      expect.stringContaining("unknown message"),
      "A connect message arrived without a port.",
    ]);
  });

  it("passes main's model messages to the engine and posts its requests to main", () => {
    const { parent, post, toMain } = fakeParent();
    const received: ModelMessage[] = [];
    const logs: string[] = [];
    startEngineHost(
      parent,
      (send) => {
        send({ type: "model-request", requestId: "model-1", modelId: null });
        return {
          kind: "real",
          connect: () => {},
          receive: (message) => received.push(message),
          dispose: () => {},
        };
      },
      (line) => logs.push(line),
    );
    expect(toMain).toEqual([{ type: "model-request", requestId: "model-1", modelId: null }]);
    post({ type: "models-changed" }, []);
    post(
      { type: "model-refused", requestId: "model-1", message: "No model.", retryable: false },
      [],
    );
    // A grant that does not parse is dropped, and its contents (a key, say) stay out of the log.
    post({ type: "model-grant", requestId: "model-2", grant: { apiKey: "sk-secret" } }, []);
    expect(received).toEqual([
      { type: "models-changed" },
      { type: "model-refused", requestId: "model-1", message: "No model.", retryable: false },
    ]);
    expect(logs.at(-1)).toBe('Ignoring an unknown message from main: type "model-grant"');
    expect(logs.join("\n")).not.toContain("sk-secret");
  });

  it("answers initialize with the reason when the engine cannot start", async () => {
    const { parent, post } = fakeParent();
    const logs: string[] = [];
    const result = startEngineHost<MessagePort>(
      parent,
      () => {
        throw new Error("The data folder /nowhere cannot be created (EACCES)");
      },
      (line) => logs.push(line),
    );
    expect(result.engine).toBeNull();
    expect(logs[0]).toContain("could not start");

    const { port1, port2 } = channel();
    post({ type: "connect" }, [port1]);
    const client = createClient(createMessagePortTransport(port2));
    const error = await client
      .initialize({ client: { name: "test", version: "0" }, capabilities: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).message).toContain("The data folder /nowhere cannot be created");
  });
});

describe("parseSpeed", () => {
  it("accepts positive numbers and Infinity, else falls back to 1", () => {
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    expect(parseSpeed(undefined, log)).toBe(1);
    expect(parseSpeed("4", log)).toBe(4);
    expect(parseSpeed("Infinity", log)).toBe(Number.POSITIVE_INFINITY);
    expect(parseSpeed("0", log)).toBe(1);
    expect(parseSpeed("fast", log)).toBe(1);
    expect(logs).toHaveLength(2);
  });
});

describe("parseEngineKind", () => {
  it("runs the real engine unless DAWG_ENGINE is mock", () => {
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    expect(parseEngineKind(undefined, log)).toBe("real");
    expect(parseEngineKind("", log)).toBe("real");
    expect(parseEngineKind("real", log)).toBe("real");
    expect(parseEngineKind("mock", log)).toBe("mock");
    expect(parseEngineKind("fake", log)).toBe("real");
    expect(logs).toEqual([expect.stringContaining('Ignoring DAWG_ENGINE="fake"')]);
  });
});
