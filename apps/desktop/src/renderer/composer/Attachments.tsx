import type { ImageAttachment } from "../state/types.ts";
import { Icon, Spinner } from "../ui/index.ts";
import styles from "./Composer.module.css";

/**
 * The images attached to the message, above its text: a thumbnail each with a remove button,
 * and a placeholder for each one still being prepared.
 */
export function Attachments(props: {
  images: readonly ImageAttachment[];
  /** Images still being read and downscaled. */
  preparing: number;
  disabled?: boolean;
  onRemove(id: string): void;
}) {
  if (props.images.length === 0 && props.preparing === 0) return null;
  return (
    <ul className={styles.attachments} aria-label="Attached images">
      {props.images.map((image) => (
        <li key={image.id} className={styles.attachment}>
          <img
            className={styles.attachmentImage}
            src={`data:${image.mediaType};base64,${image.data}`}
            alt={image.name}
            title={`${image.name} · ${image.width} × ${image.height}`}
            draggable={false}
          />
          <button
            type="button"
            className={styles.attachmentRemove}
            aria-label={`Remove ${image.name}`}
            disabled={props.disabled}
            onClick={() => props.onRemove(image.id)}
          >
            <Icon name="close" size={12} strokeWidth={2} />
          </button>
        </li>
      ))}
      {Array.from({ length: props.preparing }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <li key={`preparing-${index}`} className={`${styles.attachment} ${styles.preparing}`}>
          <Spinner size={14} label="Preparing an image" />
        </li>
      ))}
    </ul>
  );
}
