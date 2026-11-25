import logoUrl from "../assets/logo.png";
import { Button } from "../ui/index.ts";
import styles from "./App.module.css";

/** The main column when no session is selected. */
export function EmptyMain(props: { onNewSession(): void }) {
  return (
    <div className={styles.empty}>
      <img className={styles.logo} src={logoUrl} alt="" width={64} height={64} />
      <h2 className={styles.emptyTitle}>Start a session</h2>
      <p className={styles.emptyText}>Choose a project folder, then tell dawg what to do in it.</p>
      <Button variant="primary" kbd="⌘N" onClick={props.onNewSession}>
        New session
      </Button>
    </div>
  );
}
