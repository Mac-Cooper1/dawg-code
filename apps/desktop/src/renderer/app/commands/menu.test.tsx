import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MenuEntry,
  type MenuItemModel,
  type MenuModel,
  MenuModelSchema,
  PROJECT_URL,
} from "../../../shared/bridge.ts";
import type { AppState, AppStore } from "../../state/types.ts";
import { paletteFor } from "../palette/controller.ts";
import { buildMenuModel, DOCK_NEEDS_YOU, DOCK_SESSIONS, menuAccelerator } from "./menu.ts";
import {
  createMenuBar,
  type KeyTarget,
  MENU_DELAY_MS,
  PASSED_ON_MS,
  runMenuAction,
} from "./menu-bar.ts";
import { commandById, dynamicCommands } from "./registry.ts";
import { SHORTCUTS } from "./shortcuts.ts";
import { SAMPLE_SESSIONS, sessionsStore } from "./testing.ts";

/** Every item in a menu, submenus included. */
function items(entries: readonly MenuEntry[]): MenuItemModel[] {
  return entries.flatMap((entry) => {
    if (entry.type === "item") return [entry];
    if (entry.type === "submenu") return entry.items.filter((item) => item.type === "item");
    return [];
  });
}

function everyItem(model: MenuModel): MenuItemModel[] {
  return Object.values(model).flatMap((section) => items(section));
}

function item(model: MenuModel, id: string): MenuItemModel {
  const found = everyItem(model).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

function submenu(entries: readonly MenuEntry[], label: string) {
  const found = entries.find((entry) => entry.type === "submenu" && entry.label === label);
  if (found?.type !== "submenu") throw new Error(`no submenu ${label}`);
  return found;
}

const labels = (entries: readonly MenuEntry[]) =>
  entries.map((entry) => (entry.type === "separator" ? "—" : entry.label));

describe("the menu model", () => {
  it("is built from registry actions only, and main accepts it", () => {
    const { store } = sessionsStore();
    const state = store.getState();
    const model = buildMenuModel(state);
    expect(MenuModelSchema.parse(model)).toEqual(model);
    const dynamic = new Set(dynamicCommands(state).map((command) => command.id));
    for (const entry of everyItem(model)) {
      if (entry.id === DOCK_NEEDS_YOU || entry.id.startsWith("session.open:")) continue;
      expect(commandById(entry.id) !== undefined || dynamic.has(entry.id), entry.id).toBe(true);
    }
    // Ids are unique within the menu bar (main finds items by id).
    const bar = Object.entries(model)
      .filter(([name]) => name !== "dock")
      .flatMap(([, section]) => items(section).map((entry) => entry.id));
    expect(new Set(bar).size).toBe(bar.length);
  });

  it("lays out File, View, Session and Help", () => {
    const { store } = sessionsStore();
    const model = buildMenuModel(store.getState());
    expect(labels(model.app)).toEqual(["Settings…"]);
    expect(labels(model.file)).toEqual([
      "New session…",
      "New session in a worktree…",
      "New session in the project folder",
      "—",
      "New terminal",
    ]);
    expect(labels(model.edit)).toEqual(["Search sessions"]);
    expect(labels(model.view)).toEqual([
      "Hide sidebar",
      "Show panes",
      "Panes",
      "—",
      "Command palette",
      "—",
      "Appearance",
      "Tool calls",
    ]);
    expect(labels(submenu(model.view, "Panes").items)).toEqual([
      "Changes",
      "Files",
      "Terminal",
      "Plan",
      "Tasks",
    ]);
    expect(labels(submenu(model.view, "Appearance").items)).toEqual([
      "Dark",
      "Light",
      "Match macOS",
    ]);
    expect(labels(submenu(model.view, "Tool calls").items)).toEqual([
      "Open what needs a look",
      "All closed",
      "All open",
    ]);
    expect(labels(model.session)).toEqual([
      "Next session",
      "Previous session",
      "—",
      "Stop the running turn",
      "Send the held message now",
      "Compact the conversation",
      "—",
      "Mode",
      "Model",
      "Effort",
      "—",
      "Rename…",
      "Fork",
      "Mark as unread",
      "—",
      "Archive",
      "Delete…",
    ]);
    expect(labels(submenu(model.session, "Mode").items)).toEqual([
      "Ask first",
      "Accept edits",
      "Plan",
      "Don’t ask",
      "Bypass",
    ]);
    expect(labels(submenu(model.session, "Model").items)).toContain("Qwen3.8 27B (8-bit)");
    expect(labels(submenu(model.session, "Effort").items)).toEqual(
      expect.arrayContaining(["Model default", "high", "xhigh"]),
    );
    expect(labels(model.help)).toEqual(["Keyboard shortcuts", "—", "dawg-code on GitHub"]);
  });

  it("shows the keys the window runs, and only those", () => {
    const { store } = sessionsStore();
    const model = buildMenuModel(store.getState());
    expect(item(model, "settings.open").accelerator).toBe("CmdOrCtrl+,");
    expect(item(model, "session.new").accelerator).toBe("CmdOrCtrl+N");
    expect(item(model, "palette.toggle").accelerator).toBe("CmdOrCtrl+K");
    expect(item(model, "sidebar.toggle").accelerator).toBe("CmdOrCtrl+B");
    expect(item(model, "panes.toggle").accelerator).toBe("Alt+CmdOrCtrl+B");
    expect(item(model, "pane.files").accelerator).toBe("Alt+CmdOrCtrl+2");
    expect(item(model, "session.next").accelerator).toBe("Shift+CmdOrCtrl+]");
    expect(item(model, "session.previous").accelerator).toBe("Shift+CmdOrCtrl+[");
    expect(item(model, "sessions.search").accelerator).toBe("Alt+CmdOrCtrl+F");
    expect(item(model, "help.shortcuts").accelerator).toBe("CmdOrCtrl+/");
    // Main leaves Esc off on macOS, where the menu would take it from the window.
    expect(item(model, "session.stop").accelerator).toBe("Escape");
    for (const entry of everyItem(model)) {
      if (entry.accelerator === undefined) continue;
      const command = commandById(entry.id);
      expect(command?.shortcut?.scope, entry.id).toBe("window");
    }
    // ⇧Tab cycles the mode only in the message field: not shown, and not in the menu at all.
    expect(everyItem(model).some((entry) => entry.id === "mode.cycle")).toBe(false);
  });

  it("converts shortcuts to Electron's accelerators", () => {
    expect(menuAccelerator(SHORTCUTS.palette)).toBe("CmdOrCtrl+K");
    expect(menuAccelerator(SHORTCUTS.settings)).toBe("CmdOrCtrl+,");
    expect(menuAccelerator(SHORTCUTS.keyboardShortcuts)).toBe("CmdOrCtrl+/");
    expect(menuAccelerator(SHORTCUTS.nextSession)).toBe("Shift+CmdOrCtrl+]");
    expect(menuAccelerator(SHORTCUTS.tasksPane)).toBe("Alt+CmdOrCtrl+5");
    expect(menuAccelerator(SHORTCUTS.stop)).toBe("Escape");
    expect(menuAccelerator({ key: "Enter", mod: true })).toBe("CmdOrCtrl+Return");
    expect(menuAccelerator({ key: "ArrowUp", ctrl: true })).toBe("Ctrl+Up");
    expect(menuAccelerator({ key: "1–9" })).toBeUndefined();
    expect(menuAccelerator({ key: "@" })).toBeUndefined();
  });

  it("greys out the session's actions while no session shows", () => {
    const { store } = sessionsStore({ selected: null });
    const model = buildMenuModel(store.getState());
    for (const id of [
      "session.fork",
      "session.rename",
      "session.archive",
      "session.delete",
      "session.stop",
      "session.compact",
      "terminal.new",
      "panes.toggle",
      "pane.changes",
      "mode.plan",
    ]) {
      expect(item(model, id).enabled, id).toBe(false);
    }
    expect(submenu(model.session, "Mode").enabled).toBe(false);
    expect(submenu(model.session, "Model")).toMatchObject({ enabled: false, items: [] });
    expect(submenu(model.session, "Effort")).toMatchObject({ enabled: false, items: [] });
    for (const id of ["session.new", "session.next", "settings.open", "palette.toggle"]) {
      expect(item(model, id).enabled, id).toBe(true);
    }
  });

  it("follows the session that shows: what runs, what is ticked", () => {
    const { store } = sessionsStore({
      open: { fix: { activeTurnId: "t1" } },
      patch: (state) => ({
        settings: { ...state.settings, appearance: "light", toolCalls: "open" },
        layout: { ...state.layout, dockOpen: true, dockPane: "terminal" },
      }),
    });
    const model = buildMenuModel(store.getState());
    expect(item(model, "session.stop").enabled).toBe(true);
    expect(item(model, "session.send-held").enabled).toBe(false);
    expect(item(model, "mode.default").checked).toBe(true);
    expect(item(model, "mode.plan").checked).toBe(false);
    expect(item(model, "model:qwen3.8-27b-q8").checked).toBe(true);
    expect(item(model, "model:gpt-oss-20b-q4").checked).toBe(false);
    expect(item(model, "effort:default").checked).toBe(true);
    expect(item(model, "appearance.light").checked).toBe(true);
    expect(item(model, "appearance.system").checked).toBe(false);
    expect(item(model, "tool-calls.open").checked).toBe(true);
    expect(item(model, "pane.terminal").checked).toBe(true);
    expect(item(model, "pane.files").checked).toBe(false);
    expect(labels(model.view).slice(0, 2)).toEqual(["Hide sidebar", "Hide panes"]);
    // Plain actions carry no tick at all.
    expect(item(model, "session.fork").checked).toBeUndefined();
  });

  it("says Show sidebar while it is hidden, and ticks no pane while the dock is closed", () => {
    const { store } = sessionsStore({
      patch: (state) => ({ layout: { ...state.layout, sidebarOpen: false, dockOpen: false } }),
    });
    const model = buildMenuModel(store.getState());
    expect(labels(model.view).slice(0, 2)).toEqual(["Show sidebar", "Show panes"]);
    expect(items(submenu(model.view, "Panes").items).map((entry) => entry.checked)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("keeps Settings, appearance and help on first run, and greys out the rest", () => {
    const { store } = sessionsStore({ patch: () => ({ onboarding: { step: "welcome" } }) });
    const model = buildMenuModel(store.getState());
    for (const id of [
      "settings.open",
      "appearance.dark",
      "tool-calls.smart",
      "palette.toggle",
      "help.shortcuts",
      "help.github",
    ]) {
      expect(item(model, id).enabled, id).toBe(true);
    }
    for (const id of ["session.new", "session.new-worktree", "terminal.new", "sidebar.toggle"]) {
      expect(item(model, id).enabled, id).toBe(false);
    }
  });

  it("lists the sessions that need the person in the Dock menu, newest first", () => {
    const { store } = sessionsStore({
      patch: (state) => ({
        pending: { csv: [{ kind: "permission", requestId: "r1", turnId: "t1" }] },
        sessions: {
          ...state.sessions,
          // `waiting` before the request itself arrives counts too; archived ones do not.
          links: { ...(state.sessions.links as AppState["sessions"][string]), status: "waiting" },
          old: { ...(state.sessions.old as AppState["sessions"][string]), status: "waiting" },
        },
      }),
    });
    const model = buildMenuModel(store.getState());
    expect(labels(model.dock)).toEqual([
      "Needs you",
      "Flaky CSV import test",
      "Fix broken links in docs",
      "—",
      "New session…",
      "Settings…",
    ]);
    expect(item(model, DOCK_NEEDS_YOU).enabled).toBe(false);
    expect(items(model.dock)[1]?.id).toBe("session.open:csv");

    const quiet = buildMenuModel(sessionsStore().store.getState());
    expect(labels(quiet.dock)).toEqual(["New session…", "Settings…"]);
  });

  it("lists at most a few sessions in the Dock menu", () => {
    const many = Array.from({ length: DOCK_SESSIONS + 3 }, (_, index) => ({
      ...(SAMPLE_SESSIONS[0] as (typeof SAMPLE_SESSIONS)[number]),
      id: `s${index}`,
      status: "waiting" as const,
      lastActivityAt: index,
    }));
    const { store } = sessionsStore({ summaries: many, open: {}, selected: null });
    const dock = buildMenuModel(store.getState()).dock;
    expect(items(dock).filter((entry) => entry.id.startsWith("session.open:"))).toHaveLength(
      DOCK_SESSIONS,
    );
    expect(items(dock)[1]?.id).toBe(`session.open:s${DOCK_SESSIONS + 2}`);
  });
});

describe("running what the menu chose", () => {
  it("runs an action that applies, and refuses one that no longer does", () => {
    const test = sessionsStore();
    expect(runMenuAction(test.store, "darwin", "session.fork")).toBe(true);
    expect(test.actions.forkSession).toHaveBeenCalledWith("fix");
    expect(runMenuAction(test.store, "darwin", "session.stop")).toBe(false);
    expect(test.actions.interrupt).not.toHaveBeenCalled();
    expect(runMenuAction(test.store, "darwin", "no.such.action")).toBe(false);
    // Keys documented for another part of the window run nothing.
    expect(runMenuAction(test.store, "darwin", "composer.send")).toBe(false);
  });

  it("runs the state's own actions: a model, an effort level, the project page", () => {
    const test = sessionsStore();
    runMenuAction(test.store, "darwin", "model:gpt-oss-20b-q4");
    expect(test.actions.setModel).toHaveBeenCalledWith("fix", "gpt-oss-20b-q4");
    runMenuAction(test.store, "darwin", "effort:high");
    expect(test.actions.setEffort).toHaveBeenCalledWith("fix", "high");
    runMenuAction(test.store, "darwin", "help.github");
    expect(test.actions.openExternal).toHaveBeenCalledWith(PROJECT_URL);
  });

  it("closes the command palette first, then runs the action", () => {
    const test = sessionsStore();
    const palette = paletteFor(test.store);
    palette.open();
    runMenuAction(test.store, "darwin", "appearance.light");
    expect(palette.isOpen).toBe(false);
    expect(test.actions.setAppearance).not.toHaveBeenCalled();
    // The palette hands focus back, then runs what waited for it.
    palette.flush();
    expect(test.actions.setAppearance).toHaveBeenCalledWith("light");
    // The palette's own item toggles it as ⌘K does.
    palette.open();
    runMenuAction(test.store, "darwin", "palette.toggle");
    expect(palette.isOpen).toBe(false);
  });
});

describe("keeping main's menus in step", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeMenu() {
    const models: MenuModel[] = [];
    let listener: ((actionId: string) => void) | null = null;
    return {
      models,
      choose: (actionId: string) => listener?.(actionId),
      api: {
        update: (model: MenuModel) => {
          models.push(MenuModelSchema.parse(model));
        },
        onAction: (next: (actionId: string) => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
    };
  }

  it("sends the first model at once, then changes at most once per delay, and only real ones", () => {
    vi.useFakeTimers();
    const test = sessionsStore();
    const menu = fakeMenu();
    const bar = createMenuBar({ store: test.store, menu: menu.api, os: "darwin" });
    expect(menu.models).toHaveLength(1);

    test.store.setState({ layout: { ...test.store.getState().layout, sidebarOpen: false } });
    test.store.setState({ layout: { ...test.store.getState().layout, dockOpen: true } });
    expect(menu.models).toHaveLength(1);
    vi.advanceTimersByTime(MENU_DELAY_MS);
    expect(menu.models).toHaveLength(2);
    expect(labels(menu.models[1]?.view ?? []).slice(0, 2)).toEqual(["Show sidebar", "Hide panes"]);

    // A change the menus do not show sends nothing.
    test.store.setState({ layout: { ...test.store.getState().layout, sidebarWidth: 300 } });
    vi.advanceTimersByTime(MENU_DELAY_MS);
    expect(menu.models).toHaveLength(2);

    bar.dispose();
    test.store.setState({ layout: { ...test.store.getState().layout, sidebarOpen: true } });
    vi.advanceTimersByTime(MENU_DELAY_MS);
    expect(menu.models).toHaveLength(2);
    menu.choose("session.fork");
    expect(test.actions.forkSession).not.toHaveBeenCalled();
  });

  it("runs what the person chooses", () => {
    const test = sessionsStore();
    const menu = fakeMenu();
    const bar = createMenuBar({ store: test.store, menu: menu.api, os: "darwin" });
    menu.choose("pane.files");
    expect(test.actions.openPane).toHaveBeenCalledWith("files");
    menu.choose("settings.open");
    expect(test.store.getState().layout.view).toBe("settings");
    // In Settings the session's actions do not apply.
    menu.choose("session.fork");
    expect(test.actions.forkSession).not.toHaveBeenCalled();
    bar.dispose();
  });

  it("ignores an item whose keys the window just passed on, and runs it otherwise", () => {
    const test = sessionsStore();
    const menu = fakeMenu();
    const events = new EventTarget();
    let clock = 0;
    const bar = createMenuBar({
      store: test.store,
      menu: menu.api,
      os: "darwin",
      keys: events as unknown as KeyTarget,
      now: () => clock,
    });
    // A part of the window that takes ⌘K for itself.
    events.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "k") event.preventDefault();
    });
    const press = (key: string) =>
      events.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true }));
    const toggles = () => test.actions.setSidebarOpen.mock.calls.length;

    // A dialog had focus, so the window passed ⌘B on and the menu bar ran its item.
    press("b");
    menu.choose("sidebar.toggle");
    expect(toggles()).toBe(0);
    // Chosen with the mouse afterwards: it runs.
    menu.choose("sidebar.toggle");
    expect(toggles()).toBe(1);
    // Keys the window took are no reason to ignore a later click.
    press("k");
    menu.choose("sidebar.toggle");
    expect(toggles()).toBe(2);
    // Nor are another item's keys, or a press long ago.
    press("j");
    menu.choose("sidebar.toggle");
    expect(toggles()).toBe(3);
    press("b");
    clock += PASSED_ON_MS + 1;
    menu.choose("sidebar.toggle");
    expect(toggles()).toBe(4);

    bar.dispose();
  });

  it("holds what was chosen while the window connects, then runs it", async () => {
    const test = sessionsStore({
      patch: () => ({ connection: { phase: "connecting" } }) as Partial<AppStore>,
    });
    const menu = fakeMenu();
    const bar = createMenuBar({ store: test.store, menu: menu.api, os: "darwin" });
    menu.choose("session.new");
    expect(test.actions.newSession).not.toHaveBeenCalled();
    test.store.setState({ connection: { phase: "ready", engine: { name: "mock", version: "1" } } });
    await Promise.resolve();
    expect(test.actions.newSession).toHaveBeenCalledOnce();
    bar.dispose();
  });
});
