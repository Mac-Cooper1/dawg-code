import { useEffect } from "react";
import type { FileMatch } from "../../shared/bridge.ts";
import menu from "../app/menu.module.css";
import { Icon } from "../ui/index.ts";
import styles from "./Composer.module.css";
import type { FileSearch } from "./useFileSearch.ts";

export interface MentionMenuProps {
  /** The listbox id, referenced by the textarea's aria-controls. */
  id: string;
  search: FileSearch;
  active: number;
  /** The id of option `index`, for aria-activedescendant. */
  optionId(index: number): string;
  onChoose(match: FileMatch): void;
  /** The pointer moved over an option. */
  onHover(index: number): void;
}

/** A path with the matched characters marked, the folder part quieter than the name. */
function HighlightedPath({ match }: { match: FileMatch }) {
  const text = match.relativePath;
  const marked = new Set(match.highlights);
  const end = text.endsWith("/") ? text.length - 1 : text.length;
  const baseStart = text.lastIndexOf("/", end - 1) + 1;
  const parts: { text: string; hit: boolean; folder: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = marked.has(i);
    const folder = i < baseStart;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit && last.folder === folder) last.text += text[i];
    else parts.push({ text: text[i] ?? "", hit, folder });
  }
  return (
    <span className={styles.mentionPath}>
      {parts.map((part, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one path never reorder
          key={index}
          className={[part.folder ? styles.mentionFolder : "", part.hit ? styles.mentionHit : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {part.text}
        </span>
      ))}
    </span>
  );
}

/**
 * The `@` file menu above the composer. Focus stays in the textarea, which drives the list
 * (↑/↓, Enter, Tab, Esc) through aria-activedescendant; a click chooses too.
 */
export function MentionMenu(props: MentionMenuProps) {
  const { search } = props;
  const activeId = props.optionId(props.active);
  const empty = search.matches.length === 0;

  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  let status: string | null = null;
  if (search.error) status = `Files can't be searched here. ${search.error}`;
  else if (empty && search.answered === null) status = "Searching files…";
  else if (empty) status = "No matching files";

  return (
    <div className={`${menu.content} ${styles.commandMenu} ${styles.mentionMenu}`}>
      <div className={menu.label}>Files</div>
      <div
        id={props.id}
        role="listbox"
        aria-label="Files"
        aria-busy={search.loading || undefined}
        className={styles.options}
      >
        {search.matches.map((match, index) => (
          <div
            key={match.relativePath}
            id={props.optionId(index)}
            role="option"
            aria-selected={index === props.active}
            aria-label={
              match.kind === "directory" ? `${match.relativePath}, folder` : match.relativePath
            }
            tabIndex={-1}
            className={`${menu.item} ${menu.simple}`}
            data-highlighted={index === props.active ? "" : undefined}
            onMouseMove={() => {
              if (index !== props.active) props.onHover(index);
            }}
            // Mouse down, not click: choosing must not take focus from the textarea.
            onMouseDown={(event) => {
              event.preventDefault();
              props.onChoose(match);
            }}
          >
            <span className={menu.icon}>
              <Icon name={match.kind === "directory" ? "folder" : "file"} size={14} />
            </span>
            <HighlightedPath match={match} />
          </div>
        ))}
      </div>
      {status !== null && (
        <p className={styles.mentionStatus} role="status">
          {status}
        </p>
      )}
      {search.truncated && !empty && (
        <p className={`${menu.footer} ${styles.mentionNote}`}>
          Some files are not searched: the folder has over 100,000.
        </p>
      )}
    </div>
  );
}
