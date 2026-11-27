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
 *   makes it do what exit 2 does (except on Stop).
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
  /** The line the person sees in `hook.ran`. */
  message: string | null;
}

/** Events whose plain standard output (exit 0) is context for the model. */
const PLAIN_OUTPUT_IS_CONTEXT = new Set(["UserPromptSubmit", "SessionStart"]);
/** Events exit 2 (and `onFailure: "block"`) can block. */
const CAN_BLOCK = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
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
    case "UserPromptSubmit":
    case "Stop":
    case "SubagentStop":
    case "PostToolUse":
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
  if (handler.onFailure !== "block" || FAILURE_NEVER_BLOCKS.has(event) || !CAN_BLOCK.has(event)) {
    return failed;
  }
  const what = outcome === "timeout" ? "timed out" : "failed";
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
  if (json.continue === false) out.stop = { reason: str(json.stopReason) };
  out.systemMessage = str(json.systemMessage);

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
  } else if (
    event === "PostToolUse" ||
    event === "UserPromptSubmit" ||
    event === "Stop" ||
    event === "SubagentStop"
  ) {
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

/** What one finished run of `handler` on `event` means. Pure. */
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
  if (json === "none") {
    const text = run.stdout.trim();
    if (text !== "" && PLAIN_OUTPUT_IS_CONTEXT.has(event)) {
      return { ...result, context: [capText(text)] };
    }
    return result;
  }
  return applyJson(event, json, result);
}

function shortReason(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : capText(trimmed);
}
