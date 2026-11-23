import { RadioGroup } from "radix-ui";
import { type ReactNode, useId } from "react";
import type { Appearance, ResolvedTheme } from "../../shared/bridge.ts";
import styles from "./Settings.module.css";

/** A miniature window in a theme's colours: sidebar, two lines of text, an accent bar. */
function Preview(props: { theme: ResolvedTheme; className?: string }) {
  const themeClass = props.theme === "dark" ? styles.previewDark : styles.previewLight;
  return (
    <span className={`${styles.preview} ${themeClass} ${props.className ?? ""}`}>
      <span className={styles.previewSide} />
      <span className={styles.previewMain}>
        <span className={styles.previewLine} />
        <span className={styles.previewLine} />
        <span className={styles.previewAccent} />
      </span>
    </span>
  );
}

function Choice(props: {
  value: Appearance;
  title: string;
  description: string;
  preview: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <RadioGroup.Item
      value={props.value}
      className={styles.themeCard}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <span aria-hidden="true" className={styles.previewSlot}>
        {props.preview}
      </span>
      <span className={styles.themeTitle}>
        <span className={styles.radio} aria-hidden="true" />
        <span id={titleId}>{props.title}</span>
      </span>
      <span id={descriptionId} className={styles.muted}>
        {props.description}
      </span>
    </RadioGroup.Item>
  );
}

/**
 * Settings → General → Appearance: Match macOS, Dark, Light, as cards with a preview of each. A
 * radio group: arrow keys move between the cards and choose.
 */
export function AppearancePicker(props: {
  value: Appearance;
  /** What macOS shows right now, for "Right now: Dark". */
  system: ResolvedTheme;
  onChange(appearance: Appearance): void;
}) {
  return (
    <RadioGroup.Root
      className={styles.themes}
      value={props.value}
      aria-label="Appearance"
      onValueChange={(value) => {
        if (value === "system" || value === "dark" || value === "light") props.onChange(value);
      }}
    >
      <Choice
        value="system"
        title="Match macOS"
        description={`Follows System Settings. Right now: ${props.system === "dark" ? "Dark" : "Light"}`}
        preview={
          <span className={styles.previewSplit}>
            <Preview theme="light" />
            <Preview theme="dark" className={styles.previewHalf} />
          </span>
        }
      />
      <Choice
        value="dark"
        title="Dark"
        description="Always dark"
        preview={<Preview theme="dark" />}
      />
      <Choice
        value="light"
        title="Light"
        description="Always light"
        preview={<Preview theme="light" />}
      />
    </RadioGroup.Root>
  );
}
