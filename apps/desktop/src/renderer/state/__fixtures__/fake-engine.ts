/**
 * A scripted engine for the store and connection tests: the real protocol server
 * (`createServer`) over a message port, with sessions whose events the test emits by hand. It
 * keeps each session's log, status, running turn and pending requests, so `session.resume`,
 * `session.replay` and the answers behave like the engine's.
 */
import {
  createMessagePortTransport,
  createServer,
  type EngineEvent,
  ErrorCodes,
  type EventName,
  type EventPayloadInput,
  type Handlers,
  type MessagePortLike,
  type PendingRequest,
  RpcError,
  type Server,
  type SessionSnapshot,
  type SessionSummary,
} from "@dawg/protocol";
import { makeEvent, makeSnapshot, makeSummary, T0 } from "./streams.ts";

type Fields<E extends EventName> = Omit<EventPayloadInput<E>, "sessionId" | "seq" | "time">;

export interface EngineSession {
  summary: SessionSummary;
  log: EngineEvent[];
  snapshot: Omit<SessionSnapshot, "session">;
  activeTurnId: string | null;
  pending: PendingRequest[];
}

export interface FakeEngineCall {
  method: string;
  params: Record<string, unknown>;
}

interface Connection {
  server: Server;
  open: Set<string>;
}

export interface FakeEngineOptions {
  /** Versions `initialize` accepts. Default: the protocol's. */
  supportedVersions?: number[];
}

export class FakeEngine {
  readonly sessions = new Map<string, EngineSession>();
  readonly calls: FakeEngineCall[] = [];
  /** Per-method overrides, called instead of the default handler. */
  readonly overrides: Partial<Handlers> = {};
  private readonly connections = new Set<Connection>();
  private readonly options: FakeEngineOptions;
  private time = T0;
  private counter = 0;

  constructor(options: FakeEngineOptions = {}) {
    this.options = options;
  }

  addSession(
    id: string,
    summary: Partial<SessionSummary> = {},
    snapshot: Partial<Omit<SessionSnapshot, "session">> = {},
  ): EngineSession {
    const { session: _session, ...rest } = makeSnapshot(makeSummary(id, summary), snapshot);
    const session: EngineSession = {
      summary: makeSummary(id, { ...summary, id, lastSeq: 0 }),
      log: [],
      snapshot: rest,
      activeTurnId: null,
      pending: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  session(id: string): EngineSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`No fake session ${id}`);
    return session;
  }

  /** Appends an event to the session's log and sends it to every connection that has it open. */
  emit<E extends EventName>(sessionId: string, event: E, fields: Fields<E>): EngineEvent {
    const session = this.session(sessionId);
    this.time += 100;
    const built = makeEvent(event, {
      ...fields,
      sessionId,
      seq: session.summary.lastSeq + 1,
      time: this.time,
    } as EventPayloadInput<E>);
    this.track(session, built);
    for (const connection of this.connections) {
      if (connection.open.has(sessionId)) {
        connection.server.notify(event, built.payload as EventPayloadInput<E>);
      }
    }
    return built;
  }

  /** Emits a whole turn's worth of prepared events, renumbered for the session. */
  emitAll(sessionId: string, events: readonly EngineEvent[]): void {
    for (const event of events) {
      const {
        sessionId: _s,
        seq: _seq,
        time: _time,
        ...fields
      } = event.payload as Record<string, unknown>;
      this.emit(sessionId, event.event, fields as Fields<typeof event.event>);
    }
  }

  private track(session: EngineSession, event: EngineEvent): void {
    session.log.push(event);
    const p = event.payload;
    session.summary = { ...session.summary, lastSeq: p.seq, lastActivityAt: p.time };
    switch (event.event) {
      case "session.status":
        session.summary = { ...session.summary, status: event.payload.status };
        break;
      case "session.updated": {
        const u = event.payload;
        session.summary = {
          ...session.summary,
          title: u.title,
          mode: u.mode,
          model: u.model,
          effort: u.effort,
          archived: u.archived,
        };
        break;
      }
      case "turn.started":
        session.activeTurnId = event.payload.turnId;
        break;
      case "turn.finished":
        session.activeTurnId = null;
        break;
      case "permission.requested":
        session.pending.push({ kind: "permission", ...event.payload });
        break;
      case "question.asked":
        session.pending.push({ kind: "question", ...event.payload });
        break;
      case "plan.proposed":
        session.pending.push({ kind: "plan", ...event.payload });
        break;
      case "request.resolved": {
        const id = event.payload.requestId;
        session.pending = session.pending.filter(
          (request) =>
            (request.kind === "permission" ? request.request.requestId : request.requestId) !== id,
        );
        break;
      }
      default:
        break;
    }
  }

  snapshotOf(id: string): SessionSnapshot {
    const session = this.session(id);
    return {
      ...session.snapshot,
      session: session.summary,
      activeTurnId: session.activeTurnId,
      pending: session.pending,
    };
  }

  /** Serves the protocol on one port, as the engine host does. */
  serve(port: MessagePort): void {
    const transport = createMessagePortTransport(port as unknown as MessagePortLike);
    const open = new Set<string>();
    const handlers = this.handlers(open);
    const server = createServer(
      transport,
      handlers,
      this.options.supportedVersions ? { supportedVersions: this.options.supportedVersions } : {},
    );
    const connection: Connection = { server, open };
    this.connections.add(connection);
    server.onClose(() => this.connections.delete(connection));
  }

  /** Closes every connection, as a crashed engine host would. */
  dropConnections(): void {
    for (const connection of [...this.connections]) connection.server.close();
    this.connections.clear();
  }

  /** Forgets every event after `keep` per session, as an engine restarted from scratch would. */
  truncate(sessionId: string, keep: number): void {
    const session = this.session(sessionId);
    const kept = session.log.slice(0, keep);
    session.log = [];
    session.summary = { ...session.summary, lastSeq: 0, status: "idle" };
    session.activeTurnId = null;
    session.pending = [];
    for (const event of kept) this.track(session, event);
  }

  get openConnections(): number {
    return this.connections.size;
  }

  callsOf(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  private newId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private handlers(open: Set<string>): Partial<Handlers> {
    const record = (method: string, params: unknown) => {
      this.calls.push({ method, params: params as Record<string, unknown> });
    };
    const known = (id: string) => {
      const session = this.sessions.get(id);
      if (!session) throw new RpcError(ErrorCodes.SessionNotFound, `No session ${id}`);
      return session;
    };
    const defaults: Partial<Handlers> = {
      initialize: (params) => ({
        protocolVersion: params.protocolVersion,
        engine: { name: "fake engine", version: "1.0.0" },
        capabilities: { methods: [], events: [], maxMessageLength: null },
      }),
      "session.list": (params) => {
        const all = [...this.sessions.values()]
          .map((session) => session.summary)
          .filter((summary) => params.includeArchived || !summary.archived)
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        const start = params.cursor ? Number(params.cursor) : 0;
        const limit = params.limit ?? 100;
        const page = all.slice(start, start + limit);
        const next = start + limit < all.length ? String(start + limit) : null;
        return { sessions: page, nextCursor: next };
      },
      "session.resume": (params) => {
        known(params.sessionId);
        open.add(params.sessionId);
        return this.snapshotOf(params.sessionId);
      },
      "session.create": (params) => {
        const id = this.newId("created");
        this.addSession(id, {
          title: params.title ?? null,
          cwd: params.cwd,
          projectDir: params.projectDir ?? params.cwd,
          createdAt: this.time,
          lastActivityAt: this.time,
        });
        open.add(id);
        // An event before the response: clients must not rely on the order.
        this.emit(id, "session.status", { status: "idle", waitingOn: null, message: null });
        return this.snapshotOf(id);
      },
      "session.fork": (params) => {
        const parent = known(params.sessionId);
        const id = this.newId("fork");
        const fork = this.addSession(id, {
          ...parent.summary,
          title: params.title ?? `${parent.summary.title ?? "Session"} (fork)`,
          forkedFrom: { sessionId: params.sessionId, point: { position: "end" } },
        });
        for (const event of parent.log) {
          this.track(fork, {
            ...event,
            payload: { ...event.payload, sessionId: id, seq: fork.summary.lastSeq + 1 },
          } as EngineEvent);
        }
        open.add(id);
        return this.snapshotOf(id);
      },
      "session.replay": (params) => {
        const session = known(params.sessionId);
        const after = session.log.filter((event) => event.payload.seq > params.afterSeq);
        const limit = params.limit ?? after.length;
        return {
          events: after.slice(0, limit),
          lastSeq: session.summary.lastSeq,
          hasMore: after.length > limit,
        };
      },
      "session.prompt": (params) => {
        const session = known(params.sessionId);
        if (session.activeTurnId !== null) throw new RpcError(ErrorCodes.SessionBusy, "Busy");
        return { turnId: this.newId("turn") };
      },
      "session.interrupt": (params) => ({
        interrupted: known(params.sessionId).activeTurnId !== null,
      }),
      "session.command": (params) => {
        known(params.sessionId);
        if (params.name === "clear") {
          const id = this.newId("cleared");
          const parent = known(params.sessionId);
          this.addSession(id, {
            cwd: parent.summary.cwd,
            projectDir: parent.summary.projectDir,
            title: null,
          });
          open.add(id);
          return { output: null, turnId: null, openedSession: this.snapshotOf(id) };
        }
        if (params.name === "init")
          return { output: null, turnId: this.newId("turn"), openedSession: null };
        return { output: `Output of /${params.name}`, turnId: null, openedSession: null };
      },
      "session.rename": (params) => {
        this.updateSettings(params.sessionId, { title: params.title }, "title", open);
        return { session: known(params.sessionId).summary };
      },
      "session.archive": (params) => {
        this.updateSettings(
          params.sessionId,
          { archived: params.archived ?? true },
          "archived",
          open,
        );
        return { session: known(params.sessionId).summary };
      },
      "session.setMode": (params) => {
        this.updateSettings(params.sessionId, { mode: params.mode }, "mode", open);
        return { mode: params.mode };
      },
      "session.setModel": (params) => {
        this.updateSettings(params.sessionId, { model: params.model }, "model", open);
        return { model: params.model, modelInfo: null, effort: null };
      },
      "session.setEffort": (params) => {
        this.updateSettings(params.sessionId, { effort: params.effort }, "effort", open);
        return { effort: params.effort };
      },
      "permission.respond": (params) => this.answer(params.sessionId, params.requestId),
      "question.respond": (params) => this.answer(params.sessionId, params.requestId),
      "plan.respond": (params) => this.answer(params.sessionId, params.requestId),
    };
    const wrapped: Partial<Handlers> = {};
    for (const [method, handler] of Object.entries(defaults)) {
      (wrapped as Record<string, unknown>)[method] = (params: unknown, context: unknown) => {
        record(method, params);
        const override = (this.overrides as Record<string, unknown>)[method] as
          | ((params: unknown, context: unknown) => unknown)
          | undefined;
        return (override ?? (handler as (params: unknown, context: unknown) => unknown))(
          params,
          context,
        );
      };
    }
    return wrapped;
  }

  /** Changes a session setting; open sessions hear about it through `session.updated`. */
  private updateSettings(
    sessionId: string,
    patch: Partial<SessionSummary>,
    field: string,
    open: Set<string>,
  ): void {
    const session = this.session(sessionId);
    session.summary = { ...session.summary, ...patch };
    if (!open.has(sessionId)) return;
    const { summary } = session;
    this.emit(sessionId, "session.updated", {
      title: summary.title,
      mode: summary.mode,
      model: summary.model,
      modelInfo: session.snapshot.modelInfo,
      effort: summary.effort,
      archived: summary.archived,
      additionalDirectories: session.snapshot.additionalDirectories,
      changed: [field],
    });
  }

  private answer(sessionId: string, requestId: string): Record<string, never> {
    const session = this.sessions.get(sessionId);
    const pending = session?.pending.some(
      (request) =>
        (request.kind === "permission" ? request.request.requestId : request.requestId) ===
        requestId,
    );
    if (!pending) throw new RpcError(ErrorCodes.RequestNotFound, "No such request");
    return {};
  }
}
