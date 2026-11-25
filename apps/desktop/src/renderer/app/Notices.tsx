import type { ConnectionState, Notice } from "../state/types.ts";
import { Icon, IconButton, Spinner } from "../ui/index.ts";
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
 */
export function Notices(props: NoticesProps) {
  const connection = props.connection ? connectionLine(props.connection) : null;
  if (!connection && props.notices.length === 0) return null;
  return (
    <div className={styles.notices} aria-live="polite">
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
      {props.notices.map((notice) => (
        <p
          key={notice.id}
          className={styles.notice}
          data-tone={notice.tone}
          role={notice.tone === "error" ? "alert" : undefined}
        >
          {notice.tone === "error" && <Icon name="alert" size={14} />}
          <span className={styles.text}>{notice.text}</span>
          <IconButton
            icon="close"
            size="sm"
            label="Dismiss"
            onClick={() => props.onDismiss(notice.id)}
          />
        </p>
      ))}
    </div>
  );
}
