/**
 * One session in the mock engine: its settings, its event log, what the log adds up to, and the
 * connections that have it open. Every event goes through `emit`, which numbers it, folds it into
 * the state and sends it to those connections, in that order.
 */
import type {
  BackgroundTask,
  CommandInfo,
  EngineEvent,
  EventName,
  ModelInfo,
  PermissionMode,
  Prompt,
  SessionSnapshot,
  SessionSummary,
  Usage,
} from "@dawg/protocol";
import { findMockModel } from "../shared/mock-models.ts";
import type { MockClock } from "./api.ts";
import { withOutput } from "./background.ts";
import type { LoadedScenario } from "./format.ts";
import { IdScope } from "./ids.ts";
import type { Player } from "./player.ts";
import { SessionState } from "./state.ts";
import type { Fields } from "./types.ts";
import { compactAtFor, contextBreakdown } from "./usage.ts";

export interface SessionSettings {
  title: string | null;
  cwd: string;
  projectDir: string;
  mode: PermissionMode;
  model: string | null;
  effort: string | null;
  archived: boolean;
  additionalDirectories: string[];
}

const SETTING_KEYS = [
  "title",
  "mode",
  "model",
  "effort",
  "archived",
  "additionalDirectories",
] as const;

/** A connection's side of a session: where its events go. */
export interface Subscriber {
  send(event: EngineEvent): void;
}

export interface SessionHooks {
  clock: MockClock;
  /** A turn ended: `turn.finished` and the status after it were emitted (not for stored events). */
  onTurnEnded(session: MockSession): void;
}

/** The slash commands the mock engine runs, worded as the real engine's. */
export const COMMANDS: readonly CommandInfo[] = [
  { name: "help", description: "Show the commands, or details of one", argumentHint: "[command]" },
  { name: "context", description: "Show where the context window is going", argumentHint: null },
  {
    name: "compact",
    description: "Summarise the conversation to free context, optionally with a focus",
    argumentHint: "[focus]",
  },
  {
    name: "clear",
    description: "Start a new conversation; the current one stays saved",
    argumentHint: "[name]",
  },
];

/** How a recorded event is changed to fit what actually happened. */
export interface RecordedContext {
  scope: IdScope;
  /** Replaces the recorded `turn.started` prompt: the one actually sent. */
  prompt?: Prompt;
  /** The call a decision ended, with its result for the answer actually given. */
  decision?: {
    toolCallId: string;
    content: string | null;
    /** The mode an approved plan continues in; replaces the recorded mode change. */
    mode?: PermissionMode;
    modeApplied?: boolean;
  };
}

export class MockSession {
  readonly id: string;
  settings: SessionSettings;
  readonly createdAt: number;
  readonly forkedFrom: SessionSummary["forkedFrom"];
  readonly log: EngineEvent[] = [];
  readonly state = new SessionState();
  readonly subscribers = new Set<Subscriber>();
  /** Ids of recorded events played in this session. */
  readonly ids = new IdScope();
  lastActivityAt: number;
  /** The recordings behind this session, or null for a session made here. */
  scenario: LoadedScenario | null = null;
  /** Index of the next recording in `scenario.turns`. */
  nextTurn = 0;
  /** What plays now: a recording, a generated reply, a compaction. */
  player: Player | null = null;
  /** Set while `live` waits for another session's turn to end. */
  queue: { behind: string } | null = null;
  /** A title made from the first prompt, set once that turn ends. */
  pendingTitle: string | null = null;
  /** The mode before the session last entered plan mode. */
  modeBeforePlan: PermissionMode = "default";
  /** Emitted request id → its recorded id and the id scope it was raised in. */
  readonly origins = new Map<string, { recordedId: string; scope: IdScope }>();
  /** Requests answered while the recording that raised them still plays. */
  readonly answeredEarly = new Set<string>();
  /** What each background command printed, by task id (the scenario's `backgroundOutput`). */
  readonly backgroundOutput = new Map<string, string>();
  readonly #hooks: SessionHooks;
  #seq = 0;
  #turnEnding = false;

  constructor(
    init: {
      id: string;
      settings: SessionSettings;
      createdAt: number;
      forkedFrom?: SessionSummary["forkedFrom"];
    },
    hooks: SessionHooks,
  ) {
    this.id = init.id;
    this.settings = {
      ...init.settings,
      additionalDirectories: [...init.settings.additionalDirectories],
    };
    this.createdAt = init.createdAt;
    this.lastActivityAt = init.createdAt;
    this.forkedFrom = init.forkedFrom ?? null;
    this.#hooks = hooks;
    if (this.settings.mode !== "plan") this.modeBeforePlan = this.settings.mode;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /** The engine clock's time. */
  now(): number {
    return this.#hooks.clock.now();
  }

  get modelInfo(): ModelInfo | null {
    return findMockModel(this.settings.model)?.info ?? null;
  }

  /**
   * The mode approving a plan returns to unless the answer names one: the mode before plan mode,
   * or the current mode for a plan proposed outside plan mode. "default" stands in for plan.
   */
  get planReturnMode(): PermissionMode {
    const mode = this.settings.mode === "plan" ? this.modeBeforePlan : this.settings.mode;
    return mode === "plan" ? "default" : mode;
  }

  /** A turn or compaction runs, or something is still playing. */
  get busy(): boolean {
    return (
      this.state.turn !== null || this.state.compaction !== null || (this.player?.active ?? false)
    );
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  /** Numbers an event, folds it into the state, and sends it to every subscriber. */
  emit<E extends EventName>(event: E, fields: Fields<E>, time?: number): EngineEvent {
    return this.#append(event, fields, time ?? this.#hooks.clock.now(), false);
  }

  /** A stored event, already in the transcript when the engine started. */
  load(event: EngineEvent, time: number, options: { applySettings: boolean }): void {
    const { sessionId: _s, seq: _q, time: _t, ...fields } = event.payload;
    if (event.event === "session.updated" && options.applySettings) {
      this.#takeSettings(event.payload, event.payload.changed);
    }
    if (event.event === "background.updated") {
      // The task's times move with the event's.
      const shift = time - event.payload.time;
      const task = event.payload.task;
      (fields as { task: BackgroundTask }).task = {
        ...task,
        startedAt: task.startedAt + shift,
        endedAt: task.endedAt === null ? null : task.endedAt + shift,
      };
    }
    this.#append(event.event, fields as Fields<EventName>, time, true);
  }

  #append(event: EventName, fields: object, time: number, stored: boolean): EngineEvent {
    this.#seq += 1;
    const payload = { sessionId: this.id, seq: this.#seq, time, ...fields };
    const e = { event, payload } as EngineEvent;
    this.log.push(e);
    this.state.apply(e, stored);
    this.lastActivityAt = Math.max(this.lastActivityAt, time);
    for (const subscriber of [...this.subscribers]) subscriber.send(e);
    if (event === "turn.finished") {
      this.#turnEnding = true;
    } else if (event === "session.status" && this.#turnEnding) {
      this.#turnEnding = false;
      if (!stored) this.#hooks.onTurnEnded(this);
    }
    return e;
  }

  /**
   * Plays one recorded event, changed to fit the session as it is now: ids renamed, the prompt
   * actually sent, settings and usage continued from the current ones, and a decision's result.
   */
  emitRecorded(template: EngineEvent, ctx: RecordedContext): void {
    const { sessionId: _s, seq: _q, time: _t, ...rest } = template.payload;
    const fields = ctx.scope.remap(rest) as Record<string, unknown>;
    switch (template.event) {
      case "turn.started":
        if (ctx.prompt) fields.prompt = ctx.prompt;
        break;
      case "turn.finished":
        // A turn begun before the engine started ends now; its length is real, not recorded.
        if (this.state.turn?.stored) {
          fields.durationMs = Math.max(0, this.#hooks.clock.now() - this.state.turn.startedAt);
        }
        break;
      case "session.updated":
        this.#playSettings(template.payload, ctx);
        return;
      case "usage.updated":
        fields.usage = this.#continueUsage(template.payload.usage);
        break;
      case "request.resolved": {
        const requestId = String(fields.requestId);
        if (this.answeredEarly.delete(requestId) || !this.state.pending.has(requestId)) return;
        break;
      }
      case "background.updated": {
        // A task starts when its event is played; it ends now, keeping the start it had.
        const task = fields.task as BackgroundTask;
        const now = this.#hooks.clock.now();
        const startedAt = this.state.background.get(task.taskId)?.startedAt ?? now;
        fields.task = {
          ...task,
          startedAt,
          endedAt: task.endedAt === null ? null : Math.max(startedAt, now),
        };
        break;
      }
      case "tool.finished":
        if (ctx.decision?.content != null && fields.toolCallId === ctx.decision.toolCallId) {
          fields.content = [{ type: "text", text: ctx.decision.content }];
        }
        break;
      case "permission.requested": {
        const request = fields.request as { requestId: string };
        this.origins.set(request.requestId, {
          recordedId: template.payload.request.requestId,
          scope: ctx.scope,
        });
        break;
      }
      case "question.asked":
        this.origins.set(String(fields.requestId), {
          recordedId: template.payload.requestId,
          scope: ctx.scope,
        });
        break;
      case "plan.proposed":
        this.origins.set(String(fields.requestId), {
          recordedId: template.payload.requestId,
          scope: ctx.scope,
        });
        // The session's own mode history, which may differ from the recording's.
        fields.modeBeforePlan = this.planReturnMode;
        break;
      default:
        break;
    }
    this.emit(template.event, fields as Fields<EventName>);
  }

  #playSettings(
    recorded: EngineEvent["payload"] & { changed: string[] },
    ctx: RecordedContext,
  ): void {
    const changes = pickSettings(recorded, recorded.changed);
    const decision = ctx.decision;
    if (changes.mode !== undefined && decision?.mode !== undefined && !decision.modeApplied) {
      changes.mode = decision.mode;
      decision.modeApplied = true;
    }
    this.updateSettings(changes, recorded.changed);
  }

  #continueUsage(recorded: Usage): Usage {
    const before = this.state.usage?.totals;
    const last = recorded.last;
    const contextWindow = this.modelInfo?.contextWindow ?? recorded.contextWindow;
    return {
      contextWindow,
      contextUsed: recorded.contextUsed,
      last: { ...last },
      totals: {
        requests: (before?.requests ?? 0) + 1,
        promptTokens: (before?.promptTokens ?? 0) + (last.promptTokens ?? 0),
        completionTokens: (before?.completionTokens ?? 0) + (last.completionTokens ?? 0),
        cachedTokens: (before?.cachedTokens ?? 0) + (last.cachedTokens ?? 0),
        malformedToolCalls: before?.malformedToolCalls ?? recorded.totals.malformedToolCalls,
      },
      compactAt: compactAtFor(contextWindow),
      breakdown: recorded.breakdown ?? contextBreakdown(recorded.contextUsed),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  /** Applies `changes` and emits `session.updated` with the whole settings. */
  updateSettings(changes: Partial<SessionSettings>, changed: readonly string[]): void {
    this.#takeSettings(changes, changed);
    const s = this.settings;
    this.emit("session.updated", {
      title: s.title,
      mode: s.mode,
      model: s.model,
      modelInfo: this.modelInfo,
      effort: s.effort,
      archived: s.archived,
      additionalDirectories: [...s.additionalDirectories],
      changed: [...changed],
    });
  }

  #takeSettings(source: Partial<SessionSettings>, changed: readonly string[]): void {
    const changes = pickSettings(source, changed);
    if (changes.mode !== undefined && changes.mode !== this.settings.mode) {
      if (changes.mode === "plan") this.modeBeforePlan = this.settings.mode;
    }
    this.settings = { ...this.settings, ...changes };
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  summary(): SessionSummary {
    const s = this.settings;
    return {
      id: this.id,
      title: s.title,
      cwd: s.cwd,
      projectDir: s.projectDir,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      status: this.state.status,
      queuePosition: this.state.queuePosition,
      mode: s.mode,
      model: s.model,
      effort: s.effort,
      archived: s.archived,
      forkedFrom: this.forkedFrom,
      lastSeq: this.#seq,
    };
  }

  snapshot(): SessionSnapshot {
    return {
      session: this.summary(),
      modelInfo: this.modelInfo,
      additionalDirectories: [...this.settings.additionalDirectories],
      tasks: this.state.tasks.map((t) => ({ ...t })),
      usage: this.state.usage,
      pending: [...this.state.pending.values()],
      activeTurnId: this.state.turn?.turnId ?? null,
      commands: COMMANDS.map((c) => ({ ...c })),
      background: [...this.state.background.values()].map((task) =>
        withOutput(task, this.backgroundOutput.get(task.taskId)),
      ),
    };
  }
}

/** The named settings fields of a `session.updated`-like object. */
function pickSettings(source: object, changed: readonly string[]): Partial<SessionSettings> {
  const values = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (changed.includes(key) && key in values) out[key] = values[key];
  }
  return out as Partial<SessionSettings>;
}
