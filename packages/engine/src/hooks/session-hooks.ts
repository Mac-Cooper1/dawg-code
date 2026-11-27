/**
 * One session's hooks: the tier 1 events with `command` handlers, as the hooks reference
 * documents them (code.claude.com/docs/en/hooks). The runtime calls one method per event and
 * applies what comes back; this class finds the handlers that apply, runs them, reports each run
 * (`hook.ran`), and turns their output into what the event allows.
 *
 * - Only what the person has consented to runs (`CodeTrust.allows`, and the definition must
 *   still be the one on disk); hooks held back for consent are reported once per session for each
 *   state of the definitions (`hook.skipped`). Hooks the person switched off never run.
 * - Handlers that match one event run in parallel; one written identically in several files runs
 *   once ("A handler defined identically in multiple settings files runs once").
 * - Input is JSON on standard input: the documented common fields and the event's own.
 * - Environment: the engine's, then the settings `env`, then `CLAUDE_PROJECT_DIR` and
 *   `DAWG_PROJECT_DIR`. The project is the working directory.
 * - Timeouts: 600 s per command handler, 30 s on UserPromptSubmit, and on SessionEnd 1.5 s for a
 *   handler without its own (with one, up to 60 s); a handler's `timeout` (seconds) wins.
 */
import {
  EVENTS_WITH_IF,
  type HookDefinition,
  hookSupport,
  type LoadedHooks,
  loadHooks,
  type RunningEvent,
} from "@dawg/compat";
import type { CompatSource, PermissionMode } from "@dawg/protocol";
import type { Emit } from "../loop/types.ts";
import { canonicalJson, definitionsIn, hookId, needsConsent } from "../trust/definitions.ts";
import type { CodeTrust } from "../trust/index.ts";
import { type CommandRun, runCommand } from "./command.ts";
import { matcherMatches } from "./match.ts";
import { capText, type HandlerResult, interpretRun } from "./output.ts";

/** Default timeouts, documented per event. */
export interface HookTimeouts {
  /** A command handler. Default 600 s. */
  commandMs: number;
  /** A command handler on UserPromptSubmit. Default 30 s. */
  promptSubmitMs: number;
  /** A SessionEnd handler without its own timeout. Default 1.5 s. */
  sessionEndMs: number;
  /** The most a SessionEnd handler's own timeout may raise its budget to. Default 60 s. */
  sessionEndMaxMs: number;
}

export const DEFAULT_HOOK_TIMEOUTS: HookTimeouts = {
  commandMs: 600_000,
  promptSubmitMs: 30_000,
  sessionEndMs: 1_500,
  sessionEndMaxMs: 60_000,
};

/** After this many Stop-hook continuations in a row, the next block is overridden (documented). */
export const STOP_HOOK_CAP = 8;

export interface SessionHooksOptions {
  sessionId: string;
  /** The session's working directory: the hooks' working directory and `CLAUDE_PROJECT_DIR`. */
  cwd: string;
  /** The project the session belongs to: where consent and personal files are. */
  projectDir: string;
  homeDir: string;
  /** Sent as `transcript_path`. dawg's transcript is its own format (spec, Hooks, "Known gap"). */
  transcriptPath: string;
  trust: CodeTrust;
  /** The settings `env` in force. */
  env: () => Readonly<Record<string, string>>;
  mode: () => PermissionMode;
  emit: Emit;
  /** Keeps a note for the model until the next safe point (background hooks' context). */
  queueNote: (text: string) => void;
  now: () => number;
  /** The environment hooks start from. Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * Set for a subagent's session (../agents): only tool events fire in it, as documented, and
   * their input names the agent (`agent_id`, `agent_type`). Its parent fires SubagentStart and
   * SubagentStop.
   */
  subagent?: { agentId: string; agentType: string };
  timeouts?: Partial<HookTimeouts>;
}

/** What hooks ask of the session, beyond the decision their event takes. */
export interface HookEffects {
  /** For the model, at the next safe point, each one note. */
  notes: string[];
  /** `continue: false`: stop processing after this, with its reason (shown to the person). */
  stop: { reason: string | null } | null;
  /** `sessionTitle`, to rename the session. */
  title: string | null;
}

export interface PreToolUseVerdict extends HookEffects {
  decision: "allow" | "deny" | "ask" | null;
  /** The reasons the deciding hooks gave, one per line. */
  reason: string | null;
  /** The whole new input for the call. */
  updatedInput: Record<string, unknown> | null;
}

export interface PromptVerdict extends HookEffects {
  /** Set when a hook refused the prompt: its reason, for the person (never the model). */
  blocked: { reason: string | null } | null;
}

interface RunContext {
  /** What the matcher is tested against; null for events without matchers. */
  matchValue: string | null;
  /** The event's own input fields. */
  fields: Record<string, unknown>;
  turnId: string | null;
  toolCallId: string | null;
  signal?: AbortSignal;
  /** For tool events: whether a handler's `if` rule matches the call. */
  ifMatches?: (rule: string) => boolean;
}

interface Ran {
  hook: HookDefinition;
  result: HandlerResult;
}

const NO_EFFECTS = (): HookEffects => ({ notes: [], stop: null, title: null });

/** The events that fire inside a subagent's own session. */
const SUBAGENT_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);

function label(hook: HookDefinition): string {
  const flat = hook.handler.target.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

export class SessionHooks {
  readonly #o: SessionHooksOptions;
  readonly #timeouts: HookTimeouts;
  #loaded: LoadedHooks | null = null;
  /** Keys of the skip notices already sent this session. */
  readonly #noticed = new Set<string>();
  /** Stops background hooks when the session closes. */
  readonly #background = new AbortController();
  /** Stop hooks have kept this turn going (`stop_hook_active`). */
  #stopActive = false;
  /** Stop-hook continuations since the model last called a tool. */
  #stopsInARow = 0;

  constructor(options: SessionHooksOptions) {
    this.#o = options;
    this.#timeouts = { ...DEFAULT_HOOK_TIMEOUTS, ...options.timeouts };
  }

  /** Reads the hooks from the settings files. Called at start and when they change. */
  async reload(): Promise<void> {
    this.#loaded = await loadHooks({
      projectDir: this.#o.cwd,
      localDir: this.#o.projectDir,
      homeDir: this.#o.homeDir,
    });
  }

  /** The hooks in force, for tests and tools. */
  get loaded(): LoadedHooks | null {
    return this.#loaded;
  }

  /** True when some supported handler for `event` exists (before matchers, trust and switches). */
  has(event: RunningEvent): boolean {
    if (this.#o.subagent !== undefined && !SUBAGENT_EVENTS.has(event)) return false;
    const loaded = this.#loaded;
    if (loaded === null || loaded.disabledBy !== null) return false;
    return loaded.hooks.some((h) => h.event === event && hookSupport(h).status !== "not-supported");
  }

  /** A new turn: `stop_hook_active` starts false again. */
  turnStarted(): void {
    this.#stopActive = false;
    this.#stopsInARow = 0;
  }

  /** The model called a tool: the Stop hooks' count of continuations in a row starts again. */
  toolsRan(): void {
    this.#stopsInARow = 0;
  }

  /** Stops background hooks. */
  close(): void {
    this.#background.abort();
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  async preToolUse(call: {
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    signal: AbortSignal;
    ifMatches?: (rule: string) => boolean;
  }): Promise<PreToolUseVerdict> {
    const ran = await this.#run("PreToolUse", {
      matchValue: call.toolName,
      fields: {
        tool_name: call.toolName,
        tool_input: call.toolInput,
        tool_use_id: call.toolCallId,
      },
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      signal: call.signal,
      ...(call.ifMatches === undefined ? {} : { ifMatches: call.ifMatches }),
    });
    const verdict: PreToolUseVerdict = {
      ...this.#effects(
        "PreToolUse",
        ran,
        (text) => `added this about the ${call.toolName} call:\n\n${text}`,
      ),
      decision: null,
      reason: null,
      updatedInput: null,
    };
    // "When multiple PreToolUse hooks return different decisions, precedence is deny > defer >
    // ask > allow."
    for (const decision of ["deny", "ask", "allow"] as const) {
      const deciding = ran.filter((r) => r.result.decision === decision);
      if (deciding.length === 0) continue;
      verdict.decision = decision;
      const reasons = deciding.map((r) => r.result.reason).filter((r): r is string => r !== null);
      verdict.reason = reasons.length === 0 ? null : reasons.join("\n");
      break;
    }
    if (verdict.decision !== "deny") {
      verdict.updatedInput =
        ran.find((r) => r.result.updatedInput !== null)?.result.updatedInput ?? null;
    }
    return verdict;
  }

  async postToolUse(call: {
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolResponse: unknown;
    durationMs: number | null;
    signal: AbortSignal;
    ifMatches?: (rule: string) => boolean;
  }): Promise<HookEffects> {
    const ran = await this.#run("PostToolUse", {
      matchValue: call.toolName,
      fields: {
        tool_name: call.toolName,
        tool_input: call.toolInput,
        tool_response: call.toolResponse,
        tool_use_id: call.toolCallId,
        ...(call.durationMs === null ? {} : { duration_ms: call.durationMs }),
      },
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      signal: call.signal,
      ...(call.ifMatches === undefined ? {} : { ifMatches: call.ifMatches }),
    });
    const effects = this.#effects(
      "PostToolUse",
      ran,
      (text) => `added this about the ${call.toolName} call:\n\n${text}`,
    );
    // A block (or exit 2) on PostToolUse cannot undo the call; its reason goes to the model.
    for (const r of ran) {
      if (r.result.decision !== "block") continue;
      effects.notes.push(
        `A PostToolUse hook (${label(r.hook)}) reported a problem with the ${call.toolName} call: ${r.result.reason ?? "no reason given"}`,
      );
    }
    return effects;
  }

  async userPromptSubmit(prompt: { text: string; signal: AbortSignal }): Promise<PromptVerdict> {
    const ran = await this.#run("UserPromptSubmit", {
      matchValue: null,
      fields: { prompt: prompt.text },
      turnId: null,
      toolCallId: null,
      signal: prompt.signal,
    });
    const effects = this.#effects(
      "UserPromptSubmit",
      ran,
      (text) => `added this context to the user's message:\n\n${text}`,
    );
    const blocking = ran.filter((r) => r.result.decision === "block");
    let blocked: PromptVerdict["blocked"] = null;
    if (blocking.length > 0) {
      const reasons = blocking.map((r) => r.result.reason).filter((r): r is string => r !== null);
      blocked = { reason: reasons.length === 0 ? null : reasons.join("\n") };
    } else if (effects.stop !== null) {
      // `continue: false`: nothing after the hook is processed, the prompt included.
      blocked = { reason: effects.stop.reason };
    }
    return { ...effects, blocked };
  }

  /**
   * The model ended its turn. Returns the note that keeps it going when a Stop hook blocks the
   * stop or adds feedback, or null to let the turn end. After `STOP_HOOK_CAP` continuations in a
   * row without a tool call, the turn ends whatever the hooks say.
   */
  async stop(turn: {
    turnId: string;
    lastMessage: string | null;
    signal: AbortSignal;
  }): Promise<string | null> {
    if (!this.has("Stop")) return null;
    const ran = await this.#run("Stop", {
      matchValue: null,
      fields: {
        stop_hook_active: this.#stopActive,
        last_assistant_message: turn.lastMessage ?? "",
      },
      turnId: turn.turnId,
      toolCallId: null,
      signal: turn.signal,
    });
    if (turn.signal.aborted) return null;
    // `continue: false` ends the turn, and takes precedence over a block.
    if (ran.some((r) => r.result.stop !== null)) return null;
    const parts: string[] = [];
    for (const r of ran) {
      if (r.result.decision === "block") {
        parts.push(
          `A Stop hook (${label(r.hook)}) asked you to keep going instead of ending your turn: ${r.result.reason ?? "no reason given"}`,
        );
      }
      for (const text of r.result.context)
        parts.push(`Stop hook feedback (${label(r.hook)}): ${text}`);
    }
    if (parts.length === 0) return null;
    if (this.#stopsInARow >= STOP_HOOK_CAP) return null;
    this.#stopsInARow += 1;
    this.#stopActive = true;
    return parts.join("\n\n");
  }

  async sessionStart(start: {
    source: "startup" | "resume" | "clear" | "compact" | "fork";
    model: string | null;
    signal?: AbortSignal;
  }): Promise<HookEffects> {
    const ran = await this.#run("SessionStart", {
      matchValue: start.source,
      fields: { source: start.source, ...(start.model === null ? {} : { model: start.model }) },
      turnId: null,
      toolCallId: null,
      // Stopped if the session closes first.
      signal: start.signal ?? this.#background.signal,
    });
    return this.#effects("SessionStart", ran, (text) => `added this context:\n\n${text}`);
  }

  async sessionEnd(
    reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other",
  ): Promise<void> {
    await this.#run("SessionEnd", {
      matchValue: reason,
      fields: { reason },
      turnId: null,
      toolCallId: null,
    });
  }

  async notification(note: {
    type: string;
    message: string;
    title: string | null;
    turnId: string | null;
  }): Promise<void> {
    await this.#run("Notification", {
      matchValue: note.type,
      fields: {
        message: note.message,
        ...(note.title === null ? {} : { title: note.title }),
        notification_type: note.type,
      },
      turnId: note.turnId,
      toolCallId: null,
    });
  }

  /**
   * A subagent was started (fired by its parent). Matchers match the agent type. Cannot block;
   * the context hooks add goes into the agent's conversation before its task.
   */
  async subagentStart(agent: {
    agentId: string;
    agentType: string;
    turnId: string | null;
    signal?: AbortSignal;
  }): Promise<string[]> {
    if (!this.has("SubagentStart")) return [];
    const ran = await this.#run("SubagentStart", {
      matchValue: agent.agentType,
      fields: { agent_id: agent.agentId, agent_type: agent.agentType },
      turnId: agent.turnId,
      toolCallId: null,
      signal: agent.signal ?? this.#background.signal,
    });
    return ran.flatMap((r) => r.result.context.map((text) => capText(text)));
  }

  /**
   * A subagent is about to finish (fired by its parent). Returns the note that keeps the agent
   * going when a hook blocks the stop or adds feedback, or null to let it finish. Matchers match
   * the agent type.
   */
  async subagentStop(agent: {
    agentId: string;
    agentType: string;
    transcriptPath: string;
    lastMessage: string | null;
    /** True once SubagentStop hooks have kept this task going. */
    stopHookActive: boolean;
    turnId: string | null;
    signal: AbortSignal;
  }): Promise<string | null> {
    if (!this.has("SubagentStop")) return null;
    const ran = await this.#run("SubagentStop", {
      matchValue: agent.agentType,
      fields: {
        agent_id: agent.agentId,
        agent_type: agent.agentType,
        agent_transcript_path: agent.transcriptPath,
        stop_hook_active: agent.stopHookActive,
        last_assistant_message: agent.lastMessage ?? "",
      },
      turnId: agent.turnId,
      toolCallId: null,
      signal: agent.signal,
    });
    if (agent.signal.aborted) return null;
    if (ran.some((r) => r.result.stop !== null)) return null;
    const parts: string[] = [];
    for (const r of ran) {
      if (r.result.decision === "block") {
        parts.push(
          `A SubagentStop hook (${label(r.hook)}) asked you to keep going instead of finishing: ${r.result.reason ?? "no reason given"}`,
        );
      }
      for (const text of r.result.context) {
        parts.push(`SubagentStop hook feedback (${label(r.hook)}): ${text}`);
      }
    }
    return parts.length === 0 ? null : parts.join("\n\n");
  }

  // -------------------------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------------------------

  /** Notes and stop requests every event shares: contexts, `continue: false`, a title. */
  #effects(event: string, ran: readonly Ran[], context: (text: string) => string): HookEffects {
    const effects = NO_EFFECTS();
    for (const r of ran) {
      for (const text of r.result.context) {
        effects.notes.push(`A ${event} hook (${label(r.hook)}) ${context(text)}`);
      }
      if (r.result.stop !== null && effects.stop === null) {
        effects.stop = r.result.stop;
        effects.notes.push(
          `A ${event} hook (${label(r.hook)}) stopped this turn${r.result.stop.reason === null ? "." : `: ${r.result.stop.reason}`}`,
        );
      }
      effects.title ??= r.result.sessionTitle;
    }
    return effects;
  }

  /** The handlers that apply to this run, before consent and switches. */
  #candidates(event: RunningEvent, ctx: RunContext): HookDefinition[] {
    const loaded = this.#loaded;
    if (loaded === null || loaded.disabledBy !== null) return [];
    const out: HookDefinition[] = [];
    const seen = new Set<string>();
    for (const hook of loaded.hooks) {
      if (hook.event !== event) continue;
      if (hookSupport(hook).status === "not-supported") continue;
      if (ctx.matchValue !== null && !matcherMatches(event, hook.matcher, ctx.matchValue)) continue;
      if (hook.handler.if !== null) {
        // "On other events, a hook with `if` set doesn't run."
        if (!EVENTS_WITH_IF.has(event) || ctx.ifMatches === undefined) continue;
        if (!ctx.ifMatches(hook.handler.if)) continue;
      }
      // Identical handlers run once; the first (highest precedence) is the one reported.
      const key = canonicalJson(hook.handler.raw);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hook);
    }
    return out;
  }

  /** Those of `hooks` that may run: switched on, and consented to where consent is needed. */
  async #permitted(hooks: HookDefinition[], turnId: string | null): Promise<HookDefinition[]> {
    if (hooks.length === 0) return hooks;
    const { trust, projectDir } = this.#o;
    const off = (await trust.switches?.off(projectDir).catch(() => null)) ?? new Set<string>();
    const bySource = new Map<string, Promise<{ allowed: boolean; onDisk: Set<string> }>>();
    const check = (source: CompatSource) => {
      let pending = bySource.get(source.path);
      if (pending === undefined) {
        pending = (async () => {
          const allowed = await trust.allows(source, projectDir).catch(() => false);
          const onDisk =
            allowed && needsConsent(source) ? await definitionsIn(source) : new Set<string>();
          return { allowed, onDisk };
        })();
        bySource.set(source.path, pending);
      }
      return pending;
    };
    const out: HookDefinition[] = [];
    const held: HookDefinition[] = [];
    for (const hook of hooks) {
      const id = hookId(hook);
      if (off.has(id)) continue;
      const { allowed, onDisk } = await check(hook.source);
      // Consent covers what is on disk; a session still holding an older definition of the same
      // file waits until it reads the file again.
      if (allowed && (!needsConsent(hook.source) || onDisk.has(id))) out.push(hook);
      else held.push(hook);
    }
    if (held.length > 0) this.#noticeSkipped(held, turnId);
    return out;
  }

  #noticeSkipped(held: readonly HookDefinition[], turnId: string | null): void {
    // Once per state of the definitions: every hook loaded, so a change says so again.
    const key = (this.#loaded?.hooks ?? held).map(hookId).sort().join(",");
    if (this.#noticed.has(key)) return;
    this.#noticed.add(key);
    const sources = new Map<string, CompatSource>();
    for (const hook of held) sources.set(hook.source.path, hook.source);
    this.#o.emit("hook.skipped", {
      turnId,
      projectDir: this.#o.projectDir,
      sources: [...sources.values()],
    });
  }

  #timeoutMs(event: RunningEvent, hook: HookDefinition): number {
    const own = hook.handler.timeout === null ? null : hook.handler.timeout * 1000;
    const t = this.#timeouts;
    if (event === "SessionEnd")
      return own === null ? t.sessionEndMs : Math.min(own, t.sessionEndMaxMs);
    if (own !== null) return own;
    return event === "UserPromptSubmit" ? t.promptSubmitMs : t.commandMs;
  }

  #input(event: RunningEvent, fields: Record<string, unknown>): string {
    return JSON.stringify({
      session_id: this.#o.sessionId,
      transcript_path: this.#o.transcriptPath,
      cwd: this.#o.cwd,
      permission_mode: this.#o.mode(),
      hook_event_name: event,
      ...(this.#o.subagent === undefined
        ? {}
        : { agent_id: this.#o.subagent.agentId, agent_type: this.#o.subagent.agentType }),
      ...fields,
    });
  }

  #env(): NodeJS.ProcessEnv {
    return {
      ...(this.#o.baseEnv ?? process.env),
      ...this.#o.env(),
      CLAUDE_PROJECT_DIR: this.#o.cwd,
      DAWG_PROJECT_DIR: this.#o.cwd,
      // The shell adopts PWD when it names its starting folder, keeping the path as given.
      PWD: this.#o.cwd,
    };
  }

  async #run(event: RunningEvent, ctx: RunContext): Promise<Ran[]> {
    const hooks = await this.#permitted(this.#candidates(event, ctx), ctx.turnId);
    if (hooks.length === 0) return [];
    const stdin = this.#input(event, ctx.fields);
    const env = this.#env();
    const start = (hook: HookDefinition, signal: AbortSignal | undefined): Promise<Ran> =>
      runCommand({
        command: hook.handler.command ?? "",
        args: hook.handler.args,
        cwd: this.#o.cwd,
        env,
        stdin,
        timeoutMs: this.#timeoutMs(event, hook),
        now: this.#o.now,
        ...(signal === undefined ? {} : { signal }),
      }).then((run: CommandRun) => {
        const result = interpretRun(event, hook.handler, run);
        this.#report(event, hook, result, ctx);
        return { hook, result };
      });

    const foreground: Promise<Ran>[] = [];
    for (const hook of hooks) {
      if (hook.handler.async) {
        // Runs on without holding anything up. Its decisions have no effect; its context and
        // system message arrive at the next safe point (documented for async hooks).
        void start(hook, this.#background.signal).then((r) => {
          if (this.#background.signal.aborted) return;
          for (const text of r.result.context) {
            this.#o.queueNote(
              `A background ${event} hook (${label(r.hook)}) added this:\n\n${capText(text)}`,
            );
          }
        });
      } else {
        foreground.push(start(hook, ctx.signal));
      }
    }
    return Promise.all(foreground);
  }

  #report(event: RunningEvent, hook: HookDefinition, result: HandlerResult, ctx: RunContext): void {
    // After the session closed (a SessionStart or background hook stopped with it) there is
    // nowhere to report to.
    if (this.#background.signal.aborted) return;
    try {
      this.#o.emit("hook.ran", {
        turnId: ctx.turnId,
        toolCallId: ctx.toolCallId,
        hook: {
          event,
          matcher: hook.matcher,
          type: hook.handler.type,
          command: hook.handler.target,
          source: hook.source,
        },
        outcome: result.outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        decision: result.decision,
        message:
          result.message ??
          (result.systemMessage === null ? null : result.systemMessage.slice(0, 1000)),
      });
    } catch {
      // A session that closed while a background hook ran has nowhere to report it.
    }
  }
}
