import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createClient, createMessagePortTransport, RpcError, type Transport } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type HostedEngine, parseSpeed } from "./engine.ts";
import { type ParentPortLike, startEngineHost } from "./host.ts";

type Listener = (event: { data: unknown; ports: MessagePort[] }) => void;

function fakeParent() {
  let listener: Listener | null = null;
  const parent: ParentPortLike<MessagePort> = {
    on: (_event, next) => {
      listener = next;
    },
  };
  const post = (data: unknown, ports: MessagePort[]) => listener?.({ data, ports });
  return { parent, post };
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

  it("answers initialize with the reason when the engine cannot start", async () => {
    const { parent, post } = fakeParent();
    const logs: string[] = [];
    const result = startEngineHost<MessagePort>(
      parent,
      () => {
        throw new Error("The mock engine is not built yet");
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
    expect((error as RpcError).message).toContain("The mock engine is not built yet");
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
