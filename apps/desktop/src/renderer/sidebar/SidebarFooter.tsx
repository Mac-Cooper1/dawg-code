import type { ModelFooterView } from "../state/types.ts";
import { Icon } from "../ui/index.ts";
import styles from "./Sidebar.module.css";

/** The running model at the foot of the sidebar. Opens Settings → Models. */
export function SidebarFooter(props: { footer: ModelFooterView; onOpenModelSettings(): void }) {
  const { footer } = props;
  const ready = footer.state === "ready";
  return (
    <button
      type="button"
      className={styles.footer}
      aria-label={`${footer.label}${footer.detail ? `, ${footer.detail}` : ""}. Model settings`}
      onClick={props.onOpenModelSettings}
    >
      <span className={styles.dot} data-ready={ready ? "true" : "false"} aria-hidden="true" />
      <span className={styles.footerText}>
        <span className={styles.footerLabel}>{footer.label}</span>
        {footer.detail && <span className={styles.footerDetail}>{footer.detail}</span>}
      </span>
      <Icon name="settings" className={styles.footerIcon} />
    </button>
  );
}
