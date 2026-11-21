import { type JsonRpcMessage, parseJson } from "../jsonrpc.ts";
import {
  createTransportCore,
  type Transport,
  TransportClosedError,
  TransportError,
} from "./types.ts";

/**
 * Typed as `object` so that DOM, Electron and Node ports, whose listeners take their own event
 * classes, all fit. Message events carry the payload in `data`.
 */
type PortListener = (event: object) => void;

/**
 * The structural shape of a message port: a DOM `MessagePort` (in the renderer), Electron's
 * `MessagePortMain` (in the main or utility process) and Node's `worker_threads` port all fit.
 * DOM ports use `addEventListener`; Electron's use `on`. Whichever exists is used.
 */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
  addEventListener?(type: string, listener: PortListener): void;
  removeEventListener?(type: string, listener: PortListener): void;
  on?(type: string, listener: PortListener): unknown;
  off?(type: string, listener: PortListener): unknown;
  removeListener?(type: string, listener: PortListener): unknown;
}

/**
 * A transport over a message port. Messages are posted as plain objects (structured clone).
 * Received strings are parsed as JSON, so a peer may also post serialised text. The port's
 * "close" event, where the platform has one, closes the transport.
 */
export function createMessagePortTransport(port: MessagePortLike): Transport {
  const core = createTransportCore();

  function listen(type: string, listener: PortListener): () => void {
    if (port.addEventListener) {
      port.addEventListener(type, listener);
      return () => port.removeEventListener?.(type, listener);
    }
    if (port.on) {
      port.on(type, listener);
      return () => {
        if (port.off) port.off(type, listener);
        else port.removeListener?.(type, listener);
      };
    }
    throw new TypeError("The port has neither addEventListener nor on");
  }

  const onMessage: PortListener = (event) => {
    if (core.closed) return;
    const data = (event as { data?: unknown }).data;
    if (typeof data === "string") {
      const parsed = parseJson(data);
      if (parsed.ok) core.emitMessage(parsed.value);
      else core.emitError(new TransportError("parse", `Invalid JSON: ${parsed.error}`));
      return;
    }
    core.emitMessage(data);
  };
  const onMessageError: PortListener = () => {
    core.emitError(new TransportError("parse", "A message could not be deserialised"));
  };
  const onPortClose: PortListener = () => {
    shutdown(false);
  };

  const stops = [
    listen("message", onMessage),
    listen("messageerror", onMessageError),
    listen("close", onPortClose),
  ];
  // DOM ports used through addEventListener, and Electron's ports, deliver nothing until started.
  port.start?.();

  function shutdown(closePort: boolean): void {
    if (core.closed) return;
    for (const stop of stops) stop();
    if (closePort) {
      try {
        port.close();
      } catch {
        // Already closed.
      }
    }
    core.markClosed(null);
  }

  return {
    send(message: JsonRpcMessage) {
      if (core.closed) throw new TransportClosedError();
      try {
        port.postMessage(message);
      } catch (error) {
        const wrapped = new TransportError(
          "io",
          `Post failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        core.emitError(wrapped);
        throw wrapped;
      }
    },
    onMessage: core.onMessage,
    onError: core.onError,
    onClose: core.onClose,
    close() {
      shutdown(true);
    },
    get closed() {
      return core.closed;
    },
  };
}
