import { memo } from "react";
import { Markdown } from "../markdown/index.ts";
import type { CommandOutputItem } from "../state/types.ts";
import styles from "./CommandOutput.module.css";
import type { TranscriptEnv } from "./env.ts";

/** A command that answered at once (`/help`): the command as typed, then its answer. */
export const CommandOutput = memo(function CommandOutput({
  item,
  env,
}: {
  item: CommandOutputItem;
  env: TranscriptEnv;
}) {
  return (
    <>
      <p className={styles.command}>{item.command}</p>
      <section className={styles.output} aria-label={`Output of ${item.command}`}>
        <Markdown text={item.output} onOpenLink={env.openLink} />
      </section>
    </>
  );
});
