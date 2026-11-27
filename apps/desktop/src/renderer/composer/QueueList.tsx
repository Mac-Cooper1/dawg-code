import type { QueuedMessage } from "../state/types.ts";
import { Button, Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 images, 1 file": what goes with a waiting message besides its text. */
function extras(message: QueuedMessage): string | null {
  const parts: string[] = [];
  const images = message.images?.length ?? 0;
  const files = message.mentions?.length ?? 0;
  if (images > 0) parts.push(count(images, "image", "images"));
  if (files > 0) parts.push(count(files, "file", "files"));
  return parts.length === 0 ? null : parts.join(", ");
}

/** "Its image was not kept." Images are not saved across a relaunch; the words are. */
export function imagesNotKeptText(count: number, whose: "its" | "draft"): string {
  const images = count === 1 ? "image was" : `${count} images were`;
  return whose === "its"
    ? `Its ${images} not kept when dawg-code quit.`
    : `The ${count === 1 ? "image" : `${count} images`} attached here ${count === 1 ? "was" : "were"} not kept when dawg-code quit.`;
}

/**
 * Messages typed while dawg works wait here, above the composer. Queued ones send when the turn
 * ends; held ones stay because the person stopped the turn (or dawg-code quit before they were
 * sent), until sent or removed.
 */
export function QueueList(props: {
  queue: readonly QueuedMessage[];
  onSendNow(id: string): void;
  onRemove(id: string): void;
}) {
  if (props.queue.length === 0) return null;
  return (
    <ul className={styles.queue} aria-label="Waiting messages">
      {props.queue.map((message) => {
        const held = message.state === "held";
        const attached = extras(message);
        return (
          <li key={message.id} className={styles.queued}>
            <Icon name="clock" size={14} />
            <span className={styles.queuedBody}>
              <span className={styles.queuedText}>
                {held ? "Held: " : "Queued: "}
                <b>{message.text === "" ? attached : message.text}</b>
                {message.text !== "" && attached !== null && ` (with ${attached})`}
                {!held
                  ? " · sends when this turn ends"
                  : message.restored
                    ? " · not sent before dawg-code quit"
                    : " · not sent, because you stopped the turn"}
              </span>
              {(message.imagesNotKept ?? 0) > 0 && (
                <span className={styles.queuedNote}>
                  {imagesNotKeptText(message.imagesNotKept ?? 0, "its")}
                </span>
              )}
            </span>
            {held && (
              <Button size="sm" onClick={() => props.onSendNow(message.id)}>
                Send now
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => props.onRemove(message.id)}>
              Remove
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
