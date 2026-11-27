/**
 * A call that runs a subagent (`Agent`, a `SendMessage` to one, or a skill that runs forked): the
 * agent's type and task in the header, how it is doing on the line under it (queued with its
 * place in line, running with what it does now and its tool uses, done, failed with the error,
 * stopped), how it runs (in the background, in a worktree), and its final message as Markdown.
 * "Open transcript" shows everything the agent did, read-only, in place of this session's.
 */
import { memo, useId } from "react";
import { agentName, agentPlacement, agentStatusText, agentTitle } from "../lib/agents.ts";
import { formatDuration } from "../lib/format.ts";
import { Markdown } from "../markdown/index.ts";
import type { ToolCallItem } from "../state/types.ts";
import { Icon, Spinner } from "../ui/index.ts";
import styles from "./AgentCard.module.css";
import { agentCallProblem, agentMessage } from "./agentInfo.ts";
import type { TranscriptEnv } from "./env.ts";
import { useNow } from "./hooks.ts";

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The header's first column before the engine has said anything about the agent. */
function nameFromInput(item: ToolCallItem): string {
  if (item.toolName === "SendMessage") return "Message to an agent";
  if (item.toolName === "Agent") {
    return agentName(stringInput(item.input, "subagent_type") ?? "general-purpose");
  }
  return item.toolName;
}

/** The status line before the engine has said anything about the agent. */
function statusFromCall(item: ToolCallItem): string {
  switch (item.state) {
    case "running":
      return "Starting…";
    case "success":
      return "Done";
    case "interrupted":
      return "Stopped";
    case "denied":
      return "Not allowed";
    default:
      return "Could not start the agent";
  }
}

function Mark({ item }: { item: ToolCallItem }) {
  const status = item.agent?.status;
  if (status === "running" || (status === undefined && item.state === "running")) {
    return (
      <span className={styles.spinnerBox}>
        <Spinner size={12} />
      </span>
    );
  }
  if (status === "completed") return <Icon name="check" className={styles.ok} />;
  if (status === "failed") return <Icon name="alert" className={styles.bad} />;
  if (status === "stopped") return <Icon name="stop" size={12} className={styles.icon} />;
  if (status === "queued") return <Icon name="clock" className={styles.icon} />;
  return <Icon name="branch" className={styles.icon} />;
}

export interface AgentCardProps {
  item: ToolCallItem;
  open: boolean;
  env: TranscriptEnv;
}

export const AgentCard = memo(function AgentCard({ item, open, env }: AgentCardProps) {
  const { agent } = item;
  const bodyId = useId();
  const active = agent ? agent.status === "running" || agent.status === "queued" : false;
  const now = useNow(active);
  const name = agent ? agentName(agent.agentType) : nameFromInput(item);
  const task =
    agent?.description.trim() ||
    stringInput(item.input, "description") ||
    (item.toolName === "SendMessage" ? (stringInput(item.input, "to") ?? "") : "");
  const status = agent ? agentStatusText(agent) : statusFromCall(item);
  const placement = agent ? agentPlacement(agent) : null;
  const time =
    agent && agent.status === "running" ? formatDuration(Math.max(0, now - agent.startedAt)) : null;
  const message = agentMessage(item);
  const failed = agent?.status === "failed";
  const callProblem = agentCallProblem(item);
  const title = agent ? agentTitle(agent) : [name, task].filter(Boolean).join(": ");
  const tone =
    agent?.status === "failed" ? "bad" : agent?.status === "completed" ? "ok" : "neutral";

  return (
    <div
      className={styles.card}
      data-state={agent?.status ?? item.state}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className={styles.header}
        aria-label={[title, status, time].filter(Boolean).join(", ")}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => env.setItemOpen(item.id, !open)}
      >
        <Mark item={item} />
        <span className={styles.name}>{name}</span>
        <span className={styles.task} title={task}>
          {task}
        </span>
        {time !== null && <span className={styles.meta}>{time}</span>}
        <Icon
          name="chevron-right"
          size={14}
          className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
        />
      </button>
      <div className={styles.statusRow}>
        <span className={styles.status} data-tone={tone}>
          {status}
        </span>
        {placement !== null && <span className={styles.placement}>{placement}</span>}
        <span className={styles.grow} />
        {agent && env.openSubagent && (
          <button
            type="button"
            className={styles.link}
            data-agent-id={agent.agentId}
            aria-label={`Open the transcript of ${agentTitle(agent)}`}
            onClick={() => env.openSubagent?.(agent.agentId)}
          >
            Open transcript
          </button>
        )}
      </div>
      {open && (
        <div id={bodyId} className={styles.body}>
          {failed && agent?.error ? (
            <p className={styles.error}>{agent.error.message}</p>
          ) : message !== null ? (
            <div className={styles.message}>
              <Markdown text={message} streaming={false} onOpenLink={env.openLink} />
            </div>
          ) : callProblem !== "" ? (
            <p className={styles.error}>{callProblem}</p>
          ) : (
            <p className={styles.placeholder}>
              {agent?.status === "stopped"
                ? "It stopped before it had a final message."
                : "Its final message shows here when it finishes."}
            </p>
          )}
        </div>
      )}
    </div>
  );
});
