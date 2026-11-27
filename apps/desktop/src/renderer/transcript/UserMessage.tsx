import { memo } from "react";
import { displayPath } from "../lib/format.ts";
import { withInlineCode } from "../markdown/index.ts";
import type { UserMessageItem } from "../state/types.ts";
import { Chip } from "../ui/index.ts";
import { Divider } from "./Divider.tsx";
import type { TranscriptEnv } from "./env.ts";
import styles from "./UserMessage.module.css";

/** The first line of a turn the engine started for a background agent, short enough for a divider. */
function noticeLine(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

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
  // The engine started this turn for a background agent that ended: no person wrote it.
  if (item.fromAgent) return <Divider text={noticeLine(item.text)} />;
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
              decoding="async"
              loading="lazy"
            />
          ))}
        </div>
      )}
      {item.mentions.length > 0 && (
        <ul className={styles.mentions} aria-label="Mentioned files">
          {item.mentions.map((mention, index) => {
            const label = `${displayPath(mention.path, env.cwd, env.homeDir)}${lineRange(mention.startLine, mention.endLine)}`;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a message's mentions never reorder
              <li key={index}>
                <Chip
                  icon={mention.path.endsWith("/") ? "folder" : "file"}
                  mono
                  title={mention.path}
                >
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
