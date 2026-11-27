/**
 * The session's folders as a tree, loaded a folder at a time. Directories first; git-ignored
 * entries dimmed; files dawg created or edited marked. Keyboard as an ARIA tree: arrows move and
 * open or close folders, Enter opens a file.
 */
import type { SessionId } from "@dawg/protocol";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { basename, formatBytes } from "../../lib/format.ts";
import styles from "./FilesPane.module.css";
import { type FilesSession, openFile, setExpanded } from "./store.ts";

export interface TreeRow {
  path: string;
  name: string;
  kind: "directory" | "file" | "symlink";
  depth: number;
  ignored: boolean;
  size: number | null;
  /** Folders only. */
  expanded: boolean;
  loading: boolean;
  /** Its folder could not be listed. */
  failed: string | null;
  parent: string | null;
  setSize: number;
  position: number;
}

/** The rows the tree shows, top to bottom. */
export function visibleRows(
  roots: readonly string[],
  session: FilesSession,
  rootNames: Readonly<Record<string, string>> = {},
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = session.dirs[dir];
    const entries = listing?.entries ?? [];
    entries.forEach((entry, index) => {
      const folder = entry.kind === "directory";
      const expanded = folder && session.expanded[entry.path] === true;
      const own = session.dirs[entry.path];
      rows.push({
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        depth,
        ignored: entry.ignored,
        size: entry.size,
        expanded,
        loading: expanded && own?.status === "loading" && own.entries.length === 0,
        failed: expanded && own?.status === "failed" ? own.message : null,
        parent: dir,
        setSize: entries.length,
        position: index + 1,
      });
      if (expanded) walk(entry.path, depth + 1);
    });
  };
  roots.forEach((root, index) => {
    const expanded = session.expanded[root] === true;
    const own = session.dirs[root];
    rows.push({
      path: root,
      name: rootNames[root] ?? (basename(root) || root),
      kind: "directory",
      depth: 0,
      ignored: false,
      size: null,
      expanded,
      loading: expanded && own?.status === "loading" && own.entries.length === 0,
      failed: expanded && own?.status === "failed" ? own.message : null,
      parent: null,
      setSize: roots.length,
      position: index + 1,
    });
    if (expanded) walk(root, 1);
  });
  return rows;
}

/** Every folder above a touched file, to mark folders that hold dawg's edits. */
function foldersAbove(paths: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    let index = path.lastIndexOf("/");
    while (index > 0) {
      const folder = path.slice(0, index);
      if (folders.has(folder)) break;
      folders.add(folder);
      index = folder.lastIndexOf("/");
    }
  }
  return folders;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      aria-hidden="true"
      focusable="false"
      className={styles.chevron}
      data-open={open ? "true" : undefined}
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FileTree(props: {
  sessionId: SessionId;
  roots: readonly string[];
  /** Names for roots shown otherwise than by their folder's name ("Project memory"). */
  rootNames?: Readonly<Record<string, string>>;
  session: FilesSession;
  touched: ReadonlyMap<string, "created" | "edited">;
}) {
  const { sessionId, roots, session, touched, rootNames } = props;
  const rows = useMemo(() => visibleRows(roots, session, rootNames), [roots, session, rootNames]);
  const holders = useMemo(() => foldersAbove(touched.keys()), [touched]);
  const [focused, setFocused] = useState<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);

  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.path === (focused ?? session.active ?? roots[0])),
  );

  function focusRow(path: string) {
    setFocused(path);
    const items = tree.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [];
    for (const element of items) {
      if (element.dataset.path === path) element.focus();
    }
  }

  function activate(row: TreeRow) {
    setFocused(row.path);
    if (row.kind === "directory") setExpanded(sessionId, row.path, !row.expanded);
    else void openFile(sessionId, row.path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) {
    const go = (next: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (target) focusRow(target.path);
    };
    switch (event.key) {
      case "ArrowDown":
        go(index + 1);
        break;
      case "ArrowUp":
        go(index - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.kind !== "directory") return;
        if (!row.expanded) setExpanded(sessionId, row.path, true);
        else if (rows[index + 1]?.parent === row.path) go(index + 1);
        break;
      case "ArrowLeft":
        if (row.kind === "directory" && row.expanded) setExpanded(sessionId, row.path, false);
        else if (row.parent) focusRow(row.parent);
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className={styles.tree} role="tree" aria-label="Files" ref={tree}>
      {rows.map((row, index) => {
        const mark = touched.get(row.path);
        const holdsEdits = row.kind === "directory" && !row.expanded && holders.has(row.path);
        const classes = [styles.row, row.ignored && styles.ignored].filter(Boolean).join(" ");
        const details = [
          row.ignored ? "ignored by git" : null,
          mark === "created" ? "created by dawg" : mark === "edited" ? "edited by dawg" : null,
          holdsEdits ? "holds files dawg edited" : null,
          row.kind === "symlink" ? "a link" : null,
        ].filter(Boolean);
        return (
          <div
            key={row.path}
            role="treeitem"
            className={classes}
            data-path={row.path}
            aria-level={row.depth + 1}
            aria-setsize={row.setSize}
            aria-posinset={row.position}
            aria-expanded={row.kind === "directory" ? row.expanded : undefined}
            aria-selected={row.path === session.active}
            aria-busy={row.loading || undefined}
            aria-label={details.length > 0 ? `${row.name}, ${details.join(", ")}` : row.name}
            title={
              row.failed ??
              (row.size !== null && row.kind !== "directory"
                ? `${row.name} · ${row.size < 1000 ? `${row.size} bytes` : formatBytes(row.size)}`
                : undefined)
            }
            tabIndex={index === focusIndex ? 0 : -1}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            onClick={() => activate(row)}
            onFocus={() => setFocused(row.path)}
            onKeyDown={(event) => onKeyDown(event, row, index)}
          >
            {row.kind === "directory" ? (
              <Chevron open={row.expanded} />
            ) : (
              <span className={styles.chevronSpace} />
            )}
            <span className={row.depth === 0 ? `${styles.name} ${styles.rootName}` : styles.name}>
              {row.name}
              {row.kind === "symlink" && <span className={styles.link}> ↗</span>}
            </span>
            {row.loading && <span className={styles.rowNote}>Loading…</span>}
            {row.failed && <span className={`${styles.rowNote} ${styles.failed}`}>Can’t list</span>}
            {mark && (
              <span
                className={`${styles.mark} ${mark === "created" ? styles.created : styles.edited}`}
                aria-hidden="true"
              >
                {mark === "created" ? "A" : "M"}
              </span>
            )}
            {holdsEdits && <span className={styles.dot} aria-hidden="true" />}
          </div>
        );
      })}
    </div>
  );
}
