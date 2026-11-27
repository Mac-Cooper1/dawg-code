/**
 * MCP end to end, on the real engine with the scripted mock model server (as in
 * real-engine.spec.ts) and the engine's own test MCP server over stdio
 * (packages/engine/src/mcp/__fixtures__/test-server.ts).
 *
 * - A project whose `.mcp.json` names the test server: opening it asks before the server may
 *   start (the trust dialog), and Approve lets it.
 * - A scripted call to `mcp__test__echo`: the permission card names the server's tool, and once
 *   allowed the transcript shows the call to the server and its result.
 * - Settings → MCP servers lists the server, connected, with its tools.
 *
 * Nothing leaves the machine: the model and the MCP server both run here.
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
const testServer = path.join(
  repoRoot,
  "packages",
  "engine",
  "src",
  "mcp",
  "__fixtures__",
  "test-server.ts",
);

const ECHOED = "echo: hello from the e2e";
const ANSWER = "The test server echoed it back.";

/** Lanes are tried in order: titles; the follow-up once the result is in; then the prompt. */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [],
  lanes: {
    title: { match: { system: "short title" }, replies: [{ text: "Echoing through MCP" }] },
    echoed: { match: { bodyIncludes: ECHOED }, replies: [{ text: ANSWER }] },
    call: {
      // Answered only when the request offers the server's tool by its own name.
      match: { bodyIncludes: '"name":"mcp__test__echo"', lastUser: "Echo through MCP" },
      replies: [
        {
          toolCalls: [
            {
              id: "call_echo",
              name: "mcp__test__echo",
              arguments: { text: "hello from the e2e" },
            },
          ],
        },
      ],
    },
  },
};

let root: string;
let project: string;
let env: Record<string, string>;
let mock: ChildProcess | null = null;
const served: { path: string; lane?: string }[] = [];
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

async function startMockServer(scriptFile: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [mockCli, "--script", scriptFile, "--port", "0", "--verbose"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  mock = child;
  createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
    try {
      const entry = JSON.parse(line) as { event?: string; path?: string; lane?: string };
      if (entry.event === "request" && entry.path !== undefined) {
        served.push({
          path: entry.path,
          ...(entry.lane === undefined ? {} : { lane: entry.lane }),
        });
        return;
      }
    } catch {
      // Not a request line.
    }
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

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-mcp-"));
  project = path.join(root, "tally");
  const home = path.join(root, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# Tally\n");
  await writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [testServer] } } }),
  );
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, with its trust store and MCP servers.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = serverUrl;
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
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

test("opening the project asks before its MCP server may start, and Approve lets it", async () => {
  await expect(page.getByRole("button", { name: /Ready\. Model settings$/ })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Approve the MCP servers in tally?" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("test", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^Starts a program: /)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Not now" })).toBeFocused();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a scripted call to mcp__test__echo asks first, then shows the server's answer", async () => {
  await expect(composer()).toBeVisible();
  await composer().fill("Echo through MCP");
  await composer().press("Enter");

  // The permission card names the server's tool by the name rules match.
  const allow = page.getByRole("button", { name: /^Allow once/, disabled: false });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("mcp__test__echo").first()).toBeVisible();
  await allow.click();

  await expect(transcript().getByText(ANSWER)).toBeVisible({ timeout: 30_000 });
  const card = transcript().getByRole("button", { name: /^Called test · echo/ });
  await expect(card).toBeVisible();
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", "true");
  await expect(transcript().getByText(ECHOED)).toBeVisible();
  await expect(transcript().getByText("The echo tool of the test MCP server")).toBeVisible();
  const lanes = served.filter((r) => r.path === "/v1/chat/completions").map((r) => r.lane);
  expect(lanes).toEqual(expect.arrayContaining(["call", "echoed"]));
});

test("Settings → MCP servers lists the server, connected, with its tools", async () => {
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByRole("combobox", { name: "Search actions and sessions" })
    .fill("Settings: MCP servers");
  await expect(palette.getByRole("option", { name: /^Settings: MCP servers/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("MCP servers");
  const list = main.getByRole("list", { name: "MCP servers" });
  await expect(list).toContainText("test");
  await expect(list).toContainText("Connected");
  await expect(list).toContainText("tally/.mcp.json");
  const tools = list.getByRole("button", { name: /^6 tools, 1 prompt, 2 resources$/ });
  await tools.click();
  await expect(main.getByRole("list", { name: "test’s tools" })).toContainText("mcp__test__echo");
  expect(pageErrors).toEqual([]);
});
