/**
 * What an agent card shows, worked out from the tool item alone: whether a call is drawn as one,
 * the agent's final message for the card's task, and whether the card starts open. Pure, so the
 * rules are tested without rendering.
 */
import { AGENT_TOOLS } from "../lib/agents.ts";
import type { ToolCallItem } from "../state/types.ts";

/** Whether a tool item is drawn as an agent card rather than a plain tool card. */
export function isAgentCall(item: ToolCallItem): boolean {
  return item.agent !== undefined || AGENT_TOOLS.has(item.toolName);
}

function resultText(item: ToolCallItem): string {
  return (item.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/**
 * The agent's final message for this card's task: what the engine reported, or the call's
 * result for an agent the parent waited on. A background agent's call returns at once with a
 * note, which is not the agent's answer.
 */
export function agentMessage(item: ToolCallItem): string | null {
  const agent = item.agent;
  if (agent?.result) return agent.result;
  if (item.state !== "success") return null;
  const background = agent?.background ?? item.input.run_in_background === true;
  if (background) return null;
  const text = resultText(item);
  return text === "" ? null : text;
}

/** Why the call itself failed (it was refused, invalid or stopped before an agent ran), or "". */
export function agentCallProblem(item: ToolCallItem): string {
  if (item.agent !== undefined || item.state === "running" || item.state === "success") return "";
  return resultText(item);
}

/** An agent card opens by itself once there is something to read: a final message or an error. */
export function agentHasOutcome(item: ToolCallItem): boolean {
  if (item.agent?.status === "failed") return true;
  if (item.agent === undefined && item.state !== "running" && item.state !== "success") return true;
  return agentMessage(item) !== null;
}
