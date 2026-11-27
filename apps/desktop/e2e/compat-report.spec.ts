/**
 * The compatibility report end to end, on the real engine: a project set up for Claude Code (a
 * CLAUDE.md, a settings file with keys dawg does not use, a subagent and an MCP server) is
 * opened for the first time. The window says once what dawg found there, and its link opens
 * Settings → Project setup, which lists each item with what dawg does with it.
 *
 * The scripted mock model server stands in for a model (as in real-engine.spec.ts), so the app
 * starts without a download; nothing here asks it anything.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

let root: string;
let project: string;
let env: Record<string, string>;
let mock: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

/** Starts the mock model server and resolves with its OpenAI root. */
async function startMockServer(scriptFile: string): Promise<string> {
  const child = spawn(process.execPath, [mockCli, "--script", scriptFile, "--port", "0"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  mock = child;
  createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
    process.stdout.write(`[mock-model] ${line}\n`);
  });
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

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-compat-"));
  project = path.join(root, "tally");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  // A Claude Code setup, written from the public docs (memory, settings, sub-agents, mcp).
  await put(
    path.join(project, "CLAUDE.md"),
    "# Tally\n\nRun `uv run pytest -q` before you finish.\n",
  );
  await put(
    path.join(project, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(uv run pytest *)"] },
      theme: "dark",
      spinnerTipsEnabled: false,
    }),
  );
  await put(
    path.join(project, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews code for quality\ntools: Read, Grep\n---\n\nReview.\n",
  );
  await put(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { postgres: { command: "npx", args: ["-y", "pg-mcp"] } } }),
  );
  const scriptFile = path.join(root, "script.json");
  await writeFile(
    scriptFile,
    JSON.stringify({ server: { model: "e2e-model", contextWindow: 32_768 }, replies: [] }),
  );
  const serverUrl = await startMockServer(scriptFile);

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, which reads the files above.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's Claude Code setup stays out of the test.
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = serverUrl;

  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // The folder picker answers with the project instead of opening.
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

const NOTICE =
  "dawg found a Claude Code setup in tally: 1 subagent, 1 MCP server, 1 settings file.";

test("opening the project the first time says what dawg found there", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  // The project's MCP server waits for consent (spec, principle 3), so the trust dialog asks
  // about it first; this test leaves it off.
  const trust = page.getByRole("dialog", { name: "Approve the MCP servers in tally?" });
  await expect(trust).toBeVisible();
  await trust.getByRole("button", { name: "Not now" }).click();
  await expect(trust).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message to dawg" })).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
  // Once: no second notice for the same project.
  await expect(page.getByText(NOTICE)).toHaveCount(1);
});

test("its link opens Settings → Project setup, listing each item with its status", async () => {
  await page.getByRole("button", { name: "See what it uses" }).click();
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Project setup");
  // The notice has gone with the click.
  await expect(page.getByText(NOTICE)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(project);

  const section = (name: RegExp) => main.getByRole("region", { name });
  const loaded = section(/^Loaded/);
  await expect(loaded).toBeVisible();
  await expect(loaded.getByText("CLAUDE.md", { exact: true })).toBeVisible();
  await expect(loaded.getByText("Instructions")).toBeVisible();

  const partly = section(/^Partly supported/);
  await expect(partly.getByText(".claude/settings.json", { exact: true })).toBeVisible();
  await expect(partly.getByText("Not used by dawg yet: theme, spinnerTipsEnabled.")).toBeVisible();

  // The project's MCP server starts once approved; this test put it off.
  const waiting = section(/^Needs approval/);
  await expect(waiting.getByText("postgres", { exact: true })).toBeVisible();
  await expect(waiting.getByText("Runs a local command: npx -y pg-mcp.")).toBeVisible();

  // Subagent files load (Phase 4, subagents): the reviewer is listed with the rest.
  await expect(loaded.getByText("reviewer", { exact: true })).toBeVisible();
  await expect(section(/^Not supported/)).toHaveCount(0);

  await expect(section(/^Invalid/)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
