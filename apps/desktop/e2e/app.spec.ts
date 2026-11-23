/**
 * Launches the built app with a throwaway data root and checks the shell end to end: the window
 * opens and shows, the preload bridge is there, the page gets an engine port that answers, the
 * appearance setting reaches the window and the settings file, and screenshots in both themes.
 *
 * It does not depend on the renderer's UI, which is still being built: everything goes through
 * the preload object and the engine port.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ConsoleMessage,
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { PreloadApi, ResolvedTheme } from "../src/shared/bridge.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(import.meta.dirname, "screenshots");

type PreloadWindow = Window & { dawgPreload?: PreloadApi };

let app: ElectronApplication;
let page: Page;
let dawgHome: string;
let launchedAt: number;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  dawgHome = await mkdtemp(path.join(tmpdir(), "dawg-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL; // Always the built page, even when run from a dev shell.
  env.DAWG_HOME = dawgHome;
  env.DAWG_MOCK_SPEED = "Infinity";

  launchedAt = Date.now();
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
});

test.afterAll(async () => {
  await app?.close();
  if (dawgHome) await rm(dawgHome, { recursive: true, force: true });
  if (consoleErrors.length > 0) {
    console.log(`Console errors in the page:\n${consoleErrors.join("\n")}`);
  }
});

test("the window opens and becomes visible", async () => {
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
    )
    .toBe(true);
  const visibleAfterMs = Date.now() - launchedAt;
  test.info().annotations.push({ type: "visible after", description: `${visibleAfterMs} ms` });
  // The budget is 2 s; this generous bound only catches a window that never shows.
  expect(visibleAfterMs).toBeLessThan(10_000);

  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window ? { ...window.getBounds(), min: window.getMinimumSize() } : null;
  });
  expect(bounds?.min).toEqual([960, 600]);
  expect(bounds?.width).toBeGreaterThanOrEqual(960);
});

test("the preload bridge is exposed", async () => {
  const exposed = await page.evaluate(() => {
    const preload = (window as PreloadWindow).dawgPreload;
    return preload
      ? {
          bridgeVersion: preload.bridgeVersion,
          engine: preload.platform.engine,
          os: preload.platform.os,
          hasHomeDir: preload.platform.homeDir.length > 0,
          hasNode: typeof (globalThis as { require?: unknown }).require !== "undefined",
        }
      : null;
  });
  expect(exposed).toEqual({
    bridgeVersion: 1,
    engine: "mock",
    os: "darwin",
    hasHomeDir: true,
    hasNode: false,
  });
});

/**
 * In the page: waits for the next engine port (running `trigger`, if given, to cause one), sends
 * `initialize` on it and resolves with the reply. Also collects engine restart notices.
 */
async function nextPortReply(trigger: "connect" | "none"): Promise<unknown> {
  return page.evaluate(
    ({ portMessage, trigger }) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No engine port arrived")), 15_000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window || event.data !== portMessage) return;
          const port = event.ports[0];
          if (!port) return;
          window.removeEventListener("message", onMessage);
          port.onmessage = (reply) => {
            clearTimeout(timer);
            resolve(reply.data);
          };
          port.postMessage({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 1,
              client: { name: "dawg-e2e", version: "0.0.0" },
              capabilities: {},
            },
          });
        };
        window.addEventListener("message", onMessage);
        if (trigger === "connect") (window as PreloadWindow).dawgPreload?.engine.connect();
      }),
    { portMessage: "dawg:engine-port", trigger },
  );
}

function describeReply(response: unknown): string {
  const error = (response as { error?: { message: string } }).error;
  return error ? `error: ${error.message}` : "initialized";
}

test("the engine host answers on the port the page receives", async () => {
  const response = await nextPortReply("connect");
  expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
  // Until the mock engine is built, the engine host answers initialize with an error saying so.
  test.info().annotations.push({ type: "initialize", description: describeReply(response) });
});

test("restarting the engine host notifies the page and sends a fresh port", async () => {
  await page.evaluate(() => {
    const store = window as PreloadWindow & { restartReasons?: string[] };
    store.restartReasons = [];
    store.dawgPreload?.engine.onRestart((info) => store.restartReasons?.push(info.reason));
  });
  const reply = nextPortReply("none");
  await app.evaluate(({ Menu }) => {
    const developer = Menu.getApplicationMenu()?.items.find((item) => item.label === "Developer");
    const restart = developer?.submenu?.items.find(
      (item) => item.label === "Restart the engine host",
    );
    if (!restart) throw new Error("No Developer → Restart the engine host menu item");
    restart.click();
  });
  expect(await reply).toMatchObject({ jsonrpc: "2.0", id: 1 });
  const reasons = await page.evaluate(
    () => (window as PreloadWindow & { restartReasons?: string[] }).restartReasons,
  );
  expect(reasons).toEqual([expect.stringContaining("Developer menu")]);
});

for (const theme of ["dark", "light"] as const satisfies readonly ResolvedTheme[]) {
  test(`screenshot in ${theme}`, async () => {
    const saved = await page.evaluate(
      (appearance) => (window as PreloadWindow).dawgPreload?.settings.update({ appearance }),
      theme,
    );
    expect(saved?.appearance).toBe(theme);
    await expect
      .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors))
      .toBe(theme === "dark");

    const settingsFile = JSON.parse(await readFile(path.join(dawgHome, "settings.json"), "utf8"));
    expect(settingsFile.desktop.appearance).toBe(theme);

    // The app shell sets <html data-theme>; until it does, set it here so the shot shows the theme.
    const followed = await page
      .waitForFunction((value) => document.documentElement.dataset.theme === value, theme, {
        timeout: 3_000,
      })
      .then(() => true)
      .catch(() => false);
    if (!followed) {
      test.info().annotations.push({
        type: "note",
        description: "The renderer did not apply the theme itself; the test set data-theme.",
      });
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
    }

    await mkdir(screenshotDir, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(screenshotDir, `${theme}.png`) });
  });
}
