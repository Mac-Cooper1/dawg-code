import type { SessionId } from "@dawg/protocol";
import { type KeyboardEvent, useId } from "react";
import type { ModelFooterView, SidebarGroup } from "../state/types.ts";
import { Icon, IconButton, Kbd } from "../ui/index.ts";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";
import { SidebarFooter } from "./SidebarFooter.tsx";

/** The search field's id, so ⌘K can focus it from anywhere in the window. */
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
  onOpenModelSettings(): void;
}

/** Sessions grouped by project, with New session, search and the running model. */
export function Sidebar(props: SidebarProps) {
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && props.search !== "") {
      // Esc clears the search first; it must not also interrupt the selected session.
      event.preventDefault();
      event.stopPropagation();
      props.onSearch("");
    }
  };

  return (
    <nav className={styles.sidebar} style={{ width: props.width }} aria-label="Sessions">
      <div className={styles.top}>
        <button
          type="button"
          className={styles.newButton}
          aria-keyshortcuts="Meta+N"
          onClick={() => props.onNewSession()}
        >
          <Icon name="plus" />
          <span className={styles.grow}>New session</span>
          <span aria-hidden="true">
            <Kbd>⌘N</Kbd>
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
            aria-keyshortcuts="Meta+K"
            autoComplete="off"
            spellCheck={false}
            value={props.search}
            onChange={(event) => props.onSearch(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <Kbd>⌘K</Kbd>
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
          <ProjectGroup key={group.projectDir} group={group} {...props} />
        ))}
      </div>
      <SidebarFooter footer={props.footer} onOpenModelSettings={props.onOpenModelSettings} />
    </nav>
  );
}

function ProjectGroup(props: SidebarProps & { group: SidebarGroup }) {
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
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
