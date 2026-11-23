import type { Appearance, ResolvedTheme, ToolCallDisplay } from "../../shared/bridge.ts";
import { AppearancePicker } from "./AppearancePicker.tsx";
import styles from "./Settings.module.css";
import { ToolCallOptions } from "./ToolCallOptions.tsx";

export interface GeneralPageProps {
  appearance: Appearance;
  system: ResolvedTheme;
  toolCalls: ToolCallDisplay;
  onSetAppearance(appearance: Appearance): void;
  onSetToolCallDisplay(value: ToolCallDisplay): void;
}

/** Settings → General: appearance and how tool calls show in the transcript. */
export function GeneralPage(props: GeneralPageProps) {
  return (
    <>
      <h1 className={styles.h1}>General</h1>
      <p className={styles.lead}>How dawg looks.</p>

      <h2 className={styles.h2}>Appearance</h2>
      <AppearancePicker
        value={props.appearance}
        system={props.system}
        onChange={props.onSetAppearance}
      />
      <p className={styles.note}>
        The moon and sun button in each window’s title bar switches between Dark and Light and saves
        the choice here.
      </p>

      <h2 className={styles.h2}>Tool calls in the transcript</h2>
      <ToolCallOptions value={props.toolCalls} onChange={props.onSetToolCallDisplay} />
    </>
  );
}
