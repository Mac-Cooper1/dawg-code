/**
 * The everyday features end to end, on the real engine against a real git repository and the
 * scripted mock model (`packages/mock-model`), which here can see images:
 * - Settings → General's new-session choice: "In the project folder" starts a session at once;
 * - `@` mentions: the menu finds a file, and its contents reach the model;
 * - images: an attached picture reaches the model;
 * - Settings → Permissions: a rule added there applies to the open session's next turn;
 * - a decision while dawg is in the background: the Dock badge and a notification, whose click
 *   brings the session back;
 * - the command palette (⌘K) and the keyboard shortcuts (⌘/, ⌥⌘F).
 *
 * Notifications never reach the screen: main's `Notification.prototype.show` is swapped for a
 * recorder, and both main and the page are told no window has focus.
 *
 * Saves a screenshot of each new screen in dark and light to e2e/screenshots/daily/ for design
 * review.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const appDir = path.resolve(import.meta.dirname, "..");
const shotDir = path.join(import.meta.dirname, "screenshots", "daily");
const repoRoot = path.resolve(appDir, "..", "..");
const mockCli = path.join(repoRoot, "packages", "mock-model", "src", "cli.ts");

const TITLE = "Daily use";
const MENTIONED = "The readme is a heading and one line.";
const SEEN = "A single red dot.";
const ALLOWED = "Made the file the rule allows.";
const ASKED = "Made the other file after asking.";
const ALLOW_RULE = "Bash(touch allowed-by-rule.txt)";

/** A 2 × 2 red PNG. */
const RED_DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4r6AARAwQCgAmbgT90I7UiAAAAABJRU5ErkJggg==",
  "base64",
);

/** What the test reads of a notification main recorded instead of showing. */
interface RecordedNotification {
  title: string;
  body: string;
  emit(event: "click"): void;
}

let root: string;
let project: string;
let mock: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

function git(...args: string[]): string {
  return execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
}

/** Starts the mock model server and resolves with its OpenAI root (`http://127.0.0.1:n/v1`). */
async function startMockServer(scriptFile: string): Promise<string> {
  const child = spawn(process.execPath, [mockCli, "--script", scriptFile, "--port", "0"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  mock = child;
  child.stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[mock-model] ${chunk}`));
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The mock model server did not start")),
      15_000,
    );
    child.once("exit", (code) => reject(new Error(`The mock model server exited (${code})`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).once("line", (line) => {
      clearTimeout(timer);
      const listening = JSON.parse(line) as { event: string; baseUrl: string };
      if (listening.event === "listening") resolve(listening.baseUrl);
      else reject(new Error(`Unexpected first line from the mock model server: ${line}`));
    });
  });
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-daily-"));
  project = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# Daily use\n\nA project for the test.\n");
  await writeFile(path.join(project, "src", "answer.ts"), "export const answer = 42;\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "dawg e2e");
  git("config", "user.email", "e2e@example.invalid");
  git("add", ".");
  git("commit", "-q", "-m", "Start");

  const bash = (command: string, description: string) => ({
    toolCalls: [{ name: "Bash", arguments: { command, description } }],
  });
  const script = {
    server: { model: "e2e-vision", contextWindow: 32_768, capabilities: { vision: true } },
    // Turns that match no lane, in order.
    replies: [
      bash("touch allowed-by-rule.txt", "Create the file the rule allows"),
      { text: ALLOWED },
      bash("touch needs-asking.txt", "Create a file no rule covers"),
      { text: ASKED },
    ],
    // Tried in this order, before the replies above.
    lanes: {
      title: {
        match: { system: "short title" },
        replies: [{ text: TITLE }, { text: TITLE }, { text: TITLE }],
      },
      mention: { match: { lastUser: "mentioned by the person" }, replies: [{ text: MENTIONED }] },
      image: {
        match: { lastUser: "What is in this picture", bodyIncludes: "data:image/" },
        replies: [{ text: SEEN }],
      },
    },
  };
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(script));
  const serverUrl = await startMockServer(scriptFile);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE;
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  env.HOME = home;
  env.SHELL = "/bin/zsh";
  env.DAWG_TEST_SERVER_URL = serverUrl;

  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // The folder picker answers with the test's project instead of opening.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, project);
});

test.afterAll(async () => {
  await app?.close();
  mock?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (pageErrors.length > 0) console.log(`Errors in the page:\n${pageErrors.join("\n")}`);
});

const transcript = () => page.getByRole("log", { name: "Transcript" });
const composer = () => page.getByRole("textbox", { name: "Message to dawg" });
const settingsPage = (name: string) =>
  page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name, exact: true });
const backToSessions = () => page.getByRole("button", { name: "Back to sessions" });
const allowOnce = () => page.getByRole("button", { name: /^Allow once/, disabled: false });
const dockBadge = () => app?.evaluate(({ app: electronApp }) => electronApp.dock?.getBadge() ?? "");

/** Screenshots the window in dark, then light, then returns to dark. */
async function shoot(name: string): Promise<void> {
  mkdirSync(shotDir, { recursive: true });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate(
      (appearance) =>
        (
          window as unknown as {
            dawgPreload?: { settings: { update(patch: { appearance: string }): Promise<unknown> } };
          }
        ).dawgPreload?.settings.update({ appearance }),
      theme,
    );
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotDir, `${name}-${theme}.png`) });
  }
}

async function send(text: string) {
  await composer().click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("with “In the project folder” chosen, a new session starts without asking", async () => {
  // The window exists before its page has loaded; a key pressed then goes nowhere.
  await expect(page.getByRole("button", { name: /Ready\. Model settings$/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press("Meta+Comma");
  await expect(page.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
  await page.getByRole("radio", { name: /In the project folder/ }).click();
  await expect(page.getByRole("radio", { name: /In the project folder/ })).toBeChecked();
  await page.getByRole("heading", { name: "Notifications" }).scrollIntoViewIfNeeded();
  await shoot("01-general");
  await backToSessions().click();

  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("@ finds a file, and its contents reach the model", async () => {
  await composer().click();
  await page.keyboard.type("Summarise @READ");
  const files = page.getByRole("listbox", { name: "Files" });
  await expect(files.getByRole("option", { name: "README.md" })).toBeVisible();
  await shoot("02-mention-menu");
  await page.keyboard.press("Enter");
  await expect(composer()).toHaveValue("Summarise @README.md ");
  await page.keyboard.press("Enter");
  // The mention lane answers only when the engine put the file's contents in the prompt.
  await expect(transcript().getByText(MENTIONED)).toBeVisible({ timeout: 30_000 });
});

test("an attached image reaches a model that can see", async () => {
  await page.locator('input[type="file"]').setInputFiles({
    name: "dot.png",
    mimeType: "image/png",
    buffer: RED_DOT,
  });
  await expect(
    page
      .getByRole("list", { name: "Attached images" })
      .getByRole("button", { name: "Remove dot.png" }),
  ).toBeVisible();
  await shoot("03-image-attached");
  await send("What is in this picture?");
  await expect(transcript().getByText(SEEN)).toBeVisible({ timeout: 30_000 });
  await expect(transcript().locator("img").first()).toBeVisible();
});

test("a rule added in Settings → Permissions applies to the open session's next turn", async () => {
  await page.keyboard.press("Meta+Comma");
  await settingsPage("Permissions").click();
  const personal = page.getByRole("region", { name: "Personal for this project" });
  const add = personal.getByRole("textbox", { name: "Add an allow rule" });
  await expect(add).toBeVisible({ timeout: 15_000 });
  await add.fill(ALLOW_RULE);
  await add.press("Enter");
  await expect(personal.getByText("Saved")).toBeVisible();
  await shoot("04-permissions");
  const saved = JSON.parse(
    await readFile(path.join(project, ".dawg", "settings.local.json"), "utf8"),
  ) as { permissions?: { allow?: string[] } };
  expect(saved.permissions?.allow).toContain(ALLOW_RULE);
  await backToSessions().click();

  await send("Create the allowed file.");
  // Had the rule not applied, the turn would wait on a permission card and never finish.
  await expect(transcript().getByText(ALLOWED)).toBeVisible({ timeout: 30_000 });
  expect(existsSync(path.join(project, "allowed-by-rule.txt"))).toBe(true);
});

test("a decision while dawg is in the background badges the Dock and notifies", async () => {
  // Nothing is focused, as far as main and the page can tell, and notifications are recorded.
  await app?.evaluate(({ BrowserWindow, Notification }) => {
    const saved = globalThis as unknown as Record<string, unknown>;
    saved.e2eFocusedWindow = BrowserWindow.getFocusedWindow;
    BrowserWindow.getFocusedWindow = () => null;
    const shown: unknown[] = [];
    saved.e2eShown = shown;
    saved.e2eShow = Notification.prototype.show;
    Notification.prototype.show = function (this: Notification) {
      shown.push(this);
    };
  });
  await page.evaluate(() => {
    const saved = window as unknown as Record<string, unknown>;
    saved.e2eHasFocus = document.hasFocus;
    document.hasFocus = () => false;
  });

  await send("Create the other file.");
  await expect(allowOnce()).toBeVisible({ timeout: 30_000 });
  await expect.poll(dockBadge).toBe("1");
  const shown = () =>
    app?.evaluate(() =>
      ((globalThis as unknown as { e2eShown?: RecordedNotification[] }).e2eShown ?? []).map(
        (n) => ({ title: n.title, body: n.body }),
      ),
    );
  await expect.poll(async () => (await shown())?.at(-1)?.body ?? "").toMatch(/^Needs you/);

  expect((await shown())?.at(-1)?.title).toBe(TITLE);

  // Clicking the notification leaves Settings for the session.
  await page.keyboard.press("Meta+Comma");
  await expect(backToSessions()).toBeVisible();
  await app?.evaluate(() => {
    const list = (globalThis as unknown as { e2eShown: RecordedNotification[] }).e2eShown;
    list[list.length - 1]?.emit("click");
  });
  await expect(backToSessions()).toHaveCount(0);
  await expect(allowOnce()).toBeVisible();

  await app?.evaluate(({ BrowserWindow, Notification }) => {
    const saved = globalThis as unknown as Record<string, unknown>;
    BrowserWindow.getFocusedWindow =
      saved.e2eFocusedWindow as typeof BrowserWindow.getFocusedWindow;
    Notification.prototype.show = saved.e2eShow as typeof Notification.prototype.show;
  });
  await page.evaluate(() => {
    const saved = window as unknown as Record<string, unknown>;
    document.hasFocus = saved.e2eHasFocus as typeof document.hasFocus;
  });

  await allowOnce().click();
  await expect(transcript().getByText(ASKED)).toBeVisible({ timeout: 30_000 });
  await expect.poll(dockBadge).toBe("");
  expect(existsSync(path.join(project, "needs-asking.txt"))).toBe(true);
});

test("⌘K finds an action; ⌘/ and ⌥⌘F work from the keyboard", async () => {
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search actions and sessions" }).fill("shortcuts");
  await expect(palette.getByRole("option", { name: /^Keyboard shortcuts/ })).toBeVisible();
  await shoot("05-palette");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Shortcuts", level: 1 })).toBeVisible();
  await backToSessions().click();

  await page.keyboard.press("Meta+Slash");
  await expect(page.getByRole("heading", { name: "Shortcuts", level: 1 })).toBeVisible();
  await shoot("06-shortcuts");
  await backToSessions().click();

  await page.keyboard.press("Alt+Meta+KeyF");
  await expect(page.locator("#sidebar-search")).toBeFocused();
});

test("no errors in the page", () => {
  expect(pageErrors).toEqual([]);
});
