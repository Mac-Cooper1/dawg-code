import { ContextMenu, DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import menu from "../app/menu.module.css";
import type { SidebarRow } from "../state/types.ts";
import { Icon, IconButton, type IconName } from "../ui/index.ts";
import { RenameField } from "./RenameField.tsx";
import styles from "./Sidebar.module.css";
import { StatusMark } from "./StatusMark.tsx";

type RowAction = "rename" | "fork" | "unread" | "archive";

const ROW_ACTIONS: readonly { id: RowAction; label: string; icon: IconName }[] = [
  { id: "rename", label: "Rename", icon: "edit" },
  { id: "fork", label: "Fork", icon: "fork" },
  { id: "unread", label: "Mark as unread", icon: "unread" },
  { id: "archive", label: "Archive", icon: "archive" },
];

export interface SessionRowProps {
  row: SidebarRow;
  onSelect(): void;
  onRename(title: string): void;
  onFork(): void;
  onMarkUnread(): void;
  onArchive(): void;
}

/**
 * The row's accessible name: title, status and time, as one sentence. Set explicitly so the parts
 * are separated (screen readers would otherwise run "WorkingFix the…" together). The subtitle
 * usually starts with the status ("Needs you: run a command"); then the status is not repeated.
 */
export function rowName(row: SidebarRow): string {
  const parts = [row.title];
  if (!row.subtitle?.startsWith(row.markLabel)) parts.push(row.markLabel);
  if (row.subtitle) parts.push(row.subtitle);
  if (row.worktree) parts.push("in a worktree");
  parts.push(row.timeLabel);
  return parts.join(", ");
}

/**
 * One session in the sidebar: status mark, title, subtitle and time. Its actions are in a context
 * menu (right click) and behind a "…" button that shows on hover and focus.
 */
export function SessionRow(props: SessionRowProps) {
  const { row } = props;
  const [editing, setEditing] = useState(false);
  const rowButton = useRef<HTMLButtonElement>(null);
  // Rename starts once its menu has closed. While a menu is open it traps focus, so a field that
  // mounted earlier would lose focus to it; and the closing menu must not hand focus back to its
  // trigger. When the edit ends from the keyboard, focus returns to the row.
  const renameOnClose = useRef(false);
  const focusRowAfterEdit = useRef(false);

  useEffect(() => {
    if (!editing && focusRowAfterEdit.current) {
      focusRowAfterEdit.current = false;
      rowButton.current?.focus();
    }
  }, [editing]);

  const perform = (action: RowAction) => {
    if (action === "rename") renameOnClose.current = true;
    else if (action === "fork") props.onFork();
    else if (action === "unread") props.onMarkUnread();
    else props.onArchive();
  };

  /** Called by either menu once it has closed, just before it would focus its trigger again. */
  const onCloseAutoFocus = (event: Event) => {
    if (!renameOnClose.current) return;
    renameOnClose.current = false;
    event.preventDefault();
    setEditing(true);
  };

  const finishRename = (title: string | null, restoreFocus: boolean) => {
    focusRowAfterEdit.current = restoreFocus;
    setEditing(false);
    if (title !== null) props.onRename(title);
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={editing}>
        <div className={styles.row} data-editing={editing ? "true" : undefined}>
          {editing ? (
            <span className={styles.rowButton}>
              <StatusMark mark={row.mark} label={row.markLabel} />
              <RenameField title={row.title} onDone={finishRename} />
            </span>
          ) : (
            <button
              ref={rowButton}
              type="button"
              className={styles.rowButton}
              aria-label={rowName(row)}
              aria-current={row.selected ? "true" : undefined}
              onClick={props.onSelect}
            >
              <StatusMark mark={row.mark} label={row.markLabel} />
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>
                  {row.title}
                  {row.worktree && <Icon name="branch" size={12} className={styles.worktreeIcon} />}
                </span>
                {row.subtitle && <span className={styles.rowSubtitle}>{row.subtitle}</span>}
              </span>
              <span className={styles.rowTime}>{row.timeLabel}</span>
            </button>
          )}
          {!editing && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton
                  icon="more"
                  size="sm"
                  label={`Actions for ${row.title}`}
                  className={styles.more}
                />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className={`${menu.content} ${menu.narrow}`}
                  align="end"
                  sideOffset={4}
                  onCloseAutoFocus={onCloseAutoFocus}
                >
                  {ROW_ACTIONS.map((action) => (
                    <DropdownMenu.Item
                      key={action.id}
                      className={`${menu.item} ${menu.simple}`}
                      onSelect={() => perform(action.id)}
                    >
                      <Icon name={action.icon} size={14} className={menu.icon} />
                      {action.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={`${menu.content} ${menu.narrow}`}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {ROW_ACTIONS.map((action) => (
            <ContextMenu.Item
              key={action.id}
              className={`${menu.item} ${menu.simple}`}
              onSelect={() => perform(action.id)}
            >
              <Icon name={action.icon} size={14} className={menu.icon} />
              {action.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
