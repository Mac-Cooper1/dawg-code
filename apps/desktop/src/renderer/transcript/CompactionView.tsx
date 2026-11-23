import { memo, useId } from "react";
import { formatTokens } from "../lib/format.ts";
import { Markdown } from "../markdown/index.ts";
import type { CompactionItem } from "../state/types.ts";
import { Icon, Spinner } from "../ui/index.ts";
import styles from "./Divider.module.css";
import type { TranscriptEnv } from "./env.ts";

export function compactionLabel(item: CompactionItem): string {
  switch (item.state) {
    case "running":
      return "Compacting the conversation…";
    case "completed": {
      const lead = item.trigger === "auto" ? "Compacted automatically" : "Conversation compacted";
      if (item.contextAfter === null) return lead;
      return `${lead} · ${formatTokens(item.contextBefore)} → ${formatTokens(item.contextAfter)} tokens`;
    }
    case "failed":
      return item.error ? `Compaction failed: ${item.error.message}` : "Compaction failed";
    case "interrupted":
      return "Compaction stopped";
  }
}

/**
 * Compaction as a divider: a spinner while it runs, then the token counts before and after. The
 * label opens the summary that replaced the earlier conversation (or a failure's detail).
 */
export const CompactionView = memo(function CompactionView({
  item,
  open,
  env,
}: {
  item: CompactionItem;
  open: boolean;
  env: TranscriptEnv;
}) {
  const bodyId = useId();
  const label = compactionLabel(item);
  const failed = item.state === "failed";
  const detail = failed ? (item.error?.detail ?? null) : item.summary;
  const className = failed ? `${styles.divider} ${styles.error}` : styles.divider;
  if (item.state === "running" || !detail) {
    return (
      <div className={className}>
        <span className={styles.label}>
          {item.state === "running" && <Spinner size={11} />}
          {label}
        </span>
      </div>
    );
  }
  return (
    <div>
      <div className={className}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => env.setItemOpen(item.id, !open)}
        >
          <Icon
            name="chevron-right"
            size={12}
            className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
          />
          {label}
        </button>
      </div>
      {open && (
        <div id={bodyId} className={styles.summary}>
          {failed ? (
            <pre className={styles.summaryError}>{detail}</pre>
          ) : (
            <Markdown text={detail} onOpenLink={env.openLink} />
          )}
        </div>
      )}
    </div>
  );
});
