/**
 * The engine host's message loop, with the parent port and the engine injected so it runs in
 * tests without Electron. Every message from main is checked against `MainToHostSchema`
 * (`shared/engine-host-messages.ts`); what does not parse is logged and dropped.
 *
 * - `{ type: "connect" }` carries one end of a fresh channel for a window: each such port is
 *   served as its own protocol connection.
 * - Main's answers about models (`model-grant`, `model-refused`, `models-changed`) go to the
 *   engine, which asks for models with `model-request` through `send`.
 */
import {
  createMessagePortTransport,
  createServer,
  ErrorCodes,
  type MessagePortLike,
  RpcError,
  type Transport,
} from "@dawg/protocol";
import { type HostToMain, MainToHostSchema } from "../shared/engine-host-messages.ts";
import type { HostedEngine } from "./engine.ts";

export interface ParentPortLike<Port> {
  on(event: "message", listener: (event: { data: unknown; ports: Port[] }) => void): unknown;
  postMessage(message: unknown): void;
}

export type EngineHostLog = (message: string) => void;

/**
 * Starts serving. `createEngine` runs once, up front, and gets the function that posts to main;
 * if it throws, the host stays up and answers every connection's `initialize` with the reason
 * (see `serveUnavailable`), so the window shows a readable error instead of waiting on a port
 * nobody answers, and main does not restart a host that would only fail the same way again.
 */
export function startEngineHost<Port extends MessagePortLike>(
  parentPort: ParentPortLike<Port>,
  createEngine: (send: (message: HostToMain) => void) => HostedEngine,
  log: EngineHostLog,
): { engine: HostedEngine | null; unavailableReason: string | null } {
  let engine: HostedEngine | null = null;
  let unavailableReason: string | null = null;
  const send = (message: HostToMain) => parentPort.postMessage(message);
  try {
    engine = createEngine(send);
    log(`Serving the ${engine.kind} engine.`);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    log(`The engine could not start: ${unavailableReason}. Connections will be refused.`);
  }

  parentPort.on("message", (event) => {
    const parsed = MainToHostSchema.safeParse(event.data);
    if (!parsed.success) {
      log(`Ignoring an unknown message from main: ${summarize(event.data)}`);
      return;
    }
    const message = parsed.data;
    if (message.type !== "connect") {
      try {
        engine?.receive?.(message);
      } catch (error) {
        log(
          `Could not handle ${message.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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

/** For the log: a message's type, never its contents (a grant can carry an API key). */
function summarize(data: unknown): string {
  if (typeof data !== "object" || data === null) return JSON.stringify(data) ?? String(data);
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" ? `type "${type}"` : "a message without a type";
}

/** Answers `initialize` with the reason the engine is missing; every other method is refused. */
export function serveUnavailable(transport: Transport, reason: string): void {
  createServer(transport, {
    initialize: () => {
      throw new RpcError(ErrorCodes.InternalError, `The engine could not start: ${reason}`);
    },
  });
}
