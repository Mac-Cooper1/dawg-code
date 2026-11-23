/**
 * The renderer's connection to the engine: a JSON-RPC client over the message port the bridge
 * hands out, kept alive across engine restarts.
 *
 * Catching up follows the protocol's "Replay and reconnecting" rules. Live events of a session
 * are held back while its snapshot and replay are outstanding (and for sessions the store does
 * not know yet, such as one whose `session.create` response has not arrived), then released
 * after the replay; the reducer drops whatever the replay already covered. Everything reaches the
 * store through one batch per animation frame, in arrival order; snapshots and replay pages are
 * flushed at once, so the high-water mark is current before the next replay page is asked for.
 */
import {
  type Client,
  type ClientProtocolProblem,
  createClient,
  createMessagePortTransport,
  type EngineEvent,
  ErrorCodes,
  type MessagePortLike,
  type MethodName,
  type MethodParams,
  type MethodResult,
  RpcError,
  type SessionId,
  type SessionSnapshot,
  type SessionSummary,
} from "@dawg/protocol";
import type { DawgBridge, Unsubscribe } from "../../shared/bridge.ts";
import { createBatcher, type FrameScheduler } from "./batcher.ts";
import type { ConnectionState, EngineSlice, ReducerInput } from "./types.ts";

export const RESTART_NOTICE = "The engine restarted. Sessions were resumed from their transcripts.";

/** Replay page size: big enough to load a long session in a few round trips. */
const REPLAY_PAGE = 2000;
const LIST_PAGE = 500;

export interface SyncInfo {
  /** True when this is a new port after the engine host restarted. */
  restart: boolean;
  /** Sessions that were open on the previous connection, to resume again. */
  wasOpen: SessionId[];
  summaries: SessionSummary[];
}

export interface ConnectionHooks {
  bridge: DawgBridge;
  /** Applies a batch of reducer inputs to the store. */
  dispatch(inputs: ReducerInput[]): void;
  /** The engine part of the store, for high-water marks and open sessions. */
  getSlice(): EngineSlice;
  setConnection(state: ConnectionState): void;
  /** Runs once a port is initialized and the session list is in; opens what should be open. */
  onSynced(info: SyncInfo): Promise<void>;
  notice(text: string, tone: "neutral" | "error"): void;
  scheduleFrame?: FrameScheduler;
  onProblem?(problem: ClientProtocolProblem): void;
}

export interface EngineConnection {
  /** Asks for a port and resolves after the first sync, or once connecting failed. Idempotent. */
  start(): Promise<void>;
  /** Closes the connection and stops listening for ports. */
  stop(): void;
  /** True between a successful `initialize` and the next disconnect. */
  readonly ready: boolean;
  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** Resumes a session and replays it into the store. Deduplicated while one is running. */
  openSession(sessionId: SessionId): Promise<void>;
  /** Applies a snapshot from create, fork or a command, then replays the session. */
  adoptSnapshot(snapshot: SessionSnapshot): Promise<void>;
  /** True while the session's snapshot or replay is outstanding. */
  isSyncing(sessionId: SessionId): boolean;
  /** Hands queued inputs to the store now. */
  flush(): void;
}

export class NotConnectedError extends Error {
  override readonly name = "NotConnectedError";
  constructor() {
    super("dawg-code is not connected to its engine right now.");
  }
}

function describeInitError(error: unknown): string {
  if (error instanceof RpcError && error.code === ErrorCodes.UnsupportedProtocolVersion) {
    const data = error.data as { requested?: number; supported?: number[] } | undefined;
    const supported = data?.supported?.join(" or ");
    const versions =
      data?.requested !== undefined && supported
        ? ` The app speaks protocol version ${data.requested}; the engine speaks ${supported}.`
        : "";
    return `dawg-code and its engine are out of step.${versions} Reinstall dawg-code to fix this.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Could not connect to the engine: ${message}`;
}

export function createEngineConnection(hooks: ConnectionHooks): EngineConnection {
  const batcher = createBatcher<ReducerInput>(
    (inputs) => hooks.dispatch(inputs),
    hooks.scheduleFrame,
  );
  /** Sessions whose events go straight to the batch. Everything else is held back. */
  const live = new Set<SessionId>();
  const held = new Map<SessionId, EngineEvent[]>();
  const syncs = new Map<SessionId, Promise<void>>();
  const unsubscribe: Unsubscribe[] = [];

  let client: Client | null = null;
  /** Bumped for every port; work started for an older port stops at its next step. */
  let generation = 0;
  let ready = false;
  let stopped = false;
  let everConnected = false;
  /** Sessions open before a restart, waiting for the next port. */
  let wasOpen: Set<SessionId> | null = null;
  let started: Promise<void> | null = null;
  let resolveStarted: (() => void) | null = null;

  function settleStart(): void {
    resolveStarted?.();
    resolveStarted = null;
  }

  function handleEvent(event: EngineEvent): void {
    const id = event.payload.sessionId;
    if (live.has(id)) {
      batcher.push({ type: "event", event });
      return;
    }
    const list = held.get(id);
    if (list) list.push(event);
    else held.set(id, [event]);
  }

  function openSessionIds(): SessionId[] {
    const ids = new Set<SessionId>(live);
    for (const id of syncs.keys()) ids.add(id);
    for (const session of Object.values(hooks.getSlice().sessions)) {
      if (session.open) ids.add(session.id);
    }
    return [...ids];
  }

  /** Ends the current connection. Returns the sessions that were open on it. */
  function teardown(): SessionId[] {
    const open = openSessionIds();
    batcher.flush();
    const current = client;
    client = null;
    ready = false;
    generation++;
    live.clear();
    held.clear();
    syncs.clear();
    current?.close();
    hooks.dispatch([{ type: "disconnected" }]);
    return open;
  }

  function rememberOpen(ids: readonly SessionId[]): void {
    wasOpen ??= new Set();
    for (const id of ids) wasOpen.add(id);
  }

  function fail(message: string): void {
    const current = client;
    client = null;
    ready = false;
    generation++;
    current?.close();
    hooks.setConnection({ phase: "failed", message });
    settleStart();
  }

  async function listAll(current: Client): Promise<SessionSummary[]> {
    const all: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await current.request("session.list", {
        limit: LIST_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.sessions);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return all;
  }

  async function connectPort(port: MessagePort, restart: boolean, reopen: SessionId[]) {
    const gen = ++generation;
    const transport = createMessagePortTransport(port as unknown as MessagePortLike);
    const current = createClient(transport, hooks.onProblem ? { onProblem: hooks.onProblem } : {});
    client = current;
    current.onEvent(handleEvent);
    current.onClose(() => {
      // The port closed without a restart notice: treat it as one and wait for a new port.
      if (stopped || client !== current) return;
      rememberOpen(teardown());
      hooks.setConnection({ phase: "restarting", reason: "The connection to the engine closed." });
    });
    if (!restart) hooks.setConnection({ phase: "connecting" });

    let engine: { name: string; version: string };
    try {
      const result = await current.initialize({
        client: { name: "dawg-code", version: hooks.bridge.platform.appVersion },
        capabilities: { permissionPrompts: true, questions: true, planApproval: true },
      });
      engine = result.engine;
    } catch (error) {
      if (gen === generation) fail(describeInitError(error));
      return;
    }
    if (gen !== generation) return;

    let summaries: SessionSummary[];
    try {
      summaries = await listAll(current);
    } catch (error) {
      if (gen !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      fail(`Could not list sessions: ${message}`);
      return;
    }
    if (gen !== generation) return;

    batcher.push({ type: "summaries", sessions: summaries });
    batcher.flush();
    ready = true;
    everConnected = true;
    hooks.setConnection({ phase: "ready", engine });
    try {
      await hooks.onSynced({ restart, wasOpen: reopen, summaries });
    } finally {
      if (gen === generation && restart) hooks.notice(RESTART_NOTICE, "neutral");
      settleStart();
    }
  }

  function onPort(port: MessagePort): void {
    if (stopped) {
      port.close();
      return;
    }
    let restart = wasOpen !== null || everConnected;
    if (client) {
      rememberOpen(teardown());
      restart = true;
    }
    const reopen = [...(wasOpen ?? [])];
    wasOpen = null;
    void connectPort(port, restart, reopen);
  }

  function onRestart(reason: string): void {
    if (stopped) return;
    rememberOpen(client ? teardown() : []);
    hooks.setConnection({ phase: "restarting", reason });
  }

  /** Applies the snapshot, replays from the high-water mark, then releases held events. */
  async function catchUp(current: Client, gen: number, snapshot: SessionSnapshot): Promise<void> {
    const id = snapshot.session.id;
    batcher.push({ type: "snapshot", snapshot });
    batcher.flush();
    let afterSeq = hooks.getSlice().sessions[id]?.highWaterSeq ?? 0;
    for (;;) {
      const page = await current.request("session.replay", {
        sessionId: id,
        afterSeq,
        limit: REPLAY_PAGE,
      });
      if (gen !== generation) return;
      const last = page.events[page.events.length - 1];
      const done = !page.hasMore || last === undefined;
      batcher.push({ type: "replay", sessionId: id, events: page.events, done });
      batcher.flush();
      if (done) break;
      afterSeq = last.payload.seq;
    }
    const events = held.get(id) ?? [];
    held.delete(id);
    for (const event of events) batcher.push({ type: "event", event });
    live.add(id);
    batcher.flush();
  }

  function track(id: SessionId, run: Promise<void>): Promise<void> {
    const tracked = run.finally(() => {
      if (syncs.get(id) === tracked) syncs.delete(id);
    });
    syncs.set(id, tracked);
    return tracked;
  }

  function connected(): { current: Client; gen: number } {
    if (!client || !ready) throw new NotConnectedError();
    return { current: client, gen: generation };
  }

  return {
    start() {
      if (started) return started;
      started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      unsubscribe.push(hooks.bridge.engine.onPort(onPort));
      unsubscribe.push(hooks.bridge.engine.onRestart((info) => onRestart(info.reason)));
      hooks.bridge.engine.connect();
      return started;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const stop of unsubscribe.splice(0)) stop();
      batcher.flush();
      const current = client;
      client = null;
      ready = false;
      generation++;
      live.clear();
      held.clear();
      syncs.clear();
      current?.close();
      settleStart();
    },
    get ready() {
      return ready;
    },
    request(method, params) {
      try {
        return connected().current.request(method, params);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    openSession(sessionId) {
      const running = syncs.get(sessionId);
      if (running) return running;
      let link: { current: Client; gen: number };
      try {
        link = connected();
      } catch (error) {
        return Promise.reject(error);
      }
      live.delete(sessionId);
      return track(
        sessionId,
        (async () => {
          const snapshot = await link.current.request("session.resume", { sessionId });
          if (link.gen !== generation) return;
          await catchUp(link.current, link.gen, snapshot);
        })(),
      );
    },
    adoptSnapshot(snapshot) {
      const id = snapshot.session.id;
      const running = syncs.get(id);
      if (running) return running;
      let link: { current: Client; gen: number };
      try {
        link = connected();
      } catch (error) {
        return Promise.reject(error);
      }
      live.delete(id);
      return track(id, catchUp(link.current, link.gen, snapshot));
    },
    isSyncing(sessionId) {
      return syncs.has(sessionId);
    },
    flush() {
      batcher.flush();
    },
  };
}
