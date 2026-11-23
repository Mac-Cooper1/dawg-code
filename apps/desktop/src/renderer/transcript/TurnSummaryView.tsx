import { memo } from "react";
import { formatDuration } from "../lib/format.ts";
import type { TurnSummaryItem } from "../state/types.ts";
import styles from "./Divider.module.css";

/** "48 s · 6 model requests · 92% of the prompt read from cache", leaving out unknown parts. */
export function turnSummaryText(item: TurnSummaryItem): string {
  const parts = [formatDuration(item.durationMs)];
  if (item.modelRequests !== null) {
    parts.push(`${item.modelRequests} model ${item.modelRequests === 1 ? "request" : "requests"}`);
  }
  if (item.cachedPercent !== null) {
    parts.push(`${Math.round(item.cachedPercent)}% of the prompt read from cache`);
  }
  if (item.stopReason === "turn_limit") parts.push("stopped at the turn limit");
  return parts.join(" · ");
}

/** The small meta line under a finished turn. */
export const TurnSummaryView = memo(function TurnSummaryView({ item }: { item: TurnSummaryItem }) {
  return <p className={styles.turnMeta}>{turnSummaryText(item)}</p>;
});
