/**
 * The mock engine: serves the protocol over any number of transports and plays the recorded
 * sessions behind it. A client cannot tell it from the real engine except by what it says.
 *
 * Playback runs in the engine, not per connection: sessions with a `live` recording start
 * playing when the first connection initializes (see `startPlayback`), keep playing when
 * connections close, and a connection that opens a session gets a snapshot plus every event
 * from then on.
 */
import {
  createServer,
  type EngineEvent,
  ErrorCodes,
  EVENT_NAMES,
  type ForkPoint,
  type Handlers,
  METHOD_NAMES,
  type ParsedParams,
  type PendingRequest,
  type Prompt,
  RpcError,
  type Server,
  type SessionSnapshot,
  type Transport,
} from "@dawg/protocol";
import { findMockModel, MOCK_DEFAULT_MODEL_ID } from "../shared/mock-models.ts";
import type { MockClock, MockConnection, MockEngine, MockEngineOptions } from "./api.ts";
import { byteLength, outputPage } from "./background.ts";
import { realClock } from "./clock.ts";
import { contextText, helpText } from "./commands.ts";
import { type LoadedScenario, pickBranch } from "./format.ts";
import {
  breakdownAfter,
  compactionSummary,
  contextAfterCompaction,
  type Decision,
  decisionResult,
  genericContinuation,
  genericTurn,
  IDLE,
  interruptTurn,
  modeAfterPlan,
  type Pace,
  titleFrom,
  WORKING,
} from "./generate.ts";
import { idsIn, newSessionId } from "./ids.ts";
import { expandHome } from "./paths.ts";
import { Player, type Step, scaledDelay } from "./player.ts";
import {
  MockSession,
  type RecordedContext,
  type SessionSettings,
  type Subscriber,
} from "./session.ts";
import { requestIdOf, toolCallOf } from "./state.ts";
import { compactAtFor } from "./usage.ts";

/**
 * The status line while a turn waits for the model, as the real engine words it. Clients go by
 * `queuePosition`, not by this text.
 */
export const QUEUED_MESSAGE = "Waiting for the model";
const DEFAULT_ENGINE_INFO = { name: "dawg mock engine", version: "0.0.0" };
/** A queued session starts this long after the model is free (at speed 1). */
const QUEUE_HANDOFF_MS = 500;
const COMPACTION_MS = 1_800;

interface Connection {
  readonly transport: Transport;
  readonly open: Set<string>;
  readonly subscriber: Subscriber;
}

export interface EngineOptions extends MockEngineOptions {
  /**
   * When the live parts start playing (and queued sessions start waiting):
   * - "first-initialize" (default): when the first connection's `initialize` succeeds. The
   *   engine host starts before any window connects, so a window that opens still sees the live
   *   sessions working, and a short live turn finishes while someone is looking.
   * - "created": at once, for tests that play recordings without a client.
   * Stored times are relative to the engine's creation either way.
   */
  startPlayback?: "first-initialize" | "created";
}

export function createMockEngine(options: EngineOptions): MockEngine {
  return new Engine(options);
}

class Engine implements MockEngine {
  readonly #clock: MockClock;
  readonly #speed: number;
  readonly #homeDir: string;
  readonly #engineInfo: { name: string; version: string };
  readonly #sessions = new Map<string, MockSession>();
  readonly #connections = new Set<Connection>();
  readonly #pace: Pace;
  /** Sessions made from scenarios, in the order given. */
  readonly #scenarioSessions: MockSession[];
  #playbackStarted = false;
  #disposed = false;

  constructor(options: EngineOptions) {
    this.#clock = options.clock ?? realClock;
    const speed = options.speed ?? 1;
    this.#speed = speed > 0 ? speed : 1;
    this.#homeDir = options.homeDir;
    this.#engineInfo = options.engineInfo ?? DEFAULT_ENGINE_INFO;
    this.#pace = { speed: this.#speed, random: seededRandom(0x5eed) };
    const start = this.#clock.now();
    this.#scenarioSessions = (options.scenarios ?? []).map((loaded) =>
      this.#addScenario(loaded, start),
    );
    if (options.startPlayback === "created") this.#startPlayback();
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  connect(transport: Transport): MockConnection {
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    transport.onClose(() => resolveClosed());
    if (this.#disposed) {
      transport.close();
      return { close: () => {}, closed };
    }
    let server: Server | null = null;
    const connection: Connection = {
      transport,
      open: new Set(),
      subscriber: {
        send: (event) => {
          try {
            // One event of the union at a time; its payload matches its name by construction.
            server?.notify(event.event, event.payload as never);
          } catch {
            // An event that fails its schema is a bug in a recording; the tests catch it.
          }
        },
      },
    };
    server = createServer(transport, this.#handlers(connection), { onProblem: () => {} });
    this.#connections.add(connection);
    transport.onClose(() => {
      this.#connections.delete(connection);
      for (const id of connection.open)
        this.#sessions.get(id)?.subscribers.delete(connection.subscriber);
      connection.open.clear();
    });
    return { close: () => transport.close(), closed };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of this.#sessions.values()) {
      session.player?.stop();
      session.player = null;
      session.queue = null;
    }
    for (const connection of [...this.#connections]) connection.transport.close();
  }

  /** Starts the scenarios' live parts, once; queued ones wait for the session they are behind. */
  #startPlayback(): void {
    if (this.#playbackStarted || this.#disposed) return;
    this.#playbackStarted = true;
    const sessions = this.#scenarioSessions;
    for (const session of sessions) {
      if (session.scenario?.scenario.queuedBehind == null) this.#startLive(session);
    }
    for (const session of sessions) {
      const behind = session.scenario?.scenario.queuedBehind;
      if (behind == null) continue;
      const blocker = this.#sessions.get(behind);
      if (
        blocker !== undefined &&
        (blocker.state.turn !== null || (blocker.player?.active ?? false))
      ) {
        session.queue = { behind };
      } else {
        this.#startLive(session);
      }
    }
    this.#reportQueue();
  }

  /**
   * Tells each session waiting for the model its place in line (1 = next), in scenario order,
   * when it changed. A session leaves the line when its live part starts playing.
   */
  #reportQueue(): void {
    const waiting = this.#scenarioSessions.filter(
      (session) => session.queue !== null && this.#sessions.has(session.id),
    );
    waiting.forEach((session, index) => {
      const position = index + 1;
      const { state } = session;
      if (
        state.status === "working" &&
        state.statusMessage === QUEUED_MESSAGE &&
        state.queuePosition === position
      ) {
        return;
      }
      session.emit("session.status", {
        ...WORKING,
        message: QUEUED_MESSAGE,
        queuePosition: position,
      });
    });
  }

  #addScenario(loaded: LoadedScenario, start: number): MockSession {
    const scenario = expandHome(loaded.scenario, this.#homeDir);
    const recordings: Record<string, EngineEvent[]> = {};
    for (const [name, events] of Object.entries(loaded.recordings)) {
      recordings[name] = expandHome(events, this.#homeDir);
    }
    const named = [
      scenario.stored,
      scenario.live,
      ...scenario.turns,
      ...Object.values(scenario.branches).flatMap((table) => Object.values(table)),
    ];
    for (const name of named) {
      if (name !== null && recordings[name] === undefined) {
        throw new Error(`Scenario ${scenario.id} names a recording it does not have: ${name}`);
      }
    }
    if (this.#sessions.has(scenario.id))
      throw new Error(`Two scenarios have the id ${scenario.id}`);

    const stored = scenario.stored === null ? [] : (recordings[scenario.stored] ?? []);
    const endedAt = start - scenario.storedEndedAgoMs;
    const last = stored.at(-1);
    const first = stored[0];
    const offset = last === undefined ? 0 : endedAt - last.payload.time;
    const session = new MockSession(
      {
        id: scenario.id,
        settings: { ...scenario.session, archived: false, additionalDirectories: [] },
        createdAt: first === undefined ? endedAt : first.payload.time + offset,
      },
      this.#hooks(),
    );
    session.scenario = { scenario, recordings };
    for (const [taskId, output] of Object.entries(scenario.backgroundOutput ?? {})) {
      session.backgroundOutput.set(taskId, output);
    }
    for (const template of stored) {
      const event = {
        event: template.event,
        payload: session.ids.remap(template.payload),
      } as EngineEvent;
      const requestId = raisedRequestId(event);
      if (requestId !== null) {
        session.origins.set(requestId, {
          recordedId: raisedRequestId(template) ?? requestId,
          scope: session.ids,
        });
      }
      session.load(event, template.payload.time + offset, { applySettings: true });
    }
    this.#sessions.set(session.id, session);
    return session;
  }

  #hooks() {
    return {
      clock: this.#clock,
      onTurnEnded: (session: MockSession) => this.#onTurnEnded(session),
    };
  }

  /** After a turn: the title made from the first prompt, and sessions queued behind this one. */
  #onTurnEnded(session: MockSession): void {
    const title = session.pendingTitle;
    session.pendingTitle = null;
    if (title !== null && session.settings.title === null) {
      session.updateSettings({ title }, ["title"]);
    }
    this.#startQueuedBehind(session.id);
  }

  /** The model is free: sessions waiting behind this one start, the rest move up in line. */
  #startQueuedBehind(sessionId: string): void {
    for (const queued of this.#sessions.values()) {
      if (queued.queue?.behind !== sessionId) continue;
      queued.queue = null;
      this.#startLive(queued, scaledDelay(QUEUE_HANDOFF_MS, this.#speed));
    }
    this.#reportQueue();
  }

  #startLive(session: MockSession, firstDelay?: number): void {
    const scenario = session.scenario;
    if (this.#disposed || scenario === null || scenario.scenario.live === null) return;
    const events = scenario.recordings[scenario.scenario.live] ?? [];
    const storedName = scenario.scenario.stored;
    const lastStored = storedName === null ? undefined : scenario.recordings[storedName]?.at(-1);
    const gap =
      lastStored === undefined || events[0] === undefined
        ? 0
        : events[0].payload.time - lastStored.payload.time;
    this.#playRecording(session, events, {
      ctx: { scope: session.ids },
      firstDelay: firstDelay ?? scaledDelay(gap, this.#speed),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------------------------

  /**
   * Plays recorded events in a session. With `syncUntilTurn`, the events up to the turn's
   * `turn.started` are sent at once (from the request handler, as the real engine does), so the
   * turn id is known when the prompt is answered.
   */
  #playRecording(
    session: MockSession,
    events: readonly EngineEvent[],
    options: {
      ctx: RecordedContext;
      firstDelay?: number;
      skipFirst?: boolean;
      syncUntilTurn?: boolean;
    },
  ): void {
    const steps: Step[] = events.map((event, i) => {
      const previous = events[i - 1];
      return {
        delay:
          previous === undefined
            ? (options.firstDelay ?? 0)
            : scaledDelay(event.payload.time - previous.payload.time, this.#speed),
        run: () => session.emitRecorded(event, options.ctx),
      };
    });
    let rest = options.skipFirst ? steps.slice(1) : steps;
    if (options.syncUntilTurn) {
      const played = options.skipFirst ? events.slice(1) : events;
      const turnIndex = played.findIndex((event) => event.event === "turn.started");
      for (const step of rest.slice(0, turnIndex + 1)) step.run();
      rest = rest.slice(turnIndex + 1);
    }
    this.#play(session, rest);
  }

  #play(session: MockSession, steps: Step[]): void {
    session.player?.stop();
    const player = new Player(this.#clock, steps, () => {
      if (session.player === player) session.player = null;
    });
    session.player = player;
    player.start();
  }

  // -------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------

  #handlers(connection: Connection): Partial<Handlers> {
    return {
      initialize: (params) => {
        // Only scheduled here: the first events reach the client after this answer.
        this.#startPlayback();
        return {
          protocolVersion: params.protocolVersion,
          engine: { ...this.#engineInfo },
          capabilities: {
            methods: [...METHOD_NAMES],
            events: [...EVENT_NAMES],
            maxMessageLength: null,
          },
        };
      },
      "session.list": (params) => this.#list(params),
      "session.create": (params) => this.#create(connection, params),
      "session.resume": (params) => this.#open(connection, this.#get(params.sessionId)).snapshot(),
      "session.fork": (params) => this.#fork(connection, params),
      "session.rename": (params) => {
        const session = this.#get(params.sessionId);
        session.pendingTitle = null;
        session.updateSettings({ title: params.title }, ["title"]);
        return { session: session.summary() };
      },
      "session.archive": (params) => {
        const session = this.#get(params.sessionId);
        session.updateSettings({ archived: params.archived ?? true }, ["archived"]);
        return { session: session.summary() };
      },
      "session.delete": (params) => {
        this.#delete(this.#get(params.sessionId));
        return {};
      },
      "session.prompt": (params) =>
        this.#prompt(this.#openHere(connection, params.sessionId), params.prompt),
      "session.interrupt": (params) => ({
        interrupted: this.#interrupt(this.#openHere(connection, params.sessionId)),
      }),
      "session.setMode": (params) => {
        const session = this.#openHere(connection, params.sessionId);
        if (params.mode !== session.settings.mode)
          session.updateSettings({ mode: params.mode }, ["mode"]);
        return { mode: session.settings.mode };
      },
      "session.setModel": (params) =>
        this.#setModel(this.#openHere(connection, params.sessionId), params.model),
      "session.setEffort": (params) =>
        this.#setEffort(this.#openHere(connection, params.sessionId), params.effort),
      "session.command": (params) => this.#command(connection, params),
      "session.replay": (params) => {
        const session = this.#get(params.sessionId);
        const after = session.log.filter((event) => event.payload.seq > params.afterSeq);
        const page = params.limit === undefined ? after : after.slice(0, params.limit);
        return { events: page, lastSeq: session.lastSeq, hasMore: page.length < after.length };
      },
      "background.output": (params) => {
        const session = this.#openHere(connection, params.sessionId);
        const task = backgroundTask(session, params.taskId);
        const output = session.backgroundOutput.get(task.taskId) ?? "";
        const page = outputPage(output, params.offset, params.limit);
        return { ...page, done: task.status !== "running" && page.nextOffset >= page.totalBytes };
      },
      "background.stop": (params) => {
        const session = this.#openHere(connection, params.sessionId);
        const task = backgroundTask(session, params.taskId);
        if (task.status !== "running") return { stopped: false };
        // As the real engine stops one: interrupted, and the shell ends by that signal.
        const output = session.backgroundOutput.get(task.taskId) ?? "";
        session.emit("background.updated", {
          task: {
            ...task,
            status: "stopped",
            stopReason: "requested",
            signal: "SIGINT",
            endedAt: Math.max(task.startedAt, this.#clock.now()),
            outputBytes: Math.max(task.outputBytes, byteLength(output)),
          },
        });
        return { stopped: true };
      },
      "permission.respond": (params) =>
        this.#respond(connection, params, { kind: "permission", response: params.response }),
      "question.respond": (params) =>
        this.#respond(connection, params, { kind: "question", response: params.response }),
      "plan.respond": (params) =>
        this.#respond(connection, params, { kind: "plan", response: params.response }),
    };
  }

  #get(sessionId: string): MockSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RpcError(ErrorCodes.SessionNotFound, `No session has the id ${sessionId}`);
    }
    return session;
  }

  /** The session, which must be open on this connection. */
  #openHere(connection: Connection, sessionId: string): MockSession {
    const session = this.#get(sessionId);
    if (!connection.open.has(sessionId)) {
      throw new RpcError(
        ErrorCodes.InvalidState,
        `Session ${sessionId} is not open on this connection; resume it first`,
      );
    }
    return session;
  }

  /** Opens a session on a connection: from now on the connection gets its events. */
  #open(connection: Connection, session: MockSession): MockSession {
    connection.open.add(session.id);
    session.subscribers.add(connection.subscriber);
    return session;
  }

  #list(params: ParsedParams<"session.list">) {
    const projectDir = params.projectDir?.replace(/\/+$/, "");
    const query = params.query?.trim().toLowerCase() ?? "";
    let offset = 0;
    if (params.cursor !== undefined) {
      if (!/^\d+$/.test(params.cursor)) {
        throw new RpcError(ErrorCodes.InvalidParams, "The cursor is not one this engine gave out");
      }
      offset = Number(params.cursor);
    }
    const all = [...this.#sessions.values()]
      .map((s) => s.summary())
      .filter((s) => projectDir === undefined || s.projectDir === projectDir)
      .filter((s) => params.includeArchived === true || !s.archived)
      .filter((s) => query === "" || (s.title?.toLowerCase().includes(query) ?? false))
      .sort(
        (a, b) =>
          b.lastActivityAt - a.lastActivityAt ||
          b.createdAt - a.createdAt ||
          a.id.localeCompare(b.id),
      );
    const limit = params.limit ?? all.length;
    const sessions = all.slice(offset, offset + limit);
    const end = offset + sessions.length;
    return { sessions, nextCursor: end < all.length ? String(end) : null };
  }

  #create(connection: Connection, params: ParsedParams<"session.create">): SessionSnapshot {
    const model = params.model ?? MOCK_DEFAULT_MODEL_ID;
    const info = findMockModel(model)?.info;
    if (info === undefined) throw new RpcError(ErrorCodes.InvalidParams, `Unknown model ${model}`);
    const effort = params.effort ?? null;
    if (effort !== null && !info.effortLevels.includes(effort)) {
      throw new RpcError(
        ErrorCodes.InvalidParams,
        `${model} accepts the effort levels ${info.effortLevels.join(", ")}, not ${effort}`,
      );
    }
    const session = this.#newSession({
      title: params.title ?? null,
      cwd: params.cwd,
      projectDir: params.projectDir ?? params.cwd,
      mode: params.mode ?? "default",
      model,
      effort,
      archived: false,
      additionalDirectories: params.additionalDirectories ?? [],
    });
    return this.#open(connection, session).snapshot();
  }

  #newSession(settings: SessionSettings, forkedFrom?: MockSession["forkedFrom"]): MockSession {
    const now = this.#clock.now();
    const session = new MockSession(
      { id: newSessionId(now), settings, createdAt: now, forkedFrom: forkedFrom ?? null },
      this.#hooks(),
    );
    this.#sessions.set(session.id, session);
    return session;
  }

  #fork(connection: Connection, params: ParsedParams<"session.fork">): SessionSnapshot {
    const parent = this.#get(params.sessionId);
    const point: ForkPoint = params.point ?? { position: "end" };
    const cut = forkCut(parent, point);
    const title =
      params.title ?? (parent.settings.title === null ? null : `${parent.settings.title} (fork)`);
    const child = this.#newSession(
      { ...parent.settings, title, cwd: params.cwd ?? parent.settings.cwd, archived: false },
      { sessionId: parent.id, point },
    );
    for (const event of parent.log.slice(0, cut)) {
      // Background commands stay with the parent, as in the real engine.
      if (event.event === "background.updated") continue;
      for (const id of idsIn(event.payload)) child.ids.reserve(id);
      child.load(event, event.payload.time, { applySettings: false });
    }
    child.lastActivityAt = child.createdAt;
    return this.#open(connection, child).snapshot();
  }

  #prompt(session: MockSession, prompt: Prompt): { turnId: string } {
    if (session.busy) {
      throw new RpcError(
        ErrorCodes.SessionBusy,
        "A turn is running; wait for it to end or interrupt it",
      );
    }
    if (session.state.turns === 0 && session.settings.title === null)
      session.pendingTitle = titleFrom(prompt);
    const scenario = session.scenario;
    const name = scenario?.scenario.turns[session.nextTurn];
    const events = name === undefined ? undefined : scenario?.recordings[name];
    if (events?.some((event) => event.event === "turn.started")) {
      session.nextTurn += 1;
      this.#playRecording(session, events, {
        ctx: { scope: session.ids.child(), prompt },
        syncUntilTurn: true,
      });
      return { turnId: session.state.turn?.turnId ?? "" };
    }
    const { turnId, steps } = genericTurn(session, this.#pace, prompt);
    this.#play(session, steps);
    return { turnId };
  }

  #interrupt(session: MockSession): boolean {
    const compaction = session.state.compaction;
    if (compaction !== null) {
      session.player?.stop();
      session.player = null;
      session.emit("compaction.finished", {
        compactionId: compaction.compactionId,
        outcome: "interrupted",
        summary: null,
        contextBefore: compaction.contextUsed,
        contextAfter: null,
        error: null,
      });
      session.emit("session.status", IDLE);
      return true;
    }
    if (session.state.turn === null) return false;
    session.player?.stop();
    session.player = null;
    const wasQueued = session.queue !== null;
    session.queue = null;
    interruptTurn(session, this.#clock.now());
    if (wasQueued) this.#reportQueue();
    return true;
  }

  /**
   * Deletes a session for good. A running turn or compaction is interrupted first; then every
   * connection that has the session open gets `session.deleted`, its last event, and the session
   * is gone: later calls on it fail with SessionNotFound. Forks keep their own copy of the events.
   */
  #delete(session: MockSession): void {
    this.#interrupt(session);
    session.player?.stop();
    session.player = null;
    session.queue = null;
    session.emit("session.deleted", {});
    session.subscribers.clear();
    for (const connection of this.#connections) connection.open.delete(session.id);
    this.#sessions.delete(session.id);
    this.#startQueuedBehind(session.id);
  }

  #setModel(session: MockSession, model: string) {
    if (session.state.turn !== null || session.state.compaction !== null) {
      throw new RpcError(ErrorCodes.SessionBusy, "The model cannot change while a turn runs");
    }
    const info = findMockModel(model)?.info;
    if (info === undefined) throw new RpcError(ErrorCodes.InvalidParams, `Unknown model ${model}`);
    const changed = ["model"];
    const changes: Partial<SessionSettings> = { model };
    const effort = session.settings.effort;
    if (effort !== null && !info.effortLevels.includes(effort)) {
      changes.effort = null;
      changed.push("effort");
    }
    session.updateSettings(changes, changed);
    return { model, modelInfo: info, effort: session.settings.effort };
  }

  #setEffort(session: MockSession, effort: string | null) {
    const levels = session.modelInfo?.effortLevels;
    if (effort !== null && levels !== undefined && !levels.includes(effort)) {
      throw new RpcError(
        ErrorCodes.InvalidState,
        levels.length === 0
          ? "This model has no effort levels."
          : `Effort must be one of: ${levels.join(", ")}.`,
      );
    }
    if (effort !== session.settings.effort) session.updateSettings({ effort }, ["effort"]);
    return { effort: session.settings.effort };
  }

  #command(connection: Connection, params: ParsedParams<"session.command">) {
    const session = this.#openHere(connection, params.sessionId);
    const none = { output: null, turnId: null, openedSession: null };
    switch (params.name) {
      case "help":
        return { ...none, output: helpText(params.args) };
      case "context":
        return { ...none, output: contextText(session) };
      case "compact":
        this.#requireIdle(session, "Compacting");
        this.#compact(session, params.args.trim() === "" ? null : params.args.trim());
        return none;
      case "clear": {
        this.#requireIdle(session, "Clearing");
        const name = params.args.trim();
        if (name !== "") session.updateSettings({ title: name }, ["title"]);
        const next = this.#newSession({ ...session.settings, title: null, archived: false });
        return {
          output: "Started a new conversation. The previous one stays in the list.",
          turnId: null,
          openedSession: this.#open(connection, next).snapshot(),
        };
      }
      default:
        throw new RpcError(
          ErrorCodes.InvalidParams,
          `There is no command /${params.name}. Type /help for the list.`,
        );
    }
  }

  #requireIdle(session: MockSession, what: string): void {
    if (session.busy)
      throw new RpcError(ErrorCodes.SessionBusy, `${what} has to wait until the turn ends`);
  }

  /** `/compact`: working, `compaction.started` at once; the result a moment later. */
  #compact(session: MockSession, focus: string | null): void {
    const usage = session.state.usage;
    const before = usage?.contextUsed ?? 0;
    const window = session.modelInfo?.contextWindow ?? usage?.contextWindow ?? 0;
    const compactionId = session.ids.fresh("compaction");
    session.emit("session.status", { ...WORKING, message: "Compacting the conversation" });
    session.emit("compaction.started", {
      compactionId,
      trigger: "manual",
      turnId: null,
      contextUsed: before,
      contextWindow: window,
      focus,
    });
    this.#play(session, [
      {
        delay: scaledDelay(COMPACTION_MS, this.#speed),
        run: () => {
          const after = contextAfterCompaction(before);
          session.emit("compaction.finished", {
            compactionId,
            outcome: "completed",
            summary: compactionSummary(session),
            contextBefore: before,
            contextAfter: after,
            error: null,
          });
          const totals = session.state.usage?.totals;
          const summaryTokens = 1_180;
          session.emit("usage.updated", {
            usage: {
              contextWindow: window,
              contextUsed: after,
              last: session.state.usage?.last ?? {
                promptTokens: null,
                completionTokens: null,
                cachedTokens: null,
                promptTokensPerSecond: null,
                completionTokensPerSecond: null,
              },
              totals: {
                requests: (totals?.requests ?? 0) + 1,
                promptTokens: (totals?.promptTokens ?? 0) + before,
                completionTokens: (totals?.completionTokens ?? 0) + summaryTokens,
                cachedTokens: (totals?.cachedTokens ?? 0) + before,
                malformedToolCalls: totals?.malformedToolCalls ?? 0,
              },
              compactAt: compactAtFor(window),
              breakdown: breakdownAfter(session, after),
            },
          });
          session.emit("session.status", IDLE);
        },
      },
    ]);
  }

  #respond(
    connection: Connection,
    params: { sessionId: string; requestId: string },
    decision: Decision,
  ): Record<string, never> {
    const session = this.#openHere(connection, params.sessionId);
    const request = session.state.pending.get(params.requestId);
    if (request === undefined || request.kind !== decision.kind) {
      throw new RpcError(
        ErrorCodes.RequestNotFound,
        `No ${decision.kind} request ${params.requestId} is waiting for an answer`,
      );
    }
    emitAnswer(session, request.turnId, params.requestId, decision);
    if (session.player?.active) {
      // The recording that raised it is still playing and resolves it itself; let it go on.
      session.answeredEarly.add(params.requestId);
      return {};
    }
    this.#continueAfter(session, request, decision);
    return {};
  }

  /** The recorded branch for this answer, or a generated end of the turn when there is none. */
  #continueAfter(session: MockSession, request: PendingRequest, decision: Decision): void {
    const requestId = requestIdOf(request);
    const origin = session.origins.get(requestId);
    const scenario = session.scenario;
    const table = origin === undefined ? undefined : scenario?.scenario.branches[origin.recordedId];
    const name = pickBranch(table, decision);
    const events = name === null ? undefined : scenario?.recordings[name];
    if (origin === undefined || events === undefined || events.length === 0) {
      this.#play(session, genericContinuation(session, this.#pace, request, decision));
      return;
    }
    const mode =
      decision.kind === "plan" ? modeAfterPlan(session, request, decision.response) : null;
    const allowed = decision.kind === "permission" && decision.response.behavior === "allow";
    const result = decisionResult(request, decision, mode ?? session.settings.mode);
    this.#playRecording(session, events, {
      ctx: {
        scope: origin.scope.child(),
        decision: {
          toolCallId: toolCallOf(request),
          content: allowed ? null : result.content,
          ...(mode === null ? {} : { mode }),
        },
      },
      skipFirst: events[0]?.event === "request.resolved",
    });
  }
}

/** `request.resolved` with the answer actually given. */
function emitAnswer(
  session: MockSession,
  turnId: string,
  requestId: string,
  decision: Decision,
): void {
  const base = { turnId, requestId, outcome: "answered" as const };
  switch (decision.kind) {
    case "permission":
      session.emit("request.resolved", {
        ...base,
        kind: "permission",
        response: decision.response,
      });
      return;
    case "question":
      session.emit("request.resolved", { ...base, kind: "question", response: decision.response });
      return;
    case "plan":
      session.emit("request.resolved", { ...base, kind: "plan", response: decision.response });
      return;
  }
}

/** The id of the request an event raises, or null. */
function raisedRequestId(event: EngineEvent): string | null {
  switch (event.event) {
    case "permission.requested":
      return event.payload.request.requestId;
    case "question.asked":
    case "plan.proposed":
      return event.payload.requestId;
    default:
      return null;
  }
}

/**
 * Where a fork stops copying, as an index into the parent's log. Turns are copied whole: a cut
 * falls before the status that started a turn, never inside one.
 */
function forkCut(parent: MockSession, point: ForkPoint): number {
  const log = parent.log;
  const starts = new Map<string, number>();
  log.forEach((event, i) => {
    if (event.event === "turn.started") {
      let start = i;
      while (start > 0 && isWorkingStatus(log[start - 1])) start -= 1;
      starts.set(event.payload.turnId, start);
    }
  });
  const active = parent.state.turn?.turnId ?? null;
  if (point.position === "end") {
    return active === null ? log.length : (starts.get(active) ?? log.length);
  }
  const start = starts.get(point.turnId);
  if (start === undefined) {
    throw new RpcError(ErrorCodes.InvalidState, `The session has no turn ${point.turnId}`);
  }
  if (point.position === "beforeTurn") return start;
  if (point.turnId === active) {
    throw new RpcError(ErrorCodes.InvalidState, `Turn ${point.turnId} is still running`);
  }
  // Everything up to the next turn, so notes between turns (a title, a compaction) come along.
  const later = [...starts.values()].filter((s) => s > start);
  return later.length > 0 ? Math.min(...later) : log.length;
}

/** A background command of the session, or InvalidParams naming the unknown id. */
function backgroundTask(session: MockSession, taskId: string) {
  const task = session.state.background.get(taskId);
  if (task === undefined) {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      `There is no background task ${taskId} in this session.`,
    );
  }
  return task;
}

function isWorkingStatus(event: EngineEvent | undefined): boolean {
  return event?.event === "session.status" && event.payload.status === "working";
}

/** mulberry32, for generated pacing that is the same on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
