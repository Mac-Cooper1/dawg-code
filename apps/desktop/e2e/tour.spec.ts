/**
 * A tour of the built app against the mock engine, end to end: the split-test session streams,
 * a message typed meanwhile is queued, the three decision cards show and answer, the composer's
 * menus open, Stop holds the queued message, a session is deleted after its dialog asks, and
 * Settings → General switches the appearance.
 * Saves a screenshot of each stop in dark and light to e2e/screenshots/tour/ for design review.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { PreloadApi, ResolvedTheme } from "../src/shared/bridge.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const shotDir = path.join(import.meta.dirname, "screenshots", "tour");

type PreloadWindow = Window & { dawgPreload?: PreloadApi };

let app: ElectronApplication;
let page: Page;
let dawgHome: string;
const consoleErrors: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dawgHome = await mkdtemp(path.join(tmpdir(), "dawg-tour-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  env.DAWG_HOME = dawgHome;
  env.DAWG_ENGINE = "mock"; // The recorded sessions; real-engine.spec.ts runs the real one.
  // Fast enough for a short test, slow enough to catch the reply while it streams.
  env.DAWG_MOCK_SPEED = "3";
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await mkdir(shotDir, { recursive: true });
  await setAppearance("dark");
});

test.afterAll(async () => {
  await app?.close();
  if (dawgHome) await rm(dawgHome, { recursive: true, force: true });
});

async function setAppearance(theme: ResolvedTheme): Promise<void> {
  await page.evaluate(
    (appearance) => (window as PreloadWindow).dawgPreload?.settings.update({ appearance }),
    theme,
  );
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
}

/** Screenshots the window in dark, then light, then returns to dark. */
async function shoot(name: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await setAppearance(theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shotDir, `${name}-${theme}.png`) });
  }
  await setAppearance("dark");
}

function row(title: string) {
  return page.getByRole("button", { name: new RegExp(`^${title}`) });
}

const transcript = () => page.getByRole("log", { name: "Transcript" });
const composer = () => page.getByRole("textbox", { name: "Message to dawg" });

test("the split-test session streams, and a message sent meanwhile is queued", async () => {
  // The docs session waits for the model the split-test session is using.
  await expect(row("Docs search page")).toHaveAccessibleName(/Queued: waits for the model/);
  await row("Fix the failing split test").click();
  await expect(transcript().getByText("Fixed.", { exact: false })).toBeVisible();
  await expect(transcript().getByText("The sum is right", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  await composer().fill("Also update the README example.");
  await composer().press("Enter");
  const queue = page.getByRole("list", { name: "Waiting messages" });
  await expect(queue.getByText("Also update the README example.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop, or press Esc" })).toBeVisible();
  await shoot("01-main-streaming");
});

test("the context meter and the mode menu open", async () => {
  await page.getByRole("button", { name: /^Context used/ }).click();
  const meter = page.getByRole("dialog", { name: /^Context ·/ });
  await expect(meter.getByText("System prompt")).toBeVisible();
  await expect(meter.getByText("Messages")).toBeVisible();
  await expect(meter.getByText(/Compacts on its own at 65%/)).toBeVisible();
  await shoot("02-context-meter");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Permission mode/ }).click();
  await expect(page.getByRole("menuitemradio", { name: /Ask first/ })).toBeVisible();
  await shoot("03-mode-menu");
  await page.keyboard.press("Escape");
});

test("Stop holds the queued message", async () => {
  await page.getByRole("button", { name: "Stop, or press Esc" }).click();
  const queue = page.getByRole("list", { name: "Waiting messages" });
  await expect(queue.getByText(/Held/)).toBeVisible();
  await expect(queue.getByRole("button", { name: /Send now/ })).toBeVisible();
  await expect(transcript().getByText(/Interrupted by you/)).toBeVisible();
  await shoot("04-stopped-held");
});

test("the permission card shows and allows once", async () => {
  await row("Flaky CSV import test").click();
  await expect(page.getByText("Permission needed")).toBeVisible();
  await expect(page.getByText("uv add --dev pytest-repeat").first()).toBeVisible();
  await shoot("05-permission");
  await page.getByRole("button", { name: /^Allow once/ }).click();
  await expect(page.getByText("You allowed this once")).toBeVisible();
  await expect(
    transcript()
      .getByText(/Ran\s*uv add --dev pytest-repeat/)
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
});

test("the question card shows and takes an answer", async () => {
  await row("Add tip support").click();
  await expect(page.getByText("dawg is asking")).toBeVisible();
  await expect(page.getByText("How should the tip be shared?").first()).toBeVisible();
  await shoot("06-question");
  await page.getByRole("radio", { name: /By what each person ordered/ }).check();
  await page.getByRole("button", { name: /^Send answer/ }).click();
  await expect(page.getByText(/You answered: By what each person ordered/)).toBeVisible();
});

test("the plan card shows and approves with accept edits", async () => {
  await row("Multi-currency totals").click();
  await expect(page.getByText("Plan ready for review").first()).toBeVisible();
  await expect(
    page.getByText("Approve returns to Ask first, the mode you were in before planning."),
  ).toBeVisible();
  await shoot("07-plan");
  await page.getByRole("button", { name: /^Approve and accept edits/ }).click();
  await expect(page.getByText(/You approved the plan/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Permission mode: Accept edits/ })).toBeVisible();
});

test("the sidebar after the decisions", async () => {
  await row("Fix the failing split test").click();
  await shoot("08-after-decisions");
});

test("Delete asks first, then the session leaves the sidebar", async () => {
  await row("Bump to Python 3.13").click();
  await page.getByRole("button", { name: "Actions for Bump to Python 3.13" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete “Bump to Python 3.13”?" });
  await expect(dialog.getByText(/This cannot be undone/)).toBeVisible();
  await shoot("09-delete-dialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row("Bump to Python 3.13")).toHaveCount(0);
});

test("Settings → General switches the appearance", async () => {
  await page.keyboard.press("Meta+Comma");
  await page.getByRole("navigation", { name: "Settings pages" }).getByText("General").click();
  await expect(page.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
  await shoot("10-settings-general");
  await page.getByRole("radio", { name: /^Light/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.getByRole("radio", { name: /^Dark/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(row("Fix the failing split test")).toBeVisible();
});

test("no errors in the page", () => {
  expect(consoleErrors).toEqual([]);
});
