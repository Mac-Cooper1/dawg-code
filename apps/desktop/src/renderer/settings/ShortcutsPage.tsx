/**
 * Settings → Shortcuts: the whole keymap, read from the action registry, under the same headings
 * as the command palette. A filter narrows it by action, key or place. Read-only: shortcuts
 * cannot be changed yet.
 */
import { useId, useMemo, useState } from "react";
import {
  formatShortcut,
  type Shortcut,
  shortcutKeys,
  spokenShortcut,
} from "../app/commands/keys.ts";
import { COMMANDS } from "../app/commands/registry.ts";
import { SHORTCUTS } from "../app/commands/shortcuts.ts";
import {
  COMMAND_GROUPS,
  type Command,
  type CommandGroup,
  SCOPE_LABELS,
} from "../app/commands/types.ts";
import { type PlatformOs, usePlatformOs } from "../app/platform.tsx";
import { Icon, Kbd } from "../ui/index.ts";
import styles from "./Settings.module.css";
import page from "./ShortcutsPage.module.css";

interface KeymapGroup {
  name: CommandGroup;
  commands: Command[];
}

/** Every action with a shortcut, by group, keeping those that match each word of `filter`. */
export function keymap(filter: string, os: PlatformOs): KeymapGroup[] {
  const words = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = (command: Command) => {
    if (words.length === 0) return true;
    const shortcut = command.shortcut;
    const text = [
      command.title,
      command.group,
      shortcut ? (SCOPE_LABELS[shortcut.scope] ?? "") : "",
      ...(shortcut?.keys ?? []).flatMap((keys) => [
        formatShortcut(keys, os),
        spokenShortcut(keys, os),
      ]),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return COMMAND_GROUPS.map((name) => ({
    name,
    commands: COMMANDS.filter(
      (command) => command.group === name && command.shortcut !== undefined && matches(command),
    ),
  })).filter((group) => group.commands.length > 0);
}

/** One key combination as keycaps, read out as words ("Shift Command Right Bracket"). */
function Combo({ shortcut, os }: { shortcut: Shortcut; os: PlatformOs }) {
  return (
    <span className={page.combo}>
      <span className="vh">{spokenShortcut(shortcut, os)}</span>
      <span className={page.caps} aria-hidden="true">
        {shortcutKeys(shortcut, os).map((cap, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a combination never changes its keys
          <Kbd key={index} className={page.cap}>
            {cap}
          </Kbd>
        ))}
      </span>
    </span>
  );
}

function Keys({ keys, os }: { keys: readonly Shortcut[]; os: PlatformOs }) {
  return (
    <span className={page.keys}>
      {keys.map((shortcut, index) => (
        <span key={formatShortcut(shortcut, os)} className={page.alternative}>
          {index > 0 && <span className={page.or}>or</span>}
          <Combo shortcut={shortcut} os={os} />
        </span>
      ))}
    </span>
  );
}

function Group({ group, os }: { group: KeymapGroup; os: PlatformOs }) {
  const headingId = useId();
  return (
    <section className={page.group} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.h2}>
        {group.name}
      </h2>
      <table className={page.table} aria-labelledby={headingId}>
        <thead className="vh">
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Keys</th>
          </tr>
        </thead>
        <tbody>
          {group.commands.map((command) => {
            const shortcut = command.shortcut;
            if (!shortcut) return null;
            const where = SCOPE_LABELS[shortcut.scope];
            return (
              <tr key={command.id} className={page.row}>
                <th scope="row" className={page.action}>
                  <span className={page.title}>{command.title}</span>
                  {where && <span className={page.where}>{where}</span>}
                </th>
                <td className={page.keysCell}>
                  <Keys keys={shortcut.keys} os={os} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function ShortcutsPage() {
  const os = usePlatformOs();
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => keymap(filter, os), [filter, os]);
  const trimmed = filter.trim();

  return (
    <>
      <h1 className={styles.h1}>Shortcuts</h1>
      <p className={styles.lead}>
        Every keyboard shortcut in dawg-code. <Kbd>{formatShortcut(SHORTCUTS.palette, os)}</Kbd>{" "}
        lists every action, with or without one.
      </p>
      <div className={page.filter}>
        <Icon name="search" size={14} />
        <input
          type="search"
          className={page.filterInput}
          placeholder="Filter shortcuts"
          aria-label="Filter shortcuts"
          autoComplete="off"
          spellCheck={false}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter !== "") {
              // Clears the filter; Esc must not also reach the window.
              event.preventDefault();
              event.stopPropagation();
              setFilter("");
            }
          }}
        />
      </div>
      {groups.map((group) => (
        <Group key={group.name} group={group} os={os} />
      ))}
      {groups.length === 0 && (
        <p className={styles.note} role="status">
          No shortcuts match “{trimmed}”.
        </p>
      )}
      <p className={styles.note}>Shortcuts cannot be changed yet.</p>
    </>
  );
}
