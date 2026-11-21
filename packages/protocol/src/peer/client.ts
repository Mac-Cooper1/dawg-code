import { PROTOCOL_VERSION } from "../common.ts";
import { type EngineEvent, type EventName, type EventPayload, parseEvent } from "../events.ts";
import {
  CANCEL_METHOD,
  describeIssues,
  ErrorCodes,
  type JsonRpcId,
  makeNotification,
  makeRequest,
  parseMessage,
  RpcError,
  summarizeIssues,
} from "../jsonrpc.ts";
import { type MethodName, type MethodParams, type MethodResult, methods } from "../methods.ts";
import type { Transport, TransportError, Unsubscribe } from "../transport/types.ts";
import { checkProtocolVersion } from "../version.ts";

export interface RequestOptions {
  /** Overrides the client's default. 0 waits forever. */
  timeoutMs?: number;
  /** Aborting rejects the request with `RequestCancelled` and asks the server to stop. */
  signal?: AbortSignal;
}

/** Something wrong with what the server sent. Reported, never thrown. */
export interface ClientProtocolProblem {
  kind:
    | "transport"
    | "invalid_message"
    | "invalid_event"
    | "unexpected_response"
    | "server_error"
    | "unexpected_request";
  message: string;
  detail?: unknown;
}

export interface ClientOptions {
  /** Default request timeout. 0 disables it. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Validate params before sending, so mistakes fail locally with `InvalidParams`. Default true. */
  validateParams?: boolean;
  onProblem?: (problem: ClientProtocolProblem) => void;
}

export type InitializeOptions = Omit<MethodParams<"initialize">, "protocolVersion"> & {
  protocolVersion?: number;
};

export interface Client {
  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: RequestOptions,
  ): Promise<MethodResult<M>>;
  /**
   * Sends `initialize` with this package's protocol version and rejects with
   * `UnsupportedProtocolVersion` if the engine answers with any other version.
   */
  initialize(
    params: InitializeOptions,
    options?: RequestOptions,
  ): Promise<MethodResult<"initialize">>;
  /** Typed subscription to one event. */
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): Unsubscribe;
  /** Every known event, in arrival order. The natural feed for a reducer. */
  onEvent(listener: (event: EngineEvent) => void): Unsubscribe;
  onClose(listener: (error: Error | null) => void): Unsubscribe;
  /** Closes the transport. Pending requests reject with `ConnectionClosed`. */
  close(): void;
  readonly closed: boolean;
  /** Requests still waiting for a response. */
  readonly pendingCount: number;
}

interface Pending {
  method: MethodName;
  resolve(value: unknown): void;
  reject(error: RpcError): void;
  cleanup(): void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createClient(transport: Transport, options: ClientOptions = {}): Client {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const validateParams = options.validateParams ?? true;
  const report = (problem: ClientProtocolProblem) => options.onProblem?.(problem);

  const pending = new Map<JsonRpcId, Pending>();
  const eventListeners = new Map<string, Set<(payload: never) => void>>();
  const anyListeners = new Set<(event: EngineEvent) => void>();
  let nextId = 1;

  function settleAll(error: RpcError): void {
    const all = [...pending.values()];
    pending.clear();
    for (const entry of all) {
      entry.cleanup();
      entry.reject(error);
    }
  }

  function sendCancel(id: JsonRpcId): void {
    if (transport.closed) return;
    try {
      transport.send(makeNotification(CANCEL_METHOD, { id }));
    } catch {
      // The connection went away; the server will drop the request with it.
    }
  }

  function dispatchEvent(name: string, payload: unknown): void {
    const parsed = parseEvent(name, payload);
    if (!parsed.ok) {
      // Unknown events are a newer engine's additions: ignore them quietly.
      if (parsed.reason === "invalid") {
        report({
          kind: "invalid_event",
          message: `Dropped "${name}" event: ${describeIssues(parsed.error)}`,
          detail: summarizeIssues(parsed.error),
        });
      }
      return;
    }
    const { event } = parsed;
    for (const listener of [...(eventListeners.get(event.event) ?? [])]) {
      (listener as (payload: unknown) => void)(event.payload);
    }
    for (const listener of [...anyListeners]) listener(event);
  }

  function handleResponse(
    id: JsonRpcId | null,
    outcome: { result: unknown } | { error: RpcError },
  ) {
    if (id === null) {
      // The server could not tell which message it was answering, for example unparsable JSON.
      const message = "error" in outcome ? outcome.error.message : "Response without an id";
      report({
        kind: "server_error",
        message,
        detail: "error" in outcome ? outcome.error.toJSON() : undefined,
      });
      return;
    }
    const entry = pending.get(id);
    if (!entry) {
      // Usually the answer to a request that already timed out or was cancelled.
      report({ kind: "unexpected_response", message: `No pending request with id ${id}` });
      return;
    }
    pending.delete(id);
    entry.cleanup();
    if ("error" in outcome) {
      entry.reject(outcome.error);
      return;
    }
    const parsed = methods[entry.method].result.safeParse(outcome.result);
    if (parsed.success) {
      entry.resolve(parsed.data);
    } else {
      entry.reject(
        new RpcError(
          ErrorCodes.InternalError,
          `Invalid result for ${entry.method}: ${describeIssues(parsed.error)}`,
          { issues: summarizeIssues(parsed.error) },
        ),
      );
    }
  }

  const stops: Unsubscribe[] = [];
  stops.push(
    transport.onMessage((value) => {
      const parsed = parseMessage(value);
      switch (parsed.kind) {
        case "notification":
          dispatchEvent(parsed.message.method, parsed.message.params);
          return;
        case "success":
          handleResponse(parsed.message.id, { result: parsed.message.result });
          return;
        case "error":
          handleResponse(parsed.message.id, { error: RpcError.fromObject(parsed.message.error) });
          return;
        case "request":
          // The engine never calls the client. Answer so a confused peer does not wait forever.
          report({
            kind: "unexpected_request",
            message: `Unexpected request ${parsed.message.method}`,
          });
          try {
            transport.send({
              jsonrpc: "2.0",
              id: parsed.message.id,
              error: { code: ErrorCodes.MethodNotFound, message: "The client serves no methods" },
            });
          } catch {
            // Closed meanwhile.
          }
          return;
        case "invalid":
          report({ kind: "invalid_message", message: parsed.error.message });
          return;
      }
    }),
  );
  stops.push(
    transport.onError((error: TransportError) => {
      report({ kind: "transport", message: error.message, detail: error.kind });
    }),
  );
  stops.push(
    transport.onClose((error) => {
      for (const stop of stops) stop();
      settleAll(
        new RpcError(
          ErrorCodes.ConnectionClosed,
          error ? `Connection closed: ${error.message}` : "Connection closed",
        ),
      );
    }),
  );

  function request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    requestOptions: RequestOptions = {},
  ): Promise<MethodResult<M>> {
    return new Promise<MethodResult<M>>((resolve, reject) => {
      if (transport.closed) {
        reject(new RpcError(ErrorCodes.ConnectionClosed, "Connection closed"));
        return;
      }
      const signal = requestOptions.signal;
      if (signal?.aborted) {
        reject(new RpcError(ErrorCodes.RequestCancelled, "Request cancelled"));
        return;
      }
      if (validateParams) {
        const check = methods[method].params.safeParse(params);
        if (!check.success) {
          reject(
            new RpcError(
              ErrorCodes.InvalidParams,
              `Invalid params for ${method}: ${describeIssues(check.error)}`,
              { issues: summarizeIssues(check.error) },
            ),
          );
          return;
        }
      }

      const id = nextId++;
      const timeoutMs = requestOptions.timeoutMs ?? defaultTimeout;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => {
        if (!pending.delete(id)) return;
        cleanup();
        sendCancel(id);
        reject(new RpcError(ErrorCodes.RequestCancelled, "Request cancelled"));
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup,
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          cleanup();
          sendCancel(id);
          reject(
            new RpcError(ErrorCodes.RequestTimeout, `${method} timed out after ${timeoutMs} ms`),
          );
        }, timeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        transport.send(makeRequest(id, method, params));
      } catch (error) {
        pending.delete(id);
        cleanup();
        reject(
          new RpcError(
            ErrorCodes.ConnectionClosed,
            `Send failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  return {
    request,
    async initialize(params, requestOptions) {
      const protocolVersion = params.protocolVersion ?? PROTOCOL_VERSION;
      const result = await request("initialize", { ...params, protocolVersion }, requestOptions);
      const mismatch = checkProtocolVersion(result.protocolVersion, [protocolVersion]);
      if (mismatch) {
        throw new RpcError(
          ErrorCodes.UnsupportedProtocolVersion,
          `The engine answered with protocol version ${result.protocolVersion}, not ${protocolVersion}`,
          mismatch.data,
        );
      }
      return result;
    },
    on(event, listener) {
      let set = eventListeners.get(event);
      if (!set) {
        set = new Set();
        eventListeners.set(event, set);
      }
      const entry = listener as (payload: never) => void;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
    onEvent(listener) {
      anyListeners.add(listener);
      return () => {
        anyListeners.delete(listener);
      };
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
    get pendingCount() {
      return pending.size;
    },
  };
}
