import type { ReactNode } from "react";
import styles from "./ui.module.css";

/** A keyboard hint: <Kbd>⌘N</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className ? `${styles.kbd} ${className}` : styles.kbd}>{children}</kbd>;
}
