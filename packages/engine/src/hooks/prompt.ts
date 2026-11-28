/**
 * Runs one `prompt` hook handler (code.claude.com/docs/en/hooks, "Prompt-based hooks"): a single
 * request to a local model with the handler's prompt, `$ARGUMENTS` replaced by the hook input,
 * whose JSON answer `{ "ok": true | false, "reason": ..., "impossible": ... }` decides.
 *
 * The request goes to the helper model when it is on, and to the session's model otherwise (the
 * session's utility model, ../model/side.ts); the handler's `model` names an Anthropic model and
 * is mapped, not obeyed (spec, principle 4). An answer that does not parse is a non-blocking
 * error. `agent` hooks (./agent.ts) share the prompt and the answer's shape.
 */
import type { UtilityModel } from "../contracts/web.ts";
import { untilAborted } from "./abort.ts";
import type { HandlerRun } from "./output.ts";

/** How the model is told to answer; the handler's prompt follows as the request. */
export const PROMPT_HOOK_SYSTEM = [
  "You check one event in a coding session for a hook the user set up. The user's message holds the hook's instructions and the event's details as JSON.",
  "Decide whether the condition or rule in the instructions is met, then answer with only a JSON object and nothing else:",
  '- {"ok": true} when the action may go ahead;',
  '- {"ok": false, "reason": "..."} when it should not, with a short reason addressed to the assistant;',
  '- add "impossible": true to an ok false answer only when the condition can never be met.',
].join("\n");

/** Most tokens the answer may take: it is one small JSON object. */
const MAX_ANSWER_TOKENS = 1024;

/**
 * The prompt with the hook input in place: each `$ARGUMENTS` is replaced, and `\$` stands for a
 * literal `$` ("`\$1.00` renders as `$1.00`"). Without `$ARGUMENTS` the input is appended.
 */
export function promptWithInput(prompt: string, input: string): string {
  let used = false;
  const text = prompt.replace(/\\\$|\$ARGUMENTS/g, (match) => {
    if (match === "\\$") return "$";
    used = true;
    return input;
  });
  return used ? text : `${text}\n\n${input}`;
}

export interface HookVerdict {
  ok: boolean;
  reason: string | null;
  impossible: boolean;
}

/**
 * The `{ ok, reason, impossible }` object in a model's answer, which may come wrapped in a code
 * fence or a sentence. Null when there is none.
 */
export function readVerdict(answer: string): HookVerdict | null {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/g, "");
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const m of text.matchAll(fenced)) candidates.push((m[1] ?? "").trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text.trim());
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const value = parsed as Record<string, unknown>;
    if (typeof value.ok !== "boolean") continue;
    const reason =
      typeof value.reason === "string" && value.reason.trim() !== "" ? value.reason.trim() : null;
    return { ok: value.ok, reason, impossible: value.impossible === true };
  }
  return null;
}

function shortAnswer(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

export interface PromptHookSpec {
  prompt: string;
  /** The hook input as JSON. */
  input: string;
  /** The helper model, or the session's; null when the session has none to lend. */
  model: UtilityModel | null;
  timeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export async function runPromptHook(spec: PromptHookSpec): Promise<HandlerRun> {
  const now = spec.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  if (spec.model === null) {
    return {
      kind: "failed",
      outcome: "error",
      detail: "There is no model to ask in this session.",
      durationMs: 0,
    };
  }
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), Math.max(1, spec.timeoutMs));
  timeout.unref?.();
  const signal =
    spec.signal === undefined ? timer.signal : AbortSignal.any([timer.signal, spec.signal]);
  try {
    const answer = await untilAborted(
      spec.model.complete({
        system: PROMPT_HOOK_SYSTEM,
        prompt: promptWithInput(spec.prompt, spec.input),
        maxOutputTokens: MAX_ANSWER_TOKENS,
        signal,
      }),
      signal,
    );
    return verdictRun(answer, elapsed());
  } catch (error) {
    if (spec.signal?.aborted === true) return { kind: "aborted", durationMs: elapsed() };
    if (timer.signal.aborted) {
      return {
        kind: "failed",
        outcome: "timeout",
        detail: `The model did not answer within ${Math.round(spec.timeoutMs / 100) / 10} s.`,
        durationMs: elapsed(),
      };
    }
    return {
      kind: "failed",
      outcome: "error",
      detail: `The model could not be asked: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** A model's answer as a run: its verdict, or a non-blocking error when it has none. */
export function verdictRun(answer: string, durationMs: number): HandlerRun {
  const verdict = readVerdict(answer);
  if (verdict === null) {
    const said = shortAnswer(answer);
    return {
      kind: "failed",
      outcome: "error",
      detail: `The model's answer was not the JSON the hook needs${said === "" ? " (it was empty)." : `: ${said}`}`,
      durationMs,
    };
  }
  return { kind: "verdict", ...verdict, durationMs };
}
