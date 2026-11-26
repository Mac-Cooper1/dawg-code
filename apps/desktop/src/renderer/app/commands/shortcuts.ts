/**
 * The window's own shortcuts, by name. The registry (registry.ts) binds them to actions; the
 * parts of the window that show a hint for one (the sidebar's search field, New session) read it
 * from here, so a hint always matches what the key does.
 *
 * Chosen to stay clear of macOS (⌘Q, ⌘H, ⌘M, ⌘W, ⌘`, ⇧⌘3–5, ⌃-arrows), the Edit and View menus
 * (⌘Z, ⌘X, ⌘C, ⌘V, ⌘A, ⌘0, ⌘+, ⌘−, ⌃⌘F), text editing (⌘←, ⌥←, ⌃A, ⌃E, ⌃K), the editor
 * (⌘F, ⌘S, ⌘D, ⌘L, ⌘[, ⌘], ⌥⌘[, ⌥⌘], ⌥⌘↑, ⌥⌘↓) and the terminal (every ⌃-key belongs to the
 * shell). Claude Code's own conventions come first: Esc interrupts, ⇧Tab cycles the mode.
 */
import type { Shortcut } from "./keys.ts";

export const SHORTCUTS = {
  /** ⌘K: the usual command palette key. */
  palette: { key: "k", mod: true },
  newSession: { key: "n", mod: true },
  /** ⇧⌘] and ⇧⌘[: next and previous tab in Safari, Terminal and Xcode. */
  nextSession: { key: "]", mod: true, shift: true },
  previousSession: { key: "[", mod: true, shift: true },
  /** ⌥⌘F: search the list, as in Notes and Mail (⌘F stays free for finding in a transcript). */
  searchSessions: { key: "f", mod: true, alt: true },
  toggleSidebar: { key: "b", mod: true },
  /** ⌥⌘B: the other side's ⌘B. */
  togglePanes: { key: "b", mod: true, alt: true },
  /** ⌥⌘1 to ⌥⌘5: the panes in title-bar order. */
  changesPane: { key: "1", mod: true, alt: true },
  filesPane: { key: "2", mod: true, alt: true },
  terminalPane: { key: "3", mod: true, alt: true },
  planPane: { key: "4", mod: true, alt: true },
  tasksPane: { key: "5", mod: true, alt: true },
  settings: { key: ",", mod: true },
  keyboardShortcuts: { key: "/", mod: true },
  /** Esc interrupts, as in Claude Code. */
  stop: { key: "Escape" },
} as const satisfies Record<string, Shortcut>;
