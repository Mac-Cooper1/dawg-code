import type { MenuItemConstructorOptions } from "electron";
import type { MenuEntry, MenuItemModel, MenuModel } from "../shared/bridge.ts";

/**
 * The application menu and the Dock menu, built without Electron so they are unit-tested.
 *
 * macOS's own items keep their roles: copy, paste and undo reach text fields only through them,
 * and the roles bring the standard names, keys and behaviour (About, Services, Hide, Quit,
 * Close Window, zoom, full screen, the Window menu). dawg's items come from the focused window's
 * model, built from its action registry (renderer/app/commands/menu.ts).
 *
 * Keys. A registry item shows its shortcut, but the window's own key handling stays in charge of
 * it (typing in fields, the code editor, the terminal, IME composition, keys a card or the
 * palette handles first). Items carry `registerAccelerator: false`, which keeps the keys off the
 * system on Linux and Windows. On macOS Electron registers them all the same, so:
 * - Chromium hands a ⌘-key to the page first, and offers it to the menu only when nothing in the
 *   page called `preventDefault`. The window's key handler does whenever it runs a shortcut, so
 *   the menu never runs it a second time. When the window passes on the keys (a dialog has
 *   focus, an IME is composing), the menu's item for them reaches the window, which sees that it
 *   just passed on those very keys and ignores it (renderer/app/commands/menu-bar.ts). With no
 *   window open the keys reach the menu directly and work as menu keys.
 * - macOS offers keys without ⌘ (Esc) to the menu before the page, so an item showing Esc would
 *   take it from every field, card and dialog. Those keys are not shown (`shownAccelerator`).
 * ⌘, (Settings…) works the same way as the rest; ⌘Q, ⌘H, ⌘W and the Edit keys belong to roles.
 */

/** Help → "dawg-code on GitHub": main opens the page itself, so it works with no window open. */
export const PROJECT_PAGE_ACTION = "help.github";

/**
 * What still works with no window open (on macOS the app stays running after its last window
 * closes): choosing them opens the window first. Everything else needs a window to act in.
 */
export const WITHOUT_A_WINDOW: ReadonlySet<string> = new Set([
  "session.new",
  "settings.open",
  "help.shortcuts",
  PROJECT_PAGE_ACTION,
]);

export interface MenuOptions {
  appName: string;
  isDev: boolean;
  /** `process.platform`. */
  platform: string;
  /** The model of the window the menu is for; null until a window has sent one. */
  model: MenuModel | null;
  /** False with no window open: only `WITHOUT_A_WINDOW` stays enabled. */
  hasWindow: boolean;
  onAction(actionId: string): void;
  onRestartEngineHost(): void;
}

const COMMAND_KEY = /(?:^|\+)(?:Command|Cmd|CommandOrControl|CmdOrCtrl)\+/;

/** The keys shown beside one of dawg's items; see "Keys" above. */
export function shownAccelerator(
  accelerator: string | undefined,
  platform: string,
): string | undefined {
  if (accelerator === undefined) return undefined;
  if (platform === "darwin" && !COMMAND_KEY.test(accelerator)) return undefined;
  return accelerator;
}

interface RenderContext {
  /** Null: show no keys (the Dock menu). */
  platform: string | null;
  isEnabled(item: MenuItemModel): boolean;
  choose(actionId: string): void;
}

function renderItem(item: MenuItemModel, context: RenderContext): MenuItemConstructorOptions {
  const accelerator =
    context.platform === null ? undefined : shownAccelerator(item.accelerator, context.platform);
  return {
    id: item.id,
    label: item.label,
    enabled: context.isEnabled(item),
    // A checkbox, not a radio: Electron ticks the first radio of a group when none is ticked,
    // and "none" is right for the panes with the dock closed.
    ...(item.checked === undefined ? {} : { type: "checkbox" as const, checked: item.checked }),
    ...(accelerator === undefined ? {} : { accelerator, registerAccelerator: false }),
    click: () => context.choose(item.id),
  };
}

function renderEntries(
  entries: readonly MenuEntry[],
  context: RenderContext,
): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if (entry.type === "separator") return { type: "separator" };
    if (entry.type === "item") return renderItem(entry, context);
    return {
      label: entry.label,
      enabled: entry.enabled && entry.items.length > 0,
      submenu: entry.items.map(
        (item): MenuItemConstructorOptions =>
          item.type === "separator" ? { type: "separator" } : renderItem(item, context),
      ),
    };
  });
}

/** A separator, then `items`; nothing when there are none. */
function afterSeparator(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [{ type: "separator" }, ...items] : [];
}

/** `items`, then a separator; nothing when there are none. */
function beforeSeparator(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [...items, { type: "separator" }] : [];
}

/**
 * The menu bar: dawg-code, File, Edit, View, Session, Developer, Window, Help. Session waits for
 * a window's model; the rest are always there.
 */
export function menuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const context: RenderContext = {
    platform: options.platform,
    isEnabled: (item) => item.enabled && (options.hasWindow || WITHOUT_A_WINDOW.has(item.id)),
    choose: (actionId) => options.onAction(actionId),
  };
  const section = (name: Exclude<keyof MenuModel, "dock">) =>
    options.model ? renderEntries(options.model[name], context) : [];

  const devOnly: MenuItemConstructorOptions[] = options.isDev
    ? [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
      ]
    : [];
  const session = section("session");

  return [
    {
      label: options.appName,
      submenu: [
        { role: "about" },
        ...afterSeparator(section("app")),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "File", submenu: [...beforeSeparator(section("file")), { role: "close" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        ...afterSeparator(section("edit")),
      ],
    },
    {
      label: "View",
      submenu: [
        ...beforeSeparator(section("view")),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        ...devOnly,
        { role: "togglefullscreen" },
      ],
    },
    ...(session.length > 0 ? [{ label: "Session", submenu: session }] : []),
    {
      label: "Developer",
      submenu: [{ label: "Restart the engine host", click: () => options.onRestartEngineHost() }],
    },
    { role: "windowMenu" },
    // The help role makes it macOS's Help menu, with the search field that finds menu items.
    { role: "help", submenu: section("help") },
  ];
}

/**
 * The Dock icon's menu, from the model's `dock` section. Every item opens the window if needed,
 * so all stay as the model says. Dock menus show no keys.
 */
export function dockMenuTemplate(
  model: MenuModel | null,
  choose: (actionId: string) => void,
): MenuItemConstructorOptions[] {
  if (!model) return [];
  return renderEntries(model.dock, {
    platform: null,
    isEnabled: (item) => item.enabled,
    choose: (actionId) => choose(actionId),
  });
}
