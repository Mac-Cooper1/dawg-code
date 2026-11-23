import type { ErrorKind } from "@dawg/protocol";
import { memo, useId } from "react";
import { TextWithCode } from "../markdown/index.ts";
import type { ErrorItem } from "../state/types.ts";
import { Icon, Tag } from "../ui/index.ts";
import styles from "./ErrorCard.module.css";
import type { TranscriptEnv } from "./env.ts";

const TITLE: Record<ErrorKind, string> = {
  model_unavailable: "The model is unavailable",
  model_error: "The model returned an error",
  context_overflow: "The conversation no longer fits",
  invalid_model_output: "The model's output could not be used",
  repetition: "The model kept repeating itself",
  tool_failure: "A tool failed",
  storage: "The transcript could not be saved",
  internal: "Something went wrong in dawg",
  other: "Something went wrong",
};

/** A failed turn or an engine error: the message, and the technical detail on request. */
export const ErrorCard = memo(function ErrorCard({
  item,
  open,
  env,
}: {
  item: ErrorItem;
  open: boolean;
  env: TranscriptEnv;
}) {
  const detailId = useId();
  const titleId = useId();
  const { error } = item;
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <div className={styles.header}>
        <Icon name="alert" />
        <span id={titleId} className={styles.title}>
          {TITLE[error.kind] ?? TITLE.other}
        </span>
        {error.retryable && (
          <span title="Trying again may work">
            <Tag tone="neutral">Retryable</Tag>
          </span>
        )}
      </div>
      <p className={styles.message}>
        <TextWithCode text={error.message} />
      </p>
      {error.detail && (
        <>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            onClick={() => env.setItemOpen(item.id, !open)}
          >
            <Icon
              name="chevron-right"
              size={12}
              className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
            />
            {open ? "Hide details" : "Show details"}
          </button>
          {open && (
            <pre id={detailId} className={styles.detail}>
              {error.detail}
            </pre>
          )}
        </>
      )}
    </section>
  );
});
