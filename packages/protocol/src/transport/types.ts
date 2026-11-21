import type { JsonRpcMessage } from "../jsonrpc.ts";

export type Unsubscribe = () => void;

/** Why a transport reported a problem. */
export type TransportErrorKind =
  /** A frame was not valid JSON. The frame is dropped; the transport stays open. */
  | "parse"
  /** A frame was longer than the limit. It is dropped; the transport stays open. */
  | "oversized"
  /** Reading or writing failed. The transport closes. */
  | "io";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
    this.kind = kind;
  }
}

/** Thrown by `send` once the transport has closed. */
export class TransportClosedError extends Error {
  constructor() {
    super("The transport is closed");
    this.name = "TransportClosedError";
  }
}

/**
 * Moves JSON-RPC messages between two peers. Framing problems are reported through `onError`
 * and never thrown. Received values are decoded JSON but not yet checked as JSON-RPC; the peers
 * do that.
 */
export interface Transport {
  /** Sends one message. Throws `TransportClosedError` once closed. */
  send(message: JsonRpcMessage): void;
  /**
   * Messages received before the first listener is added are held and delivered to it, so a
   * transport can be created before its peer.
   */
  onMessage(listener: (message: unknown) => void): Unsubscribe;
  onError(listener: (error: TransportError) => void): Unsubscribe;
  /** Called once, when either side closes or I/O fails. `error` is set for failures. */
  onClose(listener: (error: Error | null) => void): Unsubscribe;
  /** Closes this end. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

/** Listener bookkeeping shared by the transports. */
export interface TransportCore {
  readonly closed: boolean;
  emitMessage(message: unknown): void;
  emitError(error: TransportError): void;
  /** Marks the transport closed and notifies listeners. Returns false if it already was. */
  markClosed(error: Error | null): boolean;
  onMessage(listener: (message: unknown) => void): Unsubscribe;
  onError(listener: (error: TransportError) => void): Unsubscribe;
  onClose(listener: (error: Error | null) => void): Unsubscribe;
}

export function createTransportCore(): TransportCore {
  const messageListeners = new Set<(message: unknown) => void>();
  const errorListeners = new Set<(error: TransportError) => void>();
  const closeListeners = new Set<(error: Error | null) => void>();
  let held: unknown[] | null = [];
  let closed = false;
  let closeError: Error | null = null;

  function subscribe<T>(set: Set<T>, listener: T): Unsubscribe {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  return {
    get closed() {
      return closed;
    },
    emitMessage(message) {
      if (held) {
        held.push(message);
        return;
      }
      for (const listener of [...messageListeners]) listener(message);
    },
    emitError(error) {
      for (const listener of [...errorListeners]) listener(error);
    },
    markClosed(error) {
      if (closed) return false;
      closed = true;
      closeError = error;
      for (const listener of [...closeListeners]) listener(error);
      closeListeners.clear();
      return true;
    },
    onMessage(listener) {
      const unsubscribe = subscribe(messageListeners, listener);
      if (held) {
        const pending = held;
        held = null;
        for (const message of pending) listener(message);
      }
      return unsubscribe;
    },
    onError(listener) {
      return subscribe(errorListeners, listener);
    },
    onClose(listener) {
      if (closed) {
        // Late subscribers still learn about the close, but asynchronously like everyone else.
        queueMicrotask(() => listener(closeError));
        return () => {};
      }
      return subscribe(closeListeners, listener);
    },
  };
}
