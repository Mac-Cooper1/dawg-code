import { formatNumber } from "../lib/format.ts";
import type { PromptProgressView } from "../state/types.ts";
import { Spinner } from "../ui/index.ts";
import styles from "./PromptProgress.module.css";

function percent(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(0, Math.min(100, (part / total) * 100)).toFixed(1)}%`;
}

/**
 * How far the model has read a long prompt: the cached part in blue, the part read so far in the
 * accent, and the read rate.
 */
export function PromptProgress({ progress }: { progress: PromptProgressView }) {
  const { total, cached, processed, tokensPerSecond, secondsLeft } = progress;
  const read = Math.max(0, processed - cached);
  const valueText = `${formatNumber(processed)} of ${formatNumber(total)} tokens`;
  return (
    <div className={styles.progress}>
      <div className={styles.line}>
        <Spinner size={12} />
        <span className={styles.label}>Reading the conversation · {valueText}</span>
        {secondsLeft !== null && secondsLeft > 0 && (
          <span className={styles.muted}>about {Math.max(1, Math.round(secondsLeft))} s</span>
        )}
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label="Reading the conversation"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(processed, total)}
        aria-valuetext={valueText}
      >
        <span
          className={styles.cached}
          style={{ width: percent(Math.min(cached, processed), total) }}
        />
        <span className={styles.read} style={{ width: percent(read, total) }} />
      </div>
      <div className={styles.detail}>
        {cached > 0 && (
          <>
            <span className={styles.cacheText}>{formatNumber(cached)} from cache</span>
            {" · "}
          </>
        )}
        {formatNumber(read)} read
        {tokensPerSecond !== null && tokensPerSecond > 0
          ? ` at ${formatNumber(tokensPerSecond)} tokens/s`
          : ""}
      </div>
    </div>
  );
}
