/**
 * The window's keyboard shortcuts, run through the action registry (app/commands): ⌘K the
 * command palette, ⌘N new session, ⌘B the sidebar, ⌘, Settings, Esc stops a working session, and
 * the rest listed in commands/shortcuts.ts.
 *
 * The listener sits on `window` in the bubble phase, so anything that handles a key first (a Radix
 * menu or popover closing on Esc, the command menu, a rename field, a decision card, the code
 * editor) can call `preventDefault` or `stopPropagation` and the shortcut stays out of its way.
 * Keys an IME is composing with are left alone, and so is everything while a dialog or menu has
 * focus.
 */
import { useEffect } from "react";
import { type AppStoreApi, useAppStoreApi } from "../state/store.ts";
import { commandContext, findWindowCommand, isInOverlay } from "./commands/dispatch.ts";
import { isComposing, isTypingTarget } from "./commands/keys.ts";
import { usePlatformOs } from "./platform.tsx";

/** Esc with text selected in the transcript clears the selection instead of stopping dawg. */
function clearSelection(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || isTypingTarget(document.activeElement)) return false;
  selection.removeAllRanges();
  return true;
}

function onKeyDown(event: KeyboardEvent, store: AppStoreApi, os: ReturnType<typeof usePlatformOs>) {
  if (event.defaultPrevented || isComposing(event) || isInOverlay(event.target)) return;
  if (clearSelection(event)) {
    event.preventDefault();
    return;
  }
  const command = findWindowCommand(event, event.target, store.getState(), os);
  if (!command?.run) return;
  event.preventDefault();
  command.run(commandContext(store, os));
}

export function useGlobalShortcuts(): void {
  const store = useAppStoreApi();
  const os = usePlatformOs();
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event, store, os);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [store, os]);
}
