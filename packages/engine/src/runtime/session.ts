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
  type Checkpoint,
  type ClientCapabilities,
  type ContentPart,
  type ContextBreakdown,
  type Effort,
  type ElicitationResponse,
  type ErrorInfo,
  elicitationIssues,
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
  type SubagentLabel,
  type TaskItem,
  type ToolDisplay,
} from "@dawg/protocol";
import {
  AGENTS_STATE_KEY,
  type AgentHost,
  openChildRuntime,
  SubagentManager,
  type SubagentRole,
} from "../agents/index.ts";
import { CheckpointStore, type Present, type RestoreOutcome } from "../checkpoints/index.ts";
import { partialSummaryNote } from "../context/summary.ts";
import type { Message } from "../contracts/messages.ts";
import type { ModelClient, ModelReply, ModelRequest } from "../contracts/model.ts";
import type { PermissionState } from "../contracts/permissions.ts";
import type { ModelProfile, PromptPrefix, SystemNote } from "../contracts/prompt.ts";
import type {
  AnyTool,
  ElicitationRequest,
  SessionServices,
  SessionStateBag,
  ToolContext,
  ToolProbeContext,
} from "../contracts/tools.ts";
import type { UtilityModel } from "../contracts/web.ts";
import type { HookAgents } from "../hooks/agent.ts";
import { ifRuleMatches } from "../hooks/if-rule.ts";
import type { HookMcp } from "../hooks/mcp-tool.ts";
import { type HookEffects, type HookElicitation, SessionHooks } from "../hooks/session-hooks.ts";
import { toolResponse } from "../hooks/tool-response.ts";
import { errorInfo, errorInfoFrom } from "../loop/errors.ts";
import type {
  ExecutedCall,
  HookedCall,
  PermissionHookVerdict,
  ToolHookVerdict,
} from "../loop/executor.ts";
import {
  type ResumedBatch,
  type RoomCheck,
  type RoomResult,
  runTurn,
  type TurnHost,
} from "../loop/turn.ts";
import type { Emit, LoopResult } from "../loop/types.ts";
import { MCP_STATE_KEY, type McpDecision, mcpToolName, SessionMcp } from "../mcp/index.ts";
import {
  autoMemoryEnabled,
  loadMemoryIndex,
  type MemoryIndex,
  memoryDirectory,
  renderMemoryPrompt,
} from "../memory/index.ts";
import { scheduledClient } from "../model/slots.ts";
import { readDeniedBy } from "../permissions/index.ts";
import { toToolSchema } from "../prompt/assembler.ts";
import { SANDBOX_STATE_KEY, SessionSandbox } from "../sandbox/session.ts";
import type { SessionRecord, SessionWriter, StateChanges } from "../session/index.ts";
import {
  SessionSkills,
  SKILLS_STATE_KEY,
  type SkillPromptOptions,
  skillTool,
  withSkillsReattached,
} from "../skills/index.ts";
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
import { SettingsReloader } from "./settings-reload.ts";
import { readSidecar, type Sidecar, writeSidecar } from "./sidecar.ts";
import { generateTitle } from "./title.ts";
import {
  callIds,
  danglingCalls,
  firstPromptText,
  modeBeforePlan,
  promptSeqOf,
  touchedSinceCompaction,
  turnIdFor,
  usageFromRecords,
  viewIndexOfRecord,
} from "./transcript.ts";
import type { CompactionOutcome, ModelConnection, TurnOutcome } from "./types.ts";
import { UsageTracker } from "./usage.ts";
import { findWaitingTurn, requestCallId, requestIdOf, type WaitingTurn } from "./waiting-turn.ts";

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

/** How long the first prompt waits for SessionStart hooks before it goes ahead without them. */
const SESSION_START_WAIT_MS = 10_000;

/** Resolves when `promise` settles or `ms` pass, whichever is first. Never rejects. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** The summary a trim writes in its compact record; it marks the record as a trim on resume. */
export const TRIM_SUMMARY = "The largest tool result was shortened to fit the context window.";

export interface RuntimeInit {
  ctx: EngineContext;
  writer: SessionWriter;
  /** The transcript as it was when the session was opened. */
  records: readonly SessionRecord[];
  log: EventLog;
  settings: Settings;
  /**
   * What the settings files looked like just before `settings` was loaded (`settingsStamp`), so
   * the first turn reloads only if they changed since. Left out, the first turn reloads them.
   */
  settingsStamp?: string | null;
  instructions: InstructionSet;
  connection: ModelConnection;
  capabilities: ClientCapabilities;
  /** The session's side folder (tool results, events, runtime.json). */
  sessionDir: string;
  sidecar: Sidecar | null;
  /** The session's skills and custom commands; loaded from its folders when left out. */
  skills?: SessionSkills;
  /**
   * Why the session opened, for SessionStart hooks (`source`): new, resumed, `/clear`, forked.
   * Default "resume".
   */
  startSource?: "startup" | "resume" | "clear" | "fork";
  /** The session's file history (../checkpoints); opened from `sessionDir` when left out. */
  checkpoints?: CheckpointStore;
  /** MEMORY.md as the session opened (../memory); null when auto memory is off. */
  memory?: MemoryIndex | null;
  /** The session's own MCP servers (an `mcpServers` object), over every other definition. */
  mcpServers?: Readonly<Record<string, unknown>>;
  /** Added (round 3): only `mcpServers`, none of the project's or the person's. */
  strictMcpConfig?: boolean;
  /** Set when this session is a subagent of another (../agents): what makes it one. */
  subagent?: SubagentRole;
  /** A main session's subagents; loaded from its folders when left out. */
  agents?: SubagentManager;
}

interface PendingEntry {
  ask: PendingRequest;
  requestId: string;
  resolve(response: unknown): void;
}

/**
 * A request brought back when the session opened (see waiting-turn.ts). The person answers it on
 * the card as usual; the call that asked it takes the answer when the turn carries on.
 */
interface RestoredAsk {
  ask: PendingRequest;
  requestId: string;
  /** Resolves with the person's answer. */
  answer: Promise<unknown>;
  settle(response: unknown): void;
}

/** A turn that waited on the person when the session stopped, brought back with it. */
interface RestoredTurn {
  waiting: WaitingTurn;
  /** True once it runs again: answered, or stopped. */
  running: boolean;
  /** Ends the session's busy state once the turn is over. */
  release(): void;
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

/**
 * What a turn waits on, as the side file keeps it: an MCP server's request for input is left out,
 * since it goes with the process and the turn cannot carry on after it (waiting-turn.ts).
 */
function waitingKind(kind: PendingRequest["kind"] | undefined): Sidecar["waitingOn"] {
  return kind === undefined || kind === "elicitation" ? null : kind;
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
  /** Reloaded at the start of a turn when a file changed (see settings-reload.ts). */
  #settings: Settings;
  readonly #settingsReloader: SettingsReloader;
  #rules: PermissionState["rules"];
  /** "Always allow" rules that could not be saved: they hold for this session whatever the files say. */
  #unsavedAllow: PermissionRule[] = [];
  #instructions: InstructionSet;
  /** The instruction files as rendered into the prefix, for the context breakdown. */
  #instructionsText: string;
  #prefix: PromptPrefix;
  /**
   * The tools this session offers, decided once when it opens (`ToolDefinition.offered`): the
   * tool list is part of the cached prefix.
   */
  #tools: readonly AnyTool[];
  /** The tools calls are run with: the engine's, and Skill when this session offers it. */
  #toolMap: ReadonlyMap<string, AnyTool>;
  /**
   * The session's MCP servers (../mcp). Their tools join the list once, before the first
   * request (`#settleMcp`), and the list never changes after that.
   */
  #mcp: SessionMcp;
  /** The prefix's MCP segment, fixed once decided. */
  #mcpSegment = "";
  #mcpSettled = false;
  /** The session's own MCP servers and strictness, which its subagents share (../agents). */
  readonly #ownMcp: { servers?: Readonly<Record<string, unknown>>; strict: boolean };
  /** Set when this session is a subagent (../agents). */
  readonly #role: SubagentRole | null;
  /** A main session's subagents (../agents); null in a subagent. */
  #agents: SubagentManager | null = null;
  /** The tools a subagent's subset is taken from: those offered before the agent tools. */
  #baseTools: readonly AnyTool[] = [];
  /** Skills and custom commands (../skills), read when the session opened. */
  readonly #skills: SessionSkills;
  /** The session's hooks (../hooks): tier 1 events, reloaded with the settings. */
  readonly #hooks: SessionHooks;
  /** Files as they were before each prompt, for rewinding them (../checkpoints). */
  readonly #checkpoints: CheckpointStore;
  /** The project's memory as the session opened, or null when auto memory is off (../memory). */
  readonly #memory: MemoryIndex | null;
  /** The memory segment of the prefix: fixed for the session's life, so the cache holds. */
  readonly #memoryPrompt: string;
  #checkpointErrorShown = false;
  /** SessionStart hooks, started when the session opened; the first prompt waits for them. */
  #sessionStart: Promise<void> = Promise.resolve();
  /** Fires the idle Notification hooks a while after a turn ends, unless another starts. */
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** A hook said `continue: false` this turn: it ends at the next safe point. */
  #hookStop = false;
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
  /** A turn brought back waiting on the person, until it is over. */
  #restoredTurn: RestoredTurn | null = null;
  /** Its requests not yet taken by the calls that asked them, by tool call id. */
  #restoredAsks = new Map<string, RestoredAsk>();
  /**
   * While a turn that waits on the person is let go on close: nothing it does on the way out is
   * recorded, so the next open finds it still waiting.
   */
  #frozen = false;
  /** What the turn waits on while it is kept for the next open (runtime.json). */
  #suspendedOn: PendingRequest["kind"] | null = null;
  /** Subagents' requests for input waiting here: an interrupt of this session's turn stops them. */
  readonly #agentAsks = new Set<AbortController>();
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
    this.#role = init.subagent ?? null;
    this.#settingsReloader = new SettingsReloader(
      {
        projectDir: this.cwd,
        // A worktree session's personal settings are its project's (see engine.ts).
        localDir: this.projectDir,
        homeDir: ctx.homeDir,
        ...(ctx.settingsFlags === undefined ? {} : { flags: ctx.settingsFlags }),
      },
      init.settingsStamp ?? null,
    );
    this.#hooks = new SessionHooks({
      sessionId: this.id,
      cwd: this.cwd,
      projectDir: this.projectDir,
      homeDir: ctx.homeDir,
      // The transcript sits beside the side folder: `<id>.jsonl` next to `<id>/`.
      transcriptPath: `${init.sessionDir}.jsonl`,
      trust: ctx.trust,
      env: () => this.#settings.env,
      mode: () => this.#mode,
      emit: (event, fields) => this.#emit(event, fields),
      queueNote: (text) => this.#queuedNotes.push({ type: "text", text }),
      now: ctx.clock,
      // What http, prompt, agent and mcp_tool handlers run on, read when a hook runs.
      services: {
        model: () => this.#utilityModel(),
        agents: () => this.#hookAgents(),
        mcp: () => this.#hookMcp(),
      },
      ...(this.#role === null
        ? {}
        : {
            subagent: {
              agentId: this.#role.label.agentId,
              agentType: this.#role.label.agentType,
            },
          }),
    });
    this.#rules = {
      allow: [...init.settings.permissions.allow],
      ask: [...init.settings.permissions.ask],
      deny: [...init.settings.permissions.deny],
    };
    this.#instructions = init.instructions;
    this.#instructionsText = renderInstructions(init.instructions.files);
    const services = ctx.services();
    this.#tools = ctx.tools.filter((t) => t.offered === undefined || t.offered(services));
    // Skills (../skills): the Skill tool when the agent may load one, and their listing.
    this.#skills = init.skills ?? new SessionSkills([], null);
    this.#bindSkills();
    // The sandbox (../sandbox) reads the settings and rules in force at each call.
    this.#bag.get(
      SANDBOX_STATE_KEY,
      () =>
        new SessionSandbox({
          host: ctx.sandbox,
          settings: () => this.#settings.sandbox,
          rules: () => this.#rules,
          homeDir: ctx.homeDir,
          // Hosts a project's files list wait for the person's approval, like its hooks.
          allows: (source) => ctx.trust.allows(source, this.projectDir),
        }),
    );
    this.#toolMap = ctx.toolMap;
    if (this.#skills.offersTool && !this.#tools.some((t) => t.name === skillTool.name)) {
      this.#tools = [...this.#tools, skillTool];
      this.#toolMap = new Map([...ctx.toolMap, [skillTool.name, skillTool]]);
    }
    // Subagents (../agents): a subagent gets its role's tools, and the MCP tools its role allows
    // once they are decided (a fork its parent's exactly); a main session gets the Agent and
    // SendMessage tools.
    this.#baseTools = this.#tools;
    this.#ownMcp = {
      ...(init.mcpServers === undefined ? {} : { servers: init.mcpServers }),
      strict: init.strictMcpConfig === true,
    };
    const role = this.#role;
    if (role !== null) {
      this.#mcpSettled = role.fork !== null || (role.mcp ?? null) === null;
      if (role.fork !== null) {
        this.#tools = role.fork.tools;
        this.#toolMap = role.fork.toolMap;
      } else {
        this.#tools = role.tools(this.#tools);
        this.#toolMap = new Map(this.#tools.map((t) => [t.name, t] as const));
      }
    } else if (init.agents !== undefined) {
      const agents = init.agents;
      this.#agents = agents;
      this.#bag.get(AGENTS_STATE_KEY, () => agents);
      this.#tools = [...this.#tools, ...agents.tools];
      this.#toolMap = new Map([...this.#toolMap, ...agents.tools.map((t) => [t.name, t] as const)]);
    }
    this.#memory = init.memory ?? null;
    // A subagent's own memory has its own instructions (../agents/memory.ts).
    this.#memoryPrompt =
      this.#memory === null ? "" : (role?.memory?.prompt ?? renderMemoryPrompt(this.#memory));
    // Always given by `start`, which opens it from the session's folder.
    this.#checkpoints = init.checkpoints as CheckpointStore;
    this.#mcp = SessionMcp.none({ sessionId: this.id, cwd: this.cwd, projectDir: this.projectDir });
    this.#prefix =
      role?.fork?.prefix ??
      ctx.assembler.prefix({
        tools: this.#tools,
        instructions: this.#instructionsText,
        skills: this.#skills.listing,
        mcp: this.#mcpSegment,
        memory: this.#memoryPrompt,
        ...this.#agentPrefix(),
      });
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
      if (this.#frozen) return;
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
    const cwd = init.writer.snapshot.meta.cwd;
    const skills =
      init.skills ??
      (await SessionSkills.load({
        homeDir: init.ctx.homeDir,
        cwd,
        projectDir: init.sidecar?.projectDir ?? cwd,
        contextWindow: init.connection.client.endpoint.contextWindow,
      }));
    const sessionId = init.writer.sessionId;
    let opened: SessionRuntime | null = null;
    const checkpoints =
      init.checkpoints ??
      (await CheckpointStore.open({
        dir: path.join(init.sessionDir, "file-history"),
        sessionId,
        retention: init.ctx.checkpointRetention,
        clock: init.ctx.clock,
        onError: (message, error) => {
          if (opened !== null) opened.#checkpointError(message, error);
        },
      }));
    const memory =
      init.memory !== undefined
        ? init.memory
        : await SessionRuntime.#loadMemory(init, init.sidecar?.projectDir ?? cwd);
    const agents =
      init.subagent !== undefined || !init.ctx.subagents
        ? undefined
        : (init.agents ??
          (await SubagentManager.load({
            homeDir: init.ctx.homeDir,
            cwd,
            projectDir: init.sidecar?.projectDir ?? cwd,
          })));
    const runtime = new SessionRuntime({
      ...init,
      skills,
      checkpoints,
      memory,
      ...(agents === undefined ? {} : { agents }),
    });
    runtime.#bindAgents();
    opened = runtime;
    // MCP servers start with the session; its first request waits a little for them. A typed
    // subagent sees only what its role allows, and one with no MCP access opens none (../agents).
    const role = init.subagent;
    const noMcp = role !== undefined && role.fork === null && (role.mcp ?? null) === null;
    if (!noMcp) {
      runtime.#mcp = await SessionMcp.open(init.ctx.mcp, {
        sessionId,
        cwd,
        projectDir: runtime.projectDir,
        settingsEnv: () => runtime.#settings.env,
        ...(init.mcpServers === undefined ? {} : { sessionServers: init.mcpServers }),
        ...(init.strictMcpConfig === true ? { strictMcpConfig: true } : {}),
        ...(role?.mcp == null || role.fork !== null ? {} : { filter: role.mcp }),
      }).catch(() => runtime.#mcp);
    }
    runtime.#bag.get(MCP_STATE_KEY, () => runtime.#mcp);
    await runtime.#prepare(init.records);
    await runtime.#hooks.reload();
    // SessionStart hooks run on while the session is handed back; the first prompt waits.
    runtime.#sessionStart = runtime.#runSessionStart(init.startSource ?? "resume");
    return runtime;
  }

  async #prepare(records: readonly SessionRecord[]): Promise<void> {
    // The instruction files earlier calls made relevant were already given to the model.
    for (const file of touchedSinceCompaction(records, (s) => s === TRIM_SUMMARY)) {
      await this.#instructions.forFile(file);
      // Skills of folders inside the project, likewise (the note about them is in history).
      await this.#skills.forFile(file);
    }
    // Skill bodies already in the model's view, for "already loaded" and re-attachment.
    this.#skills.restore(this.#writer.snapshot.view);
    // A turn that stopped while it waited on the person waits on: answering carries it on.
    const waiting = findWaitingTurn(
      this.#log.all(),
      this.#writer.snapshot.view,
      this.#prefix.tools,
      this.#capabilities,
    );
    // A session that stopped mid-batch has calls without results; templates refuse that.
    const dangling = waiting === null ? danglingCalls(this.#writer.snapshot.view) : [];
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
    closeUnfinished(this.#log, this.#ctx.clock(), { keepWaitingTurn: waiting !== null });
    const stored = backgroundFromEvents(this.#log.all());
    this.#background = stored.tasks;
    this.#backgroundPaths = stored.outputPaths;
    getBackgroundTasks(this.#bag).continueAfter(stored.highestNumber);
    if (waiting !== null) this.#restore(waiting);
    await this.#saveSidecar();
  }

  /**
   * Brings back a turn that waited on the person: the session is busy with it and waiting, with
   * the same requests pending. The first answer carries the turn on; stopping it ends it as an
   * interrupted turn, with each request cancelled.
   */
  #restore(waiting: WaitingTurn): void {
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    this.#busy = {
      kind: "turn",
      turnId: waiting.turnId,
      controller,
      done,
      promptSeq: waiting.promptSeq,
    };
    const restored: RestoredTurn = { waiting, running: false, release };
    this.#restoredTurn = restored;
    for (const ask of waiting.requests) {
      const requestId = requestIdOf(ask);
      let settle: (response: unknown) => void = () => {};
      const answer = new Promise<unknown>((resolve) => {
        settle = resolve;
      });
      this.#restoredAsks.set(requestCallId(ask), { ask, requestId, answer, settle });
      this.#pending.set(requestId, {
        ask,
        requestId,
        resolve: (response) => {
          settle(response);
          this.#carryOn();
        },
      });
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        if (restored.running) return;
        for (const entry of [...this.#pending.values()]) this.#cancel(entry);
        this.#carryOn();
      },
      { once: true },
    );
    const first = waiting.requests[0]?.kind ?? null;
    this.#suspendedOn = first;
    // Clients last heard "waiting" for these requests; nothing needs saying again.
    this.#status = "waiting";
    this.#waitingOn = first;
    this.#statusQueuePosition = null;
  }

  /** Runs the brought-back turn on: its remaining calls, then the loop as usual. */
  #carryOn(): void {
    const restored = this.#restoredTurn;
    const busy = this.#busy;
    if (restored === null || restored.running || busy?.kind !== "turn") return;
    restored.running = true;
    this.#suspendedOn = null;
    void this.#saveSidecar();
    const { waiting } = restored;
    void this.#runTurn(waiting.turnId, busy.controller, waiting.startedAt, {
      messageId: waiting.messageId,
      calls: waiting.calls,
      alreadyStarted: waiting.started,
      lastText: waiting.lastText,
    }).finally(() => {
      if (this.#restoredTurn === restored) this.#restoredTurn = null;
      this.#restoredAsks.clear();
      restored.release();
    });
  }

  /** The brought-back request a call asked before the restart, taken once. */
  #takeRestored(kind: PendingRequest["kind"], toolCallId: string): RestoredAsk | null {
    const restored = this.#restoredAsks.get(toolCallId);
    if (restored === undefined || restored.ask.kind !== kind) return null;
    this.#restoredAsks.delete(toolCallId);
    return restored;
  }

  /** Waits for the answer to a brought-back request; stopping the turn cancels it. */
  #awaitRestored<R>(restored: RestoredAsk, signal: AbortSignal): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const cancel = () => {
        const entry = this.#pending.get(restored.requestId);
        if (entry !== undefined) this.#cancel(entry);
        reject(abortError());
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      void restored.answer.then((response) => {
        signal.removeEventListener("abort", cancel);
        resolve(response as R);
      });
    });
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
   * a compaction runs. `options` is for a skill or custom command the person ran (../skills).
   */
  async prompt(input: PromptInput, options: SkillPromptOptions = {}): Promise<{ turnId: string }> {
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
      // Settings edited since the last turn apply from this one.
      await this.#reloadSettings();
      // SessionStart hooks' context goes in before the first prompt; a slow hook does not hold
      // the prompt for long, and what it adds later waits for the next safe point.
      await settledWithin(this.#sessionStart, SESSION_START_WAIT_MS);
      // Servers approved since the last turn start now; the first turn decides the MCP tools.
      await this.#mcp.refresh();
      await this.#settleMcp();
      // UserPromptSubmit hooks see the prompt first and may refuse it (it is then never written).
      const promptNotes = await this.#promptHooks(prompt, options, controller.signal);
      // The start of a turn is a safe point for notes: they go before the prompt.
      await this.#flushNotes();
      const content = await this.#promptContent(prompt);
      // The assembler makes text that imitates a note harmless (pasted text, mentioned files).
      const message = { ...this.#ctx.assembler.prompt(content), kind: "prompt" as const };
      const record = await this.#writer.appendMessage(message);
      turnId = turnIdFor(record.seq);
      busy.promptSeq = record.seq;
      // A checkpoint opens before the prompt is processed (../checkpoints).
      await this.#checkpoints.open(turnId);
      // What the hooks added goes with the prompt ("added to Claude's context alongside it").
      for (const text of promptNotes) await this.#appendNote({ type: "text", text });
      // The person's message ends the last skill's grants; a skill they ran grants its own.
      this.#skills.startTurn(promptText(prompt.content) ?? "", options.invocation ?? null);
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
    const command = options.command ?? null;
    // A command's turn shows the command as typed; the model was given what it expands to.
    const shown =
      command === null
        ? prompt
        : {
            content: [
              {
                type: "text" as const,
                text: `/${command.name}${command.args === "" ? "" : ` ${command.args}`}`,
              },
            ],
            mentions: [],
          };
    this.#emit("turn.started", { turnId, prompt: shown, command });
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

  async #runTurn(
    turnId: string,
    controller: AbortController,
    startedAt: number,
    resume?: ResumedBatch,
  ): Promise<void> {
    let result: LoopResult;
    try {
      // A turn brought back after a restart may be the session's first to send a request.
      if (resume !== undefined) await this.#settleMcp();
      result = await runTurn(this.#turnHost(), {
        turnId,
        signal: controller.signal,
        ...(resume === undefined ? {} : { resume }),
      });
    } catch (error) {
      result = { stopReason: "error", finalText: null, error: errorInfoFrom(error) };
      await this.#repairDangling().catch(() => {});
    }
    for (const entry of [...this.#pending.values()]) {
      // A subagent's request for input is the agent's, which may work on in the background;
      // it goes with this turn only when the turn was interrupted.
      if (entry.ask.kind === "elicitation" && entry.ask.agent !== undefined) continue;
      this.#cancel(entry);
    }
    if (result.stopReason === "interrupted") {
      for (const stop of [...this.#agentAsks]) stop.abort();
    }
    if (result.stopReason === "error" && result.error !== null) {
      this.#stopFailureHooks(turnId, result.error);
    }
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
    if (!this.#writer.closed && !this.#frozen) {
      void this.#writer.setStatus(this.#lastTurnFailed ? "error" : "idle").catch(() => {});
    }
    void this.#saveSidecar();
    this.#maybeGenerateTitle();
    this.#scheduleIdleNotification();
  }

  /** After a failure inside the loop: give every call left without a result one. */
  async #repairDangling(): Promise<void> {
    if (this.#writer.closed || this.#frozen) return;
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

  /**
   * Answers an MCP server's request for input (`elicitation.respond`). An accepted form must
   * match its fields: otherwise `InvalidParams`, and the request stays pending.
   */
  respondElicitation(
    requestId: string,
    response: { action: ElicitationResponse["action"]; content?: Record<string, unknown> },
  ): void {
    const ask = this.#pending.get(requestId)?.ask;
    const form = ask?.kind === "elicitation" && ask.mode === "form" && response.action === "accept";
    if (form) {
      const issues = elicitationIssues(ask.fields, response.content ?? {});
      if (issues.length > 0) {
        const named = issues.map((i) =>
          i.field === null ? i.message : `${i.field}: ${i.message}`,
        );
        throw new RuntimeError(
          "InvalidParams",
          `The answer does not fit the form. ${named.join(" ")}`,
        );
      }
    }
    const answer: ElicitationResponse = {
      action: response.action,
      content: form ? ((response.content ?? {}) as ElicitationResponse["content"]) : null,
    };
    this.#answer("elicitation", requestId, answer);
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
    void this.#saveSidecar();
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
      case "elicitation":
        this.#emit("request.resolved", {
          ...base,
          kind: "elicitation",
          response: response as ElicitationResponse | null,
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
      // Listed as waiting even if the process ends before the answer (see waiting-turn.ts).
      void this.#saveSidecar();
      switch (ask.kind) {
        case "permission": {
          this.#emit("permission.requested", { turnId: ask.turnId, request: ask.request });
          // Notification hooks fire if the request is still waiting after a few seconds.
          if (this.#hooks.has("Notification")) {
            const { toolName } = ask.request;
            const timer = setTimeout(() => {
              if (this.#pending.has(requestId)) {
                this.#notify(
                  "permission_prompt",
                  `dawg needs your permission to use ${toolName}`,
                  ask.turnId,
                );
              }
            }, this.#ctx.limits.permissionNotificationMs);
            timer.unref?.();
          }
          break;
        }
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
        case "elicitation": {
          const { kind: _kind, ...asked } = ask;
          this.#emit("elicitation.requested", asked);
          // Added (Phase 4, hooks): Notification hooks fire if the form still waits after a few
          // seconds, as for a permission request.
          if (this.#hooks.has("Notification")) {
            const { server, mode } = ask;
            const timer = setTimeout(() => {
              if (this.#pending.has(requestId)) {
                this.#notify(
                  mode === "url" ? "elicitation_url_dialog" : "elicitation_dialog",
                  mode === "url"
                    ? `${server} asks you to open a page`
                    : `${server} asks for your input`,
                  ask.turnId,
                );
              }
            }, this.#ctx.limits.permissionNotificationMs);
            timer.unref?.();
          }
          break;
        }
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

  // -------------------------------------------------------------------------------------------
  // Checkpoints and rewind (../checkpoints, ./rewind.ts)
  // -------------------------------------------------------------------------------------------

  /**
   * One checkpoint per prompt in the conversation, oldest first: when it was sent, what it said,
   * the files its turn changed, and what restoring files to it would do (`session.checkpoints`).
   */
  async checkpoints(): Promise<{ checkpoints: Checkpoint[]; retention: number }> {
    await this.#checkpoints.idle();
    const seen = new Map<string, Present>();
    const out: Checkpoint[] = [];
    for (const turn of this.#turnsStarted()) {
      const { tracked, files } = this.#checkpoints.filesOf(turn.turnId);
      const steps = tracked ? await this.#checkpoints.plan(turn.turnId, seen) : [];
      out.push({
        id: turn.turnId,
        turnId: turn.turnId,
        time: turn.time,
        prompt: turn.prompt,
        tracked,
        files,
        restore: steps.map((step) => ({
          path: step.path,
          action: step.action,
          changedOutside: step.changedOutside,
        })),
      });
    }
    return { checkpoints: out, retention: this.#checkpoints.retention };
  }

  /** A checkpoint's turn and prompt; `InvalidParams` when the conversation has no such prompt. */
  checkpoint(checkpointId: string): { turnId: string; prompt: string; time: number } {
    const turn = this.#turnsStarted().find((t) => t.turnId === checkpointId);
    if (turn === undefined) {
      throw new RuntimeError(
        "InvalidParams",
        `This conversation has no checkpoint ${checkpointId}; list them again.`,
      );
    }
    return turn;
  }

  /** The person's prompts, as `turn.started` gave them, oldest first. */
  #turnsStarted(): { turnId: string; prompt: string; time: number }[] {
    const turns: { turnId: string; prompt: string; time: number }[] = [];
    for (const event of this.#log.all()) {
      if (event.event !== "turn.started") continue;
      const payload = event.payload as unknown as { turnId: string; time: number; prompt: Prompt };
      turns.push({
        turnId: payload.turnId,
        prompt: promptText(payload.prompt.content) ?? "",
        time: payload.time,
      });
    }
    return turns;
  }

  /**
   * Puts the files back as they were at a checkpoint (rewind's "restore files"). With files
   * changed outside the file tools since and no `overwrite`, changes nothing and names them.
   * The model is told at the next safe point which files changed under it.
   */
  async restoreFiles(checkpointId: string, overwrite: boolean): Promise<RestoreOutcome> {
    this.assertRewindable();
    const turn = this.checkpoint(checkpointId);
    const outcome = await this.#checkpoints.restore(turn.turnId, { overwrite });
    const changed = [...outcome.restored, ...outcome.deleted];
    if (outcome.outcome === "done" && changed.length > 0) {
      const start = turn.prompt.length > 200 ? `${turn.prompt.slice(0, 199)}…` : turn.prompt;
      this.#queuedNotes.push({
        type: "text",
        text: `The person put files back as they were before their message "${start.replace(/\s+/g, " ").trim()}". These files changed: ${changed.join(", ")}. Read a file again before you edit it; your earlier reads of it are out of date.`,
      });
    }
    return outcome;
  }

  /**
   * Summarises the conversation from a checkpoint's prompt on, keeping what is before it (rewind's
   * "summarise from here"). Starts it and returns; `compaction.*` events report it, and the
   * session is busy meanwhile. `InvalidState` when an earlier compaction already took that prompt
   * out of the model's view.
   */
  async summarizeFrom(checkpointId: string, focus: string | null): Promise<void> {
    this.assertRewindable();
    const turn = this.checkpoint(checkpointId);
    const seq = promptSeqOf(turn.turnId);
    const { records } = await this.#ctx.store.read(this.cwd, this.id);
    const from = seq === null ? null : viewIndexOfRecord(records, seq);
    const message = from === null ? undefined : this.#writer.snapshot.view[from];
    if (from === null || message?.role !== "user" || message.kind !== "prompt") {
      throw new RuntimeError(
        "InvalidState",
        "That point was already summarised by an earlier compaction; choose a later one.",
      );
    }
    if (this.#busy !== null) throw new RuntimeError("SessionBusy", "A turn is running.");
    const controller = new AbortController();
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#busy = { kind: "compaction", controller, done };
    this.#refreshStatus();
    void this.#compactNow({
      trigger: "manual",
      focus: focus === null || focus.trim() === "" ? null : focus.trim(),
      turnId: null,
      signal: controller.signal,
      from,
    })
      .catch(() => {})
      .finally(() => {
        this.#busy = null;
        release();
        this.#refreshStatus();
        void this.#saveSidecar();
      });
  }

  /**
   * Rewinding waits for the session to be still: no turn (`SessionBusy`), and no subagent left
   * working in the background (`InvalidState`), since its changes count in the checkpoints and it
   * would go on changing files after the rewind. The person stops it, or lets it finish, first.
   */
  assertRewindable(): void {
    this.#assertOpen();
    if (this.#busy !== null) {
      throw new RuntimeError("SessionBusy", "Rewinding has to wait until the current turn ends.");
    }
    const working = (this.#agents?.list() ?? []).filter(
      (a) => a.status === "queued" || a.status === "running",
    );
    if (working.length > 0) {
      const names = working.map((a) => `${a.agentId} (${a.agentType})`).join(", ");
      throw new RuntimeError(
        "InvalidState",
        `${working.length === 1 ? "A subagent is" : "Subagents are"} still working in the background: ${names}. Stop ${working.length === 1 ? "it" : "them"} or let ${working.length === 1 ? "it" : "them"} finish, then rewind.`,
      );
    }
  }

  /** Resolves once the file history has saved everything asked of it (before a fork copies it). */
  checkpointsIdle(): Promise<void> {
    return this.#checkpoints.idle();
  }

  /** The session's file history, for tests. */
  get fileHistory(): CheckpointStore {
    return this.#checkpoints;
  }

  /** The project's memory as this session loaded it, or null when auto memory is off. */
  get memory(): MemoryIndex | null {
    return this.#memory;
  }

  /** A failure to save a checkpoint: said once per session, since it repeats. */
  #checkpointError(message: string, error: unknown): void {
    if (this.#checkpointErrorShown || this.#closed) return;
    this.#checkpointErrorShown = true;
    this.#emit("error", {
      turnId: this.activeTurnId,
      error: errorInfo(
        "storage",
        `${message} Rewinding may not restore files changed from here on.`,
        error instanceof Error ? error.message : String(error),
        false,
      ),
    });
  }

  /** MEMORY.md for a session about to open, or null when auto memory is off for it. */
  static async #loadMemory(init: RuntimeInit, projectDir: string): Promise<MemoryIndex | null> {
    if (!init.ctx.autoMemory) return null;
    if (!(await autoMemoryEnabled(init.settings.files))) return null;
    try {
      return await loadMemoryIndex(await memoryDirectory(init.ctx.storeRoot, projectDir));
    } catch {
      return null;
    }
  }

  async #compactNow(input: {
    trigger: "auto" | "manual";
    focus: string | null;
    turnId: string | null;
    signal: AbortSignal;
    /**
     * Summarise only the view from this index on, keeping what is before it word for word
     * (rewind's "summarise from here"). Absent: the whole conversation.
     */
    from?: number;
  }): Promise<CompactionOutcome> {
    const ctx = this.#ctx;
    const compactionId = ctx.newId("compaction");
    // PreCompact hooks (../hooks) may block it, or give instructions for the summary.
    const pre = await this.#hooks
      .preCompact({
        trigger: input.trigger,
        customInstructions: input.trigger === "manual" ? input.focus : null,
        turnId: input.turnId,
        signal: input.signal,
      })
      .catch(() => ({ blocked: null, instructions: [] as string[] }));
    if (input.signal.aborted) return { outcome: "interrupted", summary: null, error: null };
    const before = Math.round(await this.#predictContext());
    const window = this.#contextWindow();
    if (pre.blocked !== null) {
      const info = errorInfo(
        "other",
        `A PreCompact hook blocked the compaction${pre.blocked.reason === null ? "." : `: ${pre.blocked.reason}`}`,
        null,
        false,
      );
      // An automatic one is skipped quietly (the hook's line says why); one the person asked for
      // says it did not happen.
      if (input.trigger === "manual") {
        this.#emit("compaction.started", {
          compactionId,
          trigger: input.trigger,
          turnId: input.turnId,
          contextUsed: before,
          contextWindow: window,
          focus: input.focus,
        });
        this.#emit("compaction.finished", {
          compactionId,
          outcome: "failed",
          summary: null,
          contextBefore: before,
          contextAfter: null,
          error: info,
        });
      }
      return { outcome: "failed", summary: null, error: info };
    }
    const instructions = [input.focus ?? "", ...pre.instructions].filter((t) => t.trim() !== "");
    const focus = instructions.length === 0 ? null : instructions.join("\n\n");
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
        focus,
        tasks: this.tasks,
        recentFiles: await this.#recentFiles(),
        ...(input.from === undefined ? {} : { from: input.from }),
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
      // So are the skills loaded so far, within a budget (../skills).
      // From a point: the view before it stays as it is, and the summary replaces the rest.
      const view =
        input.from === undefined
          ? result.messages
          : [
              ...this.#writer.snapshot.view.slice(0, input.from),
              partialSummaryNote(result.summary, this.tasks),
            ];
      const messages = withSkillsReattached(view, this.#skills, (text) =>
        ctx.assembler.note({ type: "text", text }),
      );
      const after = Math.round(
        ctx.estimator.estimate({
          messages: [this.#prefix.system, ...messages],
          tools: this.#prefix.tools,
        }),
      );
      await this.#writer.compact({
        trigger: input.trigger,
        ...(input.focus === null ? {} : { focus: input.focus }),
        summary: result.summary,
        messages,
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
      await this.#hooks
        .postCompact({ trigger: input.trigger, summary: result.summary, turnId: input.turnId })
        .catch(() => {});
      // SessionStart hooks run again after a compaction (source "compact"); their context
      // waits for the next safe point.
      await this.#runSessionStart("compact");
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
    this.#prefix = ctx.assembler.prefix({
      tools: this.#tools,
      instructions: this.#instructionsText,
      skills: this.#skills.listing,
      mcp: this.#mcpSegment,
      // Memory stays as the session opened, so a compaction keeps the cached prefix.
      memory: this.#memoryPrompt,
      ...this.#agentPrefix(),
    });
  }

  /**
   * Decides the session's MCP tools once, before its first request: waits a few seconds for
   * servers still starting, then adds their tools (or ToolSearch and CallMcpTool) to the list and
   * their instructions to the prefix. Nothing was sent with the old prefix yet, so no cache is
   * lost; afterwards the list never changes (../mcp/session-mcp.ts).
   */
  async #settleMcp(): Promise<void> {
    if (this.#mcpSettled) return;
    this.#mcpSettled = true;
    const ctx = this.#ctx;
    const empty = ctx.estimator.estimate({ messages: [], tools: [] });
    let decision: McpDecision;
    try {
      decision = await this.#mcp.decide({
        contextWindow: this.#contextWindow(),
        estimate: (tools) =>
          ctx.estimator.estimate({ messages: [], tools: tools.map(toToolSchema) }) - empty,
        env: { ...process.env, ...this.#settings.env },
      });
    } catch {
      return; // A failure here leaves the session without MCP tools, not without a turn.
    }
    // A subagent's servers were filtered already; the tools that come with them stay unless
    // its file takes them away (../agents/mcp.ts).
    const access = this.#role?.mcp ?? null;
    const added = decision.tools.filter(
      (t) =>
        !this.#toolMap.has(t.name) &&
        (access === null || t.name.startsWith("mcp__") || access.keeps(t.name)),
    );
    if (added.length === 0 && decision.segment === "") return;
    this.#tools = [...this.#tools, ...added];
    this.#toolMap = new Map([...this.#toolMap, ...added.map((t) => [t.name, t] as const)]);
    this.#mcpSegment = decision.segment;
    this.#prefix = ctx.assembler.prefix({
      tools: this.#tools,
      instructions: this.#instructionsText,
      skills: this.#skills.listing,
      mcp: this.#mcpSegment,
      memory: this.#memoryPrompt,
      ...this.#agentPrefix(),
    });
  }

  /** The session's MCP servers: `/mcp`, the composer's resources and prompts. */
  get mcp(): SessionMcp {
    return this.#mcp;
  }

  /** Lends the session's skills what they need: permissions, settings, the window. */
  #bindSkills(): void {
    const ctx = this.#ctx;
    this.#bag.get(SKILLS_STATE_KEY, () => this.#skills);
    this.#skills.bind({
      sessionId: this.id,
      cwd: this.cwd,
      projectDir: this.projectDir,
      homeDir: ctx.homeDir,
      permissions: ctx.permissions,
      permissionState: () => this.#permissionState(),
      env: () => this.#settings.env,
      effort: () => this.#effort,
      limits: ctx.toolLimits,
      tokens: (text) =>
        ctx.estimator.estimate({
          messages: [{ role: "user", kind: "note", content: [{ type: "text", text }] }],
          tools: [],
        }),
      contextWindow: () => this.#contextWindow(),
      // Project code in skills runs only with the person's approval (principle 3).
      allows: (source) => ctx.trust.allows(source, this.projectDir),
    });
  }

  /** The session's skills and custom commands, for its slash commands. */
  get skills(): SessionSkills {
    return this.#skills;
  }

  // -------------------------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------------------------

  /**
   * Stops the running turn, stops background commands, flushes and releases the session file.
   * Safe to call more than once.
   */
  close(reason: "clear" | "other" = "other"): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closing = (async () => {
      // Its subagents stop first; their requests waiting on the person go with them.
      await this.#agents?.close().catch(() => {});
      const waitingOn = this.#firstPending()?.ask.kind ?? null;
      if (this.#restoredTurn?.running === false) {
        // Still waiting since it was brought back: it waits on for the next open, as it is.
      } else if (
        this.#busy?.kind === "turn" &&
        waitingOn !== null &&
        // An MCP server's request lives on its connection, which goes with the process.
        ![...this.#pending.values()].some((p) => p.ask.kind === "elicitation")
      ) {
        // Waiting on the person: the turn is let go without being ended, so the next open
        // brings the request back (see waiting-turn.ts) instead of closing it as interrupted.
        this.#suspendedOn = waitingOn;
        this.#frozen = true;
        this.#busy.controller.abort();
        await this.waitForIdle();
        this.#frozen = false;
      } else if (this.#busy !== null) {
        this.#busy.controller.abort();
        await this.waitForIdle();
      }
      // SessionEnd hooks, within their documented budget; then background hooks are stopped.
      this.#clearIdleTimer();
      if (this.#hooks.has("SessionEnd")) await this.#hooks.sessionEnd(reason).catch(() => {});
      this.#hooks.close();
      await this.#mcp.close();
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

  /** Picks up changed settings files; see settings-reload.ts for what applies live. */
  async #reloadSettings(): Promise<void> {
    const check = await this.#settingsReloader.check(this.#settings);
    if (check.kind === "unchanged") return;
    if (check.kind === "unreadable") {
      this.#emit("error", {
        turnId: null,
        error: errorInfo(
          "other",
          "A settings file could not be read, so this session keeps the permission rules it had until it is fixed.",
          check.problems.map((p) => `${p.path}: ${p.message}`).join("\n"),
          false,
        ),
      });
      return;
    }
    const fresh = check.settings;
    this.#settings = fresh;
    // Hooks come from the same files, so they change with them (from this turn on).
    await this.#hooks.reload();
    const listed = new Set(fresh.permissions.allow.map((r) => r.rule));
    this.#rules = {
      allow: [...this.#unsavedAllow.filter((r) => !listed.has(r.rule)), ...fresh.permissions.allow],
      ask: [...fresh.permissions.ask],
      deny: [...fresh.permissions.deny],
    };
    if (!this.#modeAllowed(this.#mode)) {
      this.#applyMode("default");
      this.#emit("error", {
        turnId: null,
        error: errorInfo(
          "other",
          "bypassPermissions mode was turned off by permissions.disableBypassPermissionsMode, so this session now asks first.",
          null,
          false,
        ),
      });
    }
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
            // A fork's first request goes to its parent's slot, where its start is cached.
            ...(this.#role?.preferSlotOf ? { prefer: this.#role.preferSlotOf } : {}),
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
      // The memory segment counts with the instruction files: both are the project's notes.
      const text = [this.#instructionsText, this.#memoryPrompt]
        .filter((t) => t.trim() !== "")
        .join("\n\n");
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
    let waitingOn: PendingRequest["kind"] | null = null;
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
            : waitingOn === "elicitation"
              ? "Waiting for your input"
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
      waitingOn: this.#suspendedOn ?? waitingKind(this.#firstPending()?.ask.kind),
    });
  }

  /** The oldest request waiting on the person, if any. */
  #firstPending(): PendingEntry | undefined {
    // A subagent's request is not the session's own turn waiting (it ends with the agent).
    for (const entry of this.#pending.values()) {
      if (entry.ask.kind === "permission" && entry.ask.request.agent !== undefined) continue;
      if (entry.ask.kind === "elicitation" && entry.ask.agent !== undefined) continue;
      return entry;
    }
    return undefined;
  }

  /**
   * One-off requests to the utility model for tools (WebFetch's question about a page): its own
   * messages and no tools, on the side slot titles use, so the conversation's history and cache
   * are untouched. Usage is counted as side usage, like titles'.
   */
  #utilityModel(): UtilityModel {
    const target = this.#utility;
    const endpoint = target.client.endpoint;
    const weakest = endpoint.template?.reasoningEffortLevels?.[0];
    const kwargs = this.#ctx.profileFor(endpoint).chatTemplateKwargs;
    return {
      contextWindow: Math.max(0, Math.round(endpoint.contextWindow)),
      complete: async (request) => {
        let text = "";
        for await (const event of target.client.stream({
          messages: [
            { role: "system", content: request.system },
            { role: "user", kind: "prompt", content: [{ type: "text", text: request.prompt }] },
          ],
          tools: [],
          maxOutputTokens: request.maxOutputTokens,
          sampling: { temperature: 0.2 },
          ...(target.slot === undefined ? {} : { slot: target.slot }),
          ...(weakest === undefined ? {} : { reasoningEffort: weakest }),
          ...(kwargs === null ? {} : { extraBody: { chat_template_kwargs: kwargs } }),
          signal: request.signal,
        })) {
          if (event.type === "finished") {
            text = event.reply.content;
            this.#usage.recordSide(event.reply.usage);
          }
        }
        return text;
      },
    };
  }

  #maybeGenerateTitle(): void {
    if (!this.#ctx.generateTitles || this.#titleStarted || this.#closed || this.#closing !== null) {
      return;
    }
    // A subagent is named by its task's description.
    if (this.#role !== null) return;
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
    // MCP resources mentioned as `@server:scheme://…` are read from their servers.
    const typed = prompt.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    const signal = AbortSignal.timeout(this.#mcp.mentionTimeoutMs);
    for (const text of await this.#mcp.mentionTexts(
      typed,
      signal,
      this.#ctx.limits.mentionMaxChars,
    )) {
      content.push({ type: "text", text });
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
    if (this.#frozen) return;
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
    // Skills of folders inside the project load once the agent works there (../skills).
    for (const e of executed) {
      for (const file of [...e.touched.read, ...e.touched.written]) {
        const skills = await this.#skills.forFile(file);
        if (skills.length > 0) {
          await this.#appendNote({ type: "text", text: this.#skills.nestedNote(skills) });
        }
      }
    }
    // PostToolBatch hooks (../hooks): once per batch, with every call's result as the model
    // reads it. What they add goes in before the next request; a block ends the turn here.
    if (this.#hooks.has("PostToolBatch") && executed.length > 0) {
      const signal = this.#busy?.controller.signal;
      const effects = await this.#hooks.postToolBatch({
        turnId: this.activeTurnId,
        calls: executed.map((e) => ({
          toolName: e.call.name,
          toolInput: parsedArguments(e.call.arguments),
          toolCallId: e.call.id,
          toolResponse: promptText(e.result.content) ?? "",
        })),
        ...(signal === undefined ? {} : { signal }),
      });
      this.#applyHookEffects(effects);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals: hooks (../hooks)
  // -------------------------------------------------------------------------------------------

  /**
   * Added (Phase 4, hooks): UserPromptExpansion hooks for a command the person typed, before it
   * expands (../skills/commands.ts, ../mcp/session-mcp.ts). Their context waits for the turn's
   * start. Resolves with what to tell the person when a hook blocked it, else null.
   */
  async commandExpansionHooks(command: {
    expansionType: "slash_command" | "mcp_prompt";
    name: string;
    args: string;
    source: string;
  }): Promise<string | null> {
    if (this.#closed || !this.#hooks.has("UserPromptExpansion")) return null;
    const verdict = await this.#hooks.userPromptExpansion(command);
    if (verdict.blocked !== null) {
      return `A UserPromptExpansion hook blocked /${command.name}${verdict.blocked.reason === null ? "." : `: ${verdict.blocked.reason}`}`;
    }
    for (const text of verdict.notes) this.#queuedNotes.push({ type: "text", text });
    return null;
  }

  /**
   * StopFailure hooks, when a turn ended because the model's server failed. Their output is
   * ignored, so nothing waits for them.
   */
  #stopFailureHooks(turnId: string, error: ErrorInfo): void {
    if (this.#closed || !this.#hooks.has("StopFailure")) return;
    const name = stopFailureError(error);
    if (name === null) return;
    void this.#hooks
      .stopFailure({ turnId, error: name, details: error.detail, message: error.message })
      .catch(() => {});
  }

  /** Notes and requests hooks left: notes for the next safe point, a stop, a new title. */
  #applyHookEffects(effects: HookEffects): void {
    for (const text of effects.notes) this.#queuedNotes.push({ type: "text", text });
    if (effects.stop !== null) this.#hookStop = true;
    if (effects.title !== null && effects.title !== this.#title && !this.#closed) {
      void this.rename(effects.title).catch(() => {});
    }
  }

  /** SessionStart hooks; their context waits for the first prompt. Never throws. */
  async #runSessionStart(
    source: "startup" | "resume" | "clear" | "fork" | "compact",
  ): Promise<void> {
    try {
      if (!this.#hooks.has("SessionStart")) return;
      const effects = await this.#hooks.sessionStart({ source, model: this.#model });
      // A stop asked for at session start has no turn to end.
      this.#applyHookEffects({ ...effects, stop: null });
    } catch {
      // A hook that cannot run is reported by its own event; the session carries on.
    }
  }

  /**
   * UserPromptSubmit hooks: the notes they add, or a RuntimeError when one refuses the prompt.
   * A command arrives as typed ("/deploy staging"), as documented.
   */
  async #promptHooks(
    prompt: Prompt,
    options: SkillPromptOptions,
    signal: AbortSignal,
  ): Promise<string[]> {
    this.#clearIdleTimer();
    this.#hookStop = false;
    this.#hooks.turnStarted();
    if (!this.#hooks.has("UserPromptSubmit")) return [];
    const command = options.command ?? null;
    const text =
      command === null
        ? (promptText(prompt.content) ?? "")
        : `/${command.name}${command.args === "" ? "" : ` ${command.args}`}`;
    const verdict = await this.#hooks.userPromptSubmit({ text, signal });
    if (verdict.blocked !== null) {
      throw new RuntimeError(
        "InvalidState",
        `A UserPromptSubmit hook blocked this prompt${verdict.blocked.reason === null ? "." : `: ${verdict.blocked.reason}`}`,
      );
    }
    if (verdict.title !== null && verdict.title !== this.#title) {
      void this.rename(verdict.title).catch(() => {});
    }
    return verdict.notes;
  }

  /** Whether a handler's `if` rule matches a call, judged as a permission rule. */
  #ifMatches(toolName: string, input: Record<string, unknown>): (rule: string) => boolean {
    return (rule) => {
      const tool = this.#toolMap.get(toolName);
      if (tool === undefined) return false;
      try {
        const subject = tool.permission(input, this.#probeContext());
        return ifRuleMatches(rule, { toolName, subject }, this.#permissionState());
      } catch {
        // The call cannot be judged; the hook runs, as one whose input cannot be split does.
        return true;
      }
    };
  }

  async #preToolUseHooks(call: HookedCall, signal: AbortSignal): Promise<ToolHookVerdict> {
    // The model called a tool: the Stop hooks' count of continuations starts again.
    this.#hooks.toolsRan();
    if (!this.#hooks.has("PreToolUse")) return { decision: null, reason: null, updatedInput: null };
    const verdict = await this.#hooks.preToolUse({
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolInput: call.input,
      signal,
      ifMatches: this.#ifMatches(call.toolName, call.input),
    });
    this.#applyHookEffects(verdict);
    return {
      decision: verdict.decision,
      reason: verdict.reason,
      updatedInput: verdict.updatedInput,
    };
  }

  async #postToolUseHooks(
    call: HookedCall & {
      content: ContentPart[];
      display: ToolDisplay | null;
      durationMs: number | null;
    },
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.#hooks.has("PostToolUse")) return;
    const effects = await this.#hooks.postToolUse({
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolInput: call.input,
      toolResponse: toolResponse(call.content, call.display),
      durationMs: call.durationMs,
      signal,
      ifMatches: this.#ifMatches(call.toolName, call.input),
    });
    this.#applyHookEffects(effects);
  }

  /**
   * PermissionRequest hooks, when a call would ask the person: their answer, with the permission
   * updates an allow carries applied once the allow stands.
   */
  async #permissionRequestHooks(
    call: HookedCall & { suggestions: readonly string[] },
    signal: AbortSignal,
  ): Promise<PermissionHookVerdict> {
    if (!this.#hooks.has("PermissionRequest")) {
      return { behavior: null, updatedInput: null, message: null };
    }
    const verdict = await this.#hooks.permissionRequest({
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolInput: call.input,
      suggestions: call.suggestions,
      signal,
      ifMatches: this.#ifMatches(call.toolName, call.input),
    });
    this.#applyHookEffects(verdict);
    // "interrupt: if true, stops Claude": the turn ends at the next safe point.
    if (verdict.behavior === "deny" && verdict.interrupt) this.#hookStop = true;
    const updates = verdict.updatedPermissions;
    return {
      behavior: verdict.behavior,
      updatedInput: verdict.updatedInput,
      message: verdict.message,
      ...(updates.length === 0 ? {} : { accepted: () => this.#applyPermissionUpdates(updates) }),
    };
  }

  /**
   * A PermissionRequest hook's `updatedPermissions` (reference, "Permission update entries"):
   * rules added for the session, or saved to the project's personal dawg settings for
   * `localSettings`; a mode the settings allow; working directories. dawg never writes Claude
   * Code's files, so `projectSettings` and `userSettings` rules hold for this session only.
   * `replaceRules` and `removeRules` are not applied. Never throws.
   */
  async #applyPermissionUpdates(entries: readonly Record<string, unknown>[]): Promise<void> {
    const lists = ["allow", "ask", "deny"] as const;
    for (const entry of entries) {
      try {
        if (entry.type === "addRules") {
          const list = lists.find((l) => l === entry.behavior);
          const rules = (Array.isArray(entry.rules) ? entry.rules : []).flatMap((r) => {
            if (r === null || typeof r !== "object") return [];
            const { toolName, ruleContent } = r as Record<string, unknown>;
            if (typeof toolName !== "string" || toolName.trim() === "") return [];
            return [
              typeof ruleContent === "string" && ruleContent !== ""
                ? `${toolName}(${ruleContent})`
                : toolName,
            ];
          });
          if (list === undefined || rules.length === 0) continue;
          if (this.#role !== null) {
            // A subagent is judged by its parent's rules: only "always allow" reaches them.
            if (list === "allow") await this.#role.allowAlways(rules);
            continue;
          }
          if (list === "allow" && entry.destination === "localSettings") {
            await this.#allowAlways(rules);
            continue;
          }
          const from = { source: "session" as const, origin: null, path: null };
          const known = new Set(this.#rules[list].map((r) => r.rule));
          const added = rules.filter((r) => !known.has(r)).map((rule) => ({ rule, from }));
          this.#rules = { ...this.#rules, [list]: [...added, ...this.#rules[list]] };
          if (entry.destination === "localSettings") {
            await addPermissionRules({ projectDir: this.projectDir, list, rules }).catch(() => {});
          }
        } else if (entry.type === "setMode" && this.#role === null) {
          const mode = entry.mode === "manual" ? "default" : entry.mode;
          const known: readonly PermissionMode[] = [
            "default",
            "acceptEdits",
            "plan",
            "dontAsk",
            "bypassPermissions",
          ];
          const next = known.find((m) => m === mode);
          if (next !== undefined && next !== this.#mode && this.#modeAllowed(next)) {
            this.#applyMode(next);
          }
        } else if (entry.type === "addDirectories" && this.#role === null) {
          const dirs = Array.isArray(entry.directories) ? entry.directories : [];
          for (const dir of dirs) {
            if (typeof dir === "string" && dir.trim() !== "") {
              await this.addDirectory(dir).catch(() => {});
            }
          }
        }
      } catch {
        // One entry that cannot be applied does not keep the others, or the call, back.
      }
    }
  }

  /** PostToolUseFailure hooks, after a call that ran and failed; what they say is kept. */
  async #postToolUseFailureHooks(
    call: HookedCall & { error: string; isInterrupt: boolean; durationMs: number | null },
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.#hooks.has("PostToolUseFailure")) return;
    const effects = await this.#hooks.postToolUseFailure({
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      toolInput: call.input,
      error: call.error,
      isInterrupt: call.isInterrupt,
      durationMs: call.durationMs,
      signal,
      ifMatches: this.#ifMatches(call.toolName, call.input),
    });
    this.#applyHookEffects(effects);
  }

  /** What agent hooks run on: this session's subagents (none in a subagent's own session). */
  #hookAgents(): HookAgents | null {
    const agents = this.#agents;
    return agents === null ? null : { check: (task) => agents.check(task) };
  }

  /**
   * What mcp_tool hooks call through: this session's MCP servers, by `dispatch`, so the
   * arguments are checked against the tool's schema. No permission check or tool hooks: the
   * settings asked for the call, as they ask for a command.
   */
  #hookMcp(): HookMcp {
    return {
      call: async ({ server, tool, args, waitMs, signal }) => {
        if (waitMs > 0) await this.#mcp.whenServerSettled(server, waitMs);
        const resolved = this.#mcp.dispatch(mcpToolName(server, tool), args);
        if ("error" in resolved) {
          return {
            error: `MCP tool "${tool}" on server "${server}" cannot be called: ${resolved.error
              .replace(/^Error: /, "")
              .replace(/ Use ToolSearch.*$/, "")}`,
          };
        }
        const context: ToolContext = {
          ...this.#toolContext({
            turnId: this.activeTurnId ?? "hook",
            toolCallId: this.#ctx.newId("call"),
            signal,
          }),
          // Not a call of the conversation's: nothing to show progress on.
          progress: () => {},
        };
        const output = await resolved.tool.execute(resolved.input, context);
        const text = output.content
          .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        return { isError: output.isError === true, text };
      },
    };
  }

  /** Stop hooks: true when they keep the turn going, with what they said appended. */
  async #stopHooks(turn: {
    turnId: string;
    lastText: string | null;
    signal: AbortSignal;
  }): Promise<boolean> {
    if (this.#hookStop) return false;
    const note = await this.#hooks.stop({
      turnId: turn.turnId,
      lastMessage: turn.lastText,
      signal: turn.signal,
    });
    if (note === null || turn.signal.aborted) return false;
    // No calls wait for results here, so this is a safe point for the note.
    await this.#appendNote({ type: "text", text: note });
    return true;
  }

  /**
   * Notification hooks when dawg needs the person: a permission request still unanswered after a
   * few seconds ("permission_prompt"), or no new prompt a while after a turn ("idle_prompt").
   */
  #notify(
    type:
      | "permission_prompt"
      | "idle_prompt"
      | "elicitation_dialog"
      | "elicitation_url_dialog"
      | "elicitation_response",
    message: string,
    turnId: string | null,
  ): void {
    if (this.#closed || !this.#hooks.has("Notification")) return;
    void this.#hooks.notification({ type, message, title: "dawg", turnId }).catch(() => {});
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #scheduleIdleNotification(): void {
    this.#clearIdleTimer();
    if (this.#closed || this.#closing !== null || !this.#hooks.has("Notification")) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#busy === null) this.#notify("idle_prompt", "dawg is waiting for your input", null);
    }, this.#ctx.limits.idleNotificationMs);
    this.#idleTimer.unref?.();
  }

  // -------------------------------------------------------------------------------------------
  // Internals: the turn loop's host
  // -------------------------------------------------------------------------------------------

  #permissionState(): PermissionState {
    return {
      // A subagent is judged by its parent's mode and rules, live (../agents).
      mode: this.#role?.mode() ?? this.#mode,
      // A skill's allowed and disallowed tools hold until the person's next message.
      rules: this.#skills.withGrants(this.#role?.rules() ?? this.#rules),
      cwd: this.cwd,
      workingDirectories: [this.cwd, ...this.#dirs],
      homeDir: this.#ctx.homeDir,
      // The file tools keep the project's memory folder without asking (../memory).
      memoryDirectories: this.#memory === null ? [] : [this.#memory.directory],
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
        const restored = this.#takeRestored("question", toolCallId);
        const response =
          restored !== null
            ? await this.#awaitRestored<QuestionResponse>(restored, signal)
            : await this.#raise<QuestionResponse>(
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
        const restored = this.#takeRestored("plan", toolCallId);
        let response: PlanResponse;
        if (restored !== null) {
          // Proposed before the restart; its plan file is already saved.
          response = await this.#awaitRestored<PlanResponse>(restored, signal);
        } else {
          const requestId = this.#ctx.newId("request");
          const planPath = await this.#savePlan(requestId, plan);
          response = await this.#raise<PlanResponse>(
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
        }
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
      // An MCP server's request for input during this call (../mcp/elicitation.ts). A
      // subagent's goes to its parent, labelled with it, as its permission requests do.
      elicit: (request, asked) => {
        const waiting = AbortSignal.any([signal, asked]);
        if (this.#role === null) return this.#elicit(request, turnId, waiting, null);
        const parent = this.#role.elicit;
        if (parent === undefined) return Promise.reject(new NoOneToAskError());
        return parent(request, turnId, waiting);
      },
    };
  }

  /**
   * An MCP server's request for input, this session's or (with `agent`) one of its subagents'
   * (../mcp/elicitation.ts): Elicitation hooks may answer in the person's place, so the form is
   * never shown (also where nobody could answer it); otherwise it is raised here, and
   * ElicitationResult hooks see the person's answer and may change it before the server gets it.
   */
  async #elicit(
    request: ElicitationRequest,
    turnId: string,
    signal: AbortSignal,
    agent: SubagentLabel | null,
  ): Promise<ElicitationResponse> {
    let waiting = signal;
    // A subagent's outlives the parent's turn, unless that turn is interrupted.
    const stop = agent === null ? null : new AbortController();
    if (stop !== null) {
      this.#agentAsks.add(stop);
      waiting = AbortSignal.any([signal, stop.signal]);
    }
    try {
      const hooked: HookElicitation = {
        server: request.server,
        message: request.message,
        mode: request.mode,
        fields: request.fields,
        requestedSchema: request.requestedSchema ?? null,
        url: request.url,
        elicitationId: request.elicitationId ?? null,
        turnId,
        toolCallId: request.toolCallId,
        signal: waiting,
      };
      const byHook = await this.#hooks.elicitation(hooked);
      if (byHook !== null) {
        this.#notify("elicitation_response", `dawg answered ${request.server}'s request`, turnId);
        return byHook;
      }
      if (!this.#capabilities.elicitation) throw new NoOneToAskError();
      const answer = await this.#raise<ElicitationResponse>(
        {
          kind: "elicitation",
          turnId,
          requestId: this.#ctx.newId("request"),
          toolCallId: request.toolCallId,
          server: request.server,
          message: request.message,
          mode: request.mode,
          fields: request.fields,
          url: request.url,
          ...(agent === null ? {} : { agent }),
        },
        waiting,
      );
      const final = await this.#hooks.elicitationResult(hooked, answer);
      this.#notify("elicitation_response", `dawg answered ${request.server}'s request`, turnId);
      return final;
    } finally {
      if (stop !== null) this.#agentAsks.delete(stop);
    }
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
      services: this.#ctx.services(),
      utility: this.#utilityModel(),
    };
    if (state.rules.deny.length === 0) return ctx;
    return { ...ctx, readDenied: (file: string) => readDeniedBy(file, state) !== null };
  }

  async #allowAlways(rules: readonly string[]): Promise<void> {
    const from: SettingsFileRef = {
      source: "local",
      origin: "dawg",
      path: localSettingsPath(this.projectDir),
    };
    const known = new Set(this.#rules.allow.map((r) => r.rule));
    const added: PermissionRule[] = rules
      .filter((r) => !known.has(r))
      .map((rule) => ({ rule, from }));
    // In force for this session at once, whether or not the file can be written.
    this.#rules = { ...this.#rules, allow: [...added, ...this.#rules.allow] };
    try {
      // The project's personal file, also from a worktree, so the rule outlives the worktree
      // and applies to the project's other sessions from their next turn.
      await addPermissionRules({ projectDir: this.projectDir, list: "allow", rules: [...rules] });
    } catch (error) {
      this.#unsavedAllow = [...added, ...this.#unsavedAllow];
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
      tools: this.#toolMap,
      permissions: ctx.permissions,
      limits: ctx.limits,
      loopLimits:
        this.#role?.maxTurns != null
          ? { ...ctx.limits, maxRequestsPerTurn: this.#role.maxTurns }
          : ctx.limits,
      emit: this.#emit,
      now: ctx.clock,
      newId: ctx.newId,
      permissionState: () => this.#permissionState(),
      probeContext: () => this.#probeContext(),
      canAskPermission: () =>
        this.#role?.canAskPermission() ?? this.#capabilities.permissionPrompts,
      // A subagent's prompts are raised in its parent, labelled with it.
      askPermission: (request, turnId, signal) =>
        this.#role !== null
          ? this.#role.askPermission(request, turnId, signal)
          : this.#raise<PermissionResponse>({ kind: "permission", turnId, request }, signal),
      restoredPermission: (toolCallId) => {
        const restored = this.#takeRestored("permission", toolCallId);
        if (restored === null || restored.ask.kind !== "permission") return null;
        return {
          suggestions: restored.ask.request.suggestions,
          wait: (signal) => this.#awaitRestored<PermissionResponse>(restored, signal),
        };
      },
      allowAlways: (rules) =>
        this.#role !== null ? this.#role.allowAlways(rules) : this.#allowAlways(rules),
      toolContext: (call) => this.#toolContext(call),
      appendResult: async (message, extras) => {
        if (this.#frozen) return;
        await writer.appendMessage(message, extras);
      },
      saveOutput: (name, content) => writer.saveOutput(name, content),
      quote: (text) => ctx.assembler.quote(text),
      model: () => this.#requestModel(),
      prefix: () => this.#prefix,
      view: () => writer.snapshot.view,
      isCallIdTaken: (id) => this.#callIds.has(id),
      appendMessage: async (message, extras) => {
        if (this.#frozen) return;
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
      preToolUse: (call, signal) => this.#preToolUseHooks(call, signal),
      postToolUse: (call, signal) => this.#postToolUseHooks(call, signal),
      permissionRequest: (call, signal) => this.#permissionRequestHooks(call, signal),
      postToolUseFailure: (call, signal) => this.#postToolUseFailureHooks(call, signal),
      onStop: (turn) =>
        this.#role !== null ? this.#subagentStopHooks(this.#role, turn) : this.#stopHooks(turn),
      hookStopRequested: () => this.#hookStop,
      // A subagent's changes go to its parent's checkpoint (../agents/role.ts).
      fileChanges:
        this.#role?.fileChanges === undefined
          ? {
              before: (turnId, paths) => this.#checkpoints.beforeChange(turnId, paths),
              after: (_turnId, paths) => this.#checkpoints.afterChange(paths),
            }
          : {
              before: (_turnId, paths) =>
                this.#role?.fileChanges?.before(paths) ?? Promise.resolve(),
              after: (_turnId, paths) => this.#role?.fileChanges?.after(paths) ?? Promise.resolve(),
            },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals: subagents (../agents)
  // -------------------------------------------------------------------------------------------

  /** The session's subagents; null in a subagent's own session. */
  get agents(): SubagentManager | null {
    return this.#agents;
  }

  /** A subagent's system message replaces the core instructions with its own (../agents). */
  #agentPrefix(): { agent?: string } {
    const text = this.#role?.systemText ?? null;
    return text === null ? {} : { agent: text };
  }

  /** SubagentStop hooks (fired by the parent) when a subagent ends a reply: true keeps it going. */
  async #subagentStopHooks(
    role: SubagentRole,
    turn: { turnId: string; lastText: string | null; signal: AbortSignal },
  ): Promise<boolean> {
    const note = await role.onStop(turn);
    if (note === null || turn.signal.aborted) return false;
    // No calls wait for results here, so this is a safe point for the note.
    await this.#appendNote({ type: "text", text: note });
    return true;
  }

  /** Lends a main session's subagents what they need of it. */
  #bindAgents(): void {
    const agents = this.#agents;
    if (agents === null) return;
    const ctx = this.#ctx;
    const host: AgentHost = {
      sessionId: this.id,
      cwd: this.cwd,
      projectDir: this.projectDir,
      sessionDir: this.#sessionDir,
      storeRoot: ctx.storeRoot,
      // An agent's own memory follows the session's auto memory switch (../agents/memory.ts).
      memoryOn: async () => ctx.autoMemory && (await autoMemoryEnabled(this.#settings.files)),
      hooks: this.#hooks,
      emit: this.#emit,
      now: ctx.clock,
      mode: () => this.#mode,
      modeAllowed: (mode) => this.#modeAllowed(mode),
      permissionState: () => this.#permissionState(),
      canAskPermission: () => this.#capabilities.permissionPrompts,
      askPermission: (request, turnId, signal) =>
        this.#raise<PermissionResponse>({ kind: "permission", turnId, request }, signal),
      elicit: (request, turnId, signal, agent) => this.#elicit(request, turnId, signal, agent),
      allowAlways: (rules) => this.#allowAlways(rules),
      activeTurnId: () => this.activeTurnId,
      busy: () => this.#busy !== null,
      closed: () => this.#closed || this.#closing !== null,
      queueNote: (text) => {
        this.#queuedNotes.push({ type: "text", text });
      },
      wake: async (text) => {
        await this.prompt({ content: [{ type: "text", text }] });
      },
      subscribe: (listener) => this.#log.subscribe(listener),
      storedEvents: () => this.#log.all(),
      allows: (source) => ctx.trust.allows(source, this.projectDir),
      scheduler: () =>
        this.#connection.pool === undefined ? null : ctx.slots(this.#connection.pool),
      forkBasis: () => ({
        prefix: this.#prefix,
        tools: this.#tools,
        toolMap: this.#toolMap,
        view: this.#writer.snapshot.view,
      }),
      offeredTools: () => this.#baseTools,
      skills: () => this.#skills,
      sessionContext: async (cwd) => ({
        ...ctx.assembler.sessionContext(
          await ctx.environment({ cwd, additionalDirectories: this.#dirs, now: ctx.clock() }),
        ),
        kind: "note" as const,
      }),
      note: (text) => ctx.assembler.note({ type: "text", text }),
      fileChanges: (turnId, agent) => ({
        before: (paths) => this.#checkpoints.beforeChange(turnId, paths, agent),
        after: (paths) => this.#checkpoints.afterChange(paths),
      }),
      open: (input) =>
        openChildRuntime({
          ctx,
          start: (init) => SessionRuntime.start(init),
          parent: {
            sessionId: this.id,
            sessionDir: this.#sessionDir,
            projectDir: this.projectDir,
            model: this.#model,
            effort: this.#effort,
            additionalDirectories: this.#dirs,
            // Its agents share the session's own MCP servers (and `--strict-mcp-config`).
            ...(this.#ownMcp.servers === undefined ? {} : { mcpServers: this.#ownMcp.servers }),
            strictMcpConfig: this.#ownMcp.strict,
          },
          connection: this.#connection,
          // Its permission prompts go to whoever answers the parent's; nobody answers its
          // questions or plans (the tools that ask are not given to it).
          capabilities: {
            permissionPrompts: this.#capabilities.permissionPrompts,
            questions: false,
            planApproval: false,
            elicitation: false,
          },
          childId: input.childId,
          cwd: input.cwd,
          create: input.create,
          role: input.role,
        }),
    };
    agents.bind(host);
  }

  /** Reads the session's runtime.json, for tests and tools. */
  static readSidecar(sessionDir: string): Promise<Sidecar | null> {
    return readSidecar(sessionDir);
  }
}

/** A call's arguments as an object, for hooks; `{}` when they are not one. */
function parsedArguments(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * StopFailure's `error` for a turn that failed, in the reference's names, or null when the turn
 * did not fail on the model's server (a tool, the transcript, a repeated call).
 */
function stopFailureError(error: ErrorInfo): string | null {
  const said = `${error.message} ${error.detail ?? ""}`;
  switch (error.kind) {
    case "model_unavailable":
      return "server_error";
    case "context_overflow":
      return "invalid_request";
    case "invalid_model_output":
      return /output limit/i.test(said) ? "max_output_tokens" : null;
    case "model_error": {
      const status = Number(/HTTP (\d{3})/.exec(error.message)?.[1] ?? Number.NaN);
      if (status === 429) return "rate_limit";
      if (status === 401 || status === 403) return "authentication_failed";
      if (status === 404) return "model_not_found";
      if (status >= 400 && status < 500) return "invalid_request";
      if (status >= 500) return "server_error";
      return "unknown";
    }
    default:
      return null;
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
