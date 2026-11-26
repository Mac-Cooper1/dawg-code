/**
 * The shape of the action registry: every action a person can take, with its keys. The command
 * palette lists the actions, the window's key handler runs their shortcuts, and Settings →
 * Shortcuts shows the whole keymap, all from the same entries.
 */
import type { SessionId } from "@dawg/protocol";
import type { AppStoreApi } from "../../state/store.ts";
import type { AppActions, AppStore } from "../../state/types.ts";
import type { PlatformOs } from "../platform.tsx";
import type { Shortcut } from "./keys.ts";

/** Headings in the palette and on the Shortcuts page, in this order. */
export const COMMAND_GROUPS = [
  "Sessions",
  "This session",
  "Composer",
  "Decision cards",
  "Panes",
  "View",
  "Command palette",
  "Settings",
  "Models",
  "Help",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * Where a shortcut works. "window" shortcuts are run by the registry (`useGlobalShortcuts`);
 * every other scope is handled by that part of the window itself and is listed here so the
 * keymap is complete.
 */
export type ShortcutScope =
  | "window"
  | "palette"
  | "composer"
  | "composer-menu"
  | "card"
  | "question"
  | "sidebar-search"
  | "rename"
  | "resize"
  | "pane-tabs"
  | "changes"
  | "comment"
  | "file-tree"
  | "files"
  | "terminal";

/** Said after a shortcut that works only in one place: "In the message field". */
export const SCOPE_LABELS: Readonly<Record<ShortcutScope, string | null>> = {
  window: null,
  palette: "In the command palette",
  composer: "In the message field",
  "composer-menu": "While the command or file menu is open",
  card: "With focus on a decision card",
  question: "With focus on a question card",
  "sidebar-search": "In the session search field",
  rename: "While renaming a session",
  resize: "On a resize handle",
  "pane-tabs": "On the pane tabs",
  changes: "In the Changes pane’s file list",
  comment: "In a comment on a change",
  "file-tree": "In the Files pane’s tree",
  files: "In the Files pane",
  terminal: "In the terminal",
};

export interface CommandShortcut {
  /** Alternatives: any of them does it (↑ or ↓, ⏎ or ⌘⏎). The first is the one shown in rows. */
  keys: readonly Shortcut[];
  scope: ShortcutScope;
  /**
   * For "window" shortcuts: also works while typing in a text field. Shortcuts that type nothing
   * themselves (⌘K, Esc) do; plain keys would not.
   */
  whileTyping?: boolean;
}

/**
 * Whether an action can run now. True: it can. False: it does not apply and is not offered. A
 * sentence: it is offered but cannot run, and the sentence says why ("Nothing is running.").
 */
export type Availability = boolean | string;

/** The command palette, for actions that need it. */
export interface PaletteUi {
  open(): void;
  close(): void;
  toggle(): void;
  /** Asks for the session's new title in the palette. */
  rename(sessionId: SessionId): void;
  /** Asks before deleting the session. */
  confirmDelete(sessionId: SessionId): void;
  /**
   * Runs `task` once the palette has closed and handed focus back (at once when it is not open).
   * For actions that move focus or open a dialog of their own.
   */
  whenClosed(task: () => void): void;
}

export interface CommandContext {
  /** The state when the action runs. */
  state: AppStore;
  actions: AppActions;
  store: AppStoreApi;
  os: PlatformOs;
  palette: PaletteUi;
}

export interface Command {
  /** Stable: "session.fork". Recently used actions are remembered by it. */
  id: string;
  /** Sentence case, a verb first where there is one: "Fork the session". */
  title: string;
  group: CommandGroup;
  /** More words that find it in the palette. */
  keywords?: readonly string[];
  shortcut?: CommandShortcut;
  /** A tick in the palette, for the option in effect (the current mode, the appearance). */
  checked?(state: AppStore): boolean;
  /** Left out: always available. */
  when?(state: AppStore): Availability;
  /**
   * Left out for keys that only document what another part of the window does (⏎ sends): they
   * appear on the Shortcuts page, not in the palette.
   */
  run?(context: CommandContext): void;
}
