/**
 * Keeps main's menu bar and Dock menu in step with this window, and runs what the person chooses
 * in them.
 *
 * The model (menu.ts) is rebuilt at most once per `delayMs` while the store changes, and sent
 * only when it differs from the last one sent, so a streaming turn costs a few cheap rebuilds a
 * second and almost no messages. The first model goes at once: main holds an action chosen
 * before the window could hear it (⌘N with no window open) until this window's first model
 * arrives.
 *
 * A chosen action runs only if the registry still says it can: the menu may have been drawn a
 * moment before the state changed.
 *
 * Keys stay the window's (see "Keys" in main/menu.ts). macOS offers a ⌘-key to the menu bar only
 * after the window has seen it and nothing called `preventDefault`. The window's key handler
 * (useShortcuts.ts) does whenever it runs a shortcut, so the menu never runs it twice. When the
 * window passes the keys on instead (a dialog or menu has focus, an IME is composing, a pane kept
 * them), the menu bar runs the matching item and its action arrives here a moment later: it is
 * ignored, because the window has just seen those very keys and not taken them.
 */
import { useEffect } from "react";
import type { DawgBridge } from "../../../shared/bridge.ts";
import { getBridge } from "../../bridge/index.ts";
import { type AppStoreApi, useAppStoreApi } from "../../state/store.ts";
import { paletteFor } from "../palette/controller.ts";
import { type PlatformOs, usePlatformOs } from "../platform.tsx";
import { commandContext } from "./dispatch.ts";
import { matchesShortcut } from "./keys.ts";
import { buildMenuModel } from "./menu.ts";
import { availability, commandById, dynamicCommands } from "./registry.ts";

/** How long a change waits before the model is rebuilt: quick enough for a menu opened next. */
export const MENU_DELAY_MS = 100;

/**
 * How long after the window passed on a key press a menu item with those keys counts as that
 * press. The menu answers within a few milliseconds; a person choosing the same item with the
 * mouse this soon after pressing its keys is not a real case.
 */
export const PASSED_ON_MS = 1000;

/**
 * Runs a chosen menu action if it can run now; false when it cannot (unknown, or it no longer
 * applies). With the command palette open, the palette closes first and the action runs once
 * focus is back, as when it is picked in the palette.
 */
export function runMenuAction(store: AppStoreApi, os: PlatformOs, actionId: string): boolean {
  const state = store.getState();
  const command =
    commandById(actionId) ?? dynamicCommands(state).find((entry) => entry.id === actionId);
  if (!command?.run || availability(command, state) !== true) return false;
  const palette = paletteFor(store);
  if (palette.isOpen && command.id !== "palette.toggle") {
    palette.whenClosed(() => runMenuAction(store, os, actionId));
    return true;
  }
  command.run(commandContext(store, os));
  return true;
}

/** Where key presses are heard: the window. */
export type KeyTarget = Pick<Window, "addEventListener" | "removeEventListener">;

export interface MenuBarDeps {
  store: AppStoreApi;
  menu: DawgBridge["menu"];
  os: PlatformOs;
  /** Default `MENU_DELAY_MS`. */
  delayMs?: number;
  /** Default: `window`, when there is one. */
  keys?: KeyTarget | null;
  /** Default: `performance.now`. */
  now?(): number;
}

export interface MenuBar {
  dispose(): void;
}

export function createMenuBar(deps: MenuBarDeps): MenuBar {
  const { store, menu, os } = deps;
  const delay = deps.delayMs ?? MENU_DELAY_MS;
  let sent: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Chosen while the window was still connecting (the menu opened it): run once it is ready. */
  let waiting: string[] = [];
  const keys = deps.keys === undefined ? (globalThis.window ?? null) : deps.keys;
  const now = deps.now ?? (() => performance.now());
  /** The window's latest ⌘ or Ctrl press; its `defaultPrevented` is final once handled. */
  let lastPress: { event: KeyboardEvent; at: number } | null = null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey) lastPress = { event, at: now() };
  };

  function send(): void {
    timer = null;
    if (disposed) return;
    const model = buildMenuModel(store.getState());
    const text = JSON.stringify(model);
    if (text === sent) return;
    try {
      menu.update(model);
      sent = text;
    } catch (error) {
      // A model main would refuse: the menus keep the last one, and the next change tries again.
      console.error("dawg-code: the menu was not updated", error);
    }
  }

  function schedule(): void {
    if (timer === null && !disposed) timer = setTimeout(send, delay);
  }

  /** The window has just seen this action's keys and not taken them: see the file comment. */
  function passedOn(actionId: string): boolean {
    const press = lastPress;
    if (!press || press.event.defaultPrevented || now() - press.at > PASSED_ON_MS) return false;
    const shortcut = commandById(actionId)?.shortcut;
    if (shortcut?.scope !== "window") return false;
    if (!shortcut.keys.some((keys) => matchesShortcut(press.event, keys, os))) return false;
    lastPress = null;
    return true;
  }

  function choose(actionId: string): void {
    if (disposed || passedOn(actionId)) return;
    if (store.getState().connection.phase === "connecting") {
      waiting.push(actionId);
      return;
    }
    runMenuAction(store, os, actionId);
  }

  // In the capture phase, so a press a part of the window stops is still seen.
  keys?.addEventListener("keydown", onKeyDown, true);
  const stopActions = menu.onAction(choose);
  const unsubscribe = store.subscribe((state) => {
    if (waiting.length > 0 && state.connection.phase !== "connecting") {
      const chosen = waiting;
      waiting = [];
      // Outside the store's listeners, which this runs in.
      queueMicrotask(() => {
        for (const actionId of chosen) choose(actionId);
      });
    }
    schedule();
  });
  send();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      keys?.removeEventListener("keydown", onKeyDown, true);
      stopActions();
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      waiting = [];
    },
  };
}

/** Mounts the menu bar for the window's life. */
export function useMenuBar(): void {
  const store = useAppStoreApi();
  const os = usePlatformOs();
  useEffect(() => {
    const menu = getBridge().menu as DawgBridge["menu"] | undefined;
    // A preload left over from an older build has none: the window still works without it.
    if (!menu) return;
    const bar = createMenuBar({ store, menu, os });
    return () => bar.dispose();
  }, [store, os]);
}
