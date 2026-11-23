import { memo } from "react";
import { Markdown } from "../markdown/index.ts";
import type { AssistantTextItem } from "../state/types.ts";
import styles from "./AssistantText.module.css";
import type { TranscriptEnv } from "./env.ts";

/** A reply's text as Markdown, with the blinking caret while it streams. */
export const AssistantText = memo(function AssistantText({
  item,
  env,
}: {
  item: AssistantTextItem;
  env: TranscriptEnv;
}) {
  if (item.text === "" && !item.streaming) return null;
  return (
    <div className={styles.text} data-streaming={item.streaming ? "true" : undefined}>
      <Markdown text={item.text} streaming={item.streaming} onOpenLink={env.openLink} />
    </div>
  );
});
