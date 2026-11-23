import { Button, LogoMark } from "../ui/index.ts";
import styles from "./App.module.css";

/** The main column when no session is selected. */
export function EmptyMain(props: { onNewSession(): void }) {
  return (
    <div className={styles.empty}>
      <span className={styles.logo}>
        <LogoMark size={20} />
      </span>
      <h2 className={styles.emptyTitle}>Start a session</h2>
      <p className={styles.emptyText}>Choose a project folder, then tell dawg what to do in it.</p>
      <Button variant="primary" kbd="⌘N" onClick={props.onNewSession}>
        New session
      </Button>
    </div>
  );
}
