import { RadioGroup } from "radix-ui";
import { useId } from "react";
import type { ToolCallDisplay } from "../../shared/bridge.ts";
import styles from "./Settings.module.css";

const OPTIONS: readonly { value: ToolCallDisplay; title: string; description: string }[] = [
  {
    value: "smart",
    title: "Open what needs a look",
    description: "Failed commands and edits open; reads, searches and passing commands stay closed",
  },
  {
    value: "closed",
    title: "All closed",
    description: "One line per call; click a line to open it",
  },
  { value: "open", title: "All open", description: "Every output and diff, in full" },
];

function Option(props: (typeof OPTIONS)[number]) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <RadioGroup.Item
      value={props.value}
      className={styles.option}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <span className={styles.radio} aria-hidden="true" />
      <span className={styles.optionText}>
        <span id={titleId} className={styles.optionTitle}>
          {props.title}
        </span>
        <span id={descriptionId} className={styles.optionDescription}>
          {props.description}
        </span>
      </span>
    </RadioGroup.Item>
  );
}

/** Settings → General → Tool calls in the transcript. */
export function ToolCallOptions(props: {
  value: ToolCallDisplay;
  onChange(value: ToolCallDisplay): void;
}) {
  return (
    <RadioGroup.Root
      className={styles.options}
      value={props.value}
      aria-label="Tool calls in the transcript"
      onValueChange={(value) => {
        const option = OPTIONS.find((candidate) => candidate.value === value);
        if (option) props.onChange(option.value);
      }}
    >
      {OPTIONS.map((option) => (
        <Option key={option.value} {...option} />
      ))}
    </RadioGroup.Root>
  );
}
