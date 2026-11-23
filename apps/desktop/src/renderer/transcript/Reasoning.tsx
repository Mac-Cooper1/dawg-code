import { memo, useId } from "react";
import { formatDuration } from "../lib/format.ts";
import type { ReasoningItem } from "../state/types.ts";
import { Icon, Spinner } from "../ui/index.ts";
import type { TranscriptEnv } from "./env.ts";
import styles from "./Reasoning.module.css";

export function reasoningLabel(item: ReasoningItem): string {
  if (item.streaming) return "Thinking…";
  if (item.durationMs !== null) return `Thought for ${formatDuration(item.durationMs)}`;
  return "Reasoning";
}

/** A reply's reasoning, folded to "Thought for 5 s" unless the person opens it. */
export const Reasoning = memo(function Reasoning({
  item,
  open,
  env,
}: {
  item: ReasoningItem;
  open: boolean;
  env: TranscriptEnv;
}) {
  const bodyId = useId();
  return (
    <div className={styles.reasoning}>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => env.setItemOpen(item.id, !open)}
      >
        {item.streaming ? (
          <span className={styles.spinnerBox}>
            <Spinner size={11} />
          </span>
        ) : (
          <Icon
            name="chevron-right"
            size={14}
            className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
          />
        )}
        {reasoningLabel(item)}
      </button>
      {open && (
        <div id={bodyId} className={styles.body}>
          {item.text}
        </div>
      )}
    </div>
  );
});
