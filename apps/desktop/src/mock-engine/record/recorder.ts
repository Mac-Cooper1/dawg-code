/**
 * A typed builder for recorded sessions. It produces events in exactly the shape the engine
 * emits, with realistic spacing: text and reasoning stream a word or two every 40 to 90 ms,
 * prompts are read at about 1,240 tokens/s (with `prompt.progress` while a long one is read),
 * tool calls take as long as their tools would, and each model request ends with a
 * `usage.updated` whose figures follow from the conversation so far.
 *
 * Recordings branch at decisions: `fork()` copies the whole state (time, seq, usage, open turn,
 * random sequence) into a new recorder, so each continuation picks up exactly where the stored
 * part stopped.
 */
import type {
  EngineEventInput,
  ErrorInfo,
  EventInputMap,
  EventName,
  PermissionMode,
  PermissionResponse,
  PlanResponse,
  QuestionResponse,
  SessionStatus,
  StopReason,
  TaskItem,
  ToolDisplay,
  ToolOutcome,
} from "@dawg/protocol";
import { findMockModel } from "../../shared/mock-models.ts";
import { chunkWords, estimateTokens, Random } from "./text.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event's payload without the fields every event carries. */
export type Fields<E extends EventName> = DistributiveOmit<
  EventInputMap[E],
  "sessionId" | "seq" | "time"
>;

export interface SessionSettings {
  title: string | null;
  mode: PermissionMode;
  model: string | null;
  effort: string | null;
  archived: boolean;
  additionalDirectories: string[];
}

export interface RecorderOptions {
  sessionId: string;
  /** Working directory as fixtures write it ("~/code/..."). */
  cwd: string;
  settings: SessionSettings;
  /** Recorded time of the first event. The engine rebases stored times, so any epoch works. */
  startTime: number;
  seed: number;
  /** Prompt tokens of the system prompt and tool definitions; cached at the first request. */
  prefixTokens?: number;
  /** Project instructions and environment, read (uncached) with the first request. */
  instructionTokens?: number;
}

export interface ToolCall {
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Recorded time of its `tool.started`, once sent. */
  startedAt?: number;
}

export interface RequestSpec {
  /** Uncached prompt tokens beyond what the recorder counted (notes, instruction files). */
  extra?: number;
  /** Show `prompt.progress` while the prompt is read. Default: when over 3,000 tokens must be read. */
  progress?: boolean;
  /** Prompt read speed in tokens per second. Default about 1,240. */
  promptTps?: number;
  /** Exact prompt figures, instead of following from the conversation. */
  prompt?: { total: number; cached: number };
  /** Time before the first token beyond reading the prompt, in ms. */
  latencyMs?: number;
  /**
   * Completion tokens beyond the streamed text: reasoning the recording leaves out to keep the
   * transcript short. Counted in usage (and so in the context); the reported speed stays that
   * of the streamed part.
   */
  completionExtra?: number;
}

export interface ToolRun {
  durationMs: number;
  outcome?: ToolOutcome;
  /** What the model was given, as text. */
  content: string;
  display: ToolDisplay | null;
  /** Live output and status lines, at offsets (ms) from the start of the run. */
  progress?: ToolProgressStep[];
  /** False when `tool.started` was already emitted, as for a call that waited for permission. */
  start?: boolean;
}

export type ToolProgressStep =
  | { at: number; output: string; stream?: "stdout" | "stderr" }
  | { at: number; status: string };

export interface TurnStats {
  turnId: string;
  durationMs: number;
  requests: number;
  /** Share of the turn's prompt tokens read from the cache. */
  cacheRatio: number;
  contextUsed: number;
}

interface UsageState {
  contextUsed: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

interface TurnState {
  turnId: string;
  startedAt: number;
  lastText: string | null;
  requests: number;
  prompt: number;
  cached: number;
}

const CONTEXT_WINDOW = 204_800;
const COMPLETION_TPS = 41;

const STATUS_MESSAGES: Record<"permission" | "question" | "plan", string> = {
  permission: "Waiting for permission",
  question: "Waiting for an answer",
  plan: "Waiting for plan approval",
};

export class Recorder {
  readonly sessionId: string;
  readonly cwd: string;
  readonly #options: RecorderOptions;
  #random: Random;
  #events: EngineEventInput[] = [];
  #time: number;
  #seq = 0;
  #settings: SessionSettings;
  #usage: UsageState = {
    contextUsed: 0,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };
  /** Tokens added to the conversation since the last model request. */
  #pendingTokens = 0;
  #turn: TurnState | null = null;
  #stats: TurnStats[] = [];
  readonly #prefixTokens: number;
  readonly #instructionTokens: number;

  constructor(options: RecorderOptions) {
    this.#options = options;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.#random = new Random(options.seed);
    this.#time = options.startTime;
    this.#settings = { ...options.settings };
    this.#prefixTokens = options.prefixTokens ?? 15_104;
    this.#instructionTokens = options.instructionTokens ?? 1_186;
  }

  get random(): Random {
    return this.#random;
  }

  /** A recorder that continues from exactly this point, with no events of its own yet. */
  fork(): Recorder {
    const copy = new Recorder(this.#options);
    copy.#random = this.#random.clone();
    copy.#time = this.#time;
    copy.#seq = this.#seq;
    copy.#settings = {
      ...this.#settings,
      additionalDirectories: [...this.#settings.additionalDirectories],
    };
    copy.#usage = { ...this.#usage };
    copy.#pendingTokens = this.#pendingTokens;
    copy.#turn = this.#turn === null ? null : { ...this.#turn };
    return copy;
  }

  /** The events recorded since the last `take()`, which starts a new recording. */
  take(): EngineEventInput[] {
    const out = this.#events;
    this.#events = [];
    return out;
  }

  /** Figures of the turns finished since the last `takeStats()` (or the fork). */
  takeStats(): TurnStats[] {
    const out = this.#stats;
    this.#stats = [];
    return out;
  }

  get time(): number {
    return this.#time;
  }

  get seq(): number {
    return this.#seq;
  }

  get settings(): Readonly<SessionSettings> {
    return this.#settings;
  }

  get turnId(): string {
    if (this.#turn === null) throw new Error("No turn is running");
    return this.#turn.turnId;
  }

  get contextUsed(): number {
    return this.#usage.contextUsed;
  }

  /** An absolute path inside the working directory, as fixtures write it. */
  path(relative: string): string {
    return `${this.cwd}/${relative}`;
  }

  newId(prefix: string): string {
    return `${prefix}-${this.random.hex(12)}`;
  }

  wait(ms: number): this {
    this.#time += Math.max(0, Math.round(ms));
    return this;
  }

  /** Waits a random time in [min, max] ms. */
  pause(min: number, max: number): this {
    return this.wait(this.random.int(min, max));
  }

  emit<E extends EventName>(event: E, fields: Fields<E>): void {
    this.#seq += 1;
    const payload = { sessionId: this.sessionId, seq: this.#seq, time: this.#time, ...fields };
    this.#events.push({ event, payload } as EngineEventInput);
  }

  // -------------------------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------------------------

  status(
    status: SessionStatus,
    options: { waitingOn?: "permission" | "question" | "plan"; message?: string | null } = {},
  ): void {
    const waitingOn = status === "waiting" ? (options.waitingOn ?? null) : null;
    const message =
      options.message !== undefined
        ? options.message
        : status === "working"
          ? "Working"
          : waitingOn !== null
            ? STATUS_MESSAGES[waitingOn]
            : null;
    this.emit("session.status", { status, waitingOn, message });
  }

  /** `session.updated` with the whole settings, after applying `changes`. */
  updateSettings(changes: Partial<SessionSettings>): void {
    this.#settings = { ...this.#settings, ...changes };
    const s = this.#settings;
    this.emit("session.updated", {
      title: s.title,
      mode: s.mode,
      model: s.model,
      modelInfo: findMockModel(s.model)?.info ?? null,
      effort: s.effort,
      archived: s.archived,
      additionalDirectories: [...s.additionalDirectories],
      changed: Object.keys(changes),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------------------------

  /** `session.status` working, then `turn.started` with the person's message. */
  startTurn(text: string, options: { statusMessage?: string } = {}): string {
    if (this.#turn !== null) throw new Error("A turn is already running");
    this.status("working", { message: options.statusMessage ?? "Working" });
    const turnId = `turn-${this.#seq + 1}`;
    this.#turn = {
      turnId,
      startedAt: this.#time,
      lastText: null,
      requests: 0,
      prompt: 0,
      cached: 0,
    };
    this.emit("turn.started", {
      turnId,
      prompt: { content: [{ type: "text", text }], mentions: [] },
      command: null,
    });
    this.#pendingTokens += estimateTokens(text) + 8;
    return turnId;
  }

  /** `turn.finished`, then `session.status` idle (or error). */
  finishTurn(
    options: { stopReason?: StopReason; error?: ErrorInfo; durationMs?: number } = {},
  ): TurnStats {
    const turn = this.#turn;
    if (turn === null) throw new Error("No turn is running");
    const stopReason = options.stopReason ?? (options.error ? "error" : "completed");
    const durationMs = options.durationMs ?? this.#time - turn.startedAt;
    this.emit("turn.finished", {
      turnId: turn.turnId,
      stopReason,
      finalText: turn.lastText,
      error: options.error ?? null,
      durationMs,
    });
    this.#turn = null;
    if (stopReason === "error") {
      this.status("error", { message: options.error?.message ?? null });
    } else {
      this.status("idle");
    }
    const stats: TurnStats = {
      turnId: turn.turnId,
      durationMs,
      requests: turn.requests,
      cacheRatio: turn.prompt === 0 ? 0 : turn.cached / turn.prompt,
      contextUsed: this.#usage.contextUsed,
    };
    this.#stats.push(stats);
    return stats;
  }

  // -------------------------------------------------------------------------------------------
  // Model requests
  // -------------------------------------------------------------------------------------------

  /**
   * One model request: reads the prompt (with `prompt.progress` when it is long), then returns a
   * builder for the reply.
   */
  message(spec: RequestSpec = {}): MessageRecorder {
    const turn = this.#turn;
    if (turn === null) throw new Error("No turn is running");
    let total: number;
    let cached: number;
    if (spec.prompt !== undefined) {
      ({ total, cached } = spec.prompt);
    } else if (this.#usage.requests === 0) {
      cached = this.#prefixTokens;
      total = cached + this.#instructionTokens + this.#pendingTokens + (spec.extra ?? 0);
    } else {
      // The template re-renders the end of the last reply, so a few tokens are read again.
      const tail = this.random.int(8, 40);
      cached = this.#usage.contextUsed - tail;
      total = this.#usage.contextUsed + this.#pendingTokens + (spec.extra ?? 0);
    }
    this.#pendingTokens = 0;
    const tps = spec.promptTps ?? 1_240 + this.random.int(-60, 50);
    const uncached = total - cached;
    this.wait(spec.latencyMs ?? this.random.int(90, 180));
    const readMs = (uncached / tps) * 1000;
    if (spec.progress ?? uncached > 3_000) {
      const end = this.#time + readMs;
      let processed = cached;
      this.emit("prompt.progress", { turnId: turn.turnId, total, cached, processed });
      while (processed < total) {
        const step = this.random.int(450, 750);
        if (this.#time + step >= end - 150) {
          this.wait(end - this.#time);
          processed = total;
        } else {
          this.wait(step);
          processed = Math.min(total, Math.round(processed + (tps * step) / 1000));
        }
        this.emit("prompt.progress", { turnId: turn.turnId, total, cached, processed });
      }
    } else {
      this.wait(readMs);
    }
    return new MessageRecorder(this, {
      messageId: this.newId("message"),
      turnId: turn.turnId,
      total,
      cached,
      promptTps: Math.round(tps * 10) / 10,
      completionExtra: spec.completionExtra ?? 0,
    });
  }

  /** Called by `MessageRecorder.end()`: accounts the request and emits `usage.updated`. */
  recordRequest(request: {
    total: number;
    cached: number;
    completion: number;
    promptTps: number;
    completionTps: number;
    text: string;
  }): void {
    const turn = this.#turn;
    if (turn === null) throw new Error("No turn is running");
    const u = this.#usage;
    u.contextUsed = request.total + request.completion;
    u.requests += 1;
    u.promptTokens += request.total;
    u.completionTokens += request.completion;
    u.cachedTokens += request.cached;
    turn.requests += 1;
    turn.prompt += request.total;
    turn.cached += request.cached;
    if (request.text.trim() !== "") turn.lastText = request.text;
    this.emit("usage.updated", {
      usage: {
        contextWindow: CONTEXT_WINDOW,
        contextUsed: u.contextUsed,
        last: {
          promptTokens: request.total,
          completionTokens: request.completion,
          cachedTokens: request.cached,
          promptTokensPerSecond: request.total === request.cached ? null : request.promptTps,
          completionTokensPerSecond: request.completionTps,
        },
        totals: {
          requests: u.requests,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          cachedTokens: u.cachedTokens,
          malformedToolCalls: 0,
        },
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------------------------

  startTool(call: ToolCall): void {
    this.pause(4, 18);
    call.startedAt = this.#time;
    this.emit("tool.started", {
      turnId: this.turnId,
      messageId: call.messageId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }

  /** Runs a call: `tool.started` (unless already sent), its progress, then `tool.finished`. */
  runTool(call: ToolCall, run: ToolRun): void {
    if (run.start !== false) this.startTool(call);
    const t0 = this.#time + this.random.int(2, 9);
    for (const step of [...(run.progress ?? [])].sort((a, b) => a.at - b.at)) {
      this.#time = Math.max(this.#time, t0 + step.at);
      this.emit("tool.progress", {
        turnId: this.turnId,
        toolCallId: call.toolCallId,
        progress:
          "status" in step
            ? { kind: "status", message: step.status }
            : { kind: "output", stream: step.stream ?? "stdout", text: step.output },
      });
    }
    this.#time = Math.max(this.#time, t0 + run.durationMs);
    this.emit("tool.finished", {
      turnId: this.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      outcome: run.outcome ?? "success",
      content: [{ type: "text", text: run.content }],
      display: run.display,
      durationMs: run.durationMs,
    });
    this.#pendingTokens += estimateTokens(run.content) + 10;
  }

  /**
   * Ends a call that waited on the person (a question or a plan) with the result the model got.
   * Its duration runs from `tool.started`, since the tool itself waited for the answer.
   */
  finishWaitingTool(call: ToolCall, content: string): void {
    const startedAt = call.startedAt ?? this.#time;
    this.pause(3, 10);
    this.emit("tool.finished", {
      turnId: this.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      outcome: "success",
      content: [{ type: "text", text: content }],
      display: null,
      durationMs: this.#time - startedAt,
    });
    this.#pendingTokens += estimateTokens(content) + 10;
  }

  /** Ends a call the person refused: outcome "denied", and it never ran. */
  denyTool(call: ToolCall, content: string): void {
    this.pause(2, 8);
    this.emit("tool.finished", {
      turnId: this.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      outcome: "denied",
      content: [{ type: "text", text: content }],
      display: null,
      durationMs: null,
    });
    this.#pendingTokens += estimateTokens(content) + 10;
  }

  /** TodoWrite: `tasks.updated` while the call runs, then its result. */
  runTodo(call: ToolCall): void {
    const todos = call.input.todos as TaskItem[];
    this.startTool(call);
    this.pause(2, 6);
    this.emit("tasks.updated", { tasks: todos.map((t) => ({ ...t })) });
    const done = todos.filter((t) => t.status === "completed").length;
    const active = todos.filter((t) => t.status === "in_progress").length;
    const pending = todos.length - done - active;
    const lines = [
      `The task list now has ${todos.length} ${todos.length === 1 ? "task" : "tasks"}: ${done} completed, ${active} in progress, ${pending} pending.`,
    ];
    if (done === todos.length) lines.push("Every task is completed.");
    this.runTool(call, {
      start: false,
      durationMs: this.random.int(1, 4),
      content: lines.join("\n"),
      display: null,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------

  requestPermission(
    call: ToolCall,
    request: {
      requestId: string;
      title: string;
      reason: string;
      suggestions: string[];
      display?: ToolDisplay;
    },
  ): void {
    this.pause(3, 12);
    this.emit("permission.requested", {
      turnId: this.turnId,
      request: {
        requestId: request.requestId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        title: request.title,
        reason: request.reason,
        suggestions: request.suggestions,
        ...(request.display === undefined ? {} : { display: request.display }),
      },
    });
    this.status("waiting", { waitingOn: "permission" });
  }

  askQuestions(call: ToolCall, requestId: string): void {
    const input = call.input as {
      questions: {
        question: string;
        header?: string;
        options: { label: string; description?: string }[];
        multiSelect?: boolean;
      }[];
    };
    this.pause(3, 12);
    this.emit("question.asked", {
      turnId: this.turnId,
      requestId,
      toolCallId: call.toolCallId,
      questions: input.questions.map((q) => ({ ...q, multiSelect: q.multiSelect ?? false })),
    });
    this.status("waiting", { waitingOn: "question" });
  }

  proposePlan(call: ToolCall, requestId: string, planPath: string | null): void {
    this.pause(20, 60);
    this.emit("plan.proposed", {
      turnId: this.turnId,
      requestId,
      toolCallId: call.toolCallId,
      plan: String(call.input.plan),
      planPath,
    });
    this.status("waiting", { waitingOn: "plan" });
  }

  /** The person's answer: `request.resolved`, then the status goes back to working. */
  resolve(
    request:
      | { kind: "permission"; requestId: string; response: PermissionResponse }
      | { kind: "question"; requestId: string; response: QuestionResponse }
      | { kind: "plan"; requestId: string; response: PlanResponse },
  ): void {
    this.pause(2_500, 9_000);
    this.emit("request.resolved", {
      kind: request.kind,
      turnId: this.turnId,
      requestId: request.requestId,
      outcome: "answered",
      response: request.response,
    } as Fields<"request.resolved">);
    this.status("working");
  }
}

/** The reply to one model request: reasoning, text and tool calls, streamed. */
export class MessageRecorder {
  readonly messageId: string;
  readonly #rec: Recorder;
  readonly #turnId: string;
  readonly #total: number;
  readonly #cached: number;
  readonly #promptTps: number;
  readonly #completionExtra: number;
  #started = false;
  #startedAt = 0;
  #text = "";
  #reasoning = "";
  #calls: ToolCall[] = [];
  #callTokens = 0;
  #ended = false;

  constructor(
    rec: Recorder,
    info: {
      messageId: string;
      turnId: string;
      total: number;
      cached: number;
      promptTps: number;
      completionExtra: number;
    },
  ) {
    this.#rec = rec;
    this.messageId = info.messageId;
    this.#turnId = info.turnId;
    this.#total = info.total;
    this.#cached = info.cached;
    this.#promptTps = info.promptTps;
    this.#completionExtra = info.completionExtra;
  }

  #ensureStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#startedAt = this.#rec.time;
    this.#rec.emit("message.started", { turnId: this.#turnId, messageId: this.messageId });
  }

  /** Streams reasoning, a word or two at a time; `durationMs` stretches it to that length. */
  think(text: string, options: { durationMs?: number } = {}): this {
    const chunks = chunkWords(text, this.#rec.random, 1, 2);
    const gap = options.durationMs === undefined ? null : options.durationMs / chunks.length;
    for (const chunk of chunks) {
      this.#ensureStarted();
      if (gap === null) this.#rec.pause(40, 90);
      else this.#rec.wait(gap * (0.8 + this.#rec.random.next() * 0.4));
      this.#reasoning += chunk;
      this.#rec.emit("reasoning.delta", {
        turnId: this.#turnId,
        messageId: this.messageId,
        text: chunk,
      });
    }
    return this;
  }

  /** Streams reply text, a word or two every 40 to 90 ms. */
  say(text: string): this {
    if (this.#reasoning !== "" && this.#text === "") this.#rec.pause(120, 260);
    for (const chunk of chunkWords(text, this.#rec.random, 1, 2)) {
      this.#ensureStarted();
      this.#rec.pause(40, 90);
      this.#text += chunk;
      this.#rec.emit("message.delta", {
        turnId: this.#turnId,
        messageId: this.messageId,
        text: chunk,
      });
    }
    return this;
  }

  /** A tool call; generating its arguments takes as long as their tokens would. */
  call(toolName: string, input: Record<string, unknown>): ToolCall {
    this.#ensureStarted();
    const tokens = estimateTokens(JSON.stringify(input)) + 12;
    this.#rec.wait((tokens / COMPLETION_TPS) * 1000 * (0.9 + this.#rec.random.next() * 0.2));
    this.#callTokens += tokens;
    const call: ToolCall = {
      messageId: this.messageId,
      toolCallId: this.#rec.newId("call"),
      toolName,
      input,
    };
    this.#calls.push(call);
    return call;
  }

  /**
   * The request failed part-way: `message.finished` with what streamed so far and no calls, and
   * no usage, as the real engine does before it ends the turn with an error.
   */
  abort(): void {
    if (this.#ended) throw new Error("The message already ended");
    this.#ended = true;
    if (!this.#started) return;
    this.#rec.emit("message.finished", {
      turnId: this.#turnId,
      messageId: this.messageId,
      text: this.#text,
      reasoning: this.#reasoning === "" ? null : this.#reasoning,
      toolCalls: [],
    });
  }

  /** `message.finished` with the whole reply, then the request's `usage.updated`. */
  end(): ToolCall[] {
    if (this.#ended) throw new Error("The message already ended");
    this.#ended = true;
    this.#ensureStarted();
    this.#rec.pause(10, 40);
    this.#rec.emit("message.finished", {
      turnId: this.#turnId,
      messageId: this.messageId,
      text: this.#text,
      reasoning: this.#reasoning === "" ? null : this.#reasoning,
      toolCalls: this.#calls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName })),
    });
    const streamed = Math.max(
      1,
      estimateTokens(this.#text) + estimateTokens(this.#reasoning) + this.#callTokens,
    );
    const seconds = Math.max(0.05, (this.#rec.time - this.#startedAt) / 1000);
    this.#rec.recordRequest({
      total: this.#total,
      cached: this.#cached,
      completion: streamed + this.#completionExtra,
      promptTps: this.#promptTps,
      completionTps: Math.round((streamed / seconds) * 10) / 10,
      text: this.#text,
    });
    return this.#calls;
  }
}
