import type { SessionId } from "@dawg/protocol";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { ariaKeyShortcut, formatShortcut } from "../app/commands/keys.ts";
import { SHORTCUTS } from "../app/commands/shortcuts.ts";
import { usePlatformOs } from "../app/platform.tsx";
import type { ModelFooterView, SidebarGroup } from "../state/types.ts";
import { useFocusFallback } from "../ui/focus.ts";
import { Icon, IconButton, Kbd } from "../ui/index.ts";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { SidebarFooter } from "./SidebarFooter.tsx";

/** The search field's id, so its shortcut (⌥⌘F) can focus it from anywhere in the window. */
export const SIDEBAR_SEARCH_ID = "sidebar-search";

export interface SidebarProps {
  groups: readonly SidebarGroup[];
  search: string;
  footer: ModelFooterView;
  width: number;
  onSearch(query: string): void;
  /** Without a project, the store asks for a folder first. */
  onNewSession(projectDir?: string): void;
  onSelect(id: SessionId): void;
  onRename(id: SessionId, title: string): void;
  onFork(id: SessionId): void;
  onMarkUnread(id: SessionId): void;
  onArchive(id: SessionId): void;
  /** After the person confirmed in the row's dialog. */
  onDelete(id: SessionId): void;
  onOpenModelSettings(): void;
}

/**
 * ↑ and ↓ move between session rows (across projects), Home and End go to the first and last.
 * Returns true when it moved focus.
 */
function moveBetweenRows(event: KeyboardEvent<HTMLButtonElement>): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const list = event.currentTarget.closest("nav");
  if (!list) return false;
  const rows = [...list.querySelectorAll<HTMLButtonElement>("button[data-session-row]")];
  const index = rows.indexOf(event.currentTarget);
  let next: number;
  if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
  else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = rows.length - 1;
  else return false;
  rows[next]?.focus();
  return true;
}

/** Sessions grouped by project, with New session, search and the running model. */
export function Sidebar(props: SidebarProps) {
  const os = usePlatformOs();
  // Roving focus: one row is in the tab order (the last one focused, else the selected one, else
  // the first), so Tab passes the list in one step and the arrows move inside it.
  const [focusedId, setFocusedId] = useState<SessionId | null>(null);
  const rows = props.groups.flatMap((group) => group.rows);
  const tabbableId =
    rows.find((row) => row.sessionId === focusedId)?.sessionId ??
    rows.find((row) => row.selected)?.sessionId ??
    rows[0]?.sessionId ??
    null;
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (moveBetweenRows(event)) event.preventDefault();
  };
  // Hidden with focus inside (⌘B): focus goes to the message field.
  const ref = useRef<HTMLElement>(null);
  useFocusFallback(ref);
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && props.search !== "") {
      // Esc clears the search first; it must not also interrupt the selected session.
      event.preventDefault();
      event.stopPropagation();
      props.onSearch("");
    }
  };

  return (
    <nav ref={ref} className={styles.sidebar} style={{ width: props.width }} aria-label="Sessions">
      <div className={styles.top}>
        <button
          type="button"
          className={styles.newButton}
          aria-keyshortcuts={ariaKeyShortcut(SHORTCUTS.newSession, os)}
          onClick={() => props.onNewSession()}
        >
          <Icon name="plus" />
          <span className={styles.grow}>New session</span>
          <span aria-hidden="true">
            <Kbd>{formatShortcut(SHORTCUTS.newSession, os)}</Kbd>
          </span>
        </button>
        <div className={styles.search}>
          <Icon name="search" size={14} />
          <input
            id={SIDEBAR_SEARCH_ID}
            type="search"
            className={styles.searchInput}
            placeholder="Search sessions"
            aria-label="Search sessions"
            aria-keyshortcuts={ariaKeyShortcut(SHORTCUTS.searchSessions, os)}
            autoComplete="off"
            spellCheck={false}
            value={props.search}
            onChange={(event) => props.onSearch(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {/* The field's aria-keyshortcuts says it for VoiceOver. */}
          <span aria-hidden="true">
            <Kbd>{formatShortcut(SHORTCUTS.searchSessions, os)}</Kbd>
          </span>
        </div>
      </div>
      <div className={styles.list}>
        {props.groups.length === 0 && (
          <p className={styles.emptyList}>
            {props.search.trim() !== ""
              ? `No sessions match “${props.search.trim()}”.`
              : "No sessions yet. Start one with New session."}
          </p>
        )}
        {props.groups.map((group) => (
          <ProjectGroup
            key={group.projectDir}
            group={group}
            {...props}
            tabbableId={tabbableId}
            onRowKeyDown={onRowKeyDown}
            onRowFocus={setFocusedId}
          />
        ))}
      </div>
      <SidebarFooter footer={props.footer} onOpenModelSettings={props.onOpenModelSettings} />
    </nav>
  );
}

function ProjectGroup(
  props: SidebarProps & {
    group: SidebarGroup;
    tabbableId: SessionId | null;
    onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
    onRowFocus(id: SessionId): void;
  },
) {
  const { group } = props;
  const headingId = useId();
  return (
    <div className={styles.group}>
      <div className={styles.groupHeader}>
        <Icon name="folder" size={14} />
        <h2 id={headingId} className={styles.groupName}>
          {group.name}
        </h2>
        <span className={styles.groupPath}>{group.displayPath}</span>
        <span className={styles.grow} />
        <IconButton
          icon="plus"
          size="sm"
          label={`New session in ${group.name}`}
          onClick={() => props.onNewSession(group.projectDir)}
        />
      </div>
      <ul className={styles.rows} aria-labelledby={headingId}>
        {group.rows.map((row) => (
          <li key={row.sessionId}>
            <SessionRow
              row={row}
              onSelect={() => props.onSelect(row.sessionId)}
              onRename={(title) => props.onRename(row.sessionId, title)}
              onFork={() => props.onFork(row.sessionId)}
              onMarkUnread={() => props.onMarkUnread(row.sessionId)}
              onArchive={() => props.onArchive(row.sessionId)}
              onDelete={() => props.onDelete(row.sessionId)}
              tabbable={row.sessionId === props.tabbableId}
              onRowKeyDown={props.onRowKeyDown}
              onRowFocus={() => props.onRowFocus(row.sessionId)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
