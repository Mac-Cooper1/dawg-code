/**
 * Settings → Models' helper section in the built app on the mock engine: the helper model that
 * answers side requests (titles, page summaries) shows with its state, and its switch is reached
 * with the keyboard and read out with its name, in both themes.
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

let app: ElectronApplication;
let page: Page;
let dawgHome: string;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dawgHome = await mkdtemp(path.join(tmpdir(), "dawg-helper-"));
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
  page.on("pageerror", (error) => pageErrors.push(String(error)));
});

test.afterAll(async () => {
  await app?.close();
  if (dawgHome) await rm(dawgHome, { recursive: true, force: true });
});

/** Presses Tab until `target` has focus, at most `limit` times. */
async function tabTo(target: ReturnType<Page["locator"]>, limit = 60): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("Settings → Models shows the helper model, its state and its switch, by keyboard", async () => {
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
  await page.keyboard.press("Meta+Comma");
  const nav = page.getByRole("navigation", { name: "Settings pages" });
  const models = nav.getByRole("button", { name: "Models", exact: true });
  await expect(nav.locator("[aria-current='page']")).toBeFocused();
  for (let i = 0; i < 8; i++) {
    if (await models.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("Models");

  const helper = page.getByRole("region", { name: "Helper model" });
  await expect(helper).toBeVisible();
  await expect(helper).toContainText("MiniCPM5 1B (8-bit)");
  await expect(helper).toContainText("Running");
  await expect(helper).toContainText("writes session titles and summarises web pages");

  const toggle = helper.getByRole("switch", { name: "Use the helper for side requests" });
  await tabTo(toggle);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(helper.getByRole("button", { name: "Remove MiniCPM5 1B (8-bit)" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`the helper section reads in ${theme}`, async () => {
    await page.evaluate(
      (appearance) => (window as PreloadWindow).dawgPreload?.settings.update({ appearance }),
      theme,
    );
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    const helper = page.getByRole("region", { name: "Helper model" });
    await expect(helper).toBeVisible();
    // The name and the switch keep a visible colour of their own against the card in both themes.
    const colours = await helper.evaluate((element) => {
      const name = element.querySelector("span");
      const track = element.querySelector("[role='switch']");
      return {
        name: name ? getComputedStyle(name).color : "",
        track: track ? getComputedStyle(track).backgroundColor : "",
      };
    });
    expect(colours.name).not.toBe("");
    expect(colours.track).not.toBe("rgba(0, 0, 0, 0)");
    expect(pageErrors).toEqual([]);
  });
}
