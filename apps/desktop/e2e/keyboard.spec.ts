/**
 * A keyboard-only walkthrough of the built app on the mock engine. Nothing here touches the
 * mouse: every step is a key press, and each one checks where focus lands. It moves through the
 * title bar and the sidebar, starts a session and sends a message, answers a permission card,
 * opens every pane, goes through the Settings pages, uses the command palette, opens and closes
 * the composer's menus, and checks the window follows Increase contrast, forced colours and
 * Reduce motion. A few regions are checked against ARIA snapshots, as VoiceOver would read them.
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

const appDir = path.resolve(import.meta.dirname, "..");

let app: ElectronApplication;
let page: Page;
let dawgHome: string;
let project: string;
const consoleErrors: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dawgHome = await mkdtemp(path.join(tmpdir(), "dawg-keyboard-"));
  project = await mkdtemp(path.join(tmpdir(), "dawg-keyboard-project-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  env.DAWG_HOME = dawgHome;
  env.DAWG_ENGINE = "mock";
  // Instant playback: the recorded sessions settle at once, so the sidebar's order holds still.
  env.DAWG_MOCK_SPEED = "Infinity";
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  // The folder picker is the system's; it answers with the test's project folder.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, project);
});

test.afterAll(async () => {
  await app?.close();
  if (dawgHome) await rm(dawgHome, { recursive: true, force: true });
  if (project) await rm(project, { recursive: true, force: true });
});

const composer = () => page.getByRole("textbox", { name: "Message to dawg" });
const sidebar = () => page.getByRole("navigation", { name: "Sessions" });
const row = (title: string) => sidebar().getByRole("button", { name: new RegExp(`^${title},`) });
const transcript = () => page.getByRole("log", { name: "Transcript" });
const dock = () => page.getByRole("complementary", { name: "Side panes" });
const palette = () => page.getByRole("dialog", { name: "Command palette" });

async function press(...keys: string[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(key);
}

const CONTROL_ROLES =
  "button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|tab|option|" +
  "menuitem|menuitemradio|menuitemcheckbox|treeitem|progressbar|meter|separator";
/** A control in an ARIA snapshot with no name: `- button`, `- tab [selected]`, `- radio:`. */
const UNNAMED = new RegExp(`^\\s*- (?:${CONTROL_ROLES})(?: \\[[^\\]]*\\])*:?$`);

/** Every control on screen has a name VoiceOver can read. */
async function expectNamedControls(where: string): Promise<void> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const unnamed = snapshot.split("\n").filter((line) => UNNAMED.test(line.trimEnd()));
  expect(unnamed, `controls without a name in ${where}`).toEqual([]);
}

/** Presses Tab (or another key) until `target` has focus, at most `limit` times. */
async function pressUntilFocused(
  target: ReturnType<Page["locator"]>,
  key = "Tab",
  limit = 12,
): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await press(key);
  }
  await expect(target).toBeFocused();
}

test("focus starts in the message field; F6 and the arrows cross the title bar and sidebar", async () => {
  await expect(sidebar()).toBeVisible();
  // The window opens on the last session, ready to type.
  await expect(composer()).toBeFocused();
  await expectNamedControls("the main window");

  // F6 moves between the window's parts: title bar, sidebar, main column.
  await press("F6");
  await expect(page.getByRole("button", { name: "Hide the sidebar" })).toBeFocused();
  await expect(page.getByRole("banner")).toMatchAriaSnapshot(`
    - banner:
      - button "Hide the sidebar"
      - heading [level=1]
      - navigation "Side panes":
        - button /^Changes/
        - button "Files"
        - button "Terminal"
        - button "Plan"
        - button /^Tasks/
      - button /^Switch to (dark|light) appearance$/
  `);

  await press("F6");
  // The sidebar's list keeps one row in the tab order: the selected one.
  const selected = sidebar().locator("button[data-session-row][aria-current='true']");
  await expect(selected).toBeFocused();
  const selectedTitle = ((await selected.getAttribute("aria-label")) ?? "").split(",")[0] ?? "";

  // ↑ ↓ Home End move through the rows of every project, in the order the sidebar shows them.
  const rows = sidebar().locator("button[data-session-row]");
  const titles = await rows.evaluateAll((elements) =>
    elements.map((element) => (element.getAttribute("aria-label") ?? "").split(",")[0] ?? ""),
  );
  const at = titles.indexOf(selectedTitle);
  await press(at === titles.length - 1 ? "ArrowUp" : "ArrowDown");
  await expect(rows.nth(at === titles.length - 1 ? at - 1 : at + 1)).toBeFocused();
  await press("End");
  await expect(rows.last()).toBeFocused();
  await press("Home");
  await expect(rows.first()).toBeFocused();
  const first = titles[0] ?? "";

  // Tab leaves the list in one step; Shift+Tab comes back to the row last used.
  await press("Tab");
  await expect(page.getByRole("button", { name: `Actions for ${first}` })).toBeFocused();
  await press("Shift+Tab");
  await expect(rows.first()).toBeFocused();
  await press("Shift+Tab");
  await expect(
    sidebar()
      .getByRole("button", { name: /^New session in / })
      .first(),
  ).toBeFocused();
  await press("Shift+Tab");
  await expect(page.getByRole("searchbox", { name: "Search sessions" })).toBeFocused();
  await press("Shift+Tab");
  await expect(sidebar().getByRole("button", { name: "New session", exact: true })).toBeFocused();
  await press("Tab", "Tab", "Tab");
  await expect(rows.first()).toBeFocused();
  await expect(rows.first()).toHaveAttribute("tabindex", "0");
  await expect(sidebar().locator("button[data-session-row][tabindex='0']")).toHaveCount(1);

  // Enter on a row opens that session; focus stays on the row.
  const other = titles.find((title) => title !== selectedTitle) ?? "";
  await pressUntilFocused(row(other), "ArrowDown", titles.length);
  await press("Enter");
  await expect(row(other)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 1, name: other })).toBeVisible();
  await expect(row(other)).toBeFocused();

  await expect(page.getByRole("list", { name: "notes-cli" })).toMatchAriaSnapshot(`
    - list "notes-cli":
      - listitem:
        - button /^Bump to Python 3\\.13, Error/
        - button "Actions for Bump to Python 3.13"
      - listitem:
        - button /^Export notes to Markdown, Idle, /
        - button "Actions for Export notes to Markdown"
  `);
});

test("⌘N starts a session with focus in its message field, and Enter sends", async () => {
  await press("Meta+KeyN");
  await expect(page.getByRole("heading", { level: 1, name: "New session" })).toBeVisible();
  await expect(composer()).toBeFocused();
  await page.keyboard.type("Say hello from the keyboard test.");
  await press("Enter");
  await expect(
    transcript()
      .getByRole("article", { name: "Your message" })
      .getByText("Say hello from the keyboard test."),
  ).toBeVisible();
  await expect(composer()).toBeFocused();
  await expect(composer()).toHaveValue("");
  await expect(page.getByRole("region", { name: "Composer" })).toMatchAriaSnapshot(`
    - region "Composer":
      - textbox "Message to dawg"
      - button "Attach images"
      - button /^Permission mode/
      - button /^Model/
  `);
});

test("a permission card takes focus, Enter answers it, and focus returns to the message field", async () => {
  await press("Meta+KeyK");
  const search = palette().getByRole("combobox", { name: "Search actions and sessions" });
  await expect(search).toBeFocused();
  await page.keyboard.type("Flaky CSV");
  await expect(palette().getByRole("option", { name: /^Flaky CSV import test/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await press("Enter");
  await expect(palette()).toHaveCount(0);

  const card = page.getByRole("region", { name: /^Permission needed/ });
  const allow = card.getByRole("button", { name: /^Allow once/ });
  await expect(allow).toBeFocused();
  await expectNamedControls("a permission card");
  await expect(card).toMatchAriaSnapshot(`
    - region /^Permission needed/:
      - button /^Allow once/
      - button /^Always allow/
      - button /^Deny…/
  `);
  await press("Enter");
  await expect(page.getByText("You allowed this once")).toBeVisible();
  await expect(composer()).toBeFocused();
});

test("every pane opens from the keyboard, and closing the dock gives focus back", async () => {
  await expect(composer()).toBeFocused();
  // ⌥⌘1 opens Changes and leaves focus where it was.
  await press("Alt+Meta+Digit1");
  await expect(dock().getByRole("tab", { name: /^Changes/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(composer()).toBeFocused();

  // F6 reaches the dock's selected tab; the arrows go through the panes.
  await press("F6");
  await expect(dock().getByRole("tab", { name: /^Changes/ })).toBeFocused();
  for (const name of ["Files", "Terminal", "Plan", /^Tasks/]) {
    await press("ArrowRight");
    const tab = dock().getByRole("tab", { name });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(dock().getByRole("tabpanel")).toBeVisible();
    await expectNamedControls(`the ${String(name)} pane`);
  }
  await expect(dock().getByRole("tablist", { name: "Panes" })).toMatchAriaSnapshot(`
    - tablist "Panes":
      - tab /^Changes/
      - tab "Files"
      - tab "Terminal"
      - tab "Plan"
      - tab /^Tasks/ [selected]
  `);

  // ⇧F6 goes back to the message field; the pane shortcuts switch panes from there.
  await press("Shift+F6");
  await expect(composer()).toBeFocused();
  await press("Alt+Meta+Digit3");
  await expect(dock().getByRole("tab", { name: "Terminal" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(composer()).toBeFocused();

  // The dock's close button: focus goes to the message field, not to the page.
  await press("F6", "Tab");
  await expect(dock().getByRole("button", { name: "Close the panes" })).toBeFocused();
  await press("Enter");
  await expect(dock()).toHaveCount(0);
  await expect(composer()).toBeFocused();
});

test("menus and popovers close with Esc and give focus back to their button", async () => {
  await press("Tab", "Tab");
  const mode = page.getByRole("button", { name: /^Permission mode: / });
  await expect(mode).toBeFocused();
  await press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(":focus")).toHaveCount(1);
  await expectNamedControls("the mode menu");
  await press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(mode).toBeFocused();

  // The context meter's popover (past the model and effort pills).
  const meter = page.getByRole("button", { name: /^Context used: / });
  await pressUntilFocused(meter);
  await press("Enter");
  const popover = page.getByRole("dialog", { name: /^Context · / });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("meter", { name: "Context used" })).toHaveAttribute(
    "aria-valuetext",
    /tokens, \d+%$/,
  );
  await press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(meter).toBeFocused();
});

test("Settings opens on its page list, and each page is reached with the keyboard", async () => {
  await press("Meta+Comma");
  const nav = page.getByRole("navigation", { name: "Settings pages" });
  await expect(nav.locator("[aria-current='page']")).toBeFocused();
  await expect(nav).toMatchAriaSnapshot(`
    - navigation "Settings pages":
      - button "General"
      - button "Models"
      - button "Permissions"
      - button "Project setup"
      - button "Hooks"
      - button "Skills and commands"
      - button "Subagents"
      - button "MCP servers"
      - button "Web"
      - button "Shortcuts"
  `);
  const choose = async (name: string, key: string) => {
    const button = nav.getByRole("button", { name, exact: true });
    // Shift+Tab from the last page back to the first passes every page.
    await pressUntilFocused(button, key, 10);
    await press("Enter");
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(button).toBeFocused();
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(name);
    await expectNamedControls(`Settings → ${name}`);
  };
  await choose("General", "Shift+Tab");
  await choose("Models", "Tab");
  await choose("Permissions", "Tab");
  await choose("Project setup", "Tab");
  await choose("Hooks", "Tab");
  await choose("Skills and commands", "Tab");
  await choose("Subagents", "Tab");
  await choose("MCP servers", "Tab");
  await choose("Web", "Tab");
  await choose("Shortcuts", "Tab");
  await choose("General", "Shift+Tab");

  // Back to sessions, from the title bar: the session's message field has focus again.
  await press("Shift+F6");
  await expect(page.getByRole("banner").locator(":focus")).toHaveCount(1);
  await pressUntilFocused(page.getByRole("button", { name: "Back to sessions" }));
  await press("Enter");
  await expect(composer()).toBeFocused();
});

test("the command palette runs an action and gives focus back; Esc closes it", async () => {
  await expect(composer()).toBeFocused();
  await press("Meta+KeyK");
  await expect(palette()).toMatchAriaSnapshot(`
    - dialog "Command palette":
      - combobox "Search actions and sessions"
      - listbox "Actions and sessions"
  `);
  await expectNamedControls("the command palette");
  await page.keyboard.type("hide the sidebar");
  await press("Enter");
  await expect(palette()).toHaveCount(0);
  await expect(sidebar()).toHaveCount(0);
  await expect(composer()).toBeFocused();

  await press("Meta+KeyK");
  await page.keyboard.type("show the sidebar");
  await press("Enter");
  await expect(sidebar()).toBeVisible();
  await expect(composer()).toBeFocused();

  await press("Meta+KeyK");
  await expect(palette()).toBeVisible();
  await press("Escape");
  await expect(palette()).toHaveCount(0);
  await expect(composer()).toBeFocused();
});

test("follows Increase contrast, forced colours and Reduce motion", async () => {
  const token = (name: string) =>
    page.evaluate(
      (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
      name,
    );
  expect(await token("--focus-width")).toBe("2px");
  await page.emulateMedia({ contrast: "more" });
  expect(await token("--focus-width")).toBe("3px");
  await page.emulateMedia({ contrast: "no-preference" });

  // Forced colours: the selected row keeps an outline once its fill is gone.
  await page.emulateMedia({ forcedColors: "active" });
  const selected = sidebar().locator("[aria-current='true']");
  expect(await selected.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
    "solid",
  );
  await page.emulateMedia({ forcedColors: "none" });

  // Reduce motion: animations and transitions all but stop (base.css), the spinning marks too.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const durations = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, [data-mark]")].flatMap((element) => {
      const style = getComputedStyle(element);
      return [style.transitionDuration, style.animationDuration].map((value) =>
        Number.parseFloat(value),
      );
    }),
  );
  expect(durations.length).toBeGreaterThan(0);
  for (const seconds of durations) expect(seconds).toBeLessThan(0.001);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("no errors in the page", () => {
  expect(consoleErrors).toEqual([]);
});
