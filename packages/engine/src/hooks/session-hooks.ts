/**
 * One session's hooks: the tier 1 and tier 2 events with every handler type, as the hooks
 * reference documents them (code.claude.com/docs/en/hooks). The runtime calls one method per
 * event and applies what comes back; this class finds the handlers that apply, runs them,
 * reports each run (`hook.ran`), and turns their output into what the event allows.
 *
 * - Only what the person has consented to runs (`CodeTrust.allows`, and the definition must
 *   still be the one on disk); hooks held back for consent are reported once per session for each
 *   state of the definitions (`hook.skipped`). Hooks the person switched off never run.
 * - Handlers that match one event run in parallel; one written identically in several files runs
 *   once ("A handler defined identically in multiple settings files runs once").
 * - Input is JSON on standard input: the documented common fields and the event's own.
 * - Environment: the engine's, then the settings `env`, then `CLAUDE_PROJECT_DIR` and
 *   `DAWG_PROJECT_DIR`. The project is the working directory.
 * - Handler types: `command` (./command.ts), `http` (./http.ts), `prompt` (./prompt.ts), `agent`
 *   (./agent.ts) and `mcp_tool` (./mcp-tool.ts), each on the events the reference lists for it.
 *   Only command hooks run in the background (`async`).
 * - Timeouts: 600 s for command, http and mcp_tool handlers (30 s on UserPromptSubmit), 30 s for
 *   prompt, 60 s for agent; on SessionEnd 1.5 s for a handler without its own (with one, up to
 *   60 s); a handler's `timeout` (seconds) wins.
 */
import {
  EVENTS_WITH_IF,
  type HookDefinition,
  headerVariablesAllowed,
  hookSupport,
  interpolateHeaders,
  type LoadedHooks,
  loadHooks,
  type RunningEvent,
} from "@dawg/compat";
import {
  type CompatSource,
  type ElicitationContent,
  type ElicitationField,
  type ElicitationResponse,
  elicitationIssues,
  type PermissionMode,
} from "@dawg/protocol";
import type { UtilityModel } from "../contracts/web.ts";
import type { Emit } from "../loop/types.ts";
import { canonicalJson, definitionsIn, hookId, needsConsent } from "../trust/definitions.ts";
import type { CodeTrust } from "../trust/index.ts";
import { type HookAgents, runAgentHook } from "./agent.ts";
import { runCommand } from "./command.ts";
import { runHttpHook } from "./http.ts";
import { matcherMatches } from "./match.ts";
import { type HookMcp, runMcpToolHook } from "./mcp-tool.ts";
import { capText, type HandlerResult, interpretHandler, interpretRun } from "./output.ts";
import { runPromptHook } from "./prompt.ts";

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
  /** A prompt handler. Default 30 s. */
  promptMs: number;
  /** An agent handler. Default 60 s. */
  agentMs: number;
  /**
   * How long an mcp_tool hook waits for its server while it is still connecting, on events that
   * can block or change the result (`MCP_TIMEOUT` in Claude Code). Default 30 s.
   */
  mcpConnectMs: number;
}

/** "Defaults: 600 for command, http, and mcp_tool; 30 for prompt; 60 for agent." */
export const DEFAULT_HOOK_TIMEOUTS: HookTimeouts = {
  commandMs: 600_000,
  promptSubmitMs: 30_000,
  sessionEndMs: 1_500,
  sessionEndMaxMs: 60_000,
  promptMs: 30_000,
  agentMs: 60_000,
  mcpConnectMs: 30_000,
};

/**
 * What the handler types other than `command` run on, lent by the session. A type whose service
 * is missing fails as a non-blocking error.
 */
export interface HookServices {
  /** Prompt hooks: the helper model when it is on, else the session's model. */
  model?: () => UtilityModel | null;
  /** Agent hooks: the session's subagents. */
  agents?: () => HookAgents | null;
  /** MCP tool hooks: the session's MCP servers. */
  mcp?: () => HookMcp | null;
  /** HTTP hooks; for tests. Default the global `fetch`. */
  fetch?: typeof fetch;
}

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
  /** What http, prompt, agent and mcp_tool handlers run on. */
  services?: HookServices;
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

/**
 * What PermissionRequest hooks answered for the person (reference, "PermissionRequest decision
 * control"): deny wins over allow; with neither, the prompt is shown as usual.
 */
export interface PermissionRequestVerdict extends HookEffects {
  behavior: "allow" | "deny" | null;
  /** Allow: the whole new input for the call, judged again by deny and ask rules. */
  updatedInput: Record<string, unknown> | null;
  /** Allow: permission update entries to apply, as written. */
  updatedPermissions: Record<string, unknown>[];
  /** Deny: the message for the model. */
  message: string | null;
  /** Deny with `interrupt: true`: the turn stops too. */
  interrupt: boolean;
}

/** What PreCompact hooks decided (reference, "PreCompact"). */
export interface PreCompactVerdict {
  /** Set when a hook blocked the compaction, with its reason. */
  blocked: { reason: string | null } | null;
  /** Their standard output on exit 0: instructions for the summary, one per hook. */
  instructions: string[];
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
  /**
   * False where MCP servers are not there yet (SessionStart at launch): mcp_tool hooks are skipped
   * ("Claude Code skips their mcp_tool hooks without calling the tool"). Default true.
   */
  mcpReady?: boolean;
  /** Checks one handler's result before it is reported and used (an elicitation's answer). */
  check?: (result: HandlerResult) => HandlerResult;
}

/** An MCP server's request for input, as Elicitation and ElicitationResult hooks see it. */
export interface HookElicitation {
  server: string;
  message: string;
  mode: "form" | "url";
  /** The form, to check a hook's answer against; empty in URL mode. */
  fields: readonly ElicitationField[];
  /** The server's `requestedSchema` as sent, or null in URL mode or when not known. */
  requestedSchema: unknown;
  url: string | null;
  elicitationId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  signal?: AbortSignal;
}

/**
 * A hook's elicitation answer, checked against the form: an accepted form must fit it, as the
 * person's must ("so a hook can't submit content the form would refuse"). An answer that does
 * not fit is refused, and counts as the hook's failure.
 */
function checkedAnswer(
  request: Pick<HookElicitation, "mode" | "fields">,
  result: HandlerResult,
): HandlerResult {
  const answer = result.elicitation;
  if (answer === null || answer.action !== "accept") return result;
  if (request.mode === "url")
    return { ...result, elicitation: { action: "accept", content: null } };
  const issues = elicitationIssues([...request.fields], answer.content ?? {});
  if (issues.length === 0) return result;
  const named = issues.map((i) => (i.field === null ? i.message : `${i.field}: ${i.message}`));
  return {
    ...result,
    outcome: "error",
    decision: null,
    elicitation: null,
    message: `Its answer does not fit the form, so it was not used. ${named.join(" ")}`.slice(
      0,
      1000,
    ),
  };
}

/** Of several hooks' answers: a decline wins, then a cancel, then the first accept. */
function strongestAnswer(
  answers: readonly NonNullable<HandlerResult["elicitation"]>[],
): NonNullable<HandlerResult["elicitation"]> | null {
  return (
    answers.find((a) => a.action === "decline") ??
    answers.find((a) => a.action === "cancel") ??
    answers.find((a) => a.action === "accept") ??
    null
  );
}

interface Ran {
  hook: HookDefinition;
  result: HandlerResult;
}

const NO_EFFECTS = (): HookEffects => ({ notes: [], stop: null, title: null });

/** The events that fire inside a subagent's own session: its tool events. */
const SUBAGENT_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);

/**
 * Events where a hook may block or change the result, on which an mcp_tool hook waits for a
 * server still connecting; on the others it does not ("On observational events ... it doesn't
 * wait").
 */
const DECIDING_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
]);

/** A permission rule written `Tool(specifier)`, as a permission update entry names it. */
function ruleEntry(rule: string): { toolName: string; ruleContent?: string } {
  const open = rule.indexOf("(");
  if (open > 0 && rule.endsWith(")")) {
    const content = rule.slice(open + 1, -1);
    return content === "" || content === "*"
      ? { toolName: rule.slice(0, open) }
      : { toolName: rule.slice(0, open), ruleContent: content };
  }
  return { toolName: rule };
}

function label(hook: HookDefinition): string {
  const flat = hook.handler.target.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** What the server gets from the hooks that ran, or null when none answered. */
function elicitationAnswer(ran: readonly Ran[]): ElicitationResponse | null {
  // Exit 2 or a top-level block declines, whatever else the hook said.
  if (ran.some((r) => r.result.decision === "block" && r.result.elicitation === null)) {
    return { action: "decline", content: null };
  }
  const answer = strongestAnswer(
    ran.flatMap((r) => (r.result.elicitation === null ? [] : [r.result.elicitation])),
  );
  if (answer === null) return null;
  return answer.action === "accept"
    ? { action: "accept", content: (answer.content ?? null) as ElicitationContent | null }
    : { action: answer.action, content: null };
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
    return loaded.hooks.some(
      (h) => h.event === event && hookSupport(h, loaded.http).status !== "not-supported",
    );
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
      // At launch the session's MCP servers are not there for hooks yet; after /clear or a
      // compaction they are.
      mcpReady: start.source === "clear" || start.source === "compact",
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

  /**
   * A permission prompt is about to be shown (or, where nobody can answer one, the call would be
   * refused): the hooks may answer it instead of the person. Never called when a rule decided.
   * `suggestions` are the rules "always allow" would save, sent as `permission_suggestions`.
   */
  async permissionRequest(call: {
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    suggestions: readonly string[];
    signal: AbortSignal;
    ifMatches?: (rule: string) => boolean;
  }): Promise<PermissionRequestVerdict> {
    const suggestions =
      call.suggestions.length === 0
        ? []
        : [
            {
              type: "addRules",
              rules: call.suggestions.map(ruleEntry),
              behavior: "allow",
              destination: "localSettings",
            },
          ];
    const ran = await this.#run("PermissionRequest", {
      matchValue: call.toolName,
      fields: {
        tool_name: call.toolName,
        tool_input: call.toolInput,
        ...(suggestions.length === 0 ? {} : { permission_suggestions: suggestions }),
      },
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      signal: call.signal,
      ...(call.ifMatches === undefined ? {} : { ifMatches: call.ifMatches }),
    });
    const verdict: PermissionRequestVerdict = {
      ...this.#effects(
        "PermissionRequest",
        ran,
        (text) => `added this about the ${call.toolName} call:\n\n${text}`,
      ),
      behavior: null,
      updatedInput: null,
      updatedPermissions: [],
      message: null,
      interrupt: false,
    };
    const denying = ran.filter((r) => r.result.decision === "deny");
    if (denying.length > 0) {
      verdict.behavior = "deny";
      const reasons = denying.map((r) => r.result.reason).filter((r): r is string => r !== null);
      verdict.message = reasons.length === 0 ? null : reasons.join("\n");
      verdict.interrupt = denying.some((r) => r.result.interrupt);
      return verdict;
    }
    const allowing = ran.filter((r) => r.result.decision === "allow");
    if (allowing.length > 0) {
      verdict.behavior = "allow";
      verdict.updatedInput =
        allowing.find((r) => r.result.updatedInput !== null)?.result.updatedInput ?? null;
      verdict.updatedPermissions = allowing.flatMap(
        (r) => r.result.updatedPermissions as Record<string, unknown>[],
      );
    }
    return verdict;
  }

  /**
   * A tool call failed: it threw, or its result is an error. Not for a call the person stopped
   * ("Cancelling a running tool does not fire this hook"). What the hooks say goes to the model.
   */
  async postToolUseFailure(call: {
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    error: string;
    isInterrupt: boolean;
    durationMs: number | null;
    signal: AbortSignal;
    ifMatches?: (rule: string) => boolean;
  }): Promise<HookEffects> {
    const ran = await this.#run("PostToolUseFailure", {
      matchValue: call.toolName,
      fields: {
        tool_name: call.toolName,
        tool_input: call.toolInput,
        tool_use_id: call.toolCallId,
        error: call.error,
        is_interrupt: call.isInterrupt,
        ...(call.durationMs === null ? {} : { duration_ms: call.durationMs }),
      },
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      signal: call.signal,
      ...(call.ifMatches === undefined ? {} : { ifMatches: call.ifMatches }),
    });
    const effects = this.#effects(
      "PostToolUseFailure",
      ran,
      (text) => `added this about the failed ${call.toolName} call:\n\n${text}`,
    );
    // Exit 2, a block or a prompt hook's `ok: false`: "Shows stderr to Claude; the tool already
    // failed."
    for (const r of ran) {
      if (r.result.decision !== "block") continue;
      effects.notes.push(
        `A PostToolUseFailure hook (${label(r.hook)}) said this about the failed ${call.toolName} call: ${r.result.reason ?? "no reason given"}`,
      );
    }
    return effects;
  }

  /**
   * Before a compaction: hooks may block it (exit 2, `decision: "block"`), and what they print on
   * exit 0 becomes instructions for the summary. Matchers match the trigger.
   */
  async preCompact(compaction: {
    trigger: "manual" | "auto";
    /** What the person passed to `/compact`; null for an automatic compaction. */
    customInstructions: string | null;
    turnId: string | null;
    signal: AbortSignal;
  }): Promise<PreCompactVerdict> {
    if (!this.has("PreCompact")) return { blocked: null, instructions: [] };
    const ran = await this.#run("PreCompact", {
      matchValue: compaction.trigger,
      fields: { trigger: compaction.trigger, custom_instructions: compaction.customInstructions },
      turnId: compaction.turnId,
      toolCallId: null,
      signal: compaction.signal,
    });
    const blocking = ran.filter((r) => r.result.decision === "block");
    if (blocking.length > 0) {
      const reasons = blocking.map((r) => r.result.reason).filter((r): r is string => r !== null);
      return {
        blocked: { reason: reasons.length === 0 ? null : reasons.join("\n") },
        instructions: [],
      };
    }
    return { blocked: null, instructions: ran.flatMap((r) => r.result.context) };
  }

  // Tier 3 ------------------------------------------------------------------------------------

  /**
   * Once a batch of tool calls has all its results, before the next request (reference,
   * "PostToolBatch"). A block, exit 2 or `continue: false` ends the turn there, with the reason
   * kept for the model; their context goes in before the next request.
   */
  async postToolBatch(batch: {
    turnId: string | null;
    calls: {
      toolName: string;
      toolInput: Record<string, unknown>;
      toolCallId: string;
      /** What the model gets as the call's result. */
      toolResponse: string;
    }[];
    signal?: AbortSignal;
  }): Promise<HookEffects> {
    if (!this.has("PostToolBatch") || batch.calls.length === 0) return NO_EFFECTS();
    const ran = await this.#run("PostToolBatch", {
      matchValue: null,
      fields: {
        tool_calls: batch.calls.map((c) => ({
          tool_name: c.toolName,
          tool_input: c.toolInput,
          tool_use_id: c.toolCallId,
          tool_response: c.toolResponse,
        })),
      },
      turnId: batch.turnId,
      toolCallId: null,
      ...(batch.signal === undefined ? {} : { signal: batch.signal }),
    });
    const effects = this.#effects(
      "PostToolBatch",
      ran,
      (text) => `added this after the tool calls:\n\n${text}`,
    );
    for (const r of ran) {
      if (r.result.decision !== "block" || effects.stop !== null) continue;
      effects.stop = { reason: r.result.reason };
      effects.notes.push(
        `A PostToolBatch hook (${label(r.hook)}) stopped this turn${r.result.reason === null ? "." : `: ${r.result.reason}`}`,
      );
    }
    return effects;
  }

  /**
   * A command the person typed is about to expand into a prompt: a skill or custom command
   * (`slash_command`), or an MCP server's prompt (`mcp_prompt`). Matchers match the command's
   * name. A block stops it before it expands, with the reason for the person; context goes in
   * alongside the expanded prompt.
   */
  async userPromptExpansion(command: {
    expansionType: "slash_command" | "mcp_prompt";
    name: string;
    args: string;
    /** Where the command comes from: "userSettings", "projectSettings" or "mcp". */
    source: string;
    signal?: AbortSignal;
  }): Promise<PromptVerdict> {
    const empty: PromptVerdict = { ...NO_EFFECTS(), blocked: null };
    if (!this.has("UserPromptExpansion")) return empty;
    const ran = await this.#run("UserPromptExpansion", {
      matchValue: command.name,
      fields: {
        expansion_type: command.expansionType,
        command_name: command.name,
        command_args: command.args,
        command_source: command.source,
        prompt: `/${command.name}${command.args === "" ? "" : ` ${command.args}`}`,
      },
      turnId: null,
      toolCallId: null,
      ...(command.signal === undefined ? {} : { signal: command.signal }),
    });
    const effects = this.#effects(
      "UserPromptExpansion",
      ran,
      (text) => `added this context to /${command.name}:\n\n${text}`,
    );
    const blocking = ran.filter((r) => r.result.decision === "block");
    let blocked: PromptVerdict["blocked"] = null;
    if (blocking.length > 0) {
      const reasons = blocking.map((r) => r.result.reason).filter((r): r is string => r !== null);
      blocked = { reason: reasons.length === 0 ? null : reasons.join("\n") };
    } else if (effects.stop !== null) {
      blocked = { reason: effects.stop.reason };
    }
    return { ...effects, blocked };
  }

  /**
   * A turn ended because the model's server failed, instead of Stop (reference, "StopFailure").
   * Matchers match `error`. What the hooks print, and how they exit, changes nothing.
   */
  async stopFailure(failure: {
    turnId: string | null;
    /** The reference's names: "rate_limit", "server_error", "invalid_request"... */
    error: string;
    details: string | null;
    message: string | null;
  }): Promise<void> {
    if (!this.has("StopFailure")) return;
    await this.#run("StopFailure", {
      matchValue: failure.error,
      fields: {
        error: failure.error,
        ...(failure.details === null ? {} : { error_details: failure.details }),
        ...(failure.message === null ? {} : { last_assistant_message: failure.message }),
      },
      turnId: failure.turnId,
      toolCallId: null,
      signal: this.#background.signal,
    });
  }

  /**
   * An MCP server asks for input (reference, "Elicitation"). Hooks may answer in the person's
   * place: accept (with the form's content), decline or cancel; exit 2 or a block declines, and a
   * decline wins over the others. Resolves with that answer, or null to show the form. Matchers
   * match the server's name.
   */
  async elicitation(request: HookElicitation): Promise<ElicitationResponse | null> {
    if (!this.has("Elicitation")) return null;
    const ran = await this.#run("Elicitation", {
      matchValue: request.server,
      fields: {
        mcp_server_name: request.server,
        message: request.message,
        mode: request.mode,
        ...(request.url === null ? {} : { url: request.url }),
        ...(request.elicitationId === null ? {} : { elicitation_id: request.elicitationId }),
        ...(request.mode === "form" && request.requestedSchema !== null
          ? { requested_schema: request.requestedSchema }
          : {}),
      },
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      check: (result) => checkedAnswer(request, result),
    });
    return elicitationAnswer(ran);
  }

  /**
   * The person answered an MCP server's request (reference, "ElicitationResult"), declining and
   * cancelling included. Hooks may let it through, change the form's values, decline or cancel;
   * exit 2 or a block declines. Resolves with what the server gets.
   */
  async elicitationResult(
    request: HookElicitation,
    answer: ElicitationResponse,
  ): Promise<ElicitationResponse> {
    if (!this.has("ElicitationResult")) return answer;
    const ran = await this.#run("ElicitationResult", {
      matchValue: request.server,
      fields: {
        mcp_server_name: request.server,
        action: answer.action,
        mode: request.mode,
        ...(request.elicitationId === null ? {} : { elicitation_id: request.elicitationId }),
        ...(answer.content === null ? {} : { content: answer.content }),
      },
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      // An accept that leaves out `content` keeps the person's.
      check: (result) =>
        checkedAnswer(
          request,
          result.elicitation?.action === "accept" && result.elicitation.content === null
            ? { ...result, elicitation: { action: "accept", content: answer.content ?? {} } }
            : result,
        ),
    });
    return elicitationAnswer(ran) ?? answer;
  }

  /** After a compaction, with its summary. Nothing they say changes anything. */
  async postCompact(compaction: {
    trigger: "manual" | "auto";
    summary: string;
    turnId: string | null;
  }): Promise<void> {
    if (!this.has("PostCompact")) return;
    await this.#run("PostCompact", {
      matchValue: compaction.trigger,
      fields: { trigger: compaction.trigger, compact_summary: compaction.summary },
      turnId: compaction.turnId,
      toolCallId: null,
      signal: this.#background.signal,
    });
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
      if (hookSupport(hook, loaded.http).status === "not-supported") continue;
      if (hook.handler.type === "mcp_tool" && ctx.mcpReady === false) continue;
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
    if (hook.handler.type === "prompt") return t.promptMs;
    if (hook.handler.type === "agent") return t.agentMs;
    return event === "UserPromptSubmit" ? t.promptSubmitMs : t.commandMs;
  }

  #input(event: RunningEvent, fields: Record<string, unknown>): Record<string, unknown> {
    return {
      session_id: this.#o.sessionId,
      transcript_path: this.#o.transcriptPath,
      cwd: this.#o.cwd,
      permission_mode: this.#o.mode(),
      hook_event_name: event,
      ...(this.#o.subagent === undefined
        ? {}
        : { agent_id: this.#o.subagent.agentId, agent_type: this.#o.subagent.agentType }),
      ...fields,
    };
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

  /** Runs one handler of any type to its result. Never rejects. */
  async #runOne(
    event: RunningEvent,
    hook: HookDefinition,
    ctx: RunContext,
    input: { object: Record<string, unknown>; json: string; env: NodeJS.ProcessEnv },
    signal: AbortSignal | undefined,
  ): Promise<HandlerResult> {
    const { handler } = hook;
    const timeoutMs = this.#timeoutMs(event, hook);
    const services = this.#o.services ?? {};
    const common = { timeoutMs, now: this.#o.now, ...(signal === undefined ? {} : { signal }) };
    try {
      switch (handler.type) {
        case "http": {
          const policy = this.#loaded?.http ?? { allowedUrls: null, allowedEnvVars: null };
          const headers = interpolateHeaders(
            handler.headers,
            headerVariablesAllowed(handler, policy),
            input.env,
          );
          const run = await runHttpHook({
            ...common,
            url: handler.url ?? "",
            headers,
            body: input.json,
            ...(services.fetch === undefined ? {} : { fetch: services.fetch }),
          });
          return interpretHandler(event, handler, run);
        }
        case "prompt": {
          const run = await runPromptHook({
            ...common,
            prompt: handler.prompt ?? "",
            input: input.json,
            model: services.model?.() ?? null,
          });
          return interpretHandler(event, handler, run);
        }
        case "agent": {
          const run = await runAgentHook({
            ...common,
            event,
            prompt: handler.prompt ?? "",
            input: input.json,
            agents: services.agents?.() ?? null,
            turnId: ctx.turnId,
            toolCallId: ctx.toolCallId,
          });
          return interpretHandler(event, handler, run);
        }
        case "mcp_tool": {
          const run = await runMcpToolHook({
            ...common,
            server: handler.server ?? "",
            tool: handler.tool ?? "",
            input: handler.input,
            hookInput: input.object,
            mcp: services.mcp?.() ?? null,
            waitMs: DECIDING_EVENTS.has(event) ? this.#timeouts.mcpConnectMs : 0,
          });
          return interpretHandler(event, handler, run);
        }
        default: {
          const run = await runCommand({
            ...common,
            command: handler.command ?? "",
            args: handler.args,
            cwd: this.#o.cwd,
            env: input.env,
            stdin: input.json,
          });
          return interpretRun(event, handler, run);
        }
      }
    } catch (error) {
      // A runner that throws is a bug; the hook counts as a failed run, never as the turn's.
      return interpretHandler(event, handler, {
        kind: "failed",
        outcome: "error",
        detail: `It could not run: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: 0,
      });
    }
  }

  async #run(event: RunningEvent, ctx: RunContext): Promise<Ran[]> {
    const hooks = await this.#permitted(this.#candidates(event, ctx), ctx.turnId);
    if (hooks.length === 0) return [];
    const object = this.#input(event, ctx.fields);
    const input = { object, json: JSON.stringify(object), env: this.#env() };
    const start = (hook: HookDefinition, signal: AbortSignal | undefined): Promise<Ran> =>
      this.#runOne(event, hook, ctx, input, signal).then((ran) => {
        const result = ctx.check === undefined ? ran : ctx.check(ran);
        this.#report(event, hook, result, ctx);
        return { hook, result };
      });

    const foreground: Promise<Ran>[] = [];
    for (const hook of hooks) {
      // Only command hooks run in the background ("This field is only available on
      // type: "command" hooks").
      if (hook.handler.async && hook.handler.type === "command") {
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
