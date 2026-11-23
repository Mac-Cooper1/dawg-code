import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";
import styles from "./ui.module.css";

/** A small grey label, as in the title bar: [folder tally]. */
export function Chip(props: {
  children: ReactNode;
  icon?: IconName;
  mono?: boolean;
  className?: string;
  title?: string;
}) {
  const classes = [styles.chip, props.mono && styles.mono, props.className].filter(Boolean);
  return (
    <span className={classes.join(" ")} title={props.title}>
      {props.icon && <Icon name={props.icon} size={12} />}
      {props.children}
    </span>
  );
}

export type TagTone = "neutral" | "green" | "amber" | "accent" | "red";

const TONE_CLASS: Record<TagTone, string | undefined> = {
  neutral: undefined,
  green: styles.tagGreen,
  amber: styles.tagAmber,
  accent: styles.tagAccent,
  red: styles.tagRed,
};

/** A rounded status label: <Tag tone="accent">Recommended</Tag>. */
export function Tag(props: { children: ReactNode; tone?: TagTone; className?: string }) {
  const classes = [styles.tag, TONE_CLASS[props.tone ?? "neutral"], props.className].filter(
    Boolean,
  );
  return <span className={classes.join(" ")}>{props.children}</span>;
}
