import { Popover } from "radix-ui";
import { useId, useState } from "react";
import menu from "../app/menu.module.css";
import { formatPercent, formatTokens } from "../lib/format.ts";
import type { ContextMeterView } from "../state/types.ts";
import { Button } from "../ui/index.ts";
import styles from "./Composer.module.css";
import {
  compactLine,
  compactMarker,
  contextHeading,
  contextLabel,
  contextSegments,
  lastRequestLine,
  RING_CIRCUMFERENCE,
} from "./contextMeter.ts";

const SWATCH_CLASS = {
  systemPrompt: styles.swatchSystem,
  instructions: styles.swatchInstructions,
  tools: styles.swatchTools,
  messages: styles.swatchMessages,
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

/** What VoiceOver reads for the pill: "Context used: 74.2K of 204.8K tokens, 36%". */
export function contextSpoken(context: ContextMeterView): string {
  return `${formatTokens(context.used)} of ${formatTokens(context.window)} tokens, ${formatPercent(context.fraction)}`;
}

/**
 * The context meter pill ("74.2K / 204.8K") and its popover: how full the context is and what
 * fills it (system prompt, instructions, tools, messages), with a mark where compaction starts
 * on its own; the last request's speeds and cache share; and Compact now.
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
  const compact = compactLine(context);
  const marker = compactMarker(context);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={props.disabled}>
        <button
          type="button"
          className={styles.pill}
          aria-label={`Context used: ${contextSpoken(context)}`}
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
          {/* A meter for VoiceOver; the coloured parts are spelled out in the list below. A <meter>
              element cannot hold the stacked parts and the compaction mark. */}
          {/* biome-ignore lint/a11y/useSemanticElements: see above */}
          <div
            className={styles.stackFrame}
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(1, Math.max(0, context.fraction)) * 100)}
            aria-valuetext={contextSpoken(context)}
          >
            <div className={styles.stack}>
              {segments
                .filter((segment) => segment.key !== "free" && segment.tokens > 0)
                .map((segment) => (
                  <span
                    key={segment.key}
                    aria-hidden="true"
                    className={`${styles.stackPart} ${SWATCH_CLASS[segment.key]}`}
                    style={{ width: `${segment.share * 100}%` }}
                  />
                ))}
            </div>
            {marker !== null && (
              <span
                aria-hidden="true"
                className={styles.compactMark}
                data-testid="compact-mark"
                style={{ left: `${marker * 100}%` }}
              />
            )}
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
            {compact && <p className={styles.contextLine}>{compact}</p>}
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
