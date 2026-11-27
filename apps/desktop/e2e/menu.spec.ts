/**
 * The menu bar and the Dock menu, end to end on the mock engine: macOS's menus keep their roles,
 * dawg's items come from the window's action registry with their keys shown, they grey out and
 * tick as the window changes, and choosing one makes the window respond. The keys still work as
 * before beside them.
 *
 * Items are chosen through Electron's menus (`MenuItem.click()`), as macOS does for a click. The
 * folder picker and the browser are stubbed in main, so nothing leaves the test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { PreloadApi } from "../src/shared/bridge.ts";

const appDir = path.resolve(import.meta.dirname, "..");

type PreloadWindow = Window & { dawgPreload?: PreloadApi };

/** What main stubs record, on its global. */
type Recorder = typeof globalThis & { folderAsks?: number; opened?: string[] };

interface ItemState {
  label: string;
  enabled: boolean;
  checked: boolean;
  accelerator: string | null;
  registerAccelerator: boolean;
}

let app: ElectronApplication;
let page: Page;
let dawgHome: string;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dawgHome = await mkdtemp(path.join(tmpdir(), "dawg-menu-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  env.DAWG_HOME = dawgHome;
  env.DAWG_ENGINE = "mock";
  env.DAWG_MOCK_SPEED = "Infinity";
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.evaluate(() =>
    (window as PreloadWindow).dawgPreload?.settings.update({ appearance: "dark" }),
  );
  await app.evaluate(({ dialog, shell }) => {
    const recorder = globalThis as Recorder;
    recorder.folderAsks = 0;
    recorder.opened = [];
    dialog.showOpenDialog = (() => {
      recorder.folderAsks = (recorder.folderAsks ?? 0) + 1;
      return Promise.resolve({ canceled: true, filePaths: [] });
    }) as typeof dialog.showOpenDialog;
    shell.openExternal = async (url: string) => {
      recorder.opened?.push(url);
    };
  });
  // The window sends its menus once it has drawn.
  await expect.poll(() => item("session.new")).not.toBeNull();
});

test.afterAll(async () => {
  await app?.close();
  if (dawgHome) await rm(dawgHome, { recursive: true, force: true });
});

/** An item of the menu bar, by its action id, as Electron holds it now. */
function item(id: string): Promise<ItemState | null> {
  return app.evaluate(({ Menu }, id) => {
    const found = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!found) return null;
    return {
      label: found.label,
      enabled: found.enabled,
      checked: found.checked,
      accelerator: found.accelerator ?? null,
      registerAccelerator: found.registerAccelerator,
    };
  }, id);
}

async function itemState<K extends keyof ItemState>(id: string, key: K) {
  return (await item(id))?.[key];
}

/** Chooses a menu bar item as a click would. */
async function choose(id: string): Promise<void> {
  await app.evaluate(({ Menu }, id) => {
    const found = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!found) throw new Error(`No menu item ${id}`);
    found.click();
  }, id);
}

/** The Dock menu's labels. */
function dockLabels(): Promise<string[]> {
  return app.evaluate(
    ({ app }) => app.dock?.getMenu()?.items.map((entry) => entry.label || "—") ?? [],
  );
}

async function chooseInDock(label: string): Promise<void> {
  await app.evaluate(({ app }, label) => {
    const found = app.dock?.getMenu()?.items.find((entry) => entry.label === label);
    if (!found) throw new Error(`No Dock menu item ${label}`);
    found.click();
  }, label);
}

function row(title: string) {
  return page.getByRole("button", { name: new RegExp(`^${title}`) });
}

const sidebar = () => page.getByRole("navigation", { name: "Sessions" });
const settingsPages = () => page.getByRole("navigation", { name: "Settings pages" });
const palette = () => page.getByRole("dialog", { name: "Command palette" });

test("macOS's menus keep their roles around dawg's", async () => {
  const menus = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((entry) => ({
      label: entry.label,
      role: entry.role ?? null,
      items: (entry.submenu?.items ?? []).map((child) => child.role ?? child.id ?? child.type),
    })),
  );
  expect(menus.map((menu) => menu.label)).toEqual([
    "dawg-code",
    "File",
    "Edit",
    "View",
    "Session",
    "Developer",
    "Window",
    "Help",
  ]);
  const lower = (values: string[] | undefined) =>
    (values ?? []).map((value) => value.toLowerCase());
  expect(lower(menus[0]?.items)).toEqual([
    "about",
    "separator",
    "settings.open",
    "separator",
    "services",
    "separator",
    "hide",
    "hideothers",
    "unhide",
    "separator",
    "quit",
  ]);
  expect(lower(menus[1]?.items).at(-1)).toBe("close");
  expect(lower(menus[2]?.items)).toEqual(
    expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectall"]),
  );
  expect(lower(menus[3]?.items)).toEqual(
    expect.arrayContaining(["resetzoom", "zoomin", "zoomout", "togglefullscreen"]),
  );

  expect(await item("settings.open")).toMatchObject({
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    registerAccelerator: false,
    enabled: true,
  });
  expect(await item("session.new")).toMatchObject({
    label: "New session…",
    accelerator: "CmdOrCtrl+N",
    registerAccelerator: false,
  });
  expect(await item("palette.toggle")).toMatchObject({ accelerator: "CmdOrCtrl+K" });
  expect(await item("help.shortcuts")).toMatchObject({ accelerator: "CmdOrCtrl+/" });
  // Esc stays the window's: no key is shown, so macOS's menu never takes it.
  expect(await itemState("session.stop", "accelerator")).toBeNull();
});

test("the Session menu follows the session that shows", async () => {
  await row("Fix the failing split test").click();
  await expect.poll(() => itemState("session.fork", "enabled")).toBe(true);
  // The recorded session accepts edits and thinks at xhigh.
  await expect.poll(() => itemState("mode.acceptEdits", "checked")).toBe(true);
  await expect.poll(() => itemState("effort:xhigh", "checked")).toBe(true);
  expect(await itemState("model:qwen3.8-27b-q8", "checked")).toBe(true);

  // This one asks first, and its model has no effort set.
  await row("Flaky CSV import test").click();
  await expect.poll(() => itemState("mode.default", "checked")).toBe(true);
  expect(await itemState("mode.acceptEdits", "checked")).toBe(false);
  await expect.poll(() => itemState("effort:default", "checked")).toBe(true);

  await row("Fix the failing split test").click();
  await expect.poll(() => itemState("mode.acceptEdits", "checked")).toBe(true);
  await choose("mode.plan");
  await expect(page.getByRole("button", { name: /^Permission mode: Plan/ })).toBeVisible();
  await expect.poll(() => itemState("mode.plan", "checked")).toBe(true);
  expect(await itemState("mode.acceptEdits", "checked")).toBe(false);
  await choose("mode.acceptEdits");
  await expect(page.getByRole("button", { name: /^Permission mode: Accept edits/ })).toBeVisible();
});

test("View opens a pane and hides the panes and the sidebar", async () => {
  await choose("pane.files");
  const panes = page.getByRole("complementary", { name: "Side panes" });
  await expect(panes.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => itemState("pane.files", "checked")).toBe(true);
  await expect.poll(() => itemState("panes.toggle", "label")).toBe("Hide panes");

  await choose("panes.toggle");
  await expect(panes).toBeHidden();
  await expect.poll(() => itemState("panes.toggle", "label")).toBe("Show panes");
  expect(await itemState("pane.files", "checked")).toBe(false);

  await choose("sidebar.toggle");
  await expect(sidebar()).toBeHidden();
  await expect.poll(() => itemState("sidebar.toggle", "label")).toBe("Show sidebar");
  await choose("sidebar.toggle");
  await expect(sidebar()).toBeVisible();
});

test("the keys work as before beside the menu", async () => {
  // ⌘B once hides the sidebar once: the menu does not run it a second time.
  await page.keyboard.press("Meta+KeyB");
  await expect(sidebar()).toBeHidden();
  await expect.poll(() => itemState("sidebar.toggle", "label")).toBe("Show sidebar");
  await page.keyboard.press("Meta+KeyB");
  await expect(sidebar()).toBeVisible();

  await page.keyboard.press("Meta+KeyK");
  await expect(palette()).toBeVisible();
  await page.keyboard.press("Meta+KeyK");
  await expect(palette()).toBeHidden();

  // With a dialog open the window passes ⌘B on, and the menu bar does not run it either.
  await page.keyboard.press("Meta+KeyK");
  await expect(palette()).toBeVisible();
  await page.keyboard.press("Meta+KeyB");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await expect(palette()).toBeHidden();
  await expect(sidebar()).toBeVisible();
  expect(await itemState("sidebar.toggle", "label")).toBe("Hide sidebar");

  await page.keyboard.press("Meta+Comma");
  await expect(settingsPages()).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(sidebar()).toBeVisible();
});

test("the appearance follows the menu, and the menu follows Settings", async () => {
  await choose("appearance.light");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await expect.poll(() => itemState("appearance.light", "checked")).toBe(true);
  expect(await itemState("appearance.dark", "checked")).toBe(false);

  await page.evaluate(() =>
    (window as PreloadWindow).dawgPreload?.settings.update({ appearance: "dark" }),
  );
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await expect.poll(() => itemState("appearance.dark", "checked")).toBe(true);
  expect(await itemState("appearance.light", "checked")).toBe(false);
});

test("Settings opens from the app menu, where the session's items grey out", async () => {
  await choose("settings.open");
  await expect(settingsPages()).toBeVisible();
  await expect.poll(() => itemState("session.fork", "enabled")).toBe(false);
  expect(await itemState("settings.open", "enabled")).toBe(true);
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect.poll(() => itemState("session.fork", "enabled")).toBe(true);
});

test("the palette, a new session and the project page open from the menus", async () => {
  await choose("palette.toggle");
  await expect(palette()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette()).toBeHidden();

  await choose("session.new");
  await expect.poll(() => app.evaluate(() => (globalThis as Recorder).folderAsks ?? 0)).toBe(1);

  await choose("help.github");
  await expect
    .poll(() => app.evaluate(() => (globalThis as Recorder).opened ?? []))
    .toEqual(["https://github.com/Mac-Cooper1/dawg-code"]);
});

test("the Dock menu lists the sessions that need you, and opens them", async () => {
  await expect.poll(dockLabels).toEqual(expect.arrayContaining(["Needs you", "Add tip support"]));
  const labels = await dockLabels();
  expect(labels.slice(-2)).toEqual(["New session…", "Settings…"]);

  await chooseInDock("Add tip support");
  await expect(page.getByText("dawg is asking")).toBeVisible();

  await chooseInDock("Settings…");
  await expect(settingsPages()).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(sidebar()).toBeVisible();
});

test("no errors in the page", () => {
  expect(pageErrors).toEqual([]);
});
