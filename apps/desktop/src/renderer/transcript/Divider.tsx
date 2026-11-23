import styles from "./Divider.module.css";

/** A thin centred line with a short label, for notes and other quiet markers. */
export function Divider({ text, tone = "neutral" }: { text: string; tone?: "neutral" | "error" }) {
  return (
    <div className={tone === "error" ? `${styles.divider} ${styles.error}` : styles.divider}>
      <span className={styles.label}>{text}</span>
    </div>
  );
}
