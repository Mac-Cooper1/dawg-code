/**
 * The Tasks pane: dawg's task list, its background commands and its background agents, live. A
 * background command's output can be read (and followed while it runs), and a running one
 * stopped after a confirmation. An agent's transcript opens in place of the session's, and a
 * queued or running agent can be stopped the same way.
 */
import type { TaskItem } from "@dawg/protocol";
import { useCallback, useEffect, useId, useState } from "react";
import { run } from "../../app/run.ts";
import { selectTasksPane } from "../../state/selectors.ts";
import { useActions, useAppStore } from "../../state/store.ts";
import { Icon } from "../../ui/index.ts";
import { PaneEmpty } from "../PaneEmpty.tsx";
import type { PaneProps } from "../types.ts";
import { AgentRow } from "./AgentRow.tsx";
import { BackgroundRow } from "./BackgroundRow.tsx";
import styles from "./Tasks.module.css";

const STATUS_LABEL: Record<TaskItem["status"], string> = {
  completed: "Done: ",
  in_progress: "In progress: ",
  pending: "To do: ",
};

/** The time, ticking each second while `active`, for "Running for 12 s". */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function TaskList({ tasks }: { tasks: readonly TaskItem[] }) {
  const headingId = useId();
  const done = tasks.filter((task) => task.status === "completed").length;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.heading}>
        Task list · {done} of {tasks.length} done
      </h3>
      <ul className={styles.taskList}>
        {tasks.map((task, index) => {
          const text =
            task.status === "in_progress" ? (task.activeForm ?? task.content) : task.content;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on each update
              key={index}
              className={styles.task}
              data-status={task.status}
            >
              <span className={styles.box} aria-hidden="true">
                {task.status === "completed" && <Icon name="check" size={12} strokeWidth={2.2} />}
              </span>
              <span className={styles.taskText}>
                <span className="vh">{STATUS_LABEL[task.status]}</span>
                {text}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function TasksPane({ sessionId }: PaneProps) {
  const view = useAppStore((state) => selectTasksPane(state, sessionId));
  const actions = useActions();
  const headingId = useId();
  const agentsHeadingId = useId();
  const background = view?.background ?? [];
  const agents = view?.agents ?? [];
  const now = useClock(background.some((task) => task.status === "running"));
  const onStop = useCallback(
    (taskId: string) => run(actions.stopBackground(sessionId, taskId)),
    [actions, sessionId],
  );
  const onOpenAgent = useCallback(
    (agentId: string) => actions.openSubagent(sessionId, agentId),
    [actions, sessionId],
  );
  const onStopAgent = useCallback(
    (agentId: string) => run(actions.stopSubagent(sessionId, agentId)),
    [actions, sessionId],
  );

  if (!view || (view.tasks.length === 0 && background.length === 0 && agents.length === 0)) {
    return (
      <PaneEmpty pane="tasks" title="No tasks yet">
        When dawg works through a list of steps, or leaves a command or an agent running in the
        background, it shows here.
      </PaneEmpty>
    );
  }

  return (
    <div className={styles.pane}>
      {view.tasks.length > 0 && <TaskList tasks={view.tasks} />}
      <section className={styles.section} aria-labelledby={headingId}>
        <h3 id={headingId} className={styles.heading}>
          Background commands
        </h3>
        {background.length === 0 ? (
          <p className={styles.muted}>Nothing is running in the background.</p>
        ) : (
          <ul className={styles.card} aria-labelledby={headingId}>
            {background.map((task) => (
              <BackgroundRow
                key={task.taskId}
                sessionId={sessionId}
                task={task}
                now={now}
                read={actions.readBackgroundOutput}
                onStop={onStop}
              />
            ))}
          </ul>
        )}
      </section>
      {agents.length > 0 && (
        <section className={styles.section} aria-labelledby={agentsHeadingId}>
          <h3 id={agentsHeadingId} className={styles.heading}>
            Background agents
          </h3>
          <ul className={styles.card} aria-labelledby={agentsHeadingId}>
            {agents.map((agent) => (
              <AgentRow
                key={agent.agentId}
                agent={agent}
                onOpen={onOpenAgent}
                onStop={onStopAgent}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
