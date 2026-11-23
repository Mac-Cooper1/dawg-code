import type { CommandInfo } from "@dawg/protocol";
import { useEffect } from "react";
import menu from "../app/menu.module.css";
import styles from "./Composer.module.css";

export interface CommandMenuProps {
  /** The listbox id, referenced by the textarea's aria-controls. */
  id: string;
  commands: readonly CommandInfo[];
  active: number;
  /** The id of option `index`, for aria-activedescendant. */
  optionId(index: number): string;
  onChoose(command: CommandInfo): void;
}

/**
 * The slash-command menu above the composer. Focus stays in the textarea, which drives the list
 * (↑/↓, Enter, Tab, Esc) through aria-activedescendant; a click chooses too.
 */
export function CommandMenu(props: CommandMenuProps) {
  const activeId = props.optionId(props.active);

  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  return (
    <div className={`${menu.content} ${styles.commandMenu}`}>
      <div className={menu.label}>Commands</div>
      <div id={props.id} role="listbox" aria-label="Commands" className={styles.options}>
        {props.commands.map((command, index) => (
          <div
            key={command.name}
            id={props.optionId(index)}
            role="option"
            aria-selected={index === props.active}
            tabIndex={-1}
            className={menu.item}
            data-highlighted={index === props.active ? "" : undefined}
            // Mouse down, not click: choosing must not take focus from the textarea.
            onMouseDown={(event) => {
              event.preventDefault();
              props.onChoose(command);
            }}
          >
            <span className={menu.text}>
              <span className={menu.title}>
                /{command.name}
                {command.argumentHint && (
                  <span className={styles.argumentHint}> {command.argumentHint}</span>
                )}
              </span>
              <span className={menu.description}>{command.description}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
