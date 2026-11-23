import type { SidebarMark } from "../state/types.ts";
import styles from "./Sidebar.module.css";

/** The shape class of each mark. Marks differ in shape as well as colour. */
export const MARK_CLASS: Record<SidebarMark, string | undefined> = {
  working: styles.markWorking,
  "needs-you": styles.markNeedsYou,
  unread: styles.markUnread,
  queued: styles.markQueued,
  error: styles.markError,
  idle: undefined,
};

/**
 * A session's status mark: a spinning ring (working), an amber disc with "!" (needs you), a blue
 * dot (done, unread), a dashed ring (queued), a red disc with "×" (error), nothing (idle). The
 * shape is decorative; the hidden label is what VoiceOver reads.
 */
export function StatusMark(props: { mark: SidebarMark; label: string }) {
  const shape = MARK_CLASS[props.mark];
  return (
    <span className={styles.markSlot}>
      {shape && (
        <span className={`${styles.mark} ${shape}`} data-mark={props.mark} aria-hidden="true" />
      )}
      <span className="vh">{props.label}</span>
    </span>
  );
}
