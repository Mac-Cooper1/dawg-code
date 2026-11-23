import { memo } from "react";
import { displayPath } from "../lib/format.ts";
import { withInlineCode } from "../markdown/index.ts";
import type { UserMessageItem } from "../state/types.ts";
import { Chip } from "../ui/index.ts";
import type { TranscriptEnv } from "./env.ts";
import styles from "./UserMessage.module.css";

function lineRange(start: number | undefined, end: number | undefined): string {
  if (start === undefined) return "";
  return end === undefined || end === start ? `:${start}` : `:${start}–${end}`;
}

/** The person's message: a right-aligned bubble with its images and mentioned files. */
export const UserMessage = memo(function UserMessage({
  item,
  env,
}: {
  item: UserMessageItem;
  env: TranscriptEnv;
}) {
  const images = item.images.filter((image) => image.mediaType.startsWith("image/"));
  return (
    <article className={styles.message} aria-label="Your message">
      {item.command ? (
        <p className={styles.command}>
          /{item.command.name}
          {item.command.args ? ` ${item.command.args}` : ""}
        </p>
      ) : (
        item.text !== "" && <p className={styles.text}>{withInlineCode(item.text)}</p>
      )}
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((image, index) => (
            <img
              // biome-ignore lint/suspicious/noArrayIndexKey: a message's images never reorder
              key={index}
              className={styles.thumb}
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={`Attachment ${index + 1}`}
            />
          ))}
        </div>
      )}
      {item.mentions.length > 0 && (
        <ul className={styles.mentions} aria-label="Mentioned files">
          {item.mentions.map((mention) => {
            const label = `${displayPath(mention.path, env.cwd, env.homeDir)}${lineRange(mention.startLine, mention.endLine)}`;
            return (
              <li key={label}>
                <Chip icon="file" mono title={mention.path}>
                  {label}
                </Chip>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
});
