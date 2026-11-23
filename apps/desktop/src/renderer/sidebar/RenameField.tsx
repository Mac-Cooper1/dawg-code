import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import styles from "./Sidebar.module.css";

/**
 * Inline editing of a session's title. Enter saves, Esc cancels, leaving the field saves.
 * `onDone` gets the new title, or null when nothing changed or the edit was cancelled; `restoreFocus`
 * is true when the person finished from the keyboard, so focus goes back to the row.
 */
export function RenameField(props: {
  title: string;
  onDone(title: string | null, restoreFocus: boolean): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(props.title);
  // Enter and Esc unmount the field, which may also blur it; finish only once.
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (save: boolean, restoreFocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = value.trim();
    props.onDone(save && next !== "" && next !== props.title ? next : null, restoreFocus);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true, true);
    } else if (event.key === "Escape") {
      // Handled here: Esc must not also interrupt the selected session.
      event.preventDefault();
      event.stopPropagation();
      finish(false, true);
    }
  };

  return (
    <input
      ref={input}
      className={styles.renameInput}
      aria-label="Session title"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true, false)}
    />
  );
}
