import type { SubagentInfo } from "@dawg/protocol";
import { memo, useState } from "react";
import { agentActive, agentName, agentStatusText, agentTitle } from "../../lib/agents.ts";
import { Button, ConfirmDialog, Icon } from "../../ui/index.ts";
import styles from "./Tasks.module.css";

function StatusMark({ status }: { status: SubagentInfo["status"] }) {
  return (
    <span className={styles.mark} data-status={status} aria-hidden="true">
      {status === "running" && <span className={styles.spin} />}
      {status === "queued" && <Icon name="clock" size={14} />}
      {status === "completed" && <Icon name="check" size={14} />}
      {status === "failed" && <Icon name="alert" size={14} />}
      {status === "stopped" && <Icon name="stop" size={12} />}
    </span>
  );
}

export interface AgentRowProps {
  agent: SubagentInfo;
  onOpen(agentId: string): void;
  onStop(agentId: string): void;
}

/** One background agent: its type and task, how it is doing, Open and (while it works) Stop. */
export const AgentRow = memo(function AgentRow({ agent, onOpen, onStop }: AgentRowProps) {
  const [confirming, setConfirming] = useState(false);
  const title = agentTitle(agent);
  const description = agent.description.trim();
  return (
    <li className={styles.command} aria-label={title}>
      <div className={styles.row}>
        <StatusMark status={agent.status} />
        <div className={styles.info}>
          <span className={styles.agentText} title={title}>
            <span className={styles.agentType}>{agentName(agent.agentType)}</span>
            {description !== "" && ` · ${description}`}
          </span>
          <span className={styles.meta} data-status={agent.status}>
            <span className={styles.status}>{agentStatusText(agent)}</span>
            {agent.worktree !== null && ` · worktree ${agent.worktree.branch}`}
          </span>
        </div>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.actionButton}
            aria-label={`Open the transcript of ${title}`}
            onClick={() => onOpen(agent.agentId)}
          >
            Open
          </Button>
          {agentActive(agent) && (
            <Button
              variant="danger"
              size="sm"
              className={styles.actionButton}
              aria-label={`Stop ${title}`}
              onClick={() => setConfirming(true)}
            >
              Stop
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Stop “${title}”?`}
        confirmLabel="Stop the agent"
        destructive
        onConfirm={() => onStop(agent.agentId)}
      >
        <p>
          The agent ends its work where it is. dawg sees that it was stopped, and what it found so
          far stays in its transcript.
        </p>
      </ConfirmDialog>
    </li>
  );
});
