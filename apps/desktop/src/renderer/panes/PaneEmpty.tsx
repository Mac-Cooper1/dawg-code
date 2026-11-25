import type { ReactNode } from "react";
import type { Pane } from "../../shared/bridge.ts";
import { PANES } from "../app/panes.ts";
import { Icon } from "../ui/index.ts";
import styles from "./PaneEmpty.module.css";

export interface PaneEmptyProps {
  pane: Pane;
  /** The heading; the pane's name by default. */
  title?: string;
  /** What to say; the pane's description by default. */
  children?: ReactNode;
}

/** A pane with nothing to show yet: its icon, a heading and a sentence or two. */
export function PaneEmpty(props: PaneEmptyProps) {
  const info = PANES.find((pane) => pane.id === props.pane);
  return (
    <div className={styles.empty}>
      {info && <Icon name={info.icon} size={20} />}
      <h2 className={styles.title}>{props.title ?? info?.label}</h2>
      <div className={styles.text}>{props.children ?? info?.description}</div>
    </div>
  );
}
