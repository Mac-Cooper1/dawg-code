/**
 * Window-wide keyboard shortcuts: ⌘B sidebar, ⌘N new session, ⌘, Settings, ⌘K sidebar search,
 * Esc interrupts the selected session while dawg works.
 *
 * The listener sits on `window` in the bubble phase, so anything that handles a key first (a Radix
 * menu or popover closing on Esc, the command menu, a rename field, a decision card) can call
 * `preventDefault` or `stopPropagation` and the shortcut stays out of its way.
 */
import { useEffect } from "react";
import { SIDEBAR_SEARCH_ID } from "../sidebar/Sidebar.tsx";
import { selectComposer } from "../state/selectors.ts";
import { type AppStoreApi, useAppStoreApi } from "../state/store.ts";
import { type PlatformOs, usePlatformOs, usesCommandKey } from "./platform.tsx";
import { run } from "./run.ts";

function hasCommandModifier(event: KeyboardEvent, os: PlatformOs): boolean {
  if (event.altKey || event.shiftKey) return false;
  return usesCommandKey(os) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable
  );
}

function focusSidebarSearch(): boolean {
  const input = document.getElementById(SIDEBAR_SEARCH_ID);
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.select();
  return true;
}

/** Esc: first clears a text selection in the transcript, else stops a working session. */
function onEscape(event: KeyboardEvent, store: AppStoreApi): void {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && !isEditable(document.activeElement)) {
    selection.removeAllRanges();
    event.preventDefault();
    return;
  }
  const state = store.getState();
  const id = state.layout.selectedSessionId;
  if (state.layout.view !== "sessions" || id === null) return;
  if (selectComposer(state, id)?.working) {
    event.preventDefault();
    run(state.actions.interrupt(id));
  }
}

function onCommand(key: string, store: AppStoreApi): boolean {
  const { actions, layout, onboarding } = store.getState();
  // First run has no sessions yet: only Settings opens.
  if (onboarding !== null && key !== ",") return key === "b" || key === "n" || key === "k";
  switch (key) {
    case "b":
      if (layout.view === "sessions") actions.setSidebarOpen(!layout.sidebarOpen);
      return true;
    case "n":
      if (layout.view !== "sessions") actions.setView("sessions");
      run(actions.newSession());
      return true;
    case ",":
      actions.setView("settings");
      return true;
    case "k":
      if (layout.view !== "sessions") actions.setView("sessions");
      if (!layout.sidebarOpen) actions.setSidebarOpen(true);
      // The field may only appear after React renders the change.
      if (!focusSidebarSearch()) setTimeout(focusSidebarSearch, 0);
      return true;
    default:
      return false;
  }
}

export function useGlobalShortcuts(): void {
  const store = useAppStoreApi();
  const os = usePlatformOs();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          onEscape(event, store);
        }
        return;
      }
      if (hasCommandModifier(event, os) && onCommand(event.key.toLowerCase(), store)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, os]);
}
