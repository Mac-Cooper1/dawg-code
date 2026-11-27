import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC, type MenuModel, MenuModelSchema } from "../shared/bridge.ts";
import { createMenuSendHandlers } from "./ipc-handlers.ts";
import {
  dockMenuTemplate,
  type MenuOptions,
  menuTemplate,
  shownAccelerator,
  WITHOUT_A_WINDOW,
} from "./menu.ts";
import { createMenuBar, type MenuBarDeps } from "./menu-bar.ts";

/** A model as a window sends it: a few of each kind of entry. */
function sampleModel(overrides: Partial<MenuModel> = {}): MenuModel {
  return MenuModelSchema.parse({
    app: [
      {
        type: "item",
        id: "settings.open",
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        enabled: true,
      },
    ],
    file: [
      {
        type: "item",
        id: "session.new",
        label: "New session…",
        accelerator: "CmdOrCtrl+N",
        enabled: true,
      },
      { type: "separator" },
      { type: "item", id: "terminal.new", label: "New terminal", enabled: false },
    ],
    edit: [
      {
        type: "item",
        id: "sessions.search",
        label: "Search sessions",
        accelerator: "Alt+CmdOrCtrl+F",
        enabled: true,
      },
    ],
    view: [
      {
        type: "item",
        id: "palette.toggle",
        label: "Command palette",
        accelerator: "CmdOrCtrl+K",
        enabled: true,
      },
      {
        type: "submenu",
        label: "Appearance",
        enabled: true,
        items: [
          { type: "item", id: "appearance.dark", label: "Dark", enabled: true, checked: true },
          { type: "item", id: "appearance.light", label: "Light", enabled: true, checked: false },
        ],
      },
    ],
    session: [
      {
        type: "item",
        id: "session.stop",
        label: "Stop the running turn",
        accelerator: "Escape",
        enabled: true,
      },
      { type: "submenu", label: "Effort", enabled: false, items: [] },
      { type: "item", id: "session.fork", label: "Fork", enabled: false },
    ],
    help: [
      {
        type: "item",
        id: "help.shortcuts",
        label: "Keyboard shortcuts",
        accelerator: "CmdOrCtrl+/",
        enabled: true,
      },
      { type: "item", id: "help.github", label: "dawg-code on GitHub", enabled: true },
    ],
    dock: [
      { type: "item", id: "dock.needs-you", label: "Needs you", enabled: false },
      { type: "item", id: "session.open:s1", label: "Fix the flaky test", enabled: true },
      { type: "separator" },
      {
        type: "item",
        id: "session.new",
        label: "New session…",
        accelerator: "CmdOrCtrl+N",
        enabled: true,
      },
    ],
    ...overrides,
  });
}

function options(overrides: Partial<MenuOptions> = {}): MenuOptions {
  return {
    appName: "dawg-code",
    isDev: false,
    platform: "darwin",
    model: sampleModel(),
    hasWindow: true,
    onAction: () => {},
    onRestartEngineHost: () => {},
    ...overrides,
  };
}

function submenuOf(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  const submenu = item?.submenu;
  if (!Array.isArray(submenu)) throw new Error(`no submenu in ${item?.label ?? item?.role}`);
  return submenu;
}

function menuNamed(template: MenuItemConstructorOptions[], name: string) {
  return submenuOf(template.find((item) => item.label === name || item.role === name));
}

/** Every item, depth first. */
function allItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) =>
    Array.isArray(item.submenu) ? [item, ...allItems(item.submenu)] : [item],
  );
}

function byId(template: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const found = allItems(template).find((item) => item.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

const roles = (items: MenuItemConstructorOptions[]) =>
  items.map((item) => item.role ?? item.id ?? item.type);

/** Chooses an item as Electron does, with the mouse or (`byKeys`) with its keys. */
function click(item: MenuItemConstructorOptions, byKeys = false): void {
  (item.click as (item: unknown, window: unknown, event: unknown) => void)({}, undefined, {
    triggeredByAccelerator: byKeys,
    altKey: false,
    ctrlKey: false,
    metaKey: byKeys,
    shiftKey: false,
  });
}

describe("the menu bar", () => {
  it("has macOS's menus in their places, with dawg's Session menu", () => {
    const template = menuTemplate(options());
    expect(template.map((item) => item.label ?? item.role)).toEqual([
      "dawg-code",
      "File",
      "Edit",
      "View",
      "Session",
      "Developer",
      "windowMenu",
      "help",
    ]);
  });

  it("keeps the roles, with Settings… after About", () => {
    const template = menuTemplate(options());
    expect(roles(menuNamed(template, "dawg-code"))).toEqual([
      "about",
      "separator",
      "settings.open",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    expect(roles(menuNamed(template, "Edit"))).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
      "separator",
      "sessions.search",
    ]);
    expect(roles(menuNamed(template, "File"))).toEqual([
      "session.new",
      "separator",
      "terminal.new",
      "separator",
      "close",
    ]);
    expect(roles(menuNamed(template, "View")).slice(-5)).toEqual([
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "separator",
      "togglefullscreen",
    ]);
    // Roles keep their own keys, registered with the system.
    for (const item of allItems(template).filter((entry) => entry.role)) {
      expect(item.registerAccelerator, item.role).toBeUndefined();
      expect(item.accelerator, item.role).toBeUndefined();
    }
  });

  it("adds the developer items only in development", () => {
    const view = (isDev: boolean) => roles(menuNamed(menuTemplate(options({ isDev })), "View"));
    expect(view(false)).not.toContain("toggleDevTools");
    expect(view(true)).toEqual(
      expect.arrayContaining(["reload", "forceReload", "toggleDevTools", "togglefullscreen"]),
    );
    const restart = vi.fn();
    const developer = menuNamed(
      menuTemplate(options({ onRestartEngineHost: restart })),
      "Developer",
    );
    expect(developer[0]?.label).toBe("Restart the engine host");
    click(developer[0] as MenuItemConstructorOptions);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("shows the registry's keys without registering them", () => {
    const template = menuTemplate(options());
    for (const [id, keys] of [
      ["settings.open", "CmdOrCtrl+,"],
      ["session.new", "CmdOrCtrl+N"],
      ["palette.toggle", "CmdOrCtrl+K"],
      ["sessions.search", "Alt+CmdOrCtrl+F"],
      ["help.shortcuts", "CmdOrCtrl+/"],
    ] as const) {
      expect(byId(template, id)).toMatchObject({ accelerator: keys, registerAccelerator: false });
    }
  });

  it("never shows keys without ⌘ on macOS, where the menu would take them from the window", () => {
    expect(byId(menuTemplate(options()), "session.stop").accelerator).toBeUndefined();
    expect(byId(menuTemplate(options({ platform: "linux" })), "session.stop")).toMatchObject({
      accelerator: "Escape",
      registerAccelerator: false,
    });
    expect(shownAccelerator("Escape", "darwin")).toBeUndefined();
    expect(shownAccelerator("Shift+Tab", "darwin")).toBeUndefined();
    expect(shownAccelerator("Shift+CmdOrCtrl+]", "darwin")).toBe("Shift+CmdOrCtrl+]");
    expect(shownAccelerator("Alt+Command+1", "darwin")).toBe("Alt+Command+1");
    expect(shownAccelerator(undefined, "darwin")).toBeUndefined();
  });

  it("greys out and ticks what the window's model says", () => {
    const template = menuTemplate(options());
    expect(byId(template, "session.new").enabled).toBe(true);
    expect(byId(template, "terminal.new").enabled).toBe(false);
    expect(byId(template, "session.fork").enabled).toBe(false);
    expect(byId(template, "appearance.dark")).toMatchObject({ type: "checkbox", checked: true });
    expect(byId(template, "appearance.light")).toMatchObject({ type: "checkbox", checked: false });
    expect(byId(template, "session.new").type).toBeUndefined();
    const effort = menuNamed(template, "Session").find((item) => item.label === "Effort");
    expect(effort?.enabled).toBe(false);
  });

  it("keeps only what can open a window enabled while none is open", () => {
    const template = menuTemplate(options({ hasWindow: false }));
    const enabled = allItems(template)
      .filter((item) => item.id !== undefined && item.enabled)
      .map((item) => item.id);
    expect(enabled.sort()).toEqual([
      "help.github",
      "help.shortcuts",
      "session.new",
      "settings.open",
    ]);
    expect([...WITHOUT_A_WINDOW].sort()).toEqual(enabled);
    expect(byId(template, "palette.toggle").enabled).toBe(false);
    expect(byId(template, "sessions.search").enabled).toBe(false);
  });

  it("has the roles but no Session menu before a window has sent its model", () => {
    const template = menuTemplate(options({ model: null }));
    expect(template.some((item) => item.label === "Session")).toBe(false);
    expect(roles(menuNamed(template, "File"))).toEqual(["close"]);
    expect(roles(menuNamed(template, "dawg-code"))[0]).toBe("about");
    expect(roles(menuNamed(template, "dawg-code"))[1]).toBe("separator");
    expect(menuNamed(template, "help")).toEqual([]);
  });
});

describe("the Dock menu", () => {
  it("lists the model's Dock items, with no keys", () => {
    const chosen: string[] = [];
    const template = dockMenuTemplate(sampleModel(), (id) => chosen.push(id));
    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "Needs you",
      "Fix the flaky test",
      "separator",
      "New session…",
    ]);
    expect(template[0]?.enabled).toBe(false);
    for (const item of template) expect(item.accelerator).toBeUndefined();
    click(template[1] as MenuItemConstructorOptions);
    click(template[3] as MenuItemConstructorOptions);
    expect(chosen).toEqual(["session.open:s1", "session.new"]);
    expect(dockMenuTemplate(null, () => {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Which window the menus are for, and where a chosen item goes
// ---------------------------------------------------------------------------------------------

interface Harness {
  deps: MenuBarDeps;
  focused: number | null;
  open: number[];
  sent: [number, string][];
  forward: number[];
  opened: number;
  sessions: string[];
  projectPages: number;
  bars: MenuItemConstructorOptions[][];
  docks: MenuItemConstructorOptions[][];
  later: (() => void)[];
}

function harness(): Harness {
  const h: Harness = {
    focused: null,
    open: [],
    sent: [],
    forward: [],
    opened: 0,
    sessions: [],
    projectPages: 0,
    bars: [],
    docks: [],
    later: [],
    deps: undefined as never,
  };
  h.deps = {
    template: { appName: "dawg-code", isDev: false, platform: "darwin", onRestartEngineHost() {} },
    show: (bar, dock) => {
      h.bars.push(bar);
      h.docks.push(dock);
    },
    focusedWindow: () => h.focused,
    openWindows: () => h.open,
    bringForward: (id) => h.forward.push(id),
    openMainWindow: () => {
      h.opened += 1;
      const id = 100 + h.opened;
      h.open = [...h.open, id];
      return id;
    },
    sendAction: (id, actionId) => h.sent.push([id, actionId]),
    openSession: (sessionId) => h.sessions.push(sessionId),
    openProjectPage: () => {
      h.projectPages += 1;
    },
    later: (task) => h.later.push(task),
  };
  return h;
}

const lastBar = (h: Harness) => h.bars.at(-1) ?? [];
const lastDock = (h: Harness) => h.docks.at(-1) ?? [];
const labelled = (label: string): Partial<MenuModel> => ({
  file: [{ type: "item", id: "session.new", label, enabled: true }],
});

describe("the menus across windows", () => {
  it("shows the focused window's model, and the last one focused when none is", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    bar.render();
    expect(lastBar(h).some((item) => item.label === "Session")).toBe(false);
    h.open = [1, 2];
    h.focused = 1;
    bar.update(1, sampleModel(labelled("One")));
    bar.update(2, sampleModel(labelled("Two")));
    expect(byId(lastBar(h), "session.new").label).toBe("One");
    h.focused = 2;
    bar.render();
    expect(byId(lastBar(h), "session.new").label).toBe("Two");
    h.focused = null;
    bar.render();
    expect(byId(lastBar(h), "session.new").label).toBe("Two");
    // A window that is not the one shown updates silently.
    const shown = h.bars.length;
    bar.update(1, sampleModel(labelled("One again")));
    expect(h.bars.length).toBe(shown);
  });

  it("sends a clicked item to the focused window and draws the menus again after", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(1, sampleModel());
    const shown = h.bars.length;
    click(byId(lastBar(h), "appearance.light"));
    expect(h.sent).toEqual([[1, "appearance.light"]]);
    expect(h.forward).toEqual([]);
    for (const task of h.later.splice(0)) task();
    expect(h.bars.length).toBe(shown + 1);
  });

  it("leaves it to the window to tell an item chosen with its keys", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(1, sampleModel());
    click(byId(lastBar(h), "palette.toggle"), true);
    expect(h.sent).toEqual([[1, "palette.toggle"]]);
  });

  it("brings an unfocused window forward for a clicked item", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(1, sampleModel());
    h.focused = null;
    click(byId(lastBar(h), "palette.toggle"));
    expect(h.forward).toEqual([1]);
    expect(h.sent).toEqual([[1, "palette.toggle"]]);
  });

  it("with no window open, opens one and runs the item once its page is listening", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(1, sampleModel());
    h.open = [];
    h.focused = null;
    bar.windowClosed(1);
    expect(byId(lastBar(h), "session.new").enabled).toBe(true);
    expect(byId(lastBar(h), "palette.toggle").enabled).toBe(false);
    // ⌘N with no window: the keys reach the menu directly, and choose the item.
    click(byId(lastBar(h), "session.new"));
    expect(h.opened).toBe(1);
    expect(h.sent).toEqual([]);
    bar.update(101, sampleModel());
    expect(h.sent).toEqual([[101, "session.new"]]);
  });

  it("holds items for a page that is loading until it sends its model again", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(1, sampleModel());
    bar.pageLoading(1);
    click(byId(lastBar(h), "palette.toggle"));
    expect(h.sent).toEqual([]);
    bar.update(1, sampleModel());
    expect(h.sent).toEqual([[1, "palette.toggle"]]);
  });

  it("opens sessions and the project page itself, and brings the window forward for the Dock", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(1, sampleModel());
    const dock = lastDock(h);
    click(dock.find((item) => item.id === "session.open:s1") as MenuItemConstructorOptions);
    expect(h.sessions).toEqual(["s1"]);
    click(dock.find((item) => item.id === "session.new") as MenuItemConstructorOptions);
    expect(h.forward).toEqual([1]);
    expect(h.sent).toEqual([[1, "session.new"]]);
    click(byId(lastBar(h), "help.github"));
    expect(h.projectPages).toBe(1);
    expect(h.sent).toHaveLength(1);
  });

  it("ignores a Dock session whose id is not one", () => {
    const h = harness();
    const bar = createMenuBar(h.deps);
    h.open = [1];
    h.focused = 1;
    bar.update(
      1,
      sampleModel({
        dock: [
          { type: "item", id: `session.open:${"x".repeat(300)}`, label: "Long", enabled: true },
        ],
      }),
    );
    click(lastDock(h)[0] as MenuItemConstructorOptions);
    expect(h.sessions).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe("the menu IPC", () => {
  it("validates a window's model before it reaches the menus", () => {
    const updates: [string, MenuModel][] = [];
    const logs: string[] = [];
    const handlers = createMenuSendHandlers<string>(
      { update: (sender, model) => updates.push([sender, model]) },
      (message) => logs.push(message),
    );
    const update = handlers[IPC.menuUpdate];
    if (!update) throw new Error("no menu handler");
    const good = sampleModel();
    const item = { type: "item", id: "x", label: "X", enabled: true };
    const bad: unknown[] = [
      undefined,
      "menu",
      { ...good, extra: [] },
      { ...good, dock: undefined },
      { ...good, file: [{ ...item, accelerator: "Hyper+K" }] },
      { ...good, file: [{ ...item, accelerator: "CmdOrCtrl+KK" }] },
      { ...good, file: [{ ...item, label: "" }] },
      { ...good, file: [{ ...item, label: "x".repeat(201) }] },
      { ...good, file: [{ ...item, id: "" }] },
      { ...good, file: [{ ...item, enabled: "yes" }] },
      { ...good, file: [{ ...item, click: "alert(1)" }] },
      { ...good, file: [{ type: "role", role: "quit" }] },
      {
        ...good,
        view: [
          {
            type: "submenu",
            label: "Deep",
            enabled: true,
            items: [{ type: "submenu", label: "Deeper", enabled: true, items: [] }],
          },
        ],
      },
      { ...good, file: Array.from({ length: 101 }, () => item) },
    ];
    for (const model of bad) update("window-1", [model]);
    expect(updates).toEqual([]);
    expect(logs).toHaveLength(bad.length);
    expect(logs[0]).toMatch(/^Dropped "dawg:menu:update": Invalid menu/);
    update("window-1", [good]);
    expect(updates).toEqual([["window-1", good]]);
  });
});
