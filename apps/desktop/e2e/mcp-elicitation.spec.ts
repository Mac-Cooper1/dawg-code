/**
 * An MCP server's request for input, end to end, on the real engine with the scripted mock model
 * server and the engine's elicitation test server over stdio
 * (packages/engine/src/mcp/__fixtures__/elicit-server.ts).
 *
 * - A project whose `.mcp.json` names the server, approved in the trust dialog.
 * - A scripted call to `mcp__forms__ask_name`, allowed once: while the call is in progress the
 *   server asks for a name, and the card "forms asks for input" shows the form where the
 *   question cards appear. Submitting it empty says the field is required; filled in, the
 *   answer goes to the server, and the call's result shows what the server made of it.
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
const formsServer = path.join(
  repoRoot,
  "packages",
  "engine",
  "src",
  "mcp",
  "__fixtures__",
  "elicit-server.ts",
);

const GREETED = "Hello, Ada.";
const ANSWER = "The forms server greeted Ada.";

/** Lanes are tried in order: titles; the follow-up once the result is in; then the prompt. */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [],
  lanes: {
    title: { match: { system: "short title" }, replies: [{ text: "Asking through MCP" }] },
    greeted: { match: { bodyIncludes: GREETED }, replies: [{ text: ANSWER }] },
    call: {
      match: { bodyIncludes: '"name":"mcp__forms__ask_name"', lastUser: "Ask my name" },
      replies: [{ toolCalls: [{ id: "call_ask", name: "mcp__forms__ask_name", arguments: {} }] }],
    },
  },
};

let root: string;
let project: string;
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
  root = await mkdtemp(path.join(tmpdir(), "dawg-mcp-forms-"));
  project = path.join(root, "booking");
  const home = path.join(root, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# Booking\n");
  await writeFile(
    path.join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { forms: { command: process.execPath, args: [formsServer] } } }),
  );
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  const env: Record<string, string> = {};
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
  await app.evaluate(({ dialog, shell }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    // Nothing here may open a real browser.
    shell.openExternal = (() => Promise.resolve()) as typeof shell.openExternal;
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

test("the project's server is approved before it may start", async () => {
  await expect(page.getByRole("button", { name: /Ready\. Model settings$/ })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Approve the MCP servers in booking?" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toHaveCount(0);
});

test("the server's form shows during its call, and the answer reaches it", async () => {
  await expect(composer()).toBeVisible();
  await composer().fill("Ask my name");
  await composer().press("Enter");

  const allow = page.getByRole("button", { name: /^Allow once/, disabled: false });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("mcp__forms__ask_name").first()).toBeVisible();
  await allow.click();

  // The card is labelled with the server, and the session waits on the person.
  const card = transcript().getByRole("region", { name: "forms asks for input" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("What should I call you?")).toBeVisible();
  await expect(composer()).toHaveAttribute(
    "placeholder",
    "Waiting on you. Answer the form above; a message here declines it.",
  );
  const name = card.getByLabel("Your name");
  await expect(name).toHaveAttribute("aria-required", "true");

  // Empty, it is refused with the reason next to the field; filled in, it is sent.
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(card.getByText("This is required.")).toBeVisible();
  await expect(name).toBeFocused();
  await name.fill("Ada");
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(transcript().getByText("You sent forms the form")).toBeVisible({ timeout: 15_000 });

  // The call's result shows what the server did with the answer, and the model heard it.
  await expect(transcript().getByText(ANSWER)).toBeVisible({ timeout: 30_000 });
  const call = transcript().getByRole("button", { name: /^Called forms · ask_name/ });
  await expect(call).toBeVisible();
  await call.click();
  await expect(call).toHaveAttribute("aria-expanded", "true");
  await expect(transcript().getByText(GREETED)).toBeVisible();
  const lanes = served.filter((r) => r.path === "/v1/chat/completions").map((r) => r.lane);
  expect(lanes).toEqual(expect.arrayContaining(["call", "greeted"]));
  expect(pageErrors).toEqual([]);
});
