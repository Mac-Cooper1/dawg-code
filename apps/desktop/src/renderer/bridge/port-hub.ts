import type { Unsubscribe } from "../../shared/bridge.ts";

/**
 * Hands engine ports to `onPort` listeners. A port that arrives while nobody listens (after an
 * engine restart, say, before the app has subscribed) is held for the first listener; only the
 * newest is kept, since an older one leads to an engine host that is gone.
 */
export interface PortHub {
  deliver(port: MessagePort): void;
  onPort(listener: (port: MessagePort) => void): Unsubscribe;
}

export function createPortHub(): PortHub {
  const listeners = new Set<(port: MessagePort) => void>();
  let held: MessagePort | null = null;

  return {
    deliver(port) {
      if (listeners.size === 0) {
        held?.close();
        held = port;
        return;
      }
      for (const listener of [...listeners]) listener(port);
    },
    onPort(listener) {
      listeners.add(listener);
      if (held) {
        const port = held;
        held = null;
        // Later, so the listener already holds its unsubscribe function when the port arrives.
        queueMicrotask(() => {
          if (listeners.has(listener)) listener(port);
          else if (listeners.size > 0) for (const other of [...listeners]) other(port);
          else held = port;
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
