import type { TaskItem } from "@dawg/protocol";
import { memo, useId } from "react";
import type { TasksItem } from "../state/types.ts";
import { Icon } from "../ui/index.ts";
import type { TranscriptEnv } from "./env.ts";
import styles from "./TasksCard.module.css";
import toolStyles from "./ToolCard.module.css";

const STATUS_LABEL: Record<TaskItem["status"], string> = {
  completed: "Done: ",
  in_progress: "In progress: ",
  pending: "To do: ",
};

function TaskList({ tasks }: { tasks: readonly TaskItem[] }) {
  return (
    <ul className={styles.list}>
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
            <span className={styles.text}>
              <span className="vh">{STATUS_LABEL[task.status]}</span>
              {text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function doneLabel(tasks: readonly TaskItem[]): string {
  const done = tasks.filter((task) => task.status === "completed").length;
  return `${done} of ${tasks.length} done`;
}

export interface TasksCardProps {
  item: TasksItem;
  /** Its turn is still running: the list shows in full. */
  running: boolean;
  open: boolean;
  env: TranscriptEnv;
}

/**
 * The task list of a turn. While the turn runs it shows every task with its state; once the turn
 * has finished it folds to one line ("Tasks · 3 of 3 done") that opens to the list.
 */
export const TasksCard = memo(function TasksCard({ item, running, open, env }: TasksCardProps) {
  const bodyId = useId();
  if (running) {
    return (
      <section className={styles.card} aria-label="Tasks">
        <div className={styles.header}>
          <Icon name="tasks" />
          <span>Tasks</span>
          <span className={styles.count}>{doneLabel(item.tasks)}</span>
        </div>
        <TaskList tasks={item.tasks} />
      </section>
    );
  }
  return (
    <div className={toolStyles.card}>
      <button
        type="button"
        className={toolStyles.header}
        aria-label={`Tasks, ${doneLabel(item.tasks)}`}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => env.setItemOpen(item.id, !open)}
      >
        <Icon name="tasks" className={toolStyles.icon} />
        <span className={toolStyles.verb}>Tasks</span>
        <span className={styles.summary}>{doneLabel(item.tasks)}</span>
        <Icon
          name="chevron-right"
          size={14}
          className={open ? `${toolStyles.chevron} ${toolStyles.chevronOpen}` : toolStyles.chevron}
        />
      </button>
      {open && (
        <div id={bodyId} className={styles.foldedBody}>
          <TaskList tasks={item.tasks} />
        </div>
      )}
    </div>
  );
});
