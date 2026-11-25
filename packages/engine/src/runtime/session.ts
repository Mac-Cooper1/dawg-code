/**
 * One open session: its history, its state, its events, and the turn running in it.
 *
 * Everything that enters the model's view is appended to the transcript as it happens, so a
 * crash loses nothing that was complete. The static prefix is built once per session and again
 * only after compaction; later facts are appended as notes at safe points (see `#flushNotes`).
 * The runtime is the turn loop's host and implements the `SessionServices` the interactive tools
 * use. See README.md in this folder for the public API.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addPermissionRules,
  type InstructionSet,
  loadInstructions,
  localSettingsPath,
  type PermissionRule,
  renderInstructions,
  type Settings,
  type SettingsFileRef,
} from "@dawg/compat";
import {
  type BackgroundTask,
  type ClientCapabilities,
  type ContentPart,
  type ContextBreakdown,
  type Effort,
  type ModelInfo,
  type PendingRequest,
  type PermissionMode,
  type PermissionResponse,
  type PlanResponse,
  type Prompt,
  type PromptInput,
  PromptSchema,
  type SessionSnapshot as ProtocolSnapshot,
  type SessionSummary as ProtocolSummary,
  type QuestionResponse,
  type SessionStatus,
  type TaskItem,
} from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { ModelClient, ModelReply, ModelRequest } from "../contracts/model.ts";
import type { PermissionState } from "../contracts/permissions.ts";
import type { ModelProfile, PromptPrefix, SystemNote } from "../contracts/prompt.ts";
import type {
  SessionServices,
  SessionStateBag,
  ToolContext,
  ToolProbeContext,
} from "../contracts/tools.ts";
import { errorInfo, errorInfoFrom } from "../loop/errors.ts";
import type { ExecutedCall } from "../loop/executor.ts";
import { type RoomCheck, type RoomResult, runTurn, type TurnHost } from "../loop/turn.ts";
import type { Emit, LoopResult } from "../loop/types.ts";
import { scheduledClient } from "../model/slots.ts";
import { readDeniedBy } from "../permissions/index.ts";
import type { SessionRecord, SessionWriter, StateChanges } from "../session/index.ts";
import {
  type BackgroundTaskInfo,
  getBackgroundTasks,
  readOutputPage,
} from "../tools/bash/index.ts";
import { fileTracker } from "../tools/files/index.ts";
import { NoOneToAskError, RequestDismissedError } from "../tools/interactive/index.ts";
import { backgroundFromEvents, toBackgroundTask } from "./background.ts";
import type { EngineContext } from "./context.ts";
import { RuntimeError } from "./errors.ts";
import { closeUnfinished, type EventLog, type LoggedEvent, type ReplayPage } from "./event-log.ts";
import { knownDate, knownMode, localDate } from "./known.ts";
import { readSidecar, type Sidecar, writeSidecar } from "./sidecar.ts";
import { generateTitle } from "./title.ts";
import {
  callIds,
  danglingCalls,
  firstPromptText,
  modeBeforePlan,
  touchedSinceCompaction,
  turnIdFor,
  usageFromRecords,
} from "./transcript.ts";
import type { CompactionOutcome, ModelConnection, TurnOutcome } from "./types.ts";
import { UsageTracker } from "./usage.ts";

/**
 * Within a turn, history is compacted only when the next reply might not fit: when less than
 * this share of the window (at least MIN_REPLY_RESERVE tokens, at most the profile's reply
 * ceiling) is left. At the start of a turn the profile's lower threshold applies instead.
 */
const REPLY_RESERVE_SHARE = 0.25;
const MIN_REPLY_RESERVE = 4096;
/** Kept between the predicted prompt and the reply limit, for estimation error. */
const OUTPUT_MARGIN_SHARE = 0.02;
const OUTPUT_MARGIN_TOKENS = 256;
/** The smallest reply limit asked for, even when the window is nearly full. */
const MIN_OUTPUT_TOKENS = 1024;
/** History must grow by this share of the window after a compaction before another one. */
const MIN_GROWTH_BEFORE_RECOMPACTION = 0.1;
/** History smaller than this share of the window is not worth compacting automatically. */
const MIN_HISTORY_SHARE = 0.1;

/** The summary a trim writes in its compact record; it marks the record as a trim on resume. */
export const TRIM_SUMMARY = "The largest tool result was shortened to fit the context window.";

export interface RuntimeInit {
  ctx: EngineContext;
  writer: SessionWriter;
  /** The transcript as it was when the session was opened. */
  records: readonly SessionRecord[];
  log: EventLog;
  settings: Settings;
  instructions: InstructionSet;
  connection: ModelConnection;
  capabilities: ClientCapabilities;
  /** The session's side folder (tool results, events, runtime.json). */
  sessionDir: string;
  sidecar: Sidecar | null;
}

interface PendingEntry {
  ask: PendingRequest;
  requestId: string;
  resolve(response: unknown): void;
}

type Busy =
  | {
      kind: "turn";
      turnId: string | null;
      controller: AbortController;
      done: Promise<void>;
      /** Sequence number of the turn's prompt record, once written. */
      promptSeq: number | null;
    }
  | { kind: "compaction"; controller: AbortController; done: Promise<void> };

function createStateBag(): SessionStateBag {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create());
      return values.get(key) as T;
    },
  };
}

function abortError(): Error {
  const error = new Error("The turn was interrupted.");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class SessionRuntime {
  readonly id: string;
  /** The session's primary working directory (absolute). */
  readonly cwd: string;
  readonly projectDir: string;

  readonly #ctx: EngineContext;
  readonly #writer: SessionWriter;
  readonly #log: EventLog;
  readonly #sessionDir: string;
  readonly #bag: SessionStateBag = createStateBag();
  readonly #settings: Settings;
  #rules: PermissionState["rules"];
  #instructions: InstructionSet;
  /** The instruction files as rendered into the prefix, for the context breakdown. */
  #instructionsText: string;
  #prefix: PromptPrefix;
  #connection: ModelConnection;
  /** Where conversation requests go: the connection's client, behind its pool's scheduler. */
  #client!: ModelClient;
  /** Where titles go, likewise. */
  #utility!: { client: ModelClient; slot?: number };
  #profile: ModelProfile;
  #capabilities: ClientCapabilities;

  #mode: PermissionMode;
  #modeBeforePlan: PermissionMode;
  #model: string | null;
  #effort: Effort | null;
  #title: string | null;
  #archived: boolean;
  #tasks: TaskItem[];
  /** Background commands of this run and earlier ones, latest state, oldest first. */
  #background = new Map<string, BackgroundTask>();
  /** Output files of background commands from earlier runs, which the registry does not know. */
  #backgroundPaths = new Map<string, string>();
  #dirs: string[];
  #forkPoint: Sidecar["forkPoint"];

  #status: SessionStatus = "idle";
  #waitingOn: string | null = null;
  /** The running request's place in line for the model (1 = next); null when not waiting. */
  #queuePosition: number | null = null;
  #statusQueuePosition: number | null = null;
  #busy: Busy | null = null;
  #pending = new Map<string, PendingEntry>();
  #lastOutcome: TurnOutcome | null = null;
  #lastTurnFailed: boolean;
  #closed = false;
  #closing: Promise<void> | null = null;

  /** What the model was last told, read back from the view (see known.ts). */
  #knownMode: PermissionMode;
  #knownDate: string;
  readonly #startDate: string;
  #planApprovedInto: PermissionMode | null = null;
  /** Notes waiting for a safe point. */
  #queuedNotes: SystemNote[] = [];

  #usage: UsageTracker;
  /** Where the last request's reported size applies: later messages are estimated. */
  #usageMark: { generation: number; viewLength: number; promptTokens: number } | null = null;
  #viewGeneration = 0;
  #autoCompactionFailedIn: string | null = null;
  /** Predicted prompt size of the next request, from the latest room check; null when unknown. */
  #nextPromptTokens: number | null = null;
  /** Context size right after the latest compaction or trim. */
  #compactedTo: number | null = null;
  /** Estimated tokens of each message, which never changes once it is in history. */
  readonly #messageTokens = new WeakMap<Message, number>();
  /** Estimated tokens of the prefix's parts, for the prefix they were measured on. */
  #prefixTokens: {
    prefix: PromptPrefix;
    parts: Omit<ContextBreakdown, "messages">;
  } | null = null;
  #callIds: Set<string>;

  #firstPrompt: string | null;
  #titleStarted = false;
  #titleJob: { controller: AbortController; done: Promise<void> } | null = null;

  readonly #emit: Emit;

  private constructor(init: RuntimeInit) {
    const { ctx, writer, records } = init;
    const snapshot = writer.snapshot;
    this.#ctx = ctx;
    this.#writer = writer;
    this.#log = init.log;
    this.#sessionDir = init.sessionDir;
    this.id = writer.sessionId;
    this.cwd = snapshot.meta.cwd;
    this.projectDir = init.sidecar?.projectDir ?? this.cwd;
    this.#settings = init.settings;
    this.#rules = {
      allow: [...init.settings.permissions.allow],
      ask: [...init.settings.permissions.ask],
      deny: [...init.settings.permissions.deny],
    };
    this.#instructions = init.instructions;
    this.#instructionsText = renderInstructions(init.instructions.files);
    this.#prefix = ctx.assembler.prefix({ tools: ctx.tools, instructions: this.#instructionsText });
    this.#connection = init.connection;
    this.#useConnection(init.connection);
    this.#profile = ctx.profileFor(init.connection.client.endpoint);
    this.#capabilities = init.capabilities;

    const state = snapshot.state;
    this.#mode = state.mode ?? "default";
    this.#modeBeforePlan = modeBeforePlan(records);
    this.#model = state.model;
    this.#effort = state.effort;
    this.#title = state.title;
    this.#archived = state.archived;
    this.#tasks = [...state.tasks];
    this.#dirs = [...state.additionalDirectories];
    this.#forkPoint = init.sidecar?.forkPoint ?? null;
    this.#lastTurnFailed = init.sidecar?.lastTurnFailed ?? false;

    this.#startDate = localDate(Date.parse(snapshot.meta.time));
    this.#knownMode = knownMode(snapshot.view, ctx.assembler);
    this.#knownDate = knownDate(
      snapshot.view,
      ctx.assembler,
      this.#startDate,
      localDate(ctx.clock()),
    );
    const window = init.connection.client.endpoint.contextWindow;
    this.#usage = new UsageTracker(window, usageFromRecords(records, window));
    this.#usage.compactAt = this.#compactAt();
    if (this.#usage.snapshot() !== null) this.#usage.split(this.#contextEstimate(snapshot.view));
    this.#callIds = callIds(records);
    this.#firstPrompt = firstPromptText(records);
    this.#titleStarted = this.#title !== null;

    this.#emit = (event, fields) => {
      this.#log.emit(event, fields);
    };
    this.#log.subscribe((event) => ctx.publish(event));
    getBackgroundTasks(this.#bag).onUpdated((info) => {
      const task = toBackgroundTask(info);
      this.#background.set(task.taskId, task);
      this.#emit("background.updated", { task });
    });
  }

  /** Opens a runtime on a writer the engine has prepared. Repairs what a crash left behind. */
  static async start(init: RuntimeInit): Promise<SessionRuntime> {
    const runtime = new SessionRuntime(init);
    await runtime.#prepare(init.records);
    return runtime;
  }

  async #prepare(records: readonly SessionRecord[]): Promise<void> {
    // The instruction files earlier calls made relevant were already given to the model.
    for (const file of touchedSinceCompaction(records, (s) => s === TRIM_SUMMARY)) {
      await this.#instructions.forFile(file);
    }
    // A session that stopped mid-batch has calls without results; templates refuse that.
    const dangling = danglingCalls(this.#writer.snapshot.view);
    if (dangling.length > 0) {
      for (const call of dangling) {
        await this.#writer.appendMessage({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: "Interrupted: the session stopped before this call finished.",
            },
          ],
          isError: true,
        });
      }
      await this.#appendNote({ type: "interrupted" });
    }
    closeUnfinished(this.#log, this.#ctx.clock());
    const stored = backgroundFromEvents(this.#log.all());
    this.#background = stored.tasks;
    this.#backgroundPaths = stored.outputPaths;
    getBackgroundTasks(this.#bag).continueAfter(stored.highestNumber);
    await this.#saveSidecar();
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  get mode(): PermissionMode {
    return this.#mode;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  /** True while a turn or a compaction runs (including while it waits on the person). */
  get busy(): boolean {
    return this.#busy !== null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get capabilities(): ClientCapabilities {
    return { ...this.#capabilities };
  }

  /** The running turn's id, or null. */
  get activeTurnId(): string | null {
    return this.#busy?.kind === "turn" ? this.#busy.turnId : null;
  }

  /** For forks: the sequence number of the running turn's prompt record. */
  get activePromptSeq(): number | null {
    return this.#busy?.kind === "turn" ? this.#busy.promptSeq : null;
  }

  /** The model chosen for the session; null means the provider's default. */
  get modelSetting(): string | null {
    return this.#model;
  }

  get effort(): Effort | null {
    return this.#effort;
  }

  get additionalDirectories(): string[] {
    return [...this.#dirs];
  }

  get tasks(): TaskItem[] {
    return this.#tasks.map((t) => ({ ...t }));
  }

  /** Commands started with `run_in_background` in this runtime, running or ended. */
  backgroundTasks(): BackgroundTaskInfo[] {
    return getBackgroundTasks(this.#bag).list();
  }

  /**
   * The session's background commands as the protocol shows them, oldest first: this runtime's
   * (a running one with its output so far) and those of earlier runs (rebuilt from the stored
   * events, all ended).
   */
  background(): BackgroundTask[] {
    const tasks = getBackgroundTasks(this.#bag);
    return [...this.#background.values()].map((t) => {
      const live = t.status === "running" ? tasks.get(t.taskId) : undefined;
      return live === undefined ? { ...t } : toBackgroundTask(live);
    });
  }

  /**
   * A page of a background command's output (`background.output`): at most `limit` bytes from
   * byte `offset`, never splitting a character. `done` is true once the command has ended and
   * the page reaches the end of its output. `InvalidParams` for an unknown task.
   */
  async readBackgroundOutput(
    taskId: string,
    offset: number,
    limit: number,
  ): Promise<{ text: string; nextOffset: number; totalBytes: number; done: boolean }> {
    const live = getBackgroundTasks(this.#bag).get(taskId);
    const file = live?.outputPath ?? this.#backgroundPaths.get(taskId);
    const known = live !== undefined || this.#background.has(taskId);
    if (!known) throw this.#unknownTask(taskId);
    // The state comes first: once a task has ended its file is complete.
    const ended = live === undefined || live.status !== "running";
    if (file === undefined) return { text: "", nextOffset: 0, totalBytes: 0, done: ended };
    const page = await readOutputPage(file, offset, limit);
    return { ...page, done: ended && page.nextOffset >= page.totalBytes };
  }

  /**
   * Stops a background command and everything it started, as the model's TaskStop does, and
   * resolves once it has ended (`background.stop`). False when it had already ended.
   * `InvalidParams` for an unknown task.
   */
  async stopBackground(taskId: string): Promise<boolean> {
    const tasks = getBackgroundTasks(this.#bag);
    const live = tasks.get(taskId);
    if (live === undefined) {
      if (this.#background.has(taskId)) return false;
      throw this.#unknownTask(taskId);
    }
    if (live.status !== "running") return false;
    await tasks.stop(taskId, "requested");
    return true;
  }

  #unknownTask(taskId: string): RuntimeError {
    return new RuntimeError(
      "InvalidParams",
      `There is no background task ${taskId} in this session.`,
    );
  }

  /** The model's current view after the system message. Read-only. */
  get view(): readonly Message[] {
    return this.#writer.snapshot.view;
  }

  get prefix(): PromptPrefix {
    return this.#prefix;
  }

  /** The messages the next request would start with: the system message, then the view. */
  requestMessages(): Message[] {
    return [this.#prefix.system, ...this.#writer.snapshot.view];
  }

  modelInfo(): ModelInfo {
    const endpoint = this.#connection.client.endpoint;
    return {
      id: endpoint.model,
      contextWindow: Math.max(0, Math.round(endpoint.contextWindow)),
      vision: endpoint.capabilities.vision,
      reasoning: endpoint.capabilities.reasoning,
      effortLevels: this.#effortLevels(),
    };
  }

  summary(): ProtocolSummary {
    const snap = this.#writer.snapshot;
    return {
      id: this.id,
      title: this.#title,
      cwd: this.cwd,
      projectDir: this.projectDir,
      createdAt: Date.parse(snap.meta.time),
      lastActivityAt: Date.parse(snap.lastTime),
      status: this.#status,
      queuePosition: this.#statusQueuePosition,
      mode: this.#mode,
      model: this.#model ?? this.#connection.client.endpoint.model,
      effort: this.#effort,
      archived: this.#archived,
      forkedFrom:
        snap.meta.forkedFrom === null
          ? null
          : {
              sessionId: snap.meta.forkedFrom.sessionId,
              point: this.#forkPoint ?? { position: "end" },
            },
      lastSeq: this.#log.lastSeq,
    };
  }

  /**
   * What fills the context window, for `/context`. After a request: the endpoint's count, split
   * as in `usage.breakdown`. Before the first one: an estimate of what the next request holds.
   */
  contextUsage(): {
    contextWindow: number;
    contextUsed: number;
    /** True when `contextUsed` is the endpoint's count rather than an estimate. */
    measured: boolean;
    compactAt: number | null;
    breakdown: ContextBreakdown;
  } {
    const usage = this.#usage.snapshot();
    const contextWindow = this.#contextWindow();
    const compactAt = this.#compactAt();
    if (usage !== null && usage.contextUsed > 0 && usage.breakdown !== null) {
      return {
        contextWindow,
        contextUsed: usage.contextUsed,
        measured: true,
        compactAt,
        breakdown: usage.breakdown,
      };
    }
    const estimate = this.#contextEstimate(this.#writer.snapshot.view);
    const total =
      estimate.systemPrompt + estimate.instructions + estimate.tools + estimate.messages;
    return {
      contextWindow,
      contextUsed: total,
      measured: false,
      compactAt,
      breakdown: estimate,
    };
  }

  /** The protocol's `SessionSnapshot`. `commands` is left empty for the command registry. */
  snapshot(): ProtocolSnapshot {
    return {
      session: this.summary(),
      modelInfo: this.modelInfo(),
      additionalDirectories: [...this.#dirs],
      tasks: this.tasks,
      usage: this.#usage.snapshot(),
      pending: [...this.#pending.values()].map((p) => p.ask),
      activeTurnId: this.activeTurnId,
      commands: [],
      background: this.background(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  /** Live events from now on. Returns a function that stops them. */
  subscribe(listener: (event: LoggedEvent) => void): () => void {
    return this.#log.subscribe(listener);
  }

  /** Stored events with `seq > afterSeq`, for a client that reconnects. */
  eventsAfter(afterSeq: number, limit?: number): ReplayPage {
    return this.#log.after(afterSeq, limit);
  }

  get lastSeq(): number {
    return this.#log.lastSeq;
  }

  // -------------------------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------------------------

  /**
   * Starts a turn and resolves with its id as soon as the prompt is in the transcript. The turn
   * runs on; follow it through events or `waitForIdle`. Rejects with SessionBusy while a turn or
   * a compaction runs.
   */
  async prompt(input: PromptInput): Promise<{ turnId: string }> {
    this.#assertOpen();
    if (this.#busy !== null) throw new RuntimeError("SessionBusy", "A turn is already running.");
    const prompt = PromptSchema.parse(input);
    const controller = new AbortController();
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy: Busy = { kind: "turn", turnId: null, controller, done, promptSeq: null };
    this.#busy = busy;
    const startedAt = this.#ctx.clock();
    let turnId: string;
    try {
      // The start of a turn is a safe point for notes: they go before the prompt.
      await this.#flushNotes();
      const content = await this.#promptContent(prompt);
      // The assembler makes text that imitates a note harmless (pasted text, mentioned files).
      const message = { ...this.#ctx.assembler.prompt(content), kind: "prompt" as const };
      const record = await this.#writer.appendMessage(message);
      turnId = turnIdFor(record.seq);
      busy.promptSeq = record.seq;
    } catch (error) {
      this.#busy = null;
      release();
      this.#refreshStatus();
      throw error;
    }
    busy.turnId = turnId;
    this.#firstPrompt ??= promptText(prompt.content);
    this.#lastTurnFailed = false;
    this.#refreshStatus();
    this.#emit("turn.started", { turnId, prompt, command: null });
    void this.#runTurn(turnId, controller, startedAt).finally(release);
    return { turnId };
  }

  /** `prompt` then `waitForIdle`: runs one whole turn. */
  async run(input: PromptInput): Promise<TurnOutcome> {
    const { turnId } = await this.prompt(input);
    const outcome = await this.waitForIdle();
    if (outcome === null || outcome.turnId !== turnId) {
      throw new RuntimeError("InvalidState", "The turn ended without an outcome.");
    }
    return outcome;
  }

  /** Waits until no turn or compaction runs; resolves with the latest turn's outcome. */
  async waitForIdle(): Promise<TurnOutcome | null> {
    while (this.#busy !== null) await this.#busy.done;
    return this.#lastOutcome;
  }

  /** Stops the running turn or compaction. False when nothing was running. */
  interrupt(): boolean {
    if (this.#busy === null) return false;
    this.#busy.controller.abort();
    return true;
  }

  async #runTurn(turnId: string, controller: AbortController, startedAt: number): Promise<void> {
    let result: LoopResult;
    try {
      result = await runTurn(this.#turnHost(), { turnId, signal: controller.signal });
    } catch (error) {
      result = { stopReason: "error", finalText: null, error: errorInfoFrom(error) };
      await this.#repairDangling().catch(() => {});
    }
    for (const entry of [...this.#pending.values()]) this.#cancel(entry);
    const durationMs = Math.max(0, this.#ctx.clock() - startedAt);
    this.#emit("turn.finished", {
      turnId,
      stopReason: result.stopReason,
      finalText: result.finalText,
      error: result.error,
      durationMs,
    });
    this.#lastOutcome = {
      turnId,
      stopReason: result.stopReason,
      finalText: result.finalText,
      error: result.error,
      usage: this.#usage.snapshot(),
      durationMs,
    };
    this.#lastTurnFailed = result.stopReason === "error";
    this.#busy = null;
    this.#refreshStatus();
    if (!this.#writer.closed) {
      void this.#writer.setStatus(this.#lastTurnFailed ? "error" : "idle").catch(() => {});
    }
    void this.#saveSidecar();
    this.#maybeGenerateTitle();
  }

  /** After a failure inside the loop: give every call left without a result one. */
  async #repairDangling(): Promise<void> {
    if (this.#writer.closed) return;
    for (const call of danglingCalls(this.#writer.snapshot.view)) {
      await this.#writer.appendMessage({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "Error: the turn failed before this call finished." }],
        isError: true,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  /** Changes the permission mode. The model is told at the next safe point. */
  setMode(mode: PermissionMode): PermissionMode {
    this.#assertOpen();
    if (!this.#modeAllowed(mode)) {
      throw new RuntimeError(
        "InvalidState",
        "bypassPermissions mode is turned off by permissions.disableBypassPermissionsMode.",
      );
    }
    this.#applyMode(mode);
    return this.#mode;
  }

  /** Switches the model. Not while a turn runs. Resets the effort if the new model lacks it. */
  async setModel(
    model: string,
  ): Promise<{ model: string; modelInfo: ModelInfo; effort: Effort | null }> {
    this.#assertOpen();
    if (this.#busy !== null) throw new RuntimeError("SessionBusy", "A turn is running.");
    const connection = await this.#ctx.models.connect(model);
    this.#useConnection(connection);
    this.#connection = connection;
    this.#profile = this.#ctx.profileFor(connection.client.endpoint);
    this.#usage.contextWindow = connection.client.endpoint.contextWindow;
    this.#usage.compactAt = this.#compactAt();
    this.#usageMark = null;
    this.#model = model;
    const changes: StateChanges = { model };
    const changed = ["model"];
    if (this.#effort !== null && !this.#effortLevels().includes(this.#effort)) {
      this.#effort = null;
      changes.effort = null;
      changed.push("effort");
    }
    await this.#writer.setState(changes);
    this.#emitUpdated(changed);
    // The window, and with it the compaction limit, may differ.
    this.#emitUsage();
    void this.#saveSidecar();
    return { model, modelInfo: this.modelInfo(), effort: this.#effort };
  }

  /** Sets the reasoning effort; null returns to the model's default. */
  setEffort(effort: Effort | null): Effort | null {
    this.#assertOpen();
    if (effort !== null && !this.#effortLevels().includes(effort)) {
      const levels = this.#effortLevels();
      throw new RuntimeError(
        "InvalidState",
        levels.length === 0
          ? "This model has no effort levels."
          : `Effort must be one of: ${levels.join(", ")}.`,
      );
    }
    if (effort === this.#effort) return effort;
    this.#effort = effort;
    void this.#writer.setState({ effort }).catch(() => {});
    this.#emitUpdated(["effort"]);
    void this.#saveSidecar();
    return effort;
  }

  /** Adds a working directory. The model is told with a note. */
  async addDirectory(directory: string): Promise<string[]> {
    this.#assertOpen();
    const absolute = path.resolve(this.cwd, directory);
    const info = await stat(absolute).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new RuntimeError("InvalidState", `${absolute} is not a directory.`);
    }
    if (absolute === this.cwd || this.#dirs.includes(absolute)) return [...this.#dirs];
    this.#dirs = [...this.#dirs, absolute];
    await this.#writer.setState({ additionalDirectories: [...this.#dirs] });
    this.#emitUpdated(["additionalDirectories"]);
    const note: SystemNote = { type: "directory_added", path: absolute };
    // Between turns any moment is safe; during one, wait for the next safe point.
    if (this.#busy === null) await this.#appendNote(note);
    else this.#queuedNotes.push(note);
    return [...this.#dirs];
  }

  async rename(title: string | null): Promise<ProtocolSummary> {
    this.#assertOpen();
    await this.#writer.setState({ title });
    this.#title = title;
    this.#titleStarted = true;
    this.#emitUpdated(["title"]);
    return this.summary();
  }

  async setArchived(archived: boolean): Promise<ProtocolSummary> {
    this.#assertOpen();
    await this.#writer.setState({ archived });
    this.#archived = archived;
    this.#emitUpdated(["archived"]);
    return this.summary();
  }

  /** What the person's client can answer from now on. */
  setCapabilities(capabilities: Partial<ClientCapabilities>): void {
    this.#capabilities = { ...this.#capabilities, ...capabilities };
  }

  // -------------------------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------------------------

  respondPermission(requestId: string, response: PermissionResponse): void {
    this.#answer("permission", requestId, response);
  }

  respondQuestion(requestId: string, response: QuestionResponse): void {
    this.#answer("question", requestId, response);
  }

  respondPlan(requestId: string, response: PlanResponse): void {
    this.#answer("plan", requestId, response);
  }

  /** Requests waiting on the person, oldest first. */
  pending(): PendingRequest[] {
    return [...this.#pending.values()].map((p) => p.ask);
  }

  #answer(kind: PendingRequest["kind"], requestId: string, response: unknown): void {
    this.#assertOpen();
    const entry = this.#pending.get(requestId);
    if (entry === undefined || entry.ask.kind !== kind) {
      throw new RuntimeError(
        "RequestNotFound",
        `No ${kind} request ${requestId} is waiting for an answer.`,
      );
    }
    this.#pending.delete(requestId);
    this.#emitResolved(entry, "answered", response);
    this.#refreshStatus();
    entry.resolve(response);
  }

  #emitResolved(entry: PendingEntry, outcome: "answered" | "cancelled", response: unknown): void {
    const base = {
      turnId: entry.ask.turnId,
      requestId: entry.requestId,
      outcome,
    };
    switch (entry.ask.kind) {
      case "permission":
        this.#emit("request.resolved", {
          ...base,
          kind: "permission",
          response: response as PermissionResponse | null,
        });
        break;
      case "question":
        this.#emit("request.resolved", {
          ...base,
          kind: "question",
          response: response as QuestionResponse | null,
        });
        break;
      case "plan":
        this.#emit("request.resolved", {
          ...base,
          kind: "plan",
          response: response as PlanResponse | null,
        });
        break;
    }
  }

  #cancel(entry: PendingEntry): void {
    if (!this.#pending.delete(entry.requestId)) return;
    this.#emitResolved(entry, "cancelled", null);
    this.#refreshStatus();
  }

  /** Raises a request and waits for its answer; rejects when `signal` aborts. */
  #raise<R>(ask: PendingRequest, signal: AbortSignal): Promise<R> {
    const requestId = ask.kind === "permission" ? ask.request.requestId : ask.requestId;
    return new Promise<R>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const entry: PendingEntry = {
        ask,
        requestId,
        resolve: (response) => {
          signal.removeEventListener("abort", onAbort);
          resolve(response as R);
        },
      };
      const onAbort = () => {
        this.#cancel(entry);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(requestId, entry);
      switch (ask.kind) {
        case "permission":
          this.#emit("permission.requested", { turnId: ask.turnId, request: ask.request });
          break;
        case "question":
          this.#emit("question.asked", {
            turnId: ask.turnId,
            requestId,
            toolCallId: ask.toolCallId,
            questions: ask.questions,
          });
          break;
        case "plan":
          this.#emit("plan.proposed", {
            turnId: ask.turnId,
            requestId,
            toolCallId: ask.toolCallId,
            plan: ask.plan,
            planPath: ask.planPath,
            modeBeforePlan: ask.modeBeforePlan,
          });
          break;
      }
      this.#refreshStatus();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------------------------

  /** Summarises the conversation now (`/compact [focus]`). Not while a turn runs. */
  async compact(focus: string | null = null): Promise<CompactionOutcome> {
    this.#assertOpen();
    if (this.#busy !== null) throw new RuntimeError("SessionBusy", "A turn is running.");
    const controller = new AbortController();
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#busy = { kind: "compaction", controller, done };
    this.#refreshStatus();
    try {
      return await this.#compactNow({
        trigger: "manual",
        focus: focus === null || focus.trim() === "" ? null : focus.trim(),
        turnId: null,
        signal: controller.signal,
      });
    } finally {
      this.#busy = null;
      release();
      this.#refreshStatus();
      void this.#saveSidecar();
    }
  }

  async #compactNow(input: {
    trigger: "auto" | "manual";
    focus: string | null;
    turnId: string | null;
    signal: AbortSignal;
  }): Promise<CompactionOutcome> {
    const ctx = this.#ctx;
    const compactionId = ctx.newId("compaction");
    const before = Math.round(await this.#predictContext());
    const window = this.#contextWindow();
    this.#emit("compaction.started", {
      compactionId,
      trigger: input.trigger,
      turnId: input.turnId,
      contextUsed: before,
      contextWindow: window,
      focus: input.focus,
    });
    try {
      if (danglingCalls(this.#writer.snapshot.view).length > 0) {
        // Compaction would give unanswered calls placeholder results; never compact mid-batch.
        throw new Error("Cannot compact while tool calls are waiting for their results.");
      }
      // The summarising request repeats the session's own request settings, so it renders the
      // prompt the same way and reuses the cache.
      const { client, options } = this.#requestModel();
      const result = await ctx.compactor.compact({
        prefix: this.#prefix,
        history: this.#writer.snapshot.view,
        client,
        focus: input.focus,
        tasks: this.tasks,
        recentFiles: await this.#recentFiles(),
        ...(options.sampling === undefined ? {} : { sampling: options.sampling }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
        ...(options.parallelToolCalls === undefined
          ? {}
          : { parallelToolCalls: options.parallelToolCalls }),
        ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
        ...(options.slot === undefined ? {} : { slot: options.slot }),
        signal: input.signal,
      });
      if (input.signal.aborted) throw abortError();
      if (result.usage !== null) this.#usage.recordSide(result.usage);
      // Instruction files are picked up again after compaction (spec, prompt assembly).
      await this.#reloadInstructions();
      const after = Math.round(
        ctx.estimator.estimate({
          messages: [this.#prefix.system, ...result.messages],
          tools: this.#prefix.tools,
        }),
      );
      await this.#writer.compact({
        trigger: input.trigger,
        ...(input.focus === null ? {} : { focus: input.focus }),
        summary: result.summary,
        messages: result.messages,
        tokensBefore: before,
        tokensAfter: after,
      });
      this.#afterViewReplaced(after);
      this.#emit("compaction.finished", {
        compactionId,
        outcome: "completed",
        summary: result.summary,
        contextBefore: before,
        contextAfter: after,
        error: null,
      });
      this.#emitUsage();
      return { outcome: "completed", summary: result.summary, error: null };
    } catch (error) {
      const interrupted = input.signal.aborted;
      const info = interrupted ? null : errorInfoFrom(error);
      this.#emit("compaction.finished", {
        compactionId,
        outcome: interrupted ? "interrupted" : "failed",
        summary: null,
        contextBefore: before,
        contextAfter: null,
        error: info,
      });
      return { outcome: interrupted ? "interrupted" : "failed", summary: null, error: info };
    }
  }

  async #trim(messages: Message[], turnId: string, before: number): Promise<void> {
    const compactionId = this.#ctx.newId("compaction");
    this.#emit("compaction.started", {
      compactionId,
      trigger: "auto",
      turnId,
      contextUsed: before,
      contextWindow: this.#contextWindow(),
      focus: null,
    });
    const after = Math.round(
      this.#ctx.estimator.estimate({
        messages: [this.#prefix.system, ...messages],
        tools: this.#prefix.tools,
      }),
    );
    await this.#writer.compact({
      trigger: "auto",
      summary: TRIM_SUMMARY,
      messages,
      tokensBefore: before,
      tokensAfter: after,
    });
    this.#afterViewReplaced(after);
    this.#emit("compaction.finished", {
      compactionId,
      outcome: "completed",
      summary: TRIM_SUMMARY,
      contextBefore: before,
      contextAfter: after,
      error: null,
    });
    this.#emitUsage();
  }

  #afterViewReplaced(tokens: number): void {
    this.#compactedTo = tokens;
    this.#nextPromptTokens = tokens;
    this.#viewGeneration += 1;
    this.#usageMark = null;
    this.#usage.setContextUsed(tokens);
    const view = this.#writer.snapshot.view;
    this.#usage.split(this.#contextEstimate(view));
    this.#knownMode = knownMode(view, this.#ctx.assembler);
    this.#knownDate = knownDate(
      view,
      this.#ctx.assembler,
      this.#startDate,
      localDate(this.#ctx.clock()),
    );
  }

  async #makeRoom(turnId: string, signal: AbortSignal, check: RoomCheck): Promise<RoomResult> {
    const window = this.#contextWindow();
    if (check !== "overflow") {
      if (window <= 0) {
        this.#nextPromptTokens = null;
        return "ok";
      }
      const used = await this.#predictContext();
      this.#nextPromptTokens = used;
      if (this.#autoCompactionFailedIn === turnId) return "ok";
      const threshold = this.#compactionLimit(window, check);
      if (used <= threshold) return "ok";
      // Compaction only shrinks history. When history is a small part of the context (the
      // prefix alone nears the threshold), or has barely grown since the last compaction,
      // compacting would cost a request and gain nothing; an overflow still forces it.
      const prefixTokens = this.#ctx.estimator.estimate({
        messages: [this.#prefix.system],
        tools: this.#prefix.tools,
      });
      if (used - prefixTokens < window * MIN_HISTORY_SHARE) return "ok";
      const floor = this.#compactedTo;
      if (floor !== null && used - floor < window * MIN_GROWTH_BEFORE_RECOMPACTION) return "ok";
      // A single oversized result is trimmed before compaction is considered.
      const trimmed = this.#ctx.compactor.trimLargestResult(
        this.#writer.snapshot.view,
        Math.max(0, threshold - prefixTokens),
      );
      if (trimmed !== null) {
        await this.#trim(trimmed, turnId, Math.round(used));
        return "compacted";
      }
    }
    const result = await this.#compactNow({ trigger: "auto", focus: null, turnId, signal });
    if (result.outcome === "completed") return "compacted";
    if (result.outcome === "interrupted") return "interrupted";
    this.#autoCompactionFailedIn = turnId;
    return "failed";
  }

  /**
   * Context size above which history is compacted. Before a turn starts, that is the profile's
   * threshold, which keeps the model's view short. Within a turn it is only what the next reply
   * needs: compacting just before a turn's last step costs a summary and a re-read of the prompt
   * and gains nothing.
   */
  #compactionLimit(window: number, check: "turn_start" | "mid_turn"): number {
    const threshold = Math.floor(window * this.#profile.compactionThreshold);
    if (check === "turn_start") return threshold;
    const reserve = Math.min(
      this.#profile.maxOutputTokens,
      Math.max(MIN_REPLY_RESERVE, Math.floor(window * REPLY_RESERVE_SHARE)),
    );
    return Math.max(threshold, window - reserve);
  }

  /** `Usage.compactAt`: the turn-start limit, or null when the window is unknown. */
  #compactAt(): number | null {
    const window = this.#contextWindow();
    return window > 0 ? Math.max(0, this.#compactionLimit(window, "turn_start")) : null;
  }

  /**
   * The reply size to ask for: the profile's ceiling, cut to what is left of the window after
   * the prompt. Servers such as vLLM refuse a request whose prompt and reply limit together
   * exceed the window; llama-server would stop at the window's end anyway.
   */
  #outputLimit(ceiling: number): number {
    const window = this.#contextWindow();
    const prompt = this.#nextPromptTokens;
    if (window <= 0 || prompt === null) return ceiling;
    const margin = Math.max(OUTPUT_MARGIN_TOKENS, Math.ceil(window * OUTPUT_MARGIN_SHARE));
    return Math.max(MIN_OUTPUT_TOKENS, Math.min(ceiling, Math.floor(window - prompt - margin)));
  }

  /** Tokens the next request would hold: the last reported size plus what was added since. */
  async #predictContext(): Promise<number> {
    const view = this.#writer.snapshot.view;
    const mark = this.#usageMark;
    const estimator = this.#ctx.estimator;
    if (
      mark !== null &&
      mark.generation === this.#viewGeneration &&
      mark.viewLength <= view.length
    ) {
      return (
        mark.promptTokens + estimator.estimate({ messages: view.slice(mark.viewLength), tools: [] })
      );
    }
    const request = { messages: [this.#prefix.system, ...view], tools: this.#prefix.tools };
    const exact = await this.#connection.client.countTokens(request).catch(() => null);
    return exact ?? estimator.estimate(request);
  }

  async #recentFiles(): Promise<{ path: string; content: string }[]> {
    const limits = this.#ctx.limits;
    const out: { path: string; content: string }[] = [];
    for (const record of fileTracker(this.#bag).list()) {
      if (out.length >= limits.compactionRecentFiles) break;
      const text = await readFile(record.path, "utf8").catch(() => null);
      if (text === null || text.includes("\u0000")) continue;
      out.push({ path: record.path, content: text.slice(0, limits.compactionRecentFileChars) });
    }
    return out;
  }

  async #reloadInstructions(): Promise<void> {
    const ctx = this.#ctx;
    this.#instructions = await loadInstructions({
      cwd: this.cwd,
      homeDir: ctx.homeDir,
      projectDir: this.cwd,
      externalImports: ctx.externalImports,
    });
    this.#instructionsText = renderInstructions(this.#instructions.files);
    this.#prefix = ctx.assembler.prefix({ tools: ctx.tools, instructions: this.#instructionsText });
  }

  // -------------------------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------------------------

  /**
   * Stops the running turn, stops background commands, flushes and releases the session file.
   * Safe to call more than once.
   */
  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closing = (async () => {
      if (this.#busy !== null) {
        this.#busy.controller.abort();
        await this.waitForIdle();
      }
      this.#closed = true;
      if (this.#titleJob !== null) {
        this.#titleJob.controller.abort();
        await this.#titleJob.done;
      }
      await getBackgroundTasks(this.#bag)
        .stopAll()
        .catch(() => {});
      await this.#saveSidecar();
      this.#log.close();
      await this.#writer.close();
      this.#ctx.onClosed(this);
    })();
    return this.#closing;
  }

  /**
   * Closes the session because it is being deleted. A running turn or compaction is interrupted
   * and its events finish first; then `session.deleted` goes out as the last event (never
   * stored), and the session closes. The caller removes the files.
   */
  async closeDeleted(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    // A loop: another window may start a turn while the interrupted one winds down.
    while (this.#busy !== null && this.#closing === null) {
      this.#busy.controller.abort();
      await this.#busy.done;
    }
    if (this.#closing !== null) return this.#closing;
    this.#emit("session.deleted", {});
    return this.close();
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing !== null) {
      throw new RuntimeError("InvalidState", `Session ${this.id} is closed.`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: state
  // -------------------------------------------------------------------------------------------

  #modeAllowed(mode: PermissionMode): boolean {
    return mode !== "bypassPermissions" || !this.#settings.permissions.bypassDisabled;
  }

  /**
   * The mode approving a plan leads to: the one the answer names, else the mode before plan
   * mode. "default" stands in for plan mode itself and for a mode settings turn off. With no
   * answer yet, this is the plan request's `modeBeforePlan`.
   */
  #modeAfterPlan(named: PermissionMode | undefined): PermissionMode {
    let next = named ?? this.#modeBeforePlan;
    if (next === "plan" || !this.#modeAllowed(next)) {
      next = this.#modeBeforePlan === "plan" ? "default" : this.#modeBeforePlan;
    }
    return this.#modeAllowed(next) ? next : "default";
  }

  #applyMode(next: PermissionMode): void {
    if (next === this.#mode) return;
    if (next === "plan") this.#modeBeforePlan = this.#mode;
    this.#mode = next;
    void this.#writer.setState({ mode: next }).catch(() => {});
    this.#emitUpdated(["mode"]);
    void this.#saveSidecar();
  }

  #setTasks(tasks: TaskItem[]): void {
    this.#tasks = tasks.map((t) => ({ ...t }));
    void this.#writer.setState({ tasks: this.tasks }).catch(() => {});
    this.#emit("tasks.updated", { tasks: this.tasks });
  }

  #effortLevels(): string[] {
    return [...(this.#connection.client.endpoint.template?.reasoningEffortLevels ?? [])];
  }

  #contextWindow(): number {
    return Math.max(0, Math.round(this.#connection.client.endpoint.contextWindow));
  }

  /**
   * Points the session's requests at a connection. With a pool, every conversation request
   * (turns and compaction) first takes a slot from the pool's scheduler, and the session shows
   * as queued while it waits; titles do the same on the utility pool, without showing.
   */
  #useConnection(connection: ModelConnection): void {
    const pool = connection.pool;
    this.#client =
      pool === undefined
        ? connection.client
        : scheduledClient(connection.client, this.#ctx.slots(pool), {
            owner: this.id,
            onQueue: (position) => this.#queued(position),
          });
    const utility = connection.utility ?? { client: connection.client };
    this.#utility =
      utility.pool === undefined
        ? utility
        : {
            client: scheduledClient(utility.client, this.#ctx.slots(utility.pool), {
              owner: this.id,
            }),
          };
  }

  #queued(position: number | null): void {
    this.#queuePosition = position;
    // An interrupted wait: the turn ends next, and its status says so.
    if (position === null && this.#busy?.controller.signal.aborted === true) return;
    this.#refreshStatus();
  }

  /**
   * Estimated tokens of each part of a request holding `view`. Instruction files are rendered
   * into the system message; they are counted apart from the rest of it.
   */
  #contextEstimate(view: readonly Message[]): ContextBreakdown {
    const estimator = this.#ctx.estimator;
    const empty = estimator.estimate({ messages: [], tools: [] });
    const cost = (messages: readonly Message[]) =>
      Math.max(0, Math.round(estimator.estimate({ messages, tools: [] }) - empty));
    let prefix = this.#prefixTokens;
    if (prefix === null || prefix.prefix !== this.#prefix) {
      const system = cost([this.#prefix.system]);
      const text = this.#instructionsText;
      const instructions =
        text === ""
          ? 0
          : Math.min(
              system,
              Math.max(
                0,
                cost([{ role: "system", content: text }]) - cost([{ role: "system", content: "" }]),
              ),
            );
      const tools = Math.max(
        0,
        Math.round(estimator.estimate({ messages: [], tools: this.#prefix.tools }) - empty),
      );
      prefix = {
        prefix: this.#prefix,
        parts: { systemPrompt: system - instructions, instructions, tools },
      };
      this.#prefixTokens = prefix;
    }
    let messages = 0;
    for (const message of view) {
      let tokens = this.#messageTokens.get(message);
      if (tokens === undefined) {
        tokens = cost([message]);
        this.#messageTokens.set(message, tokens);
      }
      messages += tokens;
    }
    return { ...prefix.parts, messages };
  }

  #emitUpdated(changed: string[]): void {
    this.#emit("session.updated", {
      title: this.#title,
      mode: this.#mode,
      model: this.#model ?? this.#connection.client.endpoint.model,
      modelInfo: this.modelInfo(),
      effort: this.#effort,
      archived: this.#archived,
      additionalDirectories: [...this.#dirs],
      changed,
    });
  }

  #emitUsage(): void {
    const usage = this.#usage.snapshot();
    if (usage !== null) this.#emit("usage.updated", { usage });
  }

  #refreshStatus(): void {
    let status: SessionStatus;
    let waitingOn: "permission" | "question" | "plan" | null = null;
    let message: string | null = null;
    let queuePosition: number | null = null;
    const first = this.#pending.values().next().value as PendingEntry | undefined;
    if (first !== undefined) {
      status = "waiting";
      waitingOn = first.ask.kind;
      message =
        waitingOn === "permission"
          ? "Waiting for permission"
          : waitingOn === "question"
            ? "Waiting for an answer"
            : "Waiting for plan approval";
    } else if (this.#busy !== null) {
      status = "working";
      queuePosition = this.#queuePosition;
      message =
        queuePosition !== null
          ? "Waiting for the model"
          : this.#busy.kind === "compaction"
            ? "Compacting the conversation"
            : "Working";
    } else {
      status = this.#lastTurnFailed ? "error" : "idle";
      message = this.#lastTurnFailed ? (this.#lastOutcome?.error?.message ?? null) : null;
    }
    const key = `${status}/${waitingOn ?? ""}/${queuePosition ?? ""}`;
    const last = `${this.#status}/${this.#waitingOn ?? ""}/${this.#statusQueuePosition ?? ""}`;
    if (key === last) return;
    this.#status = status;
    this.#waitingOn = waitingOn;
    this.#statusQueuePosition = queuePosition;
    this.#emit("session.status", { status, waitingOn, message, queuePosition });
  }

  #saveSidecar(): Promise<void> {
    return writeSidecar(this.#sessionDir, {
      v: 1,
      lastSeq: this.#log.lastSeq,
      projectDir: this.projectDir,
      mode: this.#mode,
      model: this.#model,
      effort: this.#effort,
      lastTurnFailed: this.#lastTurnFailed,
      forkPoint: this.#forkPoint,
    });
  }

  #maybeGenerateTitle(): void {
    if (!this.#ctx.generateTitles || this.#titleStarted || this.#closed || this.#closing !== null) {
      return;
    }
    const text = this.#firstPrompt;
    if (text === null) return;
    this.#titleStarted = true;
    const controller = new AbortController();
    const target = this.#utility;
    const weakest = target.client.endpoint.template?.reasoningEffortLevels?.[0];
    const kwargs = this.#ctx.profileFor(target.client.endpoint).chatTemplateKwargs;
    const done = (async () => {
      try {
        const { title, usage } = await generateTitle({
          client: target.client,
          ...(target.slot === undefined ? {} : { slot: target.slot }),
          ...(weakest === undefined ? {} : { effort: weakest }),
          ...(kwargs === null ? {} : { extraBody: { chat_template_kwargs: kwargs } }),
          promptText: text,
          signal: controller.signal,
        });
        if (usage !== null) this.#usage.recordSide(usage);
        if (title === null || this.#title !== null || controller.signal.aborted) return;
        if (this.#writer.closed) return;
        await this.#writer.setState({ title });
        this.#title = title;
        this.#emitUpdated(["title"]);
        await this.#saveSidecar();
      } catch {
        // A title is a convenience; a failed request leaves the session untitled.
      }
    })();
    this.#titleJob = { controller, done };
  }

  /** The person's message: their text and images, plus the files they mentioned. */
  async #promptContent(prompt: Prompt): Promise<ContentPart[]> {
    const content: ContentPart[] = prompt.content.map((p) => ({ ...p }));
    for (const mention of prompt.mentions) {
      content.push({ type: "text", text: await this.#mentionText(mention) });
    }
    return content;
  }

  async #mentionText(mention: Prompt["mentions"][number]): Promise<string> {
    const absolute = path.resolve(this.cwd, mention.path);
    const info = await stat(absolute).catch(() => null);
    if (info === null) return `The person mentioned ${absolute}, which does not exist.`;
    if (info.isDirectory()) return `The person mentioned the directory ${absolute}.`;
    const text = await readFile(absolute, "utf8").catch(() => null);
    if (text === null || text.includes("\u0000")) {
      return `The person mentioned the file ${absolute}; it is not a text file.`;
    }
    const lines = text.split("\n");
    const start = Math.max(1, mention.startLine ?? 1);
    const end = Math.min(lines.length, mention.endLine ?? lines.length);
    let body = lines.slice(start - 1, end).join("\n");
    const max = this.#ctx.limits.mentionMaxChars;
    const cut = body.length > max;
    if (cut) body = body.slice(0, max);
    const range =
      mention.startLine === undefined && mention.endLine === undefined
        ? ""
        : ` (lines ${start}-${end})`;
    const note = cut ? `\n[cut at ${max} characters; read the rest with Read]` : "";
    return `Contents of ${absolute}${range}, mentioned by the person:\n\`\`\`\n${body}\n\`\`\`${note}`;
  }

  async #savePlan(requestId: string, plan: string): Promise<string | null> {
    try {
      const dir = path.join(this.#ctx.storeRoot, "plans");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${this.id}-${requestId.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
      await writeFile(file, plan.endsWith("\n") ? plan : `${plan}\n`, "utf8");
      return file;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: notes
  // -------------------------------------------------------------------------------------------

  async #appendNote(note: SystemNote): Promise<void> {
    await this.#writer.appendMessage(this.#ctx.assembler.note(note));
    if (note.type === "mode_changed" || note.type === "plan_approved") this.#knownMode = note.mode;
    if (note.type === "date_changed") this.#knownDate = note.date;
  }

  /**
   * Appends the notes that wait for a safe point: between turns, or after a batch's results are
   * all in history. Never between a call and its result.
   */
  async #flushNotes(): Promise<void> {
    const today = localDate(this.#ctx.clock());
    if (today !== this.#knownDate) await this.#appendNote({ type: "date_changed", date: today });
    const approved = this.#planApprovedInto;
    this.#planApprovedInto = null;
    if (approved !== null && approved === this.#mode && this.#knownMode !== this.#mode) {
      await this.#appendNote({ type: "plan_approved", mode: this.#mode });
    }
    if (this.#mode !== this.#knownMode) {
      await this.#appendNote({ type: "mode_changed", mode: this.#mode });
    }
    while (this.#queuedNotes.length > 0) {
      await this.#appendNote(this.#queuedNotes.shift() as SystemNote);
    }
    for (const task of getBackgroundTasks(this.#bag).takeFinished()) {
      await this.#appendNote({
        type: "background_task_finished",
        taskId: task.id,
        command: task.command,
        exitCode: task.exitCode,
        outputPath: task.outputPath,
      });
    }
  }

  /** Instruction files made relevant by the files a batch read or changed, as notes. */
  async #afterToolBatch(executed: readonly ExecutedCall[]): Promise<void> {
    for (const e of executed) {
      for (const file of [...e.touched.read, ...e.touched.written]) {
        const batch = await this.#instructions.forFile(file);
        for (const found of batch.files) {
          await this.#appendNote({
            type: "instructions_added",
            path: found.path,
            content: found.content,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: the turn loop's host
  // -------------------------------------------------------------------------------------------

  #permissionState(): PermissionState {
    return {
      mode: this.#mode,
      rules: this.#rules,
      cwd: this.cwd,
      workingDirectories: [this.cwd, ...this.#dirs],
      homeDir: this.#ctx.homeDir,
    };
  }

  #probeContext(): ToolProbeContext {
    return { cwd: this.cwd, workingDirectories: [this.cwd, ...this.#dirs], state: this.#bag };
  }

  #services(turnId: string, toolCallId: string, signal: AbortSignal): SessionServices {
    return {
      getMode: () => this.#mode,
      setMode: (mode) => {
        if (this.#modeAllowed(mode)) this.#applyMode(mode);
      },
      setTasks: (tasks) => this.#setTasks(tasks),
      askUser: async (questions) => {
        if (!this.#capabilities.questions) throw new NoOneToAskError();
        const response = await this.#raise<QuestionResponse>(
          {
            kind: "question",
            turnId,
            requestId: this.#ctx.newId("request"),
            toolCallId,
            questions,
          },
          signal,
        );
        if (response.outcome === "dismissed") {
          throw new RequestDismissedError(response.message ?? null);
        }
        return response.answers;
      },
      proposePlan: async (plan) => {
        if (!this.#capabilities.planApproval) throw new NoOneToAskError();
        const requestId = this.#ctx.newId("request");
        const planPath = await this.#savePlan(requestId, plan);
        const response = await this.#raise<PlanResponse>(
          {
            kind: "plan",
            turnId,
            requestId,
            toolCallId,
            plan,
            planPath,
            modeBeforePlan: this.#modeAfterPlan(undefined),
          },
          signal,
        );
        if (response.decision === "reject") {
          return response.message === undefined
            ? { approved: false }
            : { approved: false, message: response.message };
        }
        // The answer may name the mode to continue in; the tool cannot receive it, so the
        // session switches here, before the tool reads the mode back.
        const next = this.#modeAfterPlan(response.mode);
        this.#applyMode(next);
        this.#planApprovedInto = next;
        return { approved: true };
      },
    };
  }

  #toolContext(call: { turnId: string; toolCallId: string; signal: AbortSignal }): ToolContext {
    const state = this.#permissionState();
    const endpoint = this.#connection.client.endpoint;
    const ctx: ToolContext = {
      sessionId: this.id,
      toolCallId: call.toolCallId,
      cwd: this.cwd,
      workingDirectories: state.workingDirectories,
      state: this.#bag,
      signal: call.signal,
      limits: this.#ctx.toolLimits,
      env: this.#settings.env,
      vision: endpoint.capabilities.vision,
      ripgrepPath: this.#ctx.ripgrepPath,
      session: this.#services(call.turnId, call.toolCallId, call.signal),
      progress: (update) => {
        this.#emit("tool.progress", {
          turnId: call.turnId,
          toolCallId: call.toolCallId,
          progress: update,
        });
      },
      saveOutput: (name, content) => this.#writer.saveOutput(name, content),
    };
    if (state.rules.deny.length === 0) return ctx;
    return { ...ctx, readDenied: (file: string) => readDeniedBy(file, state) !== null };
  }

  async #allowAlways(rules: readonly string[]): Promise<void> {
    const from: SettingsFileRef = {
      source: "local",
      origin: "dawg",
      path: localSettingsPath(this.cwd),
    };
    const known = new Set(this.#rules.allow.map((r) => r.rule));
    const added: PermissionRule[] = rules
      .filter((r) => !known.has(r))
      .map((rule) => ({ rule, from }));
    // In force for this session at once, whether or not the file can be written.
    this.#rules = { ...this.#rules, allow: [...added, ...this.#rules.allow] };
    try {
      await addPermissionRules({ projectDir: this.cwd, list: "allow", rules: [...rules] });
    } catch (error) {
      this.#emit("error", {
        turnId: this.activeTurnId,
        error: errorInfo(
          "storage",
          "The permission rule could not be saved to the project's settings; it applies to this session only.",
          error instanceof Error ? error.message : String(error),
          false,
        ),
      });
    }
  }

  #requestModel(): {
    client: ModelClient;
    options: Omit<ModelRequest, "messages" | "tools" | "signal">;
  } {
    const profile = this.#profile;
    const endpoint = this.#connection.client.endpoint;
    const options: Omit<ModelRequest, "messages" | "tools" | "signal"> = {
      maxOutputTokens: this.#outputLimit(profile.maxOutputTokens),
      sampling: profile.sampling,
    };
    const effort = this.#effort ?? profile.defaultEffort;
    if (effort !== null && this.#effortLevels().includes(effort)) options.reasoningEffort = effort;
    if (profile.parallelToolCalls && endpoint.template?.parallelToolCalls === true) {
      options.parallelToolCalls = true;
    }
    // With a pool, the scheduler picks the slot for each request.
    if (this.#connection.pool === undefined && this.#connection.slot !== undefined) {
      options.slot = this.#connection.slot;
    }
    if (profile.chatTemplateKwargs !== null) {
      options.extraBody = { chat_template_kwargs: profile.chatTemplateKwargs };
    }
    return { client: this.#client, options };
  }

  #recordUsage(reply: ModelReply, malformed: number, requestViewLength: number): void {
    const view = this.#writer.snapshot.view.slice(0, requestViewLength);
    const estimator = this.#ctx.estimator;
    const estimatePrompt = () =>
      estimator.estimate({ messages: [this.#prefix.system, ...view], tools: this.#prefix.tools });
    this.#usage.recordRequest(reply.usage, malformed, () => ({
      prompt: estimatePrompt(),
      completion: estimator.estimate({
        messages: [{ role: "assistant", content: reply.content, toolCalls: [] }],
        tools: [],
      }),
    }));
    // The reply, when usable, is already in history: the view holds what `contextUsed` counts.
    this.#usage.split(this.#contextEstimate(this.#writer.snapshot.view));
    this.#usageMark = {
      generation: this.#viewGeneration,
      viewLength: view.length,
      promptTokens: reply.usage.promptTokens ?? estimatePrompt(),
    };
    this.#emitUsage();
  }

  #turnHost(): TurnHost {
    const ctx = this.#ctx;
    const writer = this.#writer;
    return {
      tools: ctx.toolMap,
      permissions: ctx.permissions,
      limits: ctx.limits,
      loopLimits: ctx.limits,
      emit: this.#emit,
      now: ctx.clock,
      newId: ctx.newId,
      permissionState: () => this.#permissionState(),
      probeContext: () => this.#probeContext(),
      canAskPermission: () => this.#capabilities.permissionPrompts,
      askPermission: (request, turnId, signal) =>
        this.#raise<PermissionResponse>({ kind: "permission", turnId, request }, signal),
      allowAlways: (rules) => this.#allowAlways(rules),
      toolContext: (call) => this.#toolContext(call),
      appendResult: async (message, extras) => {
        await writer.appendMessage(message, extras);
      },
      saveOutput: (name, content) => writer.saveOutput(name, content),
      quote: (text) => ctx.assembler.quote(text),
      model: () => this.#requestModel(),
      prefix: () => this.#prefix,
      view: () => writer.snapshot.view,
      isCallIdTaken: (id) => this.#callIds.has(id),
      appendMessage: async (message, extras) => {
        await writer.appendMessage(message, extras);
        if (message.role === "assistant")
          for (const c of message.toolCalls) this.#callIds.add(c.id);
      },
      appendNote: (note) => this.#appendNote(note),
      flushNotes: () => this.#flushNotes(),
      afterToolBatch: (executed) => this.#afterToolBatch(executed),
      recordUsage: (reply, malformed, length) => this.#recordUsage(reply, malformed, length),
      makeRoom: (turnId, signal, check) => this.#makeRoom(turnId, signal, check),
      sleep,
    };
  }

  /** Reads the session's runtime.json, for tests and tools. */
  static readSidecar(sessionDir: string): Promise<Sidecar | null> {
    return readSidecar(sessionDir);
  }
}

function promptText(content: readonly ContentPart[]): string | null {
  const text = content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  return text === "" ? null : text;
}
