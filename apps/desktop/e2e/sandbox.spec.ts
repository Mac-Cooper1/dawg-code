/**
 * The sandbox end to end, on the real engine and the real sandbox runtime (macOS Seatbelt): a
 * project whose personal settings turn the sandbox on, with sandboxed commands allowed without
 * asking, is opened. A scripted Bash command that writes outside the project runs without a
 * prompt, the sandbox refuses the write, the file is not there, and the command's card says the
 * sandbox blocked it. Settings → Permissions shows the sandbox on.
 *
 * The scripted mock model server stands in for a model (as in real-engine.spec.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

const ANSWER = "The sandbox stopped the write outside the project.";

let root: string;
let project: string;
let outside: string;
let mock: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });
test.skip(
  process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"),
  "The sandbox runs on macOS.",
);

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

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "dawg-sandbox-e2e-")));
  project = path.join(root, "tally");
  outside = path.join(root, "outside");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(outside, { recursive: true });
  await put(path.join(project, "README.md"), "# tally\n");
  // The project's personal file: the person's own choice, so auto-allow counts from it.
  await put(
    path.join(project, ".dawg", "settings.local.json"),
    JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }),
  );
  const target = path.join(outside, "escaped.txt");
  const script = {
    server: { model: "e2e-model", contextWindow: 32_768 },
    replies: [
      {
        toolCalls: [
          {
            id: "call_escape",
            name: "Bash",
            arguments: {
              command: `echo hi > '${target}'`,
              description: "Write outside the project",
            },
          },
        ],
      },
      { text: ANSWER },
    ],
    lanes: { title: { match: { system: "short title" }, replies: [{ text: "Writing outside" }] } },
  };
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(script));
  const serverUrl = await startMockServer(scriptFile);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, with the real sandbox.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's own settings stay out of the test.
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

const transcript = () => page.getByRole("log", { name: "Transcript" });
const composer = () => page.getByRole("textbox", { name: "Message to dawg" });

test("a sandboxed command that writes outside the project is blocked, and the card says so", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();
  await composer().fill("Write a file outside the project");
  await composer().press("Enter");
  await expect(transcript().getByText(ANSWER)).toBeVisible({ timeout: 30_000 });

  // Auto-allowed: no permission card, and the write never reached the disk.
  await expect(page.getByRole("button", { name: /^Allow/ })).toHaveCount(0);
  const target = path.join(outside, "escaped.txt");
  expect(await exists(target)).toBe(false);

  const card = transcript().getByRole("button", { name: /sandbox blocked 1 action/ });
  await expect(card).toBeVisible();
  // A failed command's card opens by itself; it can be closed and opened again.
  await expect(card).toHaveAttribute("aria-expanded", "true");
  await card.click();
  await expect(card).toHaveAttribute("aria-expanded", "false");
  await card.press("Enter");
  await expect(card).toHaveAttribute("aria-expanded", "true");
  const blocked = transcript().getByRole("region", { name: "Blocked by the sandbox" });
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText(target);
  await expect(blocked).toContainText("dawg asks you before running a command outside the sandbox");
});

test("Settings → Permissions shows the sandbox on, from the project's personal file", async () => {
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: "Search actions and sessions" })
    .fill("Settings: Permissions");
  await expect(palette.getByRole("option", { name: /^Settings: Permissions/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Permissions");
  const sandbox = main.getByRole("region", { name: "Sandbox" });
  await expect(sandbox).toContainText("On for new sessions, set by");
  await expect(sandbox).toContainText(".dawg/settings.local.json");
  await expect(
    sandbox.getByRole("switch", { name: "Run sandboxed commands without asking" }),
  ).toBeChecked();
  expect(pageErrors).toEqual([]);
});
