/**
 * Signing in to an MCP server end to end (Phase 4, round 3), on the real engine with the
 * scripted mock model server (as in mcp.spec.ts) and the engine's test authorization server with
 * the MCP server it protects (packages/engine/src/mcp/__fixtures__/oauth-server.ts):
 *
 * - a project's HTTP server needs a sign-in once its code is approved, and Settings → MCP
 *   servers says so;
 * - "Sign in" asks main to open the authorization page. `shell.openExternal` is stubbed in the
 *   main process, so no browser opens: the test follows the address with `fetch`, as a browser
 *   would, and the engine's listener on 127.0.0.1 takes the return;
 * - the server shows connected, with its tools, and offers "Sign out".
 *
 * Sign-ins are kept in a file under the temporary data root (playwright.config.ts sets
 * DAWG_CREDENTIAL_STORE=file), never in the Keychain. Nothing leaves the machine.
 */
import { type ChildProcess, spawn } from "node:child_process";
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
const repoRoot = path.resolve(appDir, "..", "..");
const mockCli = path.join(repoRoot, "packages", "mock-model", "src", "cli.ts");
const oauthServer = path.join(
  repoRoot,
  "packages",
  "engine",
  "src",
  "mcp",
  "__fixtures__",
  "oauth-server.ts",
);

const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [],
  lanes: { title: { match: { system: "short title" }, replies: [{ text: "Signing in" }] } },
};

let root: string;
let project: string;
let dataRoot: string;
let mock: ChildProcess | null = null;
let auth: ChildProcess | null = null;
let issuer = "";
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

/** Starts a child that prints one JSON line once it listens, and resolves with that line. */
async function startChild(
  args: string[],
  name: string,
): Promise<{ child: ChildProcess; first: Record<string, string> }> {
  const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
    if (!line.startsWith("{")) process.stdout.write(`[${name}] ${line}\n`);
  });
  const first = await new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start`)), 15_000);
    child.once("exit", (code) => reject(new Error(`${name} exited (${code})`)));
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line) as Record<string, string>);
    });
  });
  return { child, first };
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-mcp-sign-in-"));
  project = path.join(root, "tally");
  dataRoot = path.join(root, "data");
  const home = path.join(root, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# Tally\n");

  const started = await startChild([oauthServer], "oauth");
  auth = started.child;
  issuer = started.first.issuer as string;
  await writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { secure: { type: "http", url: started.first.mcpUrl } } }),
  );

  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const model = await startChild([mockCli, "--script", scriptFile, "--port", "0"], "mock-model");
  mock = model.child;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, with its MCP servers and sign-ins.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = dataRoot;
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = model.first.baseUrl as string;
  expect(env.DAWG_CREDENTIAL_STORE).toBe("file");
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await app.evaluate(({ dialog, shell }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    // No browser opens: the addresses main is asked to open are kept for the test.
    const opened: string[] = [];
    (globalThis as { openedUrls?: string[] }).openedUrls = opened;
    shell.openExternal = (async (url: string) => {
      opened.push(url);
    }) as typeof shell.openExternal;
  }, project);
});

test.afterAll(async () => {
  await app?.close();
  mock?.kill("SIGTERM");
  auth?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (pageErrors.length > 0) console.log(`Errors in the page:\n${pageErrors.join("\n")}`);
});

const settingsMain = () => page.getByRole("main");
const serverList = () => settingsMain().getByRole("list", { name: "MCP servers" });

test("a project's HTTP server needs a sign-in, and Settings → MCP servers shows it", async () => {
  await expect(page.getByRole("button", { name: /Ready\. Model settings$/ })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Approve the MCP servers in tally?" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search actions and sessions" })
    .fill("Settings: MCP servers");
  await expect(palette.getByRole("option", { name: /^Settings: MCP servers/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(settingsMain().getByRole("heading", { level: 1 })).toHaveText("MCP servers");
  await expect(serverList()).toContainText("secure");
  await expect(serverList()).toContainText("Needs sign-in", { timeout: 15_000 });
  await expect(serverList()).toContainText("The server wants you to sign in first.");
});

test("Sign in opens the authorization page; following it connects the server, with its tools", async () => {
  const signIn = settingsMain().getByRole("button", { name: "Sign in to secure" });
  await signIn.focus();
  await page.keyboard.press("Enter");
  await expect(settingsMain().getByRole("status")).toContainText("Signing in…");
  await expect(
    settingsMain().getByRole("button", { name: "Cancel signing in to secure" }),
  ).toBeVisible();

  // Main was asked to open the authorization server's page, with a PKCE challenge.
  let url = "";
  await expect
    .poll(async () => {
      const opened = await app?.evaluate(
        () => (globalThis as { openedUrls?: string[] }).openedUrls ?? [],
      );
      url = opened?.[0] ?? "";
      return url;
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
  const authorize = new URL(url);
  expect(authorize.origin).toBe(issuer);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

  // The browser's part: the page sends it straight back to dawg's listener.
  const sent = await fetch(url, { redirect: "manual" });
  expect(sent.status).toBe(302);
  const back = sent.headers.get("location") ?? "";
  expect(new URL(back).pathname).toBe("/callback");
  const landed = await fetch(back);
  expect(await landed.text()).toBe("Signed in to secure. You can close this tab.\n");

  await expect(serverList()).toContainText("Connected", { timeout: 15_000 });
  const tools = serverList().getByRole("button", { name: "1 tool" });
  await tools.click();
  await expect(settingsMain().getByRole("list", { name: "secure’s tools" })).toContainText(
    "mcp__secure__whoami",
  );
  await expect(settingsMain().getByRole("button", { name: "Sign out of secure" })).toBeVisible();

  // Kept in the data root's file, which only the person can read; never shown in the page.
  const kept = await readFile(path.join(dataRoot, "mcp-credentials.json"), "utf8");
  const state = (await (await fetch(`${issuer}/test/state`)).json()) as { issued: string[] };
  expect(kept).toContain(state.issued[0] as string);
  const shown = await page.content();
  for (const secret of state.issued) expect(shown).not.toContain(secret);
  expect(pageErrors).toEqual([]);
});
