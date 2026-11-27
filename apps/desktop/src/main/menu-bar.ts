/**
 * The menu bar and the Dock menu across windows: each window's model, which one the menus show,
 * and where a chosen item goes. Kept free of Electron (windows are their pages' ids) so the rules
 * are unit-tested; `index.ts` supplies the windows and shows the menus.
 *
 * - The menus show the focused window's model; with none focused, the window that had focus
 *   last; with no window open, the last model shown, where only what can open a window stays
 *   enabled (menu.ts).
 * - A chosen item goes to that window, which checks it still applies and runs it. A window gets
 *   items only once it has sent its first model, so its listener is there; until then they wait.
 *   Whether an item came by its keys is the window's to judge (see "Keys" in menu.ts).
 * - The Dock menu brings the window forward first, opening it when none is open; a session that
 *   needs the person opens in it as a clicked notification does.
 */
import type { MenuItemConstructorOptions } from "electron";
import { MENU_OPEN_SESSION, type MenuModel, SessionRefSchema } from "../shared/bridge.ts";
import { dockMenuTemplate, type MenuOptions, menuTemplate, PROJECT_PAGE_ACTION } from "./menu.ts";

export interface MenuBarDeps {
  template: Pick<MenuOptions, "appName" | "isDev" | "platform" | "onRestartEngineHost">;
  /** Shows the menus: `Menu.setApplicationMenu` and `app.dock.setMenu`. */
  show(bar: MenuItemConstructorOptions[], dock: MenuItemConstructorOptions[]): void;
  /** The page id of the dawg window that has focus, or null. */
  focusedWindow(): number | null;
  /** The page ids of every open dawg window. */
  openWindows(): number[];
  bringForward(windowId: number): void;
  /** Opens the main window (it shows itself once drawn); answers its page id. */
  openMainWindow(): number;
  /** Sends a chosen action to a window's page. */
  sendAction(windowId: number, actionId: string): void;
  /** Shows a session in the main window, opening it if needed, as a clicked notification does. */
  openSession(sessionId: string): void;
  /** Opens the project's page in the browser. */
  openProjectPage(): void;
  /** Runs `task` after the current menu event (default: `setTimeout`). */
  later?(task: () => void): void;
}

export interface MenuBar {
  /** Shows the menus for the window that has focus now. */
  render(): void;
  /** A window sent its model. */
  update(windowId: number, model: MenuModel): void;
  /** A window's page started loading: it hears nothing until it sends a model again. */
  pageLoading(windowId: number): void;
  windowClosed(windowId: number): void;
}

export function createMenuBar(deps: MenuBarDeps): MenuBar {
  const later = deps.later ?? ((task: () => void) => void setTimeout(task, 0));
  const models = new Map<number, MenuModel>();
  /** Windows that have sent a model since their page loaded: their listener is there. */
  const ready = new Set<number>();
  const waiting = new Map<number, string[]>();
  let lastFocused: number | null = null;
  let shown: MenuModel | null = null;

  /** The window the menus are for, or null when none is open. */
  function menuWindow(): number | null {
    const focused = deps.focusedWindow();
    if (focused !== null) {
      lastFocused = focused;
      return focused;
    }
    const open = deps.openWindows();
    if (lastFocused !== null && open.includes(lastFocused)) return lastFocused;
    return open[0] ?? null;
  }

  function deliver(windowId: number, actionId: string): void {
    if (ready.has(windowId)) {
      deps.sendAction(windowId, actionId);
      return;
    }
    waiting.set(windowId, [...(waiting.get(windowId) ?? []), actionId]);
  }

  /** The window an action goes to, brought forward when it does not have focus. */
  function targetWindow(fromDock: boolean): number {
    const focused = deps.focusedWindow();
    if (focused !== null && !fromDock) return focused;
    const windowId = menuWindow();
    if (windowId === null) return deps.openMainWindow();
    deps.bringForward(windowId);
    return windowId;
  }

  function choose(actionId: string, fromDock: boolean): void {
    // Electron flips a checkbox's tick itself; the model decides, so draw it again.
    later(render);
    if (actionId === PROJECT_PAGE_ACTION) {
      deps.openProjectPage();
      return;
    }
    if (actionId.startsWith(MENU_OPEN_SESSION)) {
      const sessionId = SessionRefSchema.safeParse(actionId.slice(MENU_OPEN_SESSION.length));
      if (sessionId.success) deps.openSession(sessionId.data);
      return;
    }
    deliver(targetWindow(fromDock), actionId);
  }

  function render(): void {
    const windowId = menuWindow();
    if (windowId !== null) shown = models.get(windowId) ?? shown;
    deps.show(
      menuTemplate({
        ...deps.template,
        model: shown,
        hasWindow: windowId !== null,
        onAction: (actionId) => choose(actionId, false),
      }),
      dockMenuTemplate(shown, (actionId) => choose(actionId, true)),
    );
  }

  return {
    render,
    update(windowId, model) {
      models.set(windowId, model);
      if (!ready.has(windowId)) {
        ready.add(windowId);
        const held = waiting.get(windowId) ?? [];
        waiting.delete(windowId);
        for (const actionId of held) deps.sendAction(windowId, actionId);
      }
      if (menuWindow() === windowId) render();
    },
    pageLoading(windowId) {
      ready.delete(windowId);
    },
    windowClosed(windowId) {
      models.delete(windowId);
      ready.delete(windowId);
      waiting.delete(windowId);
      if (lastFocused === windowId) lastFocused = null;
      render();
    },
  };
}
