/**
 * What one handler's run means, per the hooks reference (code.claude.com/docs/en/hooks, "Exit
 * code output" and "JSON output"):
 *
 * - Exit 0: success. Standard output is read as JSON when it is one JSON object; otherwise it is
 *   plain text, which UserPromptSubmit and SessionStart add to the model's context.
 * - Exit 2: blocking. Standard error is the reason (unless the JSON gives one), and the action
 *   stops where the event allows it: PreToolUse denies the call, UserPromptSubmit refuses the
 *   prompt, Stop keeps the turn going, PostToolUse shows it to the model. SessionStart, SessionEnd
 *   and Notification cannot block; stderr goes to the person only.
 * - Any other exit, a timeout, a command that cannot start, or JSON that cannot be read: a
 *   non-blocking error shown to the person, unless the handler says `onFailure: "block"`, which
 *   makes it do what exit 2 does (except on Stop), and denies on PermissionRequest.
 *
 * The other handler types reach the same tables through `interpretHandler`: an http response
 * body or an MCP tool's text is read like a command's standard output on exit 0, a failed
 * request is a failure, and a prompt or agent hook's `{ ok, reason }` decides as the reference's
 * "Response schema" says for each event.
 */
import type { HookHandler } from "@dawg/compat";
import type { CommandRun } from "./command.ts";

export type HookOutcome = "success" | "blocked" | "error" | "timeout";
export type HookDecision = "allow" | "deny" | "ask" | "block";

/** The documented cap on context, system messages and plain output (10,000 characters). */
export const MAX_HOOK_TEXT = 10_000;
/** The hook.ran event's message is a line in the transcript, kept short. */
const MAX_EVENT_MESSAGE = 1000;

export interface HandlerResult {
  outcome: HookOutcome;
  exitCode: number | null;
  durationMs: number;
  /** allow / deny / ask for PreToolUse; block for the events that can block. */
  decision: HookDecision | null;
  /** Why it decided: denial reason for the model, the question for an ask, the block reason. */
  reason: string | null;
  /** PreToolUse: the whole new input for the call. */
  updatedInput: Record<string, unknown> | null;
  /** Text for the model: `additionalContext`, or plain output where it counts as context. */
  context: string[];
  /** `continue: false`: stop processing after this hook, with the reason shown to the person. */
  stop: { reason: string | null } | null;
  /** `systemMessage`: a warning for the person. */
  systemMessage: string | null;
  /** `sessionTitle` (UserPromptSubmit, SessionStart). */
  sessionTitle: string | null;
  /** PermissionRequest's allow: the permission update entries to apply (`updatedPermissions`). */
  updatedPermissions: unknown[];
  /** PermissionRequest's deny with `interrupt: true`: the turn stops too. */
  interrupt: boolean;
  /**
   * Elicitation and ElicitationResult: the answer the hook gives the server instead of the
   * person's (`hookSpecificOutput.action`, with `content` for a form), or null to leave it.
   */
  elicitation: {
    action: "accept" | "decline" | "cancel";
    content: Record<string, unknown> | null;
  } | null;
  /** The line the person sees in `hook.ran`. */
  message: string | null;
}

/**
 * Events whose plain standard output (exit 0) the event uses: context for the model, or on
 * PreCompact the instructions for the summary ("Claude Code uses its stdout as instructions for
 * the compaction summary").
 */
const PLAIN_OUTPUT_IS_CONTEXT = new Set(["UserPromptSubmit", "SessionStart", "PreCompact"]);
/** Events exit 2 (and `onFailure: "block"`) can block. */
const CAN_BLOCK = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "PostToolBatch",
  "UserPromptExpansion",
  "Elicitation",
  "ElicitationResult",
]);
/** Events whose top-level `decision: "block"` counts (the reference's decision control table). */
const TOP_LEVEL_BLOCK = new Set([
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "PostToolBatch",
  "UserPromptExpansion",
  "Elicitation",
  "ElicitationResult",
]);
/** Elicitation events: a block declines, and the person and the server are not told why. */
const ELICITATION_EVENTS = new Set(["Elicitation", "ElicitationResult"]);
/**
 * Events that discard `systemMessage` and `continue` ("Claude Code discards ..."); on StopFailure
 * "Output and exit code are ignored".
 */
const DISCARDS_GENERAL_FIELDS = new Set([
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "StopFailure",
  "Elicitation",
  "ElicitationResult",
]);
/** Events where `onFailure: "block"` has no effect, as documented. */
const FAILURE_NEVER_BLOCKS = new Set([
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "SubagentStart",
]);

export function capText(text: string, max = MAX_HOOK_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[cut: ${(text.length - max).toLocaleString("en-US")} more characters]`;
}

function shortLine(text: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_EVENT_MESSAGE
    ? `${trimmed.slice(0, MAX_EVENT_MESSAGE - 1)}…`
    : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? capText(value) : null;
}

function blank(run: Pick<CommandRun, "exitCode" | "durationMs">): HandlerResult {
  return {
    outcome: "success",
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    decision: null,
    reason: null,
    updatedInput: null,
    context: [],
    stop: null,
    systemMessage: null,
    sessionTitle: null,
    updatedPermissions: [],
    interrupt: false,
    elicitation: null,
    message: null,
  };
}

/** Standard output read as one JSON object; "none" for plain text, "invalid" for broken JSON. */
function readJson(stdout: string): Record<string, unknown> | "none" | "invalid" {
  const text = stdout.trim();
  if (!text.startsWith("{")) return "none";
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : "invalid";
  } catch {
    return "invalid";
  }
}

/** The blocking effect of exit 2 (or a failure set to block) on `event`, with `reason`. */
function block(event: string, result: HandlerResult, reason: string | null): HandlerResult {
  switch (event) {
    case "PreToolUse":
      return {
        ...result,
        outcome: "blocked",
        decision: "deny",
        reason,
        message: shortLine(reason),
      };
    case "Elicitation":
    case "ElicitationResult":
      // "An exit-2 hook's hookSpecificOutput is ignored", and nobody is shown its reason.
      return { ...result, outcome: "blocked", decision: "block", elicitation: null };
    case "UserPromptSubmit":
    case "Stop":
    case "SubagentStop":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PreCompact":
    case "PostToolBatch":
    case "UserPromptExpansion":
      return {
        ...result,
        outcome: "blocked",
        decision: "block",
        reason,
        message: shortLine(reason),
      };
    default:
      // Not blocking: shown to the person only.
      return { ...result, outcome: "error", message: shortLine(reason) };
  }
}

/** A failure: non-blocking unless the handler says `onFailure: "block"`. */
function failure(
  event: string,
  handler: HookHandler,
  result: HandlerResult,
  outcome: "error" | "timeout",
  detail: string,
): HandlerResult {
  const failed = { ...result, outcome, message: shortLine(detail) };
  const what = outcome === "timeout" ? "timed out" : "failed";
  if (event === "PermissionRequest" && handler.onFailure === "block") {
    // "With "block" set, a failure does what exit code 2 does ..., except on PermissionRequest,
    // where it denies the request."
    const reason = `The hook ${what}; denying because onFailure is "block". ${detail}`.trim();
    return { ...failed, outcome: "blocked", decision: "deny", reason, message: shortLine(reason) };
  }
  if (handler.onFailure !== "block" || FAILURE_NEVER_BLOCKS.has(event) || !CAN_BLOCK.has(event)) {
    return failed;
  }
  return block(
    event,
    failed,
    `The hook ${what}; blocking because onFailure is "block". ${detail}`.trim(),
  );
}

/** Reads the documented JSON fields for `event` into `result`. */
function applyJson(
  event: string,
  json: Record<string, unknown>,
  result: HandlerResult,
): HandlerResult {
  const out = { ...result, context: [...result.context] };
  if (!DISCARDS_GENERAL_FIELDS.has(event)) {
    if (json.continue === false) out.stop = { reason: str(json.stopReason) };
    out.systemMessage = str(json.systemMessage);
  }

  const specific = isPlainObject(json.hookSpecificOutput) ? json.hookSpecificOutput : null;
  // `hookSpecificOutput` is for the event it names; one naming another event is not ours.
  const mine =
    specific !== null && (specific.hookEventName === undefined || specific.hookEventName === event)
      ? specific
      : null;
  const context = str(mine?.additionalContext);
  if (context !== null) out.context.push(context);

  if (event === "PreToolUse") {
    // The deprecated top-level form: "approve" and "block" mean allow and deny.
    const legacy =
      json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : null;
    const raw = mine?.permissionDecision;
    const decision = raw === "allow" || raw === "deny" || raw === "ask" ? raw : legacy;
    if (decision !== null) {
      out.decision = decision;
      out.reason = str(mine?.permissionDecisionReason) ?? str(json.reason);
    }
    if (isPlainObject(mine?.updatedInput)) out.updatedInput = mine.updatedInput;
  } else if (event === "PermissionRequest") {
    // `hookSpecificOutput.decision`: allow (with new input and permission updates) or deny
    // (with a message for the model, and `interrupt` to stop).
    const answer = isPlainObject(mine?.decision) ? mine.decision : null;
    if (answer?.behavior === "allow") {
      out.decision = "allow";
      if (isPlainObject(answer.updatedInput)) out.updatedInput = answer.updatedInput;
      if (Array.isArray(answer.updatedPermissions)) {
        out.updatedPermissions = answer.updatedPermissions.filter(isPlainObject);
      }
    } else if (answer?.behavior === "deny") {
      out.decision = "deny";
      out.reason = str(answer.message);
      out.interrupt = answer.interrupt === true;
    }
  } else if (ELICITATION_EVENTS.has(event)) {
    // `hookSpecificOutput.action` answers (or changes) the request; a top-level block declines,
    // and overrides it. Claude Code discards `reason`.
    const action = mine?.action;
    if (json.decision === "block") {
      out.decision = "block";
    } else if (action === "accept" || action === "decline" || action === "cancel") {
      out.elicitation = {
        action,
        content: action === "accept" && isPlainObject(mine?.content) ? mine.content : null,
      };
      if (action === "accept") out.decision = "allow";
      if (action === "decline") out.decision = "block";
    }
  } else if (TOP_LEVEL_BLOCK.has(event)) {
    if (json.decision === "block") {
      out.decision = "block";
      out.reason = str(json.reason);
    }
  }
  if (event === "UserPromptSubmit" || event === "SessionStart") {
    out.sessionTitle = str(mine?.sessionTitle);
  }

  if (out.decision === "deny" || out.decision === "block" || out.stop !== null) {
    out.outcome = "blocked";
  }
  out.message = shortLine(out.reason ?? out.stop?.reason ?? out.systemMessage ?? null);
  return out;
}

/** What one finished run of a command `handler` on `event` means. Pure. */
export function interpretRun(event: string, handler: HookHandler, run: CommandRun): HandlerResult {
  const result = blank(run);
  if (run.startError !== null) {
    return failure(event, handler, result, "error", `It could not start: ${run.startError}`);
  }
  if (run.timedOut) {
    const seconds = Math.round(run.durationMs / 100) / 10;
    return failure(event, handler, result, "timeout", `It did not finish within ${seconds} s.`);
  }
  if (run.aborted) return { ...result, outcome: "error", message: "Stopped with the turn." };

  const json = readJson(run.stdout);
  if (run.exitCode === 2 && event === "PermissionRequest") {
    // "Claude Code doesn't read exit code 2 as a decision on this event."
    const said = shortReason(run.stderr);
    return {
      ...result,
      outcome: "error",
      message: shortLine(
        `Exit code 2 does not answer a permission request; the prompt is shown as usual.${said === null ? "" : ` ${said}`}`,
      ),
    };
  }
  if (run.exitCode === 2) {
    // Exit 2 blocks even when standard output is JSON; its reason, if it gives one, wins.
    let reason = shortReason(run.stderr);
    let applied = result;
    if (json !== "none" && json !== "invalid") {
      applied = applyJson(event, json, result);
      reason = applied.reason ?? reason;
      // On Stop, `continue: false` takes precedence over exit 2: the turn ends.
      if ((event === "Stop" || event === "SubagentStop") && applied.stop !== null) return applied;
    }
    return block(event, { ...applied, outcome: result.outcome }, reason);
  }
  if (run.exitCode !== 0) {
    const said = shortReason(run.stderr) ?? shortReason(run.stdout) ?? "";
    return failure(
      event,
      handler,
      result,
      "error",
      `Failed with non-blocking status code ${run.exitCode ?? "(none)"}${said === "" ? "" : `: ${said}`}`,
    );
  }
  if (json === "invalid") {
    return failure(event, handler, result, "error", "It printed JSON that could not be read.");
  }
  if (json === "none") return plainOutput(event, result, run.stdout);
  return applyJson(event, json, result);
}

/** Plain text on exit 0: context where the event takes it, otherwise nothing. */
function plainOutput(event: string, result: HandlerResult, stdout: string): HandlerResult {
  const text = stdout.trim();
  if (text !== "" && PLAIN_OUTPUT_IS_CONTEXT.has(event)) {
    return { ...result, context: [capText(text)] };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The other handler types
// ---------------------------------------------------------------------------------------------

/** A run of an `http`, `mcp_tool`, `prompt` or `agent` handler, reduced to what decides it. */
export type HandlerRun =
  /**
   * An answer read like a command's standard output on exit 0: an http response body (2xx) or
   * an MCP tool's text. For http, text that is not a JSON object is a non-blocking error and
   * is not used; for mcp_tool it is plain output.
   */
  | { kind: "output"; from: "http" | "mcp_tool"; text: string; durationMs: number }
  /** It failed: the request, the connection, the server, the tool, the model's answer. */
  | { kind: "failed"; outcome: "error" | "timeout"; detail: string; durationMs: number }
  /** Stopped with the turn or the session. */
  | { kind: "aborted"; durationMs: number }
  /** A prompt or agent hook's answer. `impossible` only counts for prompt hooks on Stop. */
  | { kind: "verdict"; ok: boolean; reason: string | null; impossible: boolean; durationMs: number }
  /** It did not run, and says why (an agent hook on PermissionRequest, an address not allowed). */
  | { kind: "skipped"; detail: string; durationMs: number };

/** What one finished run of a non-command handler means. Pure. */
export function interpretHandler(
  event: string,
  handler: HookHandler,
  run: HandlerRun,
): HandlerResult {
  const result = blank({ exitCode: null, durationMs: run.durationMs });
  switch (run.kind) {
    case "aborted":
      return { ...result, outcome: "error", message: "Stopped with the turn." };
    case "skipped":
      return { ...result, message: shortLine(run.detail) };
    case "failed":
      return failure(event, handler, result, run.outcome, run.detail);
    case "verdict":
      return verdict(event, handler, result, run);
    case "output": {
      const json = readJson(run.text);
      if (json === "invalid") {
        return failure(
          event,
          handler,
          result,
          "error",
          "It answered with JSON that could not be read.",
        );
      }
      if (json === "none") {
        if (run.text.trim() === "") return result;
        if (run.from === "http") {
          return failure(
            event,
            handler,
            result,
            "error",
            "It answered with text that is not a JSON object, so the answer was not used.",
          );
        }
        // "With "block" set on an event such as PreToolUse or UserPromptSubmit, a non-empty
        // answer also counts" as a failure.
        if (handler.onFailure === "block" && CAN_BLOCK.has(event)) {
          return failure(
            event,
            handler,
            result,
            "error",
            `The tool answered: ${shortLine(run.text) ?? ""}`,
          );
        }
        return plainOutput(event, result, run.text);
      }
      if (run.from === "mcp_tool" && handler.onFailure === "block" && CAN_BLOCK.has(event)) {
        const fields = Object.keys(json).filter((k) => k !== "reason");
        if (Object.keys(json).length > 0 && fields.length === 0) {
          return failure(
            event,
            handler,
            result,
            "error",
            `The tool answered: ${shortLine(run.text) ?? ""}`,
          );
        }
      }
      return applyJson(event, json, result);
    }
  }
}

/**
 * A prompt or agent hook's `{ ok, reason }` on `event` (reference, "Response schema"). An agent
 * hook's `ok: false` is handled "the same way as a prompt hook with `continueOnBlock: true`".
 */
function verdict(
  event: string,
  handler: HookHandler,
  result: HandlerResult,
  run: Extract<HandlerRun, { kind: "verdict" }>,
): HandlerResult {
  const reason = run.reason === null ? null : capText(run.reason);
  const said = { ...result, message: shortLine(reason) };
  if (run.ok) {
    // On PermissionRequest `ok: true` grants the request; elsewhere it lets the action go on.
    return event === "PermissionRequest" ? { ...said, decision: "allow" } : said;
  }
  const feedBack = handler.type === "agent" || handler.continueOnBlock;
  const blocked = (fields: Partial<HandlerResult>): HandlerResult => ({
    ...said,
    outcome: "blocked",
    reason,
    ...fields,
  });
  switch (event) {
    case "Stop":
    case "SubagentStop":
      // `impossible` lets the turn end instead of feeding the reason back (prompt hooks only).
      if (run.impossible && handler.type === "prompt") return said;
      return blocked({ decision: "block" });
    case "PreToolUse":
      return feedBack
        ? blocked({ decision: "deny" })
        : blocked({ decision: "deny", stop: { reason } });
    case "PostToolUse":
      return feedBack ? blocked({ decision: "block" }) : blocked({ stop: { reason } });
    case "UserPromptSubmit":
    case "UserPromptExpansion":
    case "PostToolUseFailure":
    // PostToolBatch: "The turn ends and the reason appears as a warning line."
    case "PostToolBatch":
      return blocked({ decision: "block" });
    default:
      // PermissionRequest: "`ok: false` doesn't deny the request"; the prompt is shown.
      return said;
  }
}

function shortReason(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : capText(trimmed);
}
