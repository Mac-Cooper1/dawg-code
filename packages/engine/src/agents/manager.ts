/**
 * One session's subagents (Phase 4 spec, "Subagents"): starting them with the `Agent` tool,
 * running their tasks on the model's free slots, reporting their state to clients, sending them
 * more work, and stopping them.
 *
 * - A subagent is a child session (./store.ts, ./open.ts): its own transcript and event log under
 *   the parent's `subagents/` folder, run by an ordinary session runtime given a `SubagentRole`.
 *   Clients replay it with `session.replay`; the parent's log carries `subagent.updated`.
 * - A typed agent starts with a fresh history: its own system prompt and tool subset, the
 *   session-context message, and the task. A fork starts from a copy of the parent's
 *   conversation, with the parent's prefix and tools, so its first request reuses the parent's
 *   prompt cache.
 * - Each task needs a seat (./seats.ts): one per conversation slot of the model. Agents beyond
 *   that wait, shown as queued.
 * - Foreground: the parent's call waits for the agent's final message, which is its result.
 *   Background: the call returns at once; when the agent ends, the parent gets a note with its
 *   result, and a parent that is idle is woken with a turn of its own to act on it.
 * - Permissions: the agent's calls are judged by the parent's rules (and mode, unless its file
 *   sets one; see `agentMode`); its prompts are raised in the parent, labelled with it.
 * - SubagentStart and SubagentStop hooks run from the parent's settings.
 */
import path from "node:path";
import type {
  CompatSource,
  ErrorInfo,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  SubagentInfo,
  SubagentLabel,
} from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { PermissionState } from "../contracts/permissions.ts";
import type { PromptPrefix } from "../contracts/prompt.ts";
import type { AnyTool, ToolContext, ToolOutput } from "../contracts/tools.ts";
import type { SessionHooks } from "../hooks/session-hooks.ts";
import type { Emit } from "../loop/types.ts";
import type { SlotScheduler } from "../model/slots.ts";
import type { LoggedEvent } from "../runtime/event-log.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import type { TurnOutcome } from "../runtime/types.ts";
import type { SessionSkills } from "../skills/session-skills.ts";
import { subagentSystemText } from "./prompts.ts";
import {
  AgentRegistry,
  type AgentSpec,
  agentMode,
  agentTools,
  FORK_TYPE,
  GENERAL_PURPOSE,
} from "./registry.ts";
import type { SubagentRole } from "./role.ts";
import { type Seat, seatsFor } from "./seats.ts";
import { childPaths, childSessionId } from "./store.ts";
import { type AgentWorktree, createAgentWorktree, finishAgentWorktree } from "./worktree.ts";

/** Where the session's tools find its subagents (`ToolContext.state`). */
export const AGENTS_STATE_KEY = "agents.session";

/** Documented for Stop hooks, applied to SubagentStop alike: continuations in a row at most. */
const STOP_HOOK_CAP = 8;

/** What a subagent's child session is opened with. */
export interface OpenChildInput {
  childId: string;
  /** Where the agent works: the parent's directory, or its worktree. */
  cwd: string;
  /** Set to create its transcript; null to open the one it has. */
  create: { title: string; mode: PermissionMode; initialMessages: Message[] } | null;
  role: SubagentRole;
}

/** What the parent session lends its subagents. Implemented by the session runtime. */
export interface AgentHost {
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectDir: string;
  /** The parent's side folder: the agents' transcripts go in its `subagents/`. */
  readonly sessionDir: string;
  readonly hooks: SessionHooks;
  readonly emit: Emit;
  now(): number;
  mode(): PermissionMode;
  modeAllowed(mode: PermissionMode): boolean;
  permissionState(): PermissionState;
  canAskPermission(): boolean;
  /** Raises a permission request in the parent, as it is (labelled by the caller). */
  askPermission(
    request: PermissionRequest,
    turnId: string,
    signal: AbortSignal,
  ): Promise<PermissionResponse>;
  allowAlways(rules: readonly string[]): Promise<void>;
  activeTurnId(): string | null;
  busy(): boolean;
  closed(): boolean;
  /** Keeps a note for the parent's model until its next safe point. */
  queueNote(text: string): void;
  /** Starts a turn of the parent's own, with `text` as its message. Rejects when it is busy. */
  wake(text: string): Promise<void>;
  subscribe(listener: (event: LoggedEvent) => void): () => void;
  /** The parent's stored events, to rebuild its agents when it opens again. */
  storedEvents(): readonly LoggedEvent[];
  /** Whether project code from this file may take effect (the trust store). */
  allows(source: CompatSource): Promise<boolean>;
  /** The scheduler of the parent's conversation slots, or null when they are not ours. */
  scheduler(): SlotScheduler | null;
  /** What a fork copies: the parent's prefix, tools and view now. */
  forkBasis(): {
    prefix: PromptPrefix;
    tools: readonly AnyTool[];
    toolMap: ReadonlyMap<string, AnyTool>;
    view: readonly Message[];
  };
  /** The tools a session offers, before the agent tools: what an agent's subset comes from. */
  offeredTools(): readonly AnyTool[];
  skills(): SessionSkills;
  /** A new agent's first message: the session context for its working directory. */
  sessionContext(cwd: string): Promise<Message>;
  /** A note as a message for an agent's history. */
  note(text: string): Message;
  open(input: OpenChildInput): Promise<SessionRuntime>;
  /**
   * Saves an agent's file changes in the parent's checkpoint for `turnId`, the turn that started
   * it (null: the latest), marked with the agent (../checkpoints). Absent: they are not saved there.
   */
  fileChanges?(
    turnId: string | null,
    agent: SubagentLabel,
  ): {
    before(paths: readonly string[]): Promise<void>;
    after(paths: readonly string[]): Promise<void>;
  };
}

interface Task {
  controller: AbortController;
  done: Promise<TaskResult>;
}

interface Agent {
  info: SubagentInfo;
  /** Null for a fork. */
  spec: AgentSpec | null;
  /** Where it works. */
  cwd: string;
  worktree: AgentWorktree | null;
  /** Its project code (grants, a looser mode) may take effect. */
  approved: boolean;
  runtime: SessionRuntime | null;
  task: Task | null;
  /** SubagentStop continuations in a row this task. */
  stopRuns: number;
}

type TaskResult =
  | { kind: "completed"; text: string; partial: boolean }
  | { kind: "failed"; error: ErrorInfo }
  | { kind: "stopped" };

export interface AgentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  run_in_background?: boolean;
  isolation?: "worktree";
}

export interface SendMessageInput {
  to: string;
  message: string;
}

function text(content: string, isError = false): ToolOutput {
  return { content: [{ type: "text", text: content }], ...(isError ? { isError: true } : {}) };
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line for people about a tool call an agent made: "Read src/app.ts". */
export function activityOf(toolName: string, input: unknown, cwd: string): string {
  const fields = (input ?? {}) as Record<string, unknown>;
  const pick = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
  const file = pick("file_path") ?? pick("path") ?? pick("notebook_path");
  if (file !== null) {
    const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
    const shown = rel === "" || rel.startsWith("..") ? file : rel;
    return `${toolName} ${oneLine(shown, 80)}`;
  }
  const target = pick("command") ?? pick("pattern") ?? pick("url") ?? pick("query");
  return target === null ? toolName : `${toolName} ${oneLine(target, 80)}`;
}

const FORK_DIRECTIVE = (task: string) =>
  `You are a fork of the conversation above: a copy of the agent that wrote it, started to do one task on your own. That agent carries on without you and sees only your final message. Do only this task; do not continue its other work.\n\nYour task:\n\n${task}`;

export class SubagentManager {
  readonly registry: AgentRegistry;
  readonly #agents = new Map<string, Agent>();
  #host: AgentHost | null = null;
  #next = 1;
  #closing = false;
  #stopEvents: (() => void) | null = null;
  readonly #agentTool: AnyTool;
  readonly #sendTool: AnyTool;

  constructor(registry: AgentRegistry) {
    this.registry = registry;
    this.#agentTool = makeAgentTool(this);
    this.#sendTool = makeSendMessageTool(this);
  }

  static async load(input: {
    homeDir: string;
    cwd: string;
    projectDir: string;
  }): Promise<SubagentManager> {
    return new SubagentManager(await AgentRegistry.load(input));
  }

  /** The session's `Agent` and `SendMessage` tools, whose descriptions list its agents. */
  get tools(): readonly AnyTool[] {
    return [this.#agentTool, this.#sendTool];
  }

  get sessionId(): string | null {
    return this.#host?.sessionId ?? null;
  }

  /**
   * Lends the manager its session. Rebuilds the agents earlier runs started from the stored
   * events: one left queued or running when the session stopped is reported stopped.
   */
  bind(host: AgentHost): void {
    this.#host = host;
    const latest = new Map<string, SubagentInfo>();
    for (const event of host.storedEvents()) {
      if (event.event !== "subagent.updated") continue;
      const info = (event.payload as unknown as { agent: SubagentInfo }).agent;
      latest.set(info.agentId, info);
    }
    for (const info of latest.values()) {
      const number = Number(/^agent-(\d+)$/.exec(info.agentId)?.[1] ?? 0);
      this.#next = Math.max(this.#next, number + 1);
      const agent: Agent = {
        info,
        spec: info.fork ? null : (this.registry.find(info.agentType) ?? null),
        cwd: host.cwd,
        worktree: null,
        approved: false,
        runtime: null,
        task: null,
        stopRuns: 0,
      };
      this.#agents.set(info.agentId, agent);
      if (info.status === "queued" || info.status === "running") {
        this.#update(agent, {
          status: "stopped",
          queuePosition: null,
          endedAt: host.now(),
          activity: null,
        });
      }
    }
    // A main conversation holds a seat while its turn runs (./seats.ts).
    const seats = seatsFor(host.scheduler());
    this.#stopEvents = host.subscribe((event) => {
      if (event.event === "turn.started") seats?.setActive(host.sessionId, true);
      if (event.event === "turn.finished") seats?.setActive(host.sessionId, false);
    });
  }

  #requireHost(): AgentHost {
    if (this.#host === null) throw new Error("The subagents are not bound to a session.");
    return this.#host;
  }

  /** Every agent of the session, oldest first. */
  list(): SubagentInfo[] {
    return [...this.#agents.values()].map((agent) => ({ ...agent.info }));
  }

  /** The live runtime of an agent's session, for replaying it while it works. */
  runtimeOf(childSessionId: string): SessionRuntime | undefined {
    for (const agent of this.#agents.values()) {
      if (agent.info.sessionId === childSessionId && agent.runtime !== null) return agent.runtime;
    }
    return undefined;
  }

  /** Whether a rule in force names an agent type (`Agent(Explore)`), so calls are judged by it. */
  ruleNamesAgents(): boolean {
    const host = this.#host;
    if (host === null) return false;
    const { rules } = host.permissionState();
    return [...rules.allow, ...rules.ask, ...rules.deny].some((r) => r.rule.startsWith("Agent("));
  }

  /** Whether an agent is running or waiting for a slot. */
  get running(): number {
    let count = 0;
    for (const agent of this.#agents.values()) if (agent.task !== null) count += 1;
    return count;
  }

  // -------------------------------------------------------------------------------------------
  // Starting
  // -------------------------------------------------------------------------------------------

  /** The `Agent` tool: starts an agent on a task. */
  async start(
    input: AgentInput,
    ctx: ToolContext,
    from: { skill?: string } = {},
  ): Promise<ToolOutput> {
    const host = this.#requireHost();
    if (ctx.sessionId !== host.sessionId) {
      return text(
        "A subagent cannot start agents of its own. Do the work yourself, or report back what needs another agent.",
        true,
      );
    }
    if (this.#closing || host.closed()) return text("The session is closing.", true);
    const type = (input.subagent_type ?? "").trim() || GENERAL_PURPOSE;
    const fork = type === FORK_TYPE;
    const spec = fork ? null : this.registry.find(type);
    if (!fork && spec === undefined) {
      const known = [...this.registry.names, FORK_TYPE].map((n) => `"${n}"`).join(", ");
      return text(`There is no agent type "${type}". Use one of: ${known}.`, true);
    }
    const description = oneLine(input.description, 120) || oneLine(input.prompt, 60);
    if (!fork && spec !== undefined && spec !== null) {
      const tools = agentTools(spec, host.offeredTools());
      if (tools.length === 0) {
        return text(
          `The ${spec.name} agent would have no tools: none of the tools its file lists (${(spec.tools ?? []).join(", ")}) is available to subagents. Fix its tools field, or use another agent.`,
          true,
        );
      }
    }
    const background = input.run_in_background === true || (spec?.background ?? false);
    const isolation = input.isolation ?? spec?.isolation ?? null;
    const approved =
      spec?.projectCode === true && spec.source !== null
        ? await host.allows(spec.source).catch(() => false)
        : true;

    const number = this.#next;
    this.#next += 1;
    const agentId = `agent-${number}`;
    const childId = childSessionId(host.sessionId, number);
    const turnId = host.activeTurnId();
    const now = host.now();
    const agent: Agent = {
      info: {
        agentId,
        sessionId: childId,
        agentType: fork ? FORK_TYPE : (spec as AgentSpec).name,
        description,
        toolCallId: ctx.toolCallId,
        turnId,
        fork,
        background,
        status: "queued",
        queuePosition: null,
        worktree: null,
        startedAt: now,
        endedAt: null,
        toolUses: 0,
        activity: from.skill === undefined ? null : `Running the ${from.skill} skill`,
        result: null,
        error: null,
      },
      spec: spec ?? null,
      cwd: host.cwd,
      worktree: null,
      approved,
      runtime: null,
      task: null,
      stopRuns: 0,
    };
    this.#agents.set(agentId, agent);

    // Its own git worktree, when asked for (./worktree.ts says why the engine makes it).
    if (isolation === "worktree") {
      try {
        agent.worktree = await createAgentWorktree(host.cwd, `agent-${shortId(childId)}`);
        agent.cwd = agent.worktree.cwd;
        agent.info.worktree = { path: agent.worktree.path, branch: agent.worktree.branch };
      } catch (error) {
        this.#agents.delete(agentId);
        return text(
          `Could not start the agent in a worktree: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    }

    // Its transcript exists from now on, so a client can open it while it waits.
    try {
      const initial = await this.#initialMessages(agent, ctx.signal);
      agent.runtime = await host.open({
        childId,
        cwd: agent.cwd,
        create: { title: description, mode: this.#modeOf(agent), initialMessages: initial },
        role: this.#role(agent),
      });
    } catch (error) {
      this.#agents.delete(agentId);
      if (agent.worktree !== null) await finishAgentWorktree(agent.worktree).catch(() => {});
      return text(
        `Could not start the agent: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    this.#emit(agent);

    const prompt = fork ? FORK_DIRECTIVE(input.prompt) : input.prompt;
    if (background) {
      this.#launch(agent, prompt, null);
      return text(
        `Started ${agentId} (${agent.info.agentType}) in the background. A note will tell you when it finishes, with its final message. Carry on with other work meanwhile; do not wait for it or check on it.${this.#worktreeLine(agent)}`,
      );
    }
    const result = await this.#foreground(agent, prompt, ctx.signal);
    return this.#resultOutput(agent, result);
  }

  /** The `SendMessage` tool: another task for an agent that has finished. */
  async send(input: SendMessageInput, ctx: ToolContext): Promise<ToolOutput> {
    const host = this.#requireHost();
    if (ctx.sessionId !== host.sessionId) {
      return text("A subagent cannot send messages to other agents.", true);
    }
    const agent = this.#agents.get(input.to.trim());
    if (agent === undefined) {
      const known = [...this.#agents.keys()];
      return text(
        known.length === 0
          ? `There is no agent "${input.to}": this session has not started any.`
          : `There is no agent "${input.to}". This session's agents: ${known.join(", ")}.`,
        true,
      );
    }
    if (agent.task !== null) {
      return text(
        `${agent.info.agentId} is still working. A note will tell you when it finishes; send it more then.`,
        true,
      );
    }
    if (agent.spec === null && !agent.info.fork) {
      return text(
        `${agent.info.agentId} cannot be sent more: its agent type "${agent.info.agentType}" is no longer defined.`,
        true,
      );
    }
    if (agent.worktree === null && agent.info.worktree !== null) {
      // Its worktree was removed when it had nothing in it; it works in a fresh one.
      try {
        agent.worktree = await createAgentWorktree(
          host.cwd,
          path.basename(agent.info.worktree.path),
        );
        agent.cwd = agent.worktree.cwd;
      } catch {
        agent.info.worktree = null;
        agent.cwd = host.cwd;
      }
    }
    try {
      agent.runtime = await host.open({
        childId: agent.info.sessionId,
        cwd: agent.cwd,
        create: null,
        role: this.#role(agent),
      });
    } catch (error) {
      return text(
        `Could not reopen ${agent.info.agentId}: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    this.#update(agent, {
      toolCallId: ctx.toolCallId,
      turnId: host.activeTurnId(),
      background: false,
      status: "queued",
      endedAt: null,
      result: null,
      error: null,
      activity: null,
    });
    const result = await this.#foreground(agent, input.message, ctx.signal);
    return this.#resultOutput(agent, result);
  }

  /** Stops a queued or running agent. False when it had ended. */
  async stop(agentId: string): Promise<boolean> {
    const agent = this.#agents.get(agentId);
    if (agent === undefined) throw new Error(`There is no agent ${agentId} in this session.`);
    const task = agent.task;
    if (task === null) return false;
    task.controller.abort();
    await task.done;
    return true;
  }

  /** Stops every agent and waits for them, before the session closes. */
  async close(): Promise<void> {
    this.#closing = true;
    const tasks = [...this.#agents.values()].flatMap((agent) =>
      agent.task === null ? [] : [agent.task],
    );
    for (const task of tasks) task.controller.abort();
    await Promise.all(tasks.map((task) => task.done.catch(() => {})));
    await Promise.all(
      [...this.#agents.values()].map(async (agent) => {
        const runtime = agent.runtime;
        agent.runtime = null;
        await runtime?.close().catch(() => {});
      }),
    );
    this.#stopEvents?.();
    this.#stopEvents = null;
  }

  // -------------------------------------------------------------------------------------------
  // Running a task
  // -------------------------------------------------------------------------------------------

  /** Runs a task while the parent's call waits: the parent lends its seat meanwhile. */
  async #foreground(agent: Agent, prompt: string, signal: AbortSignal): Promise<TaskResult> {
    const host = this.#requireHost();
    const giveBack = seatsFor(host.scheduler())?.lend(host.sessionId);
    try {
      const task = this.#launch(agent, prompt, signal);
      return await task.done;
    } finally {
      giveBack?.();
    }
  }

  #launch(agent: Agent, prompt: string, outer: AbortSignal | null): Task {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (outer !== null) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener("abort", forward, { once: true });
    }
    const task: Task = {
      controller,
      done: this.#run(agent, prompt, controller.signal).finally(() => {
        outer?.removeEventListener("abort", forward);
      }),
    };
    agent.task = task;
    if (agent.info.background) {
      void task.done.then((result) => this.#announce(agent, result));
    }
    return task;
  }

  async #run(agent: Agent, prompt: string, signal: AbortSignal): Promise<TaskResult> {
    const host = this.#requireHost();
    let seat: Seat | null = null;
    let result: TaskResult;
    try {
      const seats = seatsFor(host.scheduler());
      if (seats !== null) {
        seat = await seats.admit({
          owner: agent.info.sessionId,
          signal,
          onQueue: (position) => this.#update(agent, { status: "queued", queuePosition: position }),
        });
      }
      result = await this.#work(agent, prompt, signal);
    } catch (error) {
      result = signal.aborted
        ? { kind: "stopped" }
        : {
            kind: "failed",
            error: {
              kind: "other",
              message: error instanceof Error ? error.message : String(error),
              detail: null,
              retryable: false,
            },
          };
    } finally {
      seat?.release();
    }
    // Between tasks the agent's session is closed; another task opens it again.
    const runtime = agent.runtime;
    agent.runtime = null;
    await runtime?.close().catch(() => {});
    let worktreeNote = "";
    if (agent.worktree !== null) {
      const finished = await finishAgentWorktree(agent.worktree);
      if (!finished.kept) agent.worktree = null;
      worktreeNote = finished.kept
        ? `Its worktree ${agent.info.worktree?.path} (branch ${agent.info.worktree?.branch}) holds ${finished.summary}.`
        : "Its worktree had no changes and was removed.";
    }
    agent.task = null;
    const now = host.now();
    switch (result.kind) {
      case "completed":
        this.#update(agent, {
          status: "completed",
          endedAt: now,
          result: result.text,
          activity: worktreeNote === "" ? null : worktreeNote,
          queuePosition: null,
        });
        break;
      case "failed":
        this.#update(agent, {
          status: "failed",
          endedAt: now,
          error: result.error,
          activity: null,
          queuePosition: null,
        });
        break;
      case "stopped":
        this.#update(agent, {
          status: "stopped",
          endedAt: now,
          activity: null,
          queuePosition: null,
        });
        break;
    }
    return result;
  }

  async #work(agent: Agent, prompt: string, signal: AbortSignal): Promise<TaskResult> {
    const runtime = agent.runtime;
    if (runtime === null) throw new Error("The agent's session is not open.");
    if (signal.aborted) return { kind: "stopped" };
    agent.stopRuns = 0;
    this.#update(agent, { status: "running", queuePosition: null });
    const stop = runtime.subscribe((event) => {
      if (event.event !== "tool.started") return;
      const payload = event.payload as unknown as { toolName: string; input: unknown };
      this.#update(agent, {
        toolUses: agent.info.toolUses + 1,
        activity: activityOf(payload.toolName, payload.input, agent.cwd),
      });
    });
    const onAbort = () => runtime.interrupt();
    signal.addEventListener("abort", onAbort, { once: true });
    let outcome: TurnOutcome;
    try {
      outcome = await runtime.run({ content: [{ type: "text", text: prompt }] });
    } finally {
      signal.removeEventListener("abort", onAbort);
      stop();
    }
    if (signal.aborted || outcome.stopReason === "interrupted") return { kind: "stopped" };
    if (outcome.stopReason === "error") {
      return {
        kind: "failed",
        error: outcome.error ?? {
          kind: "other",
          message: "The agent's task failed.",
          detail: null,
          retryable: false,
        },
      };
    }
    const final = outcome.finalText?.trim() ?? "";
    return {
      kind: "completed",
      text: final === "" ? "The agent finished without a final message." : final,
      partial: outcome.stopReason === "turn_limit",
    };
  }

  /** A background agent ended: the parent hears of it, and an idle parent wakes to act on it. */
  #announce(agent: Agent, result: TaskResult): void {
    const host = this.#host;
    if (host === null || this.#closing || host.closed()) return;
    const { agentId, agentType, description } = agent.info;
    const who = `${agentId} (${agentType}: ${description})`;
    let note: string;
    switch (result.kind) {
      case "completed":
        note = `Background agent ${who} finished${result.partial ? " at its turn limit" : ""}. Its final message:\n\n${result.text}`;
        break;
      case "failed":
        note = `Background agent ${who} failed: ${result.error.message}`;
        break;
      case "stopped":
        note = `Background agent ${who} was stopped before it finished.`;
        break;
    }
    const worktree = this.#worktreeLine(agent);
    host.queueNote(`${note}${worktree}`);
    if (result.kind === "stopped" || host.busy()) return;
    void host
      .wake(`Background agent ${agentId} ${result.kind === "failed" ? "failed" : "finished"}.`)
      .catch(() => {
        // Busy after all: the note waits for the turn's next safe point.
      });
  }

  #resultOutput(agent: Agent, result: TaskResult): ToolOutput {
    const id = agent.info.agentId;
    switch (result.kind) {
      case "completed":
        return text(
          `${result.text}\n\n[${id}${result.partial ? " stopped at its turn limit" : " finished"}. To give it more work with its history, use SendMessage with to: "${id}".${this.#worktreeLine(agent)}]`,
        );
      case "failed":
        return text(`${id} failed: ${result.error.message}${this.#worktreeLine(agent)}`, true);
      case "stopped":
        return text(`${id} was stopped before it finished.`, true);
    }
  }

  #worktreeLine(agent: Agent): string {
    const wt = agent.info.worktree;
    if (wt === null) return "";
    if (agent.worktree === null && agent.task === null && agent.info.status !== "queued") {
      return " Its worktree had no changes and was removed.";
    }
    return ` It works in the git worktree ${wt.path} on branch ${wt.branch}; its changes stay there until someone merges them.`;
  }

  // -------------------------------------------------------------------------------------------
  // Its session
  // -------------------------------------------------------------------------------------------

  /** The mode a new agent's session starts in (its calls are judged by `role.mode()`). */
  #modeOf(agent: Agent): PermissionMode {
    const host = this.#requireHost();
    if (agent.spec === null) return host.mode();
    return agentMode({
      parent: host.mode(),
      spec: agent.spec,
      approved: agent.approved,
      allowed: (mode) => host.modeAllowed(mode),
    });
  }

  /** A new agent's history before its task: session context, SubagentStart context, skills. */
  async #initialMessages(agent: Agent, signal: AbortSignal): Promise<Message[]> {
    const host = this.#requireHost();
    const out: Message[] = [];
    if (agent.info.fork) {
      // The parent's conversation as it is, with a result for each call still running (this
      // one among them), so the copy is valid for chat templates.
      const { view } = host.forkBasis();
      out.push(...view);
      const answered = new Set(view.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
      const last = [...view].reverse().find((m) => m.role === "assistant");
      if (last !== undefined && last.role === "assistant") {
        for (const call of last.toolCalls) {
          if (answered.has(call.id)) continue;
          out.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: "text",
                text:
                  call.id === agent.info.toolCallId
                    ? "This call started you, the fork. Your task follows."
                    : "This call's result goes to the agent you were copied from, not to you.",
              },
            ],
            isError: false,
          });
        }
      }
    } else {
      out.push(await host.sessionContext(agent.cwd));
    }
    const hookContext = await host.hooks
      .subagentStart({
        agentId: agent.info.agentId,
        agentType: agent.info.agentType,
        turnId: host.activeTurnId(),
        signal,
      })
      .catch(() => [] as string[]);
    for (const context of hookContext) {
      out.push(host.note(`A SubagentStart hook added this context:\n\n${context}`));
    }
    // Skills its file names are loaded in full before it starts.
    const skills = host.skills();
    for (const name of agent.spec?.skills ?? []) {
      const skill = skills.find(name);
      if (skill === undefined) {
        out.push(host.note(`The skill "${name}" this agent should start with is not available.`));
        continue;
      }
      const rendered = await skills.render(skill, "", signal).catch(() => null);
      if (rendered === null || !rendered.ok) {
        out.push(
          host.note(
            `The skill "${name}" could not be loaded${rendered?.ok === false ? `: ${rendered.message}` : "."}`,
          ),
        );
        continue;
      }
      out.push(host.note(skills.toolResultText(skill, rendered.body)));
    }
    return out;
  }

  #role(agent: Agent): SubagentRole {
    const host = this.#requireHost();
    const label: SubagentLabel = {
      agentId: agent.info.agentId,
      sessionId: agent.info.sessionId,
      agentType: agent.info.agentType,
      description: agent.info.description,
    };
    const spec = agent.spec;
    const grants =
      spec !== null && (agent.approved || !spec.projectCode)
        ? spec.grants.map((rule) => ({ rule, from: GRANTED }))
        : [];
    const fork = agent.info.fork ? host.forkBasis() : null;
    return {
      label,
      systemText: spec === null ? null : subagentSystemText(spec.prompt),
      fork:
        fork === null ? null : { prefix: fork.prefix, tools: fork.tools, toolMap: fork.toolMap },
      tools: (offered) => (spec === null ? offered : agentTools(spec, offered)),
      mode: () =>
        spec === null
          ? host.mode()
          : agentMode({
              parent: host.mode(),
              spec,
              approved: agent.approved,
              allowed: (mode) => host.modeAllowed(mode),
            }),
      rules: () => {
        const rules = host.permissionState().rules;
        return grants.length === 0 ? rules : { ...rules, allow: [...grants, ...rules.allow] };
      },
      canAskPermission: () => host.canAskPermission(),
      askPermission: (request, turnId, signal) => {
        // A read-only agent's shell runs only what changes nothing: in plan mode anything else
        // would ask, so it is refused here instead of troubling the person.
        if (spec?.readOnly === true && !READ_TOOLS.has(request.toolName)) {
          return Promise.resolve({
            behavior: "deny" as const,
            message: `The ${spec.name} agent only reads: this call could change something, so it was not run. Use a command that only reads, or report what needs doing.`,
          });
        }
        return host.askPermission({ ...request, agent: label }, turnId, signal);
      },
      allowAlways: (rules) => host.allowAlways(rules),
      maxTurns: spec?.maxTurns ?? null,
      onStop: async (turn) => {
        if (agent.stopRuns >= STOP_HOOK_CAP) return null;
        const note = await host.hooks
          .subagentStop({
            agentId: agent.info.agentId,
            agentType: agent.info.agentType,
            transcriptPath: childPaths(host.sessionDir, agent.info.sessionId).file,
            lastMessage: turn.lastText,
            stopHookActive: agent.stopRuns > 0,
            turnId: host.activeTurnId(),
            signal: turn.signal,
          })
          .catch(() => null);
        if (note !== null) agent.stopRuns += 1;
        return note;
      },
      preferSlotOf: agent.info.fork ? host.sessionId : null,
      // Its edits count in the checkpoint of the parent's turn that started it (or sent it its
      // latest task), read when each change is made.
      ...(host.fileChanges === undefined
        ? {}
        : {
            fileChanges: {
              before: (paths: readonly string[]) =>
                host.fileChanges?.(agent.info.turnId, label).before(paths) ?? Promise.resolve(),
              after: (paths: readonly string[]) =>
                host.fileChanges?.(agent.info.turnId, label).after(paths) ?? Promise.resolve(),
            },
          }),
    };
  }

  // -------------------------------------------------------------------------------------------

  #update(agent: Agent, changes: Partial<SubagentInfo>): void {
    agent.info = { ...agent.info, ...changes };
    this.#emit(agent);
  }

  #emit(agent: Agent): void {
    const host = this.#host;
    if (host === null || host.closed()) return;
    try {
      host.emit("subagent.updated", { agent: { ...agent.info } });
    } catch {
      // A session closing under the agent has nowhere to report it.
    }
  }
}

/** Tools whose permission prompts a read-only agent may still raise: reading outside the project. */
const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

/** Grants from an agent file's `tools`, for the length of its tasks. Not from a file the person edits. */
const GRANTED = { source: "session" as const, origin: null, path: null };

function shortId(childId: string): string {
  const parts = childId.split("-");
  const head = (parts[0] ?? childId).slice(0, 8);
  return `${head}-${parts[parts.length - 1] ?? "0"}`;
}

// ---------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------

function agentToolDescription(registry: AgentRegistry): string {
  const lines = registry.specs.map((spec) => `- ${spec.name}: ${oneLine(spec.description, 400)}`);
  lines.push(
    `- ${FORK_TYPE}: a copy of you with this whole conversation so far, for a side task that needs everything you know. It shares your prompt cache, so it starts quickly.`,
  );
  return [
    "Starts a subagent: another agent with its own context window that works on one task with its own tools and returns its final message as this call's result. Only that message comes back; its tool calls stay out of your context.",
    "",
    "Use one for a broad search, or for a self-contained piece of work whose details you do not need to keep. Look up a known file or symbol yourself instead. A subagent sees nothing of this conversation (except a fork), so the prompt must hold everything it needs: the goal, what you already know, the files involved, and what to report back. Several Agent calls in one reply run at the same time when the model has room; the rest wait their turn.",
    "",
    "Agent types (subagent_type):",
    ...lines,
    "",
    "With run_in_background the call returns at once, and a note tells you when the agent finishes, with its final message. To give a finished agent more work, use SendMessage with its id.",
  ].join("\n");
}

function makeAgentTool(manager: SubagentManager): AnyTool {
  const types = [...manager.registry.names, FORK_TYPE];
  return {
    name: "Agent",
    description: agentToolDescription(manager.registry),
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short description of the task, three to five words, shown to the user.",
        },
        prompt: {
          type: "string",
          description:
            "The task, with everything the agent needs to do it and what to report back.",
        },
        subagent_type: {
          type: "string",
          enum: types,
          description: `Which agent to start. Default ${GENERAL_PURPOSE}.`,
        },
        run_in_background: {
          type: "boolean",
          description:
            "true to return at once and let the agent work while you carry on; a note brings its result.",
        },
        isolation: {
          type: "string",
          enum: ["worktree"],
          description:
            "worktree: the agent works in a new git worktree, so its file changes stay apart from the user's checkout.",
        },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    // Several agents of one reply run side by side: each works in its own session, where every
    // call it makes is judged on its own.
    readOnly: true,
    permission(input: AgentInput) {
      if (!manager.ruleNamesAgents()) return { kind: "none" };
      return { kind: "other", specifier: (input.subagent_type ?? "").trim() || GENERAL_PURPOSE };
    },
    execute(input: AgentInput, ctx: ToolContext) {
      return manager.start(input, ctx);
    },
  };
}

function makeSendMessageTool(manager: SubagentManager): AnyTool {
  return {
    name: "SendMessage",
    description:
      'Sends another message to a subagent you started earlier, by its id ("agent-1"). It carries on with its whole history, and its reply is this call\'s result. Only an agent that has finished can be sent a message: one still working reports back when it ends.',
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: 'The agent\'s id, for example "agent-1".' },
        message: {
          type: "string",
          description: "What to tell or ask it, with everything new it needs.",
        },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    readOnly: false,
    permission() {
      return { kind: "none" };
    },
    execute(input: SendMessageInput, ctx: ToolContext) {
      return manager.send(input, ctx);
    },
  };
}

/** The session's subagents, from a tool's context; null in a subagent's own session. */
export function agentsOf(state: ToolContext["state"]): SubagentManager | null {
  return state.get<SubagentManager | null>(AGENTS_STATE_KEY, () => null);
}

/** A forked skill (`context: fork`) run as a subagent through the `Skill` tool. */
export async function runSkillAsAgent(input: {
  manager: SubagentManager;
  skill: { name: string; agent?: string | null };
  body: string;
  ctx: ToolContext;
}): Promise<ToolOutput> {
  const result = await input.manager.start(
    {
      description: `Skill ${input.skill.name}`,
      prompt: input.body,
      subagent_type: input.skill.agent ?? GENERAL_PURPOSE,
    },
    input.ctx,
    { skill: input.skill.name },
  );
  return result;
}
