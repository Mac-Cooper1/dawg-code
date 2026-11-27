/**
 * How subagents are named and described in the UI: the Agent card in the transcript, the
 * agent's own transcript, the Tasks pane and a permission card an agent raised. Agent types are
 * Claude Code's documented ones ("Explore", "Plan", "general-purpose"), a custom agent's name,
 * or "fork".
 */
import type { SubagentInfo, SubagentLabel } from "@dawg/protocol";
import { formatDuration } from "./format.ts";

/** The tools whose calls start or continue a subagent's task. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "SendMessage"]);

/** "Explore agent", "General-purpose agent", "Forked agent", "code-reviewer agent". */
export function agentName(agentType: string): string {
  if (agentType === "fork") return "Forked agent";
  if (agentType === "general-purpose") return "General-purpose agent";
  return `${agentType} agent`;
}

/** "Explore agent: Find the config loader", or the name alone without a description. */
export function agentTitle(agent: Pick<SubagentLabel, "agentType" | "description">): string {
  const description = agent.description.trim();
  const name = agentName(agent.agentType);
  return description === "" ? name : `${name}: ${description}`;
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function toolUses(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "tool use" : "tool uses"}`;
}

/**
 * One line on how the agent is doing: "Queued · next in line", "Running · Read src/a.ts · 3
 * tool uses", "Done · 5 tool uses · 12 s", "Failed: the model stopped responding", "Stopped".
 */
export function agentStatusText(agent: SubagentInfo): string {
  const ran =
    agent.endedAt !== null ? formatDuration(Math.max(0, agent.endedAt - agent.startedAt)) : null;
  switch (agent.status) {
    case "queued":
      if (agent.queuePosition === null) return "Queued · waits for the model";
      return agent.queuePosition === 1
        ? "Queued · next in line for the model"
        : `Queued · ${ordinal(agent.queuePosition)} in line for the model`;
    case "running":
      return ["Running", agent.activity, toolUses(agent.toolUses)].filter(Boolean).join(" · ");
    case "completed":
      return ["Done", toolUses(agent.toolUses), ran].filter(Boolean).join(" · ");
    case "failed":
      return agent.error ? `Failed: ${agent.error.message.replace(/\.$/, "")}` : "Failed";
    case "stopped":
      return ["Stopped", toolUses(agent.toolUses), ran].filter(Boolean).join(" · ");
  }
}

/** A queued or running agent can be stopped. */
export function agentActive(agent: Pick<SubagentInfo, "status">): boolean {
  return agent.status === "queued" || agent.status === "running";
}

/** "In the background", "In a worktree on dawg/agent-1": how it runs, or null when plainly. */
export function agentPlacement(agent: SubagentInfo): string | null {
  const parts: string[] = [];
  if (agent.fork) parts.push("Started from a copy of this conversation");
  if (agent.background) parts.push("In the background");
  if (agent.worktree) parts.push(`In a worktree on ${agent.worktree.branch}`);
  return parts.length === 0 ? null : parts.join(" · ");
}
