import type { QueuedMessage } from "../state/types.ts";
import { Button, Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";

/**
 * Messages typed while dawg works wait here, above the composer. Queued ones send when the turn
 * ends; held ones stay because the person stopped the turn, until sent or removed.
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
        return (
          <li key={message.id} className={styles.queued}>
            <Icon name="clock" size={14} />
            <span className={styles.queuedText}>
              {held ? "Held: " : "Queued: "}
              <b>{message.text}</b>
              {held ? " · not sent, because you stopped the turn" : " · sends when this turn ends"}
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
