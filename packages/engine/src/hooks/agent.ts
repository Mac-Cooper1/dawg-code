/**
 * Runs one `agent` hook handler (code.claude.com/docs/en/hooks, "Agent-based hooks"): a subagent
 * that can only read (Read, Grep, Glob) gets the handler's prompt with the hook input, works for
 * up to `AGENT_HOOK_TURNS` model requests, and ends with the same `{ "ok": ..., "reason": ... }`
 * answer a prompt hook gives (./prompt.ts).
 *
 * The subagent is started through the session's subagents (../agents), so it takes a model slot
 * like any other agent, waits as queued when there is none, and its transcript can be opened.
 */
import { untilAborted } from "./abort.ts";
import type { HandlerRun } from "./output.ts";
import { promptWithInput, verdictRun } from "./prompt.ts";

/** "After up to 50 turns, the subagent returns a structured { "ok": true/false } decision." */
export const AGENT_HOOK_TURNS = 50;

/** The tools an agent hook's subagent may use. */
export const AGENT_HOOK_TOOLS = ["Read", "Grep", "Glob"] as const;

/** What an agent hook runs on: the session's subagents. */
export interface HookAgents {
  /**
   * Runs a read-only check as a subagent and resolves with its final message, or with why it
   * could not run. Rejects only when `signal` aborts.
   */
  check(task: {
    /** One line for people: "PreToolUse hook check". */
    description: string;
    prompt: string;
    maxTurns: number;
    turnId: string | null;
    toolCallId: string | null;
    signal: AbortSignal;
  }): Promise<{ text: string } | { error: string }>;
}

/** What the subagent is told after the hook's own prompt. */
const ANSWER_RULE =
  'When you have decided, end with a final message that is only a JSON object: {"ok": true} when the condition is met and the action may go ahead, or {"ok": false, "reason": "..."} when it is not, with a short reason addressed to the main assistant. Only read; change nothing.';

export interface AgentHookSpec {
  event: string;
  prompt: string;
  /** The hook input as JSON. */
  input: string;
  agents: HookAgents | null;
  timeoutMs: number;
  turnId: string | null;
  toolCallId: string | null;
  signal?: AbortSignal;
  now?: () => number;
}

export async function runAgentHook(spec: AgentHookSpec): Promise<HandlerRun> {
  const now = spec.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  if (spec.agents === null) {
    return {
      kind: "failed",
      outcome: "error",
      detail: "Subagents are not available in this session, so the agent hook cannot run.",
      durationMs: 0,
    };
  }
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), Math.max(1, spec.timeoutMs));
  timeout.unref?.();
  const signal =
    spec.signal === undefined ? timer.signal : AbortSignal.any([timer.signal, spec.signal]);
  try {
    const result = await untilAborted(
      spec.agents.check({
        description: `${spec.event} hook check`,
        prompt: `${promptWithInput(spec.prompt, spec.input)}\n\n${ANSWER_RULE}`,
        maxTurns: AGENT_HOOK_TURNS,
        turnId: spec.turnId,
        toolCallId: spec.toolCallId,
        signal,
      }),
      signal,
    );
    if (spec.signal?.aborted === true) return { kind: "aborted", durationMs: elapsed() };
    if (timer.signal.aborted) throw new Error("timed out");
    if ("error" in result) {
      return { kind: "failed", outcome: "error", detail: result.error, durationMs: elapsed() };
    }
    return verdictRun(result.text, elapsed());
  } catch (error) {
    if (spec.signal?.aborted === true) return { kind: "aborted", durationMs: elapsed() };
    if (timer.signal.aborted) {
      return {
        kind: "failed",
        outcome: "timeout",
        detail: `The agent did not finish within ${Math.round(spec.timeoutMs / 100) / 10} s.`,
        durationMs: elapsed(),
      };
    }
    return {
      kind: "failed",
      outcome: "error",
      detail: `The agent failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
