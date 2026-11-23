import type { MenuItemConstructorOptions } from "electron";

export interface MenuOptions {
  appName: string;
  isDev: boolean;
  onRestartEngineHost(): void;
}

/**
 * The application menu. The Edit menu is not decoration: on macOS, copy, paste and undo reach
 * text fields only through menu roles.
 */
export function menuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const devOnly: MenuItemConstructorOptions[] = options.isDev
    ? [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
      ]
    : [];
  return [
    {
      label: options.appName,
      submenu: [
        { role: "about" },
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
      ],
    },
    {
      label: "View",
      submenu: [
        ...devOnly,
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Developer",
      submenu: [{ label: "Restart the engine host", click: () => options.onRestartEngineHost() }],
    },
  ];
}
