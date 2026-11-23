import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { TextWithCode } from "../markdown/index.ts";
import { Icon, type IconName } from "../ui/index.ts";
import styles from "./DecisionCard.module.css";
import { type CardShortcuts, handleCardKey } from "./keys.ts";

export interface DecisionFrameProps {
  icon: IconName;
  /** The header bar's text: "Permission needed". */
  heading: string;
  /** Right side of the header: the tool name, the question's label, the plan's path. */
  aside?: ReactNode;
  /** Accessible name of the card. */
  label: string;
  /** Null while the card is read-only (shown again after it was answered). */
  shortcuts: CardShortcuts | null;
  readOnly?: boolean;
  children: ReactNode;
}

/**
 * The frame every decision card shares: an amber border and header bar, and keyboard shortcuts
 * that work only while focus is inside the card. The listener is native so it can stop Escape
 * before the window's own handler (which would interrupt the turn) sees it.
 */
export function DecisionFrame({
  icon,
  heading,
  aside,
  label,
  shortcuts,
  readOnly = false,
  children,
}: DecisionFrameProps) {
  const ref = useRef<HTMLElement>(null);
  const latest = useRef(shortcuts);
  useLayoutEffect(() => {
    latest.current = shortcuts;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (latest.current) handleCardKey(event, latest.current);
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <section
      ref={ref}
      className={readOnly ? `${styles.card} ${styles.readOnly}` : styles.card}
      aria-label={label}
      data-read-only={readOnly ? "true" : undefined}
    >
      <div className={styles.header}>
        <Icon name={icon} size={14} />
        <span>{heading}</span>
        <span className={styles.grow} />
        {aside}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

/** The one-line record an answered card leaves, with "Show the card again". */
export function DecisionRecord({
  icon,
  text,
  shown,
  onShowAgain,
}: {
  icon: IconName;
  text: string;
  shown: boolean;
  onShowAgain(shown: boolean): void;
}) {
  return (
    <div className={styles.record}>
      <Icon name={icon} size={14} />
      <span className={styles.recordText}>
        <TextWithCode text={text} />
      </span>
      <button
        type="button"
        className={styles.link}
        aria-expanded={shown}
        onClick={() => onShowAgain(!shown)}
      >
        {shown ? "Hide the card" : "Show the card again"}
      </button>
    </div>
  );
}

/**
 * Focuses `target` once, when the card first appears pending and the composer is empty, so ⏎,
 * ⌘⏎ and esc answer it straight away. Later changes never move focus again.
 */
export function useFocusOnAppear(
  target: RefObject<HTMLElement | null>,
  shouldFocus: boolean,
): void {
  const initial = useRef(shouldFocus);
  useEffect(() => {
    if (!initial.current) return;
    initial.current = false;
    target.current?.focus({ preventScroll: true });
  }, [target]);
}
