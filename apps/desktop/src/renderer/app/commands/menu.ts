/**
 * The menu bar and the Dock menu, from the action registry (registry.ts): which actions each menu
 * holds, and what they are called there when the menu's own name makes the palette's title
 * longer than it needs to be ("Fork" under Session, "Dark" under View → Appearance).
 *
 * An item is greyed out exactly when the registry's `when` says its action cannot run now, and
 * ticked when its `checked` says so. Only the keys the registry runs itself ("window" shortcuts)
 * are shown beside items; keys one part of the window handles (⇧Tab in the message field) work
 * only there, so a menu would misstate them.
 *
 * The window sends this model to main whenever it changes (menu-bar.ts). Main adds macOS's own
 * items around it (About, Services, Hide, Quit, the Edit and Window menus, zoom, full screen)
 * and shows the model of the window that has focus (main/menu.ts).
 */
import {
  MENU_OPEN_SESSION,
  MenuAcceleratorSchema,
  type MenuEntry,
  type MenuItemModel,
  type MenuModel,
} from "../../../shared/bridge.ts";
import { MODE_INFO, MODE_ORDER } from "../../lib/modes.ts";
import { UNTITLED } from "../../state/attention.ts";
import type { AppStore, SessionView } from "../../state/types.ts";
import { PANES } from "../panes.ts";
import type { Shortcut } from "./keys.ts";
import { availability, commandById, currentSessionId, dynamicCommands } from "./registry.ts";
import type { Command } from "./types.ts";

/** The Dock menu lists at most this many sessions that need the person. */
export const DOCK_SESSIONS = 8;

/** The Dock menu's heading over those sessions: greyed out, it does nothing. */
export const DOCK_NEEDS_YOU = "dock.needs-you";

const MAX_LABEL = 200;

const SEPARATOR: MenuEntry = { type: "separator" };

/** Electron's names for keys whose `KeyboardEvent.key` differs. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Enter: "Return",
  Tab: "Tab",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Backspace: "Backspace",
  " ": "Space",
  "+": "Plus",
};

/**
 * Electron's form of a shortcut ("CmdOrCtrl+K", "Alt+CmdOrCtrl+1", "Shift+CmdOrCtrl+]"), or
 * undefined for keys a menu cannot show.
 */
export function menuAccelerator(shortcut: Shortcut): string | undefined {
  const key =
    ACCELERATOR_KEYS[shortcut.key] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : null);
  if (key === null) return undefined;
  const accelerator = [
    shortcut.ctrl ? "Ctrl" : null,
    shortcut.alt ? "Alt" : null,
    shortcut.shift ? "Shift" : null,
    shortcut.mod ? "CmdOrCtrl" : null,
    key,
  ]
    .filter(Boolean)
    .join("+");
  return MenuAcceleratorSchema.safeParse(accelerator).success ? accelerator : undefined;
}

function clip(label: string): string {
  const line = label.replace(/\s+/g, " ").trim() || UNTITLED;
  return line.length <= MAX_LABEL ? line : `${line.slice(0, MAX_LABEL - 1)}…`;
}

function withoutPrefix(title: string, prefix: string): string {
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

interface ItemOptions {
  /** The menu's name for it, when the registry's title reads too long there. */
  label?: string;
  /** In place of the registry's `checked`, for options it does not tick (the pane showing). */
  checked?: boolean;
}

/** One registry action as a menu item. */
export function menuItem(
  command: Command,
  state: AppStore,
  options: ItemOptions = {},
): MenuItemModel {
  const shortcut = command.shortcut?.scope === "window" ? command.shortcut.keys[0] : undefined;
  const accelerator = shortcut ? menuAccelerator(shortcut) : undefined;
  const checked = options.checked ?? command.checked?.(state);
  return {
    type: "item",
    id: command.id,
    label: clip(options.label ?? command.title),
    ...(accelerator === undefined ? {} : { accelerator }),
    enabled: command.run !== undefined && availability(command, state) === true,
    ...(checked === undefined ? {} : { checked }),
  };
}

/** Drops missing items, and separators at either end or next to another. */
function compact(entries: readonly (MenuEntry | null)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === null) continue;
    if (entry.type === "separator" && (out.length === 0 || out.at(-1)?.type === "separator")) {
      continue;
    }
    out.push(entry);
  }
  if (out.at(-1)?.type === "separator") out.pop();
  return out;
}

/** A submenu, greyed out when nothing in it can run. */
function submenu(label: string, items: readonly (MenuItemModel | null)[]): MenuEntry {
  const present = items.filter((item): item is MenuItemModel => item !== null);
  return { type: "submenu", label, enabled: present.some((item) => item.enabled), items: present };
}

/** Sessions that need the person, newest activity first: what the Dock badge counts. */
export function sessionsNeedingYou(state: Pick<AppStore, "sessions" | "pending">): SessionView[] {
  return Object.values(state.sessions)
    .filter(
      (session) =>
        !session.summary.archived &&
        ((state.pending[session.id]?.length ?? 0) > 0 || session.status === "waiting"),
    )
    .sort((a, b) => b.summary.lastActivityAt - a.summary.lastActivityAt);
}

/** The window's menus, from the registry and the state it is in. */
export function buildMenuModel(state: AppStore): MenuModel {
  const dynamic = dynamicCommands(state);
  const action = (id: string, options?: ItemOptions): MenuItemModel | null => {
    const command = commandById(id);
    return command ? menuItem(command, state, options) : null;
  };
  /** An option whose registry title names its menu first: "Appearance: Dark" → "Dark". */
  const option = (id: string, prefix: string): MenuItemModel | null => {
    const command = commandById(id);
    return command
      ? menuItem(command, state, { label: withoutPrefix(command.title, prefix) })
      : null;
  };
  const choices = (prefix: string, label: (command: Command) => string) =>
    dynamic
      .filter((command) => command.id.startsWith(prefix))
      .slice(0, 150)
      .map((command) => menuItem(command, state, { label: label(command) }));
  const panesShown = currentSessionId(state) !== null && state.layout.dockOpen;
  const settings = () => action("settings.open", { label: "Settings…" });

  return {
    app: compact([settings()]),
    file: compact([
      action("session.new"),
      action("session.new-worktree"),
      action("session.new-in-folder"),
      SEPARATOR,
      action("terminal.new"),
    ]),
    edit: compact([action("sessions.search")]),
    view: compact([
      action("sidebar.toggle", {
        label: state.layout.sidebarOpen ? "Hide sidebar" : "Show sidebar",
      }),
      action("panes.toggle", { label: panesShown ? "Hide panes" : "Show panes" }),
      submenu(
        "Panes",
        PANES.map((pane) =>
          action(`pane.${pane.id}`, {
            label: pane.label,
            checked: panesShown && state.layout.dockPane === pane.id,
          }),
        ),
      ),
      SEPARATOR,
      action("palette.toggle", { label: "Command palette" }),
      SEPARATOR,
      submenu(
        "Appearance",
        ["dark", "light", "system"].map((value) => option(`appearance.${value}`, "Appearance: ")),
      ),
      submenu(
        "Tool calls",
        ["smart", "closed", "open"].map((value) => option(`tool-calls.${value}`, "Tool calls: ")),
      ),
    ]),
    session: compact([
      action("session.next"),
      action("session.previous"),
      SEPARATOR,
      action("session.stop"),
      action("session.send-held"),
      action("session.compact"),
      SEPARATOR,
      submenu(
        "Mode",
        MODE_ORDER.map((mode) => action(`mode.${mode}`, { label: MODE_INFO[mode].label })),
      ),
      submenu(
        "Model",
        choices("model:", (command) => withoutPrefix(command.title, "Model: ")),
      ),
      // As the composer's effort menu names them: "Model default", then the model's own levels.
      submenu(
        "Effort",
        choices("effort:", (command) =>
          command.id === "effort:default" ? "Model default" : command.id.slice("effort:".length),
        ),
      ),
      SEPARATOR,
      action("session.rename", { label: "Rename…" }),
      action("session.fork", { label: "Fork" }),
      action("session.mark-unread", { label: "Mark as unread" }),
      SEPARATOR,
      action("session.archive", { label: "Archive" }),
      action("session.delete", { label: "Delete…" }),
    ]),
    help: compact([
      action("help.shortcuts"),
      SEPARATOR,
      action("help.github", { label: "dawg-code on GitHub" }),
    ]),
    dock: compact([...dockSessions(state), SEPARATOR, action("session.new"), settings()]),
  };
}

/** The sessions that need the person, under a greyed-out heading; opening one shows it. */
function dockSessions(state: AppStore): MenuEntry[] {
  const waiting = sessionsNeedingYou(state).slice(0, DOCK_SESSIONS);
  if (waiting.length === 0) return [];
  return [
    { type: "item", id: DOCK_NEEDS_YOU, label: "Needs you", enabled: false },
    ...waiting.map(
      (session): MenuEntry => ({
        type: "item",
        id: `${MENU_OPEN_SESSION}${session.id}`,
        label: clip(session.summary.title ?? UNTITLED),
        enabled: true,
      }),
    ),
  ];
}
