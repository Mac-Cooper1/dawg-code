/**
 * Which window shortcut a key press means, and the context an action runs with. Used by
 * `useGlobalShortcuts` (key presses) and the command palette (picked rows).
 */
import type { AppStoreApi } from "../../state/store.ts";
import type { AppStore } from "../../state/types.ts";
import { paletteFor } from "../palette/controller.ts";
import { type PlatformOs, usesCommandKey } from "../platform.tsx";
import { isInTerminal, isTypingTarget, type KeyPress, matchesShortcut } from "./keys.ts";
import { availability, WINDOW_COMMANDS } from "./registry.ts";
import type { Command, CommandContext } from "./types.ts";

/** Focus is in a dialog or a menu: its keys are its own until it closes. */
export function isInOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[role='dialog'], [role='alertdialog'], [role='menu']") !== null
  );
}

/**
 * The window shortcut for this key press, if it can run now. Null when the press is someone
 * else's: typing in a field (unless the shortcut works there), a Ctrl-key in the terminal, or a
 * shortcut whose action does not apply at the moment.
 */
export function findWindowCommand(
  press: KeyPress,
  target: EventTarget | null,
  state: AppStore,
  os: PlatformOs,
): Command | null {
  const typing = isTypingTarget(target);
  for (const command of WINDOW_COMMANDS) {
    const shortcut = command.shortcut;
    if (!shortcut?.keys.some((keys) => matchesShortcut(press, keys, os))) continue;
    if (typing && !shortcut.whileTyping) return null;
    // Without ⌘, the command key is Ctrl, and in the terminal Ctrl-keys belong to the shell.
    if (!usesCommandKey(os) && isInTerminal(target)) return null;
    return availability(command, state) === true ? command : null;
  }
  return null;
}

export function commandContext(store: AppStoreApi, os: PlatformOs): CommandContext {
  const state = store.getState();
  return { state, actions: state.actions, store, os, palette: paletteFor(store) };
}
