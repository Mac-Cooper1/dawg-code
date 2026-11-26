import { Tooltip } from "radix-ui";
import { useRef } from "react";
import { Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";
import { IMAGE_ACCEPT, MAX_IMAGES } from "./images.ts";

/**
 * Attach images through the file picker. When the model cannot view images, or the message has
 * all it can take, the button stays focusable (aria-disabled rather than disabled) so its tooltip
 * can say why, on hover and on keyboard focus.
 */
export function AttachButton(props: {
  /** The session's model can view images. */
  canAttach: boolean;
  /** "Qwen3.8 27B · 8-bit", for saying which model cannot view images. */
  modelLabel: string;
  /** The message already has `MAX_IMAGES`. */
  full: boolean;
  disabled?: boolean;
  onFiles(files: File[]): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const unavailable = !props.canAttach || props.full || props.disabled === true;
  const tip = !props.canAttach
    ? `${props.modelLabel} can't view images`
    : props.full
      ? `A message can have up to ${MAX_IMAGES} images`
      : "Attach images, or paste or drop them";
  return (
    <>
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Attach images"
              aria-disabled={unavailable ? "true" : undefined}
              onClick={(event) => {
                if (unavailable) {
                  event.preventDefault();
                  return;
                }
                input.current?.click();
              }}
            >
              <Icon name="image" />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className={styles.tooltip} side="top" sideOffset={6}>
              {tip}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="attach-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Picking the same file again must still fire a change.
          event.target.value = "";
          if (files.length > 0) props.onFiles(files);
        }}
      />
    </>
  );
}
