import styles from "./ui.module.css";

/**
 * The spinning ring that means "working". Decorative unless given a label. Respects reduced
 * motion through base.css.
 */
export function Spinner({ size = 12, label }: { size?: number; label?: string }) {
  const style = { width: size, height: size };
  if (label) {
    return <span className={styles.spinner} style={style} role="status" aria-label={label} />;
  }
  return <span className={styles.spinner} style={style} aria-hidden="true" />;
}
