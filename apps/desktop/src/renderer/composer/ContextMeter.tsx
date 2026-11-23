import { Popover } from "radix-ui";
import { useId, useState } from "react";
import menu from "../app/menu.module.css";
import { formatTokens } from "../lib/format.ts";
import type { ContextMeterView } from "../state/types.ts";
import { Button } from "../ui/index.ts";
import styles from "./Composer.module.css";
import {
  compactLine,
  contextHeading,
  contextLabel,
  contextSegments,
  lastRequestLine,
  RING_CIRCUMFERENCE,
} from "./contextMeter.ts";

const SWATCH_CLASS = {
  cached: styles.swatchCached,
  rest: styles.swatchUsed,
  used: styles.swatchUsed,
  free: styles.swatchFree,
} as const;

/** The ring that fills as the context fills. */
function Ring(props: { fraction: number }) {
  const filled = Math.min(1, Math.max(0, props.fraction)) * RING_CIRCUMFERENCE;
  return (
    <svg className={styles.ring} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <circle className={styles.ringTrack} cx="9" cy="9" r="7" />
      <circle
        className={styles.ringValue}
        cx="9"
        cy="9"
        r="7"
        strokeDasharray={`${filled} ${RING_CIRCUMFERENCE}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

/**
 * The context meter pill ("74.2K / 204.8K") and its popover: how full the context is, what the
 * last request read from the cache, its speeds, when compaction starts, and Compact now.
 */
export function ContextMeter(props: {
  context: ContextMeterView;
  disabled?: boolean;
  onCompact(): void;
}) {
  const { context } = props;
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const segments = contextSegments(context);
  const lastLine = lastRequestLine(context);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={props.disabled}>
        <button
          type="button"
          className={styles.pill}
          aria-label={`Context used: ${contextLabel(context)}`}
        >
          <Ring fraction={context.fraction} />
          {contextLabel(context)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`${menu.content} ${styles.contextPopover}`}
          side="top"
          align="end"
          sideOffset={8}
          aria-labelledby={headingId}
        >
          <div id={headingId} className={menu.label}>
            {contextHeading(context)}
          </div>
          <div className={styles.stack} aria-hidden="true">
            {segments
              .filter((segment) => segment.key !== "free")
              .map((segment) => (
                <span
                  key={segment.key}
                  className={`${styles.stackPart} ${SWATCH_CLASS[segment.key]}`}
                  style={{ width: `${segment.share * 100}%` }}
                />
              ))}
          </div>
          <dl className={styles.breakdown}>
            {segments.map((segment) => (
              <div key={segment.key} className={styles.breakdownRow}>
                <dt className={styles.breakdownLabel}>
                  <span className={`${styles.swatch} ${SWATCH_CLASS[segment.key]}`} />
                  {segment.label}
                </dt>
                <dd className={styles.breakdownValue}>{formatTokens(segment.tokens)}</dd>
              </div>
            ))}
          </dl>
          <div className={`${menu.footer} ${styles.contextFooter}`}>
            {lastLine && <p className={styles.contextLine}>{lastLine}</p>}
            <p className={styles.contextLine}>{compactLine(context)}</p>
            <Button
              kbd="/compact"
              disabled={context.compacting}
              onClick={() => {
                setOpen(false);
                props.onCompact();
              }}
            >
              {context.compacting ? "Compacting…" : "Compact now"}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
