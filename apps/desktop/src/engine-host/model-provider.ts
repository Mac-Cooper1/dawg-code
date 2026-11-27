/**
 * The real engine's model provider. Main owns the models (downloads, the bundled runtime,
 * servers); this asks main for one over the parent port (`shared/engine-host-messages.ts`).
 *
 * - `connect(modelId)` sends `model-request` and waits for `model-grant` or `model-refused`.
 *   Loading a large model into the bundled runtime can take minutes, so the wait ends only after
 *   `grantTimeoutMs` (default 15 minutes). A refusal fails the session's creation, resume or
 *   model switch with the refusal's words.
 * - A connection outlives the grant it started with. Its client looks up the model's grant before
 *   every request and asks main again when the grant is out of date: after `models-changed`, once
 *   another grant shows a newer generation than any known when it arrived, or after a request
 *   could not reach the server. So a session survives the runtime restarting on another port, or
 *   another model being loaded in between.
 * - The session's model is the id the grant names ("qwen3.8-27b-q8", "ollama/qwen3:32b"). The
 *   engine reads a session's model id from `client.endpoint.model`, so the client shows the
 *   grant's id there; requests still carry `endpoint.model`, the server's own name for it.
 * - Grants for the bundled runtime carry its slots. Every connection to it gets the same
 *   conversation pool object, made from the first such grant and kept for the host's life, so the
 *   engine schedules every session on the same slots. Servers get no pool: their requests go out
 *   at once.
 * - Side requests (titles, WebFetch's page summaries) go through `sideClient`: to the helper model
 *   while the model's latest grant carries one (on the helper's slot), otherwise where they always
 *   went (the bundled runtime's side slot, or the server). Each request looks at the grant then,
 *   so a helper that starts later, restarts on another port or is turned off is followed. A helper
 *   that does not answer is given up on for that request (the main model answers it, and the log
 *   says so), and the next request asks main where things are.
 */
import {
  createModelClient,
  type EndpointDescription,
  type ModelClient,
  type ModelConnection,
  ModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  RuntimeError,
  type SideRoute,
  type SlotPool,
  SlotScheduler,
  sideClient,
} from "@dawg/engine";
import type { Endpoint } from "@dawg/models";
import type {
  HelperGrant,
  HostToMain,
  MainToHost,
  ModelGrant,
} from "../shared/engine-host-messages.ts";

/** Fifteen minutes: room to load the largest model the app offers from a slow disk. */
export const DEFAULT_GRANT_TIMEOUT_MS = 15 * 60_000;

/** Main's messages about models: everything it sends but `connect`. */
export type ModelMessage = Exclude<MainToHost, { type: "connect" }>;

export interface ParentModelProviderOptions {
  /** Posts a message to main. */
  send(message: HostToMain): void;
  /** How long to wait for main's answer to one request. */
  grantTimeoutMs?: number;
  log?(message: string): void;
  /** For tests. Default `createModelClient`. */
  createClient?(endpoint: Endpoint): ModelClient;
  /** For tests: how long the helper may take to start answering. Default 60 s. */
  helperFirstEventTimeoutMs?: number;
}

export interface ParentModelProvider extends ModelProvider {
  /** Hands the provider one of main's messages about models. */
  receive(message: ModelMessage): void;
  /** For `/status` and `/model`: where a model's requests go. Null before its first grant. */
  describe(modelId: string): EndpointDescription | null;
  /** The server's own name for a model (its latest grant's `endpoint.model`), or null. */
  serverName(modelId: string): string | null;
  /** The engine profile main named for a model (a catalog model's, or the helper's), or null. */
  catalogProfile(modelId: string): string | null;
  /** Ends every wait with an error. Later requests fail at once. */
  close(): void;
}

/** Main said no; `retryable` when asking again later may work. */
class ModelRefused extends Error {
  override name = "ModelRefused";
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** No answer in time, or the host is stopping. */
class ModelWaitFailed extends Error {
  override name = "ModelWaitFailed";
}

interface Held {
  grant: ModelGrant;
  /** What the engine sees: the grant's endpoint with the model id as its `model`. */
  shown: Endpoint;
  /** Sends requests to the server named in the grant. */
  client: ModelClient;
  /** The count of `models-changed` messages when it arrived. */
  epoch: number;
  /** The newest generation known when it arrived (its own included). */
  newestAtArrival: number;
  /** A request could not reach the server: ask main again before the next one. */
  unreachable: boolean;
  /** The helper model, when the grant carries one. */
  helper: HeldHelper | null;
}

interface HeldHelper {
  grant: HelperGrant;
  /** Its endpoint as the engine sees it, named by the helper's model id. */
  shown: Endpoint;
  client: ModelClient;
}

interface Waiting {
  requestId: string;
  key: string;
  promise: Promise<Held>;
  resolve(held: Held): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The key under which a request for the default model waits. Model ids are never empty. */
const DEFAULT_KEY = "";

export function createParentModelProvider(
  options: ParentModelProviderOptions,
): ParentModelProvider {
  const timeoutMs = options.grantTimeoutMs ?? DEFAULT_GRANT_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const makeClient = options.createClient ?? ((endpoint: Endpoint) => createModelClient(endpoint));

  /** The latest grant for each model id. */
  const held = new Map<string, Held>();
  /** Requests sent to main and not answered yet, by request id and by what they asked for. */
  const waiting = new Map<string, Waiting>();
  const waitingFor = new Map<string, Waiting>();
  /** The clients handed to sessions, one per model id, for the host's life. */
  const clients = new Map<string, ModelClient>();
  /** The side-request clients handed to sessions, one per model id, for the host's life. */
  const sideClients = new Map<string, ModelClient>();
  /** The latest helper grant by the helper's model id, for its profile and server name. */
  const helpers = new Map<string, HelperGrant>();
  let pools: { conversation: SlotPool; utility: SlotPool } | null = null;
  /** The bundled runtime's side slot and the helper's slot, scheduled here for every session. */
  let mainSide: SlotScheduler | null = null;
  let helperSide: SlotScheduler | null = null;
  let warnedSlots = false;
  let epoch = 0;
  let newest = 0;
  let nextRequest = 1;
  let closed = false;

  function current(entry: Held | undefined): entry is Held {
    return (
      entry !== undefined &&
      !entry.unreachable &&
      entry.epoch === epoch &&
      entry.newestAtArrival >= newest
    );
  }

  /**
   * The current grant for a model, asking main when there is none. The default (null) is always
   * asked for: the person may have chosen another one since.
   */
  function obtain(modelId: string | null, signal?: AbortSignal): Promise<Held> {
    if (closed) return Promise.reject(stopping());
    const entry = modelId === null ? undefined : held.get(modelId);
    if (current(entry)) return Promise.resolve(entry);
    return untilAborted(ask(modelId), signal);
  }

  function ask(modelId: string | null): Promise<Held> {
    const key = modelId ?? DEFAULT_KEY;
    const already = waitingFor.get(key);
    if (already !== undefined) return already.promise;
    const requestId = `model-${nextRequest++}`;
    let resolve!: (held: Held) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Held>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Nobody may be listening by the time it fails (an aborted wait); that is fine.
    promise.catch(() => {});
    const timer = setTimeout(() => {
      settle(requestId);
      log(`Main did not answer ${requestId} within ${Math.round(timeoutMs / 1000)} s.`);
      reject(
        new ModelWaitFailed(
          `The model did not become ready within ${minutes(timeoutMs)}. Check Settings → Models.`,
        ),
      );
    }, timeoutMs);
    const entry: Waiting = { requestId, key, promise, resolve, reject, timer };
    waiting.set(requestId, entry);
    waitingFor.set(key, entry);
    log(`Asking main for ${modelId === null ? "the default model" : modelId} (${requestId}).`);
    try {
      options.send({ type: "model-request", requestId, modelId });
    } catch (error) {
      settle(requestId);
      reject(new ModelWaitFailed(`Could not ask for a model: ${messageOf(error)}`));
    }
    return promise;
  }

  /** Forgets a request: answered, timed out or abandoned. */
  function settle(requestId: string): Waiting | undefined {
    const entry = waiting.get(requestId);
    if (entry === undefined) return undefined;
    clearTimeout(entry.timer);
    waiting.delete(requestId);
    if (waitingFor.get(entry.key) === entry) waitingFor.delete(entry.key);
    return entry;
  }

  function store(grant: ModelGrant): Held {
    newest = Math.max(newest, grant.generation);
    const helper = grant.helper;
    if (helper !== undefined) helpers.set(helper.modelId, helper);
    const entry: Held = {
      grant,
      shown: { ...grant.endpoint, model: grant.modelId },
      client: makeClient(grant.endpoint),
      epoch,
      newestAtArrival: newest,
      unreachable: false,
      helper:
        helper === undefined
          ? null
          : {
              grant: helper,
              shown: { ...helper.endpoint, model: helper.modelId },
              client: makeClient(helper.endpoint),
            },
    };
    held.set(grant.modelId, entry);
    return entry;
  }

  /** The scheduler for the helper's slots, made from the first helper grant. */
  function helperScheduler(helper: HelperGrant): SlotScheduler {
    helperSide ??= new SlotScheduler(helper.slots);
    return helperSide;
  }

  /**
   * Where a model's side requests go: the helper while its current grant has one, and the main
   * model's side slot (or its server) as the fallback. The fallback client is the session's own
   * model client, so it asks main again when its grant is out of date.
   */
  function sideClientFor(modelId: string): ModelClient {
    const existing = sideClients.get(modelId);
    if (existing !== undefined) return existing;
    const latest = (): Held => {
      const entry = held.get(modelId);
      if (entry === undefined) throw new Error(`No grant for ${modelId}.`);
      return entry;
    };
    const client = sideClient({
      endpoint: () => {
        const entry = latest();
        return entry.helper?.shown ?? entry.shown;
      },
      routes: async (signal) => {
        let entry: Held;
        try {
          entry = await obtain(modelId, signal);
        } catch (error) {
          throw toModelError(error);
        }
        const slots = entry.grant.slots;
        if (slots !== undefined) mainSide ??= new SlotScheduler(slots.utility);
        // The grant just obtained, not `clientFor`: a fallback marks it out of date for the next
        // request, and this one must not wait on main for that.
        const main: SideRoute = {
          client: heldClient(entry),
          ...(slots !== undefined && mainSide !== null ? { scheduler: mainSide } : {}),
        };
        const helper = entry.helper;
        return {
          helper:
            helper === null
              ? null
              : { client: helper.client, scheduler: helperScheduler(helper.grant) },
          main,
        };
      },
      onFallback: (problem) => {
        // Main is asked where the helper is before the next request (it may have restarted on
        // another port, or stopped for good).
        const entry = held.get(modelId);
        if (entry !== undefined) entry.unreachable = true;
        log(
          `The helper model did not answer (${problem}); this side request went to ${modelId} instead.`,
        );
      },
      ...(options.helperFirstEventTimeoutMs === undefined
        ? {}
        : { firstEventTimeoutMs: options.helperFirstEventTimeoutMs }),
    });
    sideClients.set(modelId, client);
    return client;
  }

  function poolsFor(grant: ModelGrant): { conversation: SlotPool; utility: SlotPool } | null {
    const slots = grant.slots;
    if (slots === undefined) return null;
    if (pools === null) {
      pools = {
        conversation: { slots: [...slots.conversation] },
        utility: { slots: [...slots.utility] },
      };
    } else if (
      !warnedSlots &&
      (!sameSlots(pools.conversation.slots, slots.conversation) ||
        !sameSlots(pools.utility.slots, slots.utility))
    ) {
      // The engine's schedulers keep the slots they were made with.
      warnedSlots = true;
      log(
        `The runtime's slots changed to ${JSON.stringify(slots)}; sessions keep using ` +
          `${JSON.stringify({ conversation: pools.conversation.slots, utility: pools.utility.slots })} until the app restarts.`,
      );
    }
    return pools;
  }

  /** The client a session holds for a model: it finds the model's current grant per request. */
  function clientFor(modelId: string): ModelClient {
    const existing = clients.get(modelId);
    if (existing !== undefined) return existing;
    const latest = (): Held => {
      const entry = held.get(modelId);
      if (entry === undefined) throw new Error(`No grant for ${modelId}.`);
      return entry;
    };
    const client: ModelClient = {
      get endpoint() {
        return latest().shown;
      },
      stream: (request) => streamWith(modelId, request),
      // Counting is an optimisation: with no current grant the engine estimates instead of
      // making main load a model.
      countTokens: async (request) => {
        const entry = held.get(modelId);
        return current(entry) ? entry.client.countTokens(request) : null;
      },
    };
    clients.set(modelId, client);
    return client;
  }

  async function* streamWith(
    modelId: string,
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    let entry: Held;
    try {
      entry = await obtain(modelId, request.signal);
    } catch (error) {
      throw toModelError(error);
    }
    yield* streamHeld(entry, request);
  }

  async function* streamHeld(entry: Held, request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    try {
      yield* entry.client.stream(request);
    } catch (error) {
      // The runtime may have stopped or moved: the next request asks main where it is now.
      if (error instanceof ModelError && error.kind === "connection") entry.unreachable = true;
      throw error;
    }
  }

  /** A client for one grant as it stands, showing the model id like `clientFor`. */
  function heldClient(entry: Held): ModelClient {
    return {
      endpoint: entry.shown,
      stream: (request) => streamHeld(entry, request),
      countTokens: (request) => entry.client.countTokens(request),
    };
  }

  return {
    async connect(modelId) {
      let entry: Held;
      try {
        entry = await obtain(modelId);
      } catch (error) {
        throw toRuntimeError(error);
      }
      const client = clientFor(entry.grant.modelId);
      const shared = poolsFor(entry.grant);
      // Side requests choose per request between the helper and the main model, and take
      // their slots in `sideClientFor`, so they need no pool here.
      const utility = { client: sideClientFor(entry.grant.modelId) };
      const connection: ModelConnection =
        shared === null ? { client, utility } : { client, pool: shared.conversation, utility };
      return connection;
    },

    receive(message) {
      switch (message.type) {
        case "models-changed":
          epoch += 1;
          log("Models changed; sessions ask main again before their next request.");
          return;
        case "model-grant": {
          const entry = store(message.grant);
          const answered = settle(message.requestId);
          const endpoint = message.grant.endpoint;
          const helper = message.grant.helper;
          log(
            `Main granted ${message.grant.modelId} (${endpoint.kind}, generation ${message.grant.generation}) for ${message.requestId}${helper === undefined ? "" : `, with the helper model ${helper.modelId} for side requests`}.`,
          );
          answered?.resolve(entry);
          return;
        }
        case "model-refused": {
          const answered = settle(message.requestId);
          log(`Main refused ${message.requestId}: ${message.message}`);
          answered?.reject(new ModelRefused(message.message, message.retryable));
          return;
        }
      }
    },

    describe(modelId) {
      const entry = held.get(modelId);
      if (entry === undefined) return null;
      return { kind: entry.grant.endpoint.kind, url: safeUrl(entry.grant.endpoint.baseUrl) };
    },

    serverName(modelId) {
      return (
        held.get(modelId)?.grant.endpoint.model ?? helpers.get(modelId)?.endpoint.model ?? null
      );
    },

    catalogProfile(modelId) {
      return held.get(modelId)?.grant.profile ?? helpers.get(modelId)?.profile ?? null;
    },

    close() {
      if (closed) return;
      closed = true;
      for (const id of [...waiting.keys()]) settle(id)?.reject(stopping());
    },
  };
}

function stopping(): ModelWaitFailed {
  return new ModelWaitFailed("The engine is stopping.");
}

/** Resolves or rejects with `promise`, or rejects with an "aborted" error once `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function aborted(): ModelError {
  return new ModelError("aborted", "The request was stopped while it waited for the model.");
}

/**
 * For a request in a turn. Main's refusal, and a wait that ran out, are "unavailable" model
 * errors: the person sees their message as it is. The turn loop sends a retryable one once more.
 */
function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof ModelRefused) {
    return new ModelError("unavailable", error.message, { retryable: error.retryable });
  }
  if (error instanceof ModelWaitFailed) {
    return new ModelError("unavailable", error.message, { retryable: true });
  }
  return new ModelError("connection", messageOf(error), { retryable: true, cause: error });
}

/** For creating, resuming or switching a session: the client sees the message as it is. */
function toRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError("InvalidState", messageOf(error), { cause: error });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return value >= 1 ? `${value} minute${value === 1 ? "" : "s"}` : `${Math.round(ms / 1000)} s`;
}

function sameSlots(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((slot, index) => slot === b[index]);
}

/** A URL for display: no credentials, no query. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}
