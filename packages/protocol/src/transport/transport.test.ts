import { PassThrough } from "node:stream";
import { MessageChannel } from "node:worker_threads";
import { describe, expect, test } from "vitest";
import { makeNotification, makeRequest } from "../jsonrpc.ts";
import { createMemoryTransportPair } from "./memory.ts";
import { createMessagePortTransport, type MessagePortLike } from "./message-port.ts";
import { createNdjsonTransport, type NdjsonTransportOptions } from "./ndjson.ts";
import { type Transport, TransportClosedError, type TransportError } from "./types.ts";

function collect(transport: Transport) {
  const messages: unknown[] = [];
  const errors: TransportError[] = [];
  const closes: (Error | null)[] = [];
  transport.onMessage((message) => messages.push(message));
  transport.onError((error) => errors.push(error));
  transport.onClose((error) => closes.push(error));
  return { messages, errors, closes };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ndjson transport", () => {
  function setup(maxLineLength?: number) {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createNdjsonTransport({ input, output, maxLineLength });
    const seen = collect(transport);
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    return { input, output, transport, written, ...seen };
  }

  test("writes one line per message", async () => {
    const { transport, written } = setup();
    transport.send(makeRequest(1, "session.list", {}));
    transport.send(makeNotification("message.delta", { text: "a\nb" }));
    await tick();
    const lines = written.join("").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      jsonrpc: "2.0",
      method: "message.delta",
      params: { text: "a\nb" },
    });
  });

  test("joins lines split across chunks, including inside a multi-byte character", async () => {
    const { input, messages } = setup();
    const bytes = Buffer.from(`${JSON.stringify({ text: "héllo ✓" })}\n`, "utf8");
    const split = bytes.indexOf(0xe2) + 1; // inside the three bytes of the check mark
    input.write(bytes.subarray(0, 3));
    input.write(bytes.subarray(3, split));
    input.write(bytes.subarray(split));
    await tick();
    expect(messages).toEqual([{ text: "héllo ✓" }]);
  });

  test("handles several messages in one chunk, CRLF and blank lines", async () => {
    const { input, messages } = setup();
    input.write('{"a":1}\n\n{"b":2}\r\n   \n{"c":3}\n');
    await tick();
    expect(messages).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("reports invalid JSON and keeps going", async () => {
    const { input, messages, errors, transport } = setup();
    input.write('{"a":1}\nnot json\n{"b":2}\n');
    await tick();
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors.map((error) => error.kind)).toEqual(["parse"]);
    expect(transport.closed).toBe(false);
  });

  test("drops oversized lines, in one chunk or many, and keeps going", async () => {
    const { input, messages, errors } = setup(20);
    input.write(`{"big":"${"x".repeat(40)}"}\n{"ok":1}\n`);
    input.write(`{"big":"${"y".repeat(10)}`);
    input.write("y".repeat(10));
    input.write("y".repeat(10));
    input.write('"}\n{"ok":2}\n');
    await tick();
    expect(messages).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(errors.map((error) => error.kind)).toEqual(["oversized", "oversized"]);
  });

  test("delivers a final line without a newline at end of input, then closes", async () => {
    const { input, messages, closes, transport } = setup();
    input.end('{"last":true}');
    await tick();
    expect(messages).toEqual([{ last: true }]);
    expect(closes).toEqual([null]);
    expect(transport.closed).toBe(true);
    expect(() => transport.send(makeNotification("x"))).toThrow(TransportClosedError);
  });

  test("closing ends the output and fires onClose once", async () => {
    const { transport, output, closes } = setup();
    let ended = false;
    output.on("end", () => {
      ended = true;
    });
    output.resume();
    transport.close();
    transport.close();
    await tick();
    expect(ended).toBe(true);
    expect(closes).toEqual([null]);
  });

  test("an input error closes the transport with that error", async () => {
    const { input, closes, errors } = setup();
    input.destroy(new Error("boom"));
    await tick();
    expect(errors.map((error) => error.kind)).toContain("io");
    expect(closes).toHaveLength(1);
    expect(closes[0]?.message).toContain("boom");
  });

  test("Node's stdio streams fit the structural stream types", () => {
    // A compile-time check: no transport is created, so stdin is left alone.
    const options: NdjsonTransportOptions = { input: process.stdin, output: process.stdout };
    expect(options.input).toBe(process.stdin);
  });

  test("holds messages that arrive before anyone listens", async () => {
    const input = new PassThrough();
    const transport = createNdjsonTransport({ input, output: new PassThrough() });
    input.write('{"early":1}\n');
    await tick();
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));
    expect(messages).toEqual([{ early: 1 }]);
    transport.close();
  });
});

describe("memory transport pair", () => {
  test("round-trips messages both ways, asynchronously", async () => {
    const [a, b] = createMemoryTransportPair();
    const seenA = collect(a);
    const seenB = collect(b);
    a.send(makeRequest(1, "session.list", {}));
    b.send(makeNotification("message.delta", { text: "x" }));
    expect(seenB.messages).toEqual([]);
    await tick();
    expect(seenB.messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "session.list", params: {} }]);
    expect(seenA.messages).toEqual([
      { jsonrpc: "2.0", method: "message.delta", params: { text: "x" } },
    ]);
  });

  test("makes payloads JSON-plain, like a real wire", async () => {
    const [a, b] = createMemoryTransportPair();
    const seen = collect(b);
    a.send(makeNotification("x", { when: new Date(0), gone: undefined }));
    await tick();
    expect(seen.messages).toEqual([
      { jsonrpc: "2.0", method: "x", params: { when: "1970-01-01T00:00:00.000Z" } },
    ]);
  });

  test("closing one end closes the other after in-flight messages", async () => {
    const [a, b] = createMemoryTransportPair();
    const seen = collect(b);
    a.send(makeNotification("last"));
    a.close();
    expect(a.closed).toBe(true);
    await tick();
    expect(seen.messages).toHaveLength(1);
    expect(seen.closes).toEqual([null]);
    expect(b.closed).toBe(true);
  });
});

describe("message port transport", () => {
  test("round-trips over a real MessageChannel and closes both ends", async () => {
    const channel = new MessageChannel();
    const a = createMessagePortTransport(channel.port1);
    const b = createMessagePortTransport(channel.port2);
    const seenA = collect(a);
    const seenB = collect(b);
    a.send(makeRequest(1, "session.list", {}));
    b.send(makeNotification("message.delta", { text: "y" }));
    await waitFor(() => seenA.messages.length > 0 && seenB.messages.length > 0);
    expect(seenB.messages).toEqual([{ jsonrpc: "2.0", id: 1, method: "session.list", params: {} }]);
    expect(seenA.messages).toEqual([
      { jsonrpc: "2.0", method: "message.delta", params: { text: "y" } },
    ]);
    a.close();
    await waitFor(() => seenB.closes.length > 0);
    expect(seenA.closes).toEqual([null]);
    expect(seenB.closes).toEqual([null]);
  });

  test("works with an Electron-style port that only has on/off, and parses string data", () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const posted: unknown[] = [];
    let started = false;
    let closed = false;
    const port: MessagePortLike = {
      postMessage: (message) => posted.push(message),
      start: () => {
        started = true;
      },
      close: () => {
        closed = true;
      },
      on: (type, listener) => listeners.set(type, listener),
      off: (type) => listeners.delete(type),
    };
    const transport = createMessagePortTransport(port);
    const seen = collect(transport);
    expect(started).toBe(true);

    listeners.get("message")?.({ data: { jsonrpc: "2.0", method: "a" } });
    listeners.get("message")?.({ data: '{"jsonrpc":"2.0","method":"b"}' });
    listeners.get("message")?.({ data: "{oops" });
    expect(seen.messages).toEqual([
      { jsonrpc: "2.0", method: "a" },
      { jsonrpc: "2.0", method: "b" },
    ]);
    expect(seen.errors.map((error) => error.kind)).toEqual(["parse"]);

    transport.send(makeNotification("c"));
    expect(posted).toEqual([{ jsonrpc: "2.0", method: "c" }]);

    listeners.get("close")?.({});
    expect(seen.closes).toEqual([null]);
    expect(listeners.size).toBe(0);
    expect(closed).toBe(false);
    expect(() => transport.send(makeNotification("d"))).toThrow(TransportClosedError);
  });
});
