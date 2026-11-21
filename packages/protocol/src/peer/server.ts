import { type EventName, type EventPayloadInput, events } from "../events.ts";
import type { JsonRpcMessage } from "../jsonrpc.ts";
import {
  CANCEL_METHOD,
  CancelParamsSchema,
  describeIssues,
  ErrorCodes,
  type JsonRpcId,
  type JsonRpcRequest,
  makeError,
  makeNotification,
  makeSuccess,
  parseMessage,
  RpcError,
  summarizeIssues,
} from "../jsonrpc.ts";
import {
  isMethodName,
  type MethodName,
  methods,
  type ParsedParams,
  type ResultInput,
} from "../methods.ts";
import type { Transport, Unsubscribe } from "../transport/types.ts";
import { checkProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../version.ts";

export interface HandlerContext {
  /** The JSON-RPC id of the request. */
  id: JsonRpcId;
  /** Aborted when the client cancels the request or the connection closes. */
  signal: AbortSignal;
}

export type Handler<M extends MethodName> = (
  params: ParsedParams<M>,
  context: HandlerContext,
) => ResultInput<M> | Promise<ResultInput<M>>;

/** A handler for every method. Engines should satisfy this; mocks may pass a partial set. */
export type Handlers = { [M in MethodName]: Handler<M> };

/** Something the server noticed that is worth logging. Never thrown. */
export interface ServerProblem {
  kind:
    | "transport"
    | "invalid_message"
    | "invalid_result"
    | "handler_error"
    | "send_failed"
    | "unexpected_response";
  message: string;
  method?: string;
  detail?: unknown;
}

export interface ServerOptions {
  /**
   * Check results and outgoing events against their schemas. An invalid result is answered with
   * `InternalError`; an invalid event throws from `notify`. Defaults to on unless
   * NODE_ENV is "production".
   */
  validateOutgoing?: boolean;
  /** Refuse other methods until `initialize` succeeds. Default true. */
  requireInitialize?: boolean;
  /** Versions `initialize` accepts. Defaults to this package's. */
  supportedVersions?: readonly number[];
  onProblem?: (problem: ServerProblem) => void;
}

export interface Server {
  /** Sends an event. Returns false when the connection is closed. */
  notify<E extends EventName>(event: E, payload: EventPayloadInput<E>): boolean;
  /** True once `initialize` has succeeded. */
  readonly initialized: boolean;
  onClose(listener: (error: Error | null) => void): Unsubscribe;
  close(): void;
  readonly closed: boolean;
}

function isProduction(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.NODE_ENV === "production";
}

export function createServer(
  transport: Transport,
  handlers: Partial<Handlers>,
  options: ServerOptions = {},
): Server {
  const validateOutgoing = options.validateOutgoing ?? !isProduction();
  const requireInitialize = options.requireInitialize ?? true;
  const supportedVersions = options.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
  const report = (problem: ServerProblem) => options.onProblem?.(problem);

  const inFlight = new Map<JsonRpcId, AbortController>();
  let initialized = false;
  let initializing = false;

  function send(message: JsonRpcMessage): boolean {
    if (transport.closed) return false;
    try {
      transport.send(message);
      return true;
    } catch (error) {
      report({
        kind: "send_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function toRpcError(error: unknown, method: string): RpcError {
    if (error instanceof RpcError) return error;
    report({
      kind: "handler_error",
      method,
      message: error instanceof Error ? error.message : String(error),
      detail: error instanceof Error ? error.stack : undefined,
    });
    const message = error instanceof Error ? error.message : "Internal error";
    return new RpcError(ErrorCodes.InternalError, message);
  }

  /** Runs the checks that come before the handler. Returns an error, or null to proceed. */
  function gate(method: string): RpcError | null {
    if (!isMethodName(method)) {
      return new RpcError(ErrorCodes.MethodNotFound, `Method not found: ${method}`);
    }
    if (!handlers[method]) {
      return new RpcError(ErrorCodes.MethodNotFound, `Method not implemented: ${method}`);
    }
    if (!requireInitialize) return null;
    if (method === "initialize") {
      if (initialized || initializing) {
        return new RpcError(ErrorCodes.InvalidState, "Already initialized");
      }
      return null;
    }
    if (!initialized) {
      return new RpcError(ErrorCodes.NotInitialized, "Call initialize first");
    }
    return null;
  }

  async function handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method } = request;
    if (inFlight.has(id)) {
      send(makeError(id, ErrorCodes.InvalidRequest, `Request id ${id} is already in use`));
      return;
    }
    const refused = gate(method);
    if (refused) {
      send(makeError(id, refused.code, refused.message, refused.data));
      return;
    }
    const name = method as MethodName;
    const definition = methods[name];
    const parsed = definition.params.safeParse(request.params ?? {});
    if (!parsed.success) {
      send(
        makeError(id, ErrorCodes.InvalidParams, `Invalid params: ${describeIssues(parsed.error)}`, {
          issues: summarizeIssues(parsed.error),
        }),
      );
      return;
    }

    if (name === "initialize") {
      const version = (parsed.data as ParsedParams<"initialize">).protocolVersion;
      const unsupported = checkProtocolVersion(version, supportedVersions);
      if (unsupported) {
        send(makeError(id, unsupported.code, unsupported.message, unsupported.data));
        return;
      }
      initializing = true;
    }

    const controller = new AbortController();
    inFlight.set(id, controller);
    // False once the request was cancelled: the cancel was already answered, so stay quiet.
    const stillOwned = () => inFlight.get(id) === controller;
    const handler = handlers[name] as Handler<MethodName>;
    try {
      const result = await handler(parsed.data as ParsedParams<MethodName>, {
        id,
        signal: controller.signal,
      });
      if (!stillOwned()) return;
      if (validateOutgoing) {
        const checked = definition.result.safeParse(result);
        if (!checked.success) {
          report({
            kind: "invalid_result",
            method,
            message: describeIssues(checked.error),
            detail: summarizeIssues(checked.error),
          });
          send(makeError(id, ErrorCodes.InternalError, `Invalid result from ${method}`));
          return;
        }
      }
      if (name === "initialize") initialized = true;
      // The handler's value is sent, not the parsed one: the client parses it again anyway.
      send(makeSuccess(id, result));
    } catch (error) {
      if (!stillOwned()) return;
      const rpcError = toRpcError(error, method);
      send(makeError(id, rpcError.code, rpcError.message, rpcError.data));
    } finally {
      if (stillOwned()) inFlight.delete(id);
      if (name === "initialize") initializing = false;
    }
  }

  /** Answers a cancelled request at once; its handler is told through its signal. */
  function cancel(id: JsonRpcId): void {
    const controller = inFlight.get(id);
    if (!controller) return;
    inFlight.delete(id);
    controller.abort();
    send(makeError(id, ErrorCodes.RequestCancelled, "Request cancelled"));
  }

  const stops: Unsubscribe[] = [];
  stops.push(
    transport.onMessage((value) => {
      const parsed = parseMessage(value);
      switch (parsed.kind) {
        case "request":
          void handleRequest(parsed.message);
          return;
        case "notification": {
          if (parsed.message.method === CANCEL_METHOD) {
            const params = CancelParamsSchema.safeParse(parsed.message.params);
            if (params.success) cancel(params.data.id);
          }
          // Other notifications are ignored: none are defined from client to engine.
          return;
        }
        case "success":
        case "error":
          report({ kind: "unexpected_response", message: "The server sends no requests" });
          return;
        case "invalid":
          report({ kind: "invalid_message", message: parsed.error.message });
          send(makeError(parsed.id, parsed.error.code, parsed.error.message));
          return;
      }
    }),
  );
  stops.push(
    transport.onError((error) => {
      report({ kind: "transport", message: error.message, detail: error.kind });
      if (error.kind === "parse") {
        send(makeError(null, ErrorCodes.ParseError, `Parse error: ${error.message}`));
      } else if (error.kind === "oversized") {
        send(makeError(null, ErrorCodes.InvalidRequest, error.message));
      }
    }),
  );
  stops.push(
    transport.onClose(() => {
      for (const stop of stops) stop();
      for (const controller of inFlight.values()) controller.abort();
    }),
  );

  return {
    notify(event, payload) {
      if (validateOutgoing) {
        const checked = events[event].safeParse(payload);
        if (!checked.success) {
          throw new RpcError(
            ErrorCodes.InternalError,
            `Invalid "${event}" event: ${describeIssues(checked.error)}`,
            { issues: summarizeIssues(checked.error) },
          );
        }
      }
      return send(makeNotification(event, payload));
    },
    get initialized() {
      return initialized;
    },
    onClose(listener) {
      return transport.onClose(listener);
    },
    close() {
      transport.close();
    },
    get closed() {
      return transport.closed;
    },
  };
}
