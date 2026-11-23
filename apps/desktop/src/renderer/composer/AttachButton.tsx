import { Tooltip } from "radix-ui";
import { Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";

/**
 * Attach an image. Not available in this build: the button stays focusable (aria-disabled rather
 * than disabled) so its tooltip can say why, on hover and on keyboard focus.
 */
export function AttachButton() {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Attach an image"
            aria-disabled="true"
            onClick={(event) => event.preventDefault()}
          >
            <Icon name="image" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={styles.tooltip} side="top" sideOffset={6}>
            Images come in a later build
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
