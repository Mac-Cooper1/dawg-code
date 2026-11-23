/**
 * The engine host's message loop, with the parent port and the engine injected so it runs in
 * tests without Electron. Main posts `{ type: "connect" }` with one end of a fresh channel for
 * every window that asks; each such port is served as its own protocol connection.
 */
import {
  createMessagePortTransport,
  createServer,
  ErrorCodes,
  type MessagePortLike,
  RpcError,
  type Transport,
} from "@dawg/protocol";
import type { HostedEngine } from "./engine.ts";

export interface ParentPortLike<Port> {
  on(event: "message", listener: (event: { data: unknown; ports: Port[] }) => void): unknown;
}

export type EngineHostLog = (message: string) => void;

/**
 * Starts serving. `createEngine` runs once, up front; if it throws, the host stays up and
 * answers every connection's `initialize` with the reason (see `serveUnavailable`), so the window
 * shows a readable error instead of waiting on a port nobody answers, and main does not restart
 * a host that would only fail the same way again.
 */
export function startEngineHost<Port extends MessagePortLike>(
  parentPort: ParentPortLike<Port>,
  createEngine: () => HostedEngine,
  log: EngineHostLog,
): { engine: HostedEngine | null; unavailableReason: string | null } {
  let engine: HostedEngine | null = null;
  let unavailableReason: string | null = null;
  try {
    engine = createEngine();
    log(`Serving the ${engine.kind} engine.`);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    log(`The engine could not start: ${unavailableReason}. Connections will be refused.`);
  }

  parentPort.on("message", (event) => {
    if (!isConnectMessage(event.data)) {
      log(`Ignoring an unknown message from main: ${JSON.stringify(event.data)}`);
      return;
    }
    const port = event.ports[0];
    if (!port) {
      log("A connect message arrived without a port.");
      return;
    }
    const transport = createMessagePortTransport(port);
    try {
      if (engine) engine.connect(transport);
      else serveUnavailable(transport, unavailableReason ?? "unknown error");
    } catch (error) {
      log(
        `Could not serve a connection: ${error instanceof Error ? error.message : String(error)}`,
      );
      transport.close();
    }
  });

  return { engine, unavailableReason };
}

function isConnectMessage(data: unknown): boolean {
  return (
    typeof data === "object" && data !== null && (data as { type?: unknown }).type === "connect"
  );
}

/** Answers `initialize` with the reason the engine is missing; every other method is refused. */
export function serveUnavailable(transport: Transport, reason: string): void {
  createServer(transport, {
    initialize: () => {
      throw new RpcError(ErrorCodes.InternalError, `The engine could not start: ${reason}`);
    },
  });
}
