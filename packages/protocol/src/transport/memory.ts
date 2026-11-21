import type { JsonRpcMessage } from "../jsonrpc.ts";
import { createTransportCore, type Transport, TransportClosedError } from "./types.ts";

/**
 * Two linked transports for tests and in-process use. Messages are delivered asynchronously and
 * pass through `JSON.stringify` and `JSON.parse`, so a payload that would not survive stdio
 * (an `undefined`, a `Date`, a class instance) behaves here as it would there.
 */
export function createMemoryTransportPair(): [Transport, Transport] {
  const a = createMemoryEnd();
  const b = createMemoryEnd();
  a.peer = b;
  b.peer = a;
  return [a.transport, b.transport];
}

interface MemoryEnd {
  transport: Transport;
  peer: MemoryEnd | null;
  deliver(text: string): void;
  peerClosed(): void;
}

function createMemoryEnd(): MemoryEnd {
  const core = createTransportCore();
  const end: MemoryEnd = {
    peer: null,
    deliver(text) {
      if (core.closed) return;
      core.emitMessage(JSON.parse(text) as unknown);
    },
    peerClosed() {
      core.markClosed(null);
    },
    transport: {
      send(message: JsonRpcMessage) {
        if (core.closed) throw new TransportClosedError();
        const text = JSON.stringify(message);
        const peer = end.peer;
        queueMicrotask(() => peer?.deliver(text));
      },
      onMessage: core.onMessage,
      onError: core.onError,
      onClose: core.onClose,
      close() {
        if (!core.markClosed(null)) return;
        const peer = end.peer;
        // After any messages already in flight, like a socket's FIN.
        queueMicrotask(() => peer?.peerClosed());
      },
      get closed() {
        return core.closed;
      },
    },
  };
  return end;
}
