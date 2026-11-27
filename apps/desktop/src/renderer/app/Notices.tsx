import { useEffect, useRef } from "react";
import type { ConnectionState, Notice } from "../state/types.ts";
import { focusIsLost, focusMessageField } from "../ui/focus.ts";
import { Button, Icon, IconButton, Spinner } from "../ui/index.ts";
import styles from "./Notices.module.css";

export interface NoticesProps {
  notices: readonly Notice[];
  /** The engine connection; left out where the engine does not matter (first run, Settings). */
  connection?: ConnectionState;
  onDismiss(id: string): void;
}

/** A quiet line while the engine connects or restarts; null when there is nothing to say. */
function connectionLine(connection: ConnectionState): Notice | null {
  switch (connection.phase) {
    case "connecting":
      return { id: "connection", text: "Connecting to the engine…", tone: "neutral" };
    case "restarting":
      return { id: "connection", text: "The engine is restarting…", tone: "neutral" };
    case "failed":
      return { id: "connection", text: connection.message, tone: "error" };
    case "ready":
      return null;
  }
}

/**
 * One-line notices under the title bar: the engine connection while it is not ready, then the
 * notices from the store, each dismissible. A failed connection cannot be dismissed: nothing can
 * be sent until it is fixed.
 *
 * The live region stays on the page while it is empty, so VoiceOver reads a notice as it arrives
 * (a region that appears together with its text is often not read). Dismissing a notice from the
 * keyboard moves focus to the next notice's Dismiss, or else to the message field.
 */
export function Notices(props: NoticesProps) {
  const connection = props.connection ? connectionLine(props.connection) : null;
  const region = useRef<HTMLDivElement>(null);
  /** The position of the notice just dismissed, while focus should follow it. */
  const dismissedAt = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the dismissed notice has gone
  useEffect(() => {
    const at = dismissedAt.current;
    if (at === null) return;
    dismissedAt.current = null;
    if (!focusIsLost()) return;
    const buttons = region.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    const next = buttons[Math.min(at, buttons.length - 1)];
    if (next) next.focus();
    else focusMessageField();
  }, [props.notices]);

  return (
    <div ref={region} className={styles.notices} aria-live="polite">
      {connection && (
        <p
          className={styles.notice}
          data-tone={connection.tone}
          role={connection.tone === "error" ? "alert" : undefined}
        >
          {connection.tone === "error" ? <Icon name="alert" size={14} /> : <Spinner size={12} />}
          <span className={styles.text}>{connection.text}</span>
        </p>
      )}
      {props.notices.map((notice, index) => (
        <p
          key={notice.id}
          className={styles.notice}
          data-tone={notice.tone}
          role={notice.tone === "error" ? "alert" : undefined}
        >
          {notice.tone === "error" && <Icon name="alert" size={14} />}
          <span className={styles.text}>{notice.text}</span>
          {notice.action && (
            <Button
              variant="ghost"
              size="sm"
              className={styles.action}
              onClick={() => {
                notice.action?.run();
                props.onDismiss(notice.id);
              }}
            >
              {notice.action.label}
            </Button>
          )}
          <IconButton
            icon="close"
            size="sm"
            label="Dismiss"
            onClick={() => {
              dismissedAt.current = index;
              props.onDismiss(notice.id);
            }}
          />
        </p>
      ))}
    </div>
  );
}
