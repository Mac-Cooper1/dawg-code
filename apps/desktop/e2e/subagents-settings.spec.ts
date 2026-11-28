/**
 * Settings → Subagents end to end, on the real engine with the scripted mock model server (as in
 * skills.spec.ts). The project has `.claude/agents/test-runner.md`, written from Claude Code's
 * docs (subagents); the home folder starts empty.
 *
 * - `/agents` typed in a session's composer opens Settings → Subagents for the session's project.
 * - It lists the project's agent with its details and file, and the built-in Explore.
 * - "Open file" asks main to open the agent's file (Electron's `shell.openPath` is stubbed, so
 *   nothing opens on the Mac).
 * - "New subagent", just for the person, writes `~/.dawg/agents/<name>.md` in the documented
 *   front matter format, and the agent then appears under Yours. Nothing is written under
 *   `.claude`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

/** Nothing here sends a prompt; the server only has to be there for the app to have a model. */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [],
  lanes: { title: { match: { system: "short title" }, replies: [{ text: "Agents" }] } },
};

let root: string;
let home: string;
let project: string;
let agentFile: string;
let mock: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

async function startMockServer(scriptFile: string): Promise<string> {
  const child = spawn(process.execPath, [mockCli, "--script", scriptFile, "--port", "0"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  mock = child;
  createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", (line) =>
    process.stdout.write(`[mock-model] ${line}\n`),
  );
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
  root = await mkdtemp(path.join(tmpdir(), "dawg-subagents-settings-"));
  project = path.join(root, "tally");
  home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await put(path.join(project, "README.md"), "# Tally\n");
  agentFile = path.join(project, ".claude", "agents", "test-runner.md");
  await put(
    agentFile,
    [
      "---",
      "name: test-runner",
      "description: Runs the test suite and reports the failures, with their causes.",
      "tools: Bash, Read, Grep",
      "---",
      "",
      "You run the project's tests and report what failed and why.",
      "",
    ].join("\n"),
  );
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, which reads the files above.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's agents stay out of the test and the form writes here.
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = serverUrl;

  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // The folder picker answers with the project instead of opening, and opening a file records
  // it instead of starting an editor on this Mac.
  const stubbed = await app.evaluate(({ dialog, shell }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
    const opened: string[] = [];
    (globalThis as { openedFiles?: string[] }).openedFiles = opened;
    const stubbedOpenPath = async (file: string) => {
      opened.push(file);
      return "";
    };
    shell.openPath = stubbedOpenPath;
    return shell.openPath === stubbedOpenPath;
  }, project);
  expect(stubbed, "shell.openPath is stubbed, so the test opens nothing").toBe(true);
});

test.afterAll(async () => {
  await app?.close();
  mock?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (pageErrors.length > 0) console.log(`Errors in the page:\n${pageErrors.join("\n")}`);
});

const composer = () => page.getByRole("textbox", { name: "Message to dawg" });
const main = () => page.getByRole("main");
const group = (name: RegExp) => main().getByRole("list", { name });

test("/agents in a session's composer opens Settings → Subagents for its project", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();
  await composer().fill("/agents");
  await expect(
    page.getByRole("listbox", { name: "Commands" }).getByRole("option", { name: /^\/agents/ }),
  ).toBeVisible();
  await composer().press("Enter");
  await expect(main().getByRole("heading", { level: 1 })).toHaveText("Subagents");
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(project);
  // Nothing was sent to the model, and the composer's draft went with the command.
  await expect(page.getByRole("button", { name: "Subagents", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("it lists the project's agent with its details, and the built-in Explore", async () => {
  const projectAgents = group(/^This project/);
  const runner = projectAgents.getByRole("listitem", { name: "test-runner" });
  await expect(runner).toBeVisible();
  await expect(runner).toContainText(
    "Runs the test suite and reports the failures, with their causes.",
  );
  await expect(runner).toContainText("Bash, Read, Grep");
  await expect(runner).toContainText(agentFile);
  await expect(runner).toContainText("Claude Code’s file, shared with the project");
  await expect(runner).toContainText("Inherits the session’s model");
  const explore = group(/^Built in/).getByRole("listitem", { name: "Explore" });
  await expect(explore).toBeVisible();
  await expect(explore).toContainText("Plan (read-only)");
  await expect(explore.getByRole("button", { name: "Open file" })).toHaveCount(0);
});

test("Open file asks main to open the agent's file", async () => {
  const runner = group(/^This project/).getByRole("listitem", { name: "test-runner" });
  await runner.getByRole("button", { name: "Open file" }).click();
  const expected = await realpath(agentFile);
  await expect
    .poll(() => app?.evaluate(() => (globalThis as { openedFiles?: string[] }).openedFiles ?? []))
    .toEqual([expected]);
});

test("New subagent writes the person's file, which then appears under Yours", async () => {
  await main().getByRole("button", { name: "New subagent" }).click();
  const form = main().getByRole("region", { name: "New subagent" });
  await expect(form.getByRole("textbox", { name: "Name" })).toBeFocused();
  await form.getByRole("textbox", { name: "Name" }).fill("doc-writer");
  await expect(form.getByRole("radio", { name: /Just for you/ })).toBeChecked();
  await expect(form).toContainText("~/.dawg/agents/doc-writer.md");
  await form
    .getByRole("textbox", { name: "Description" })
    .fill("Writes and updates the project's docs: guides, READMEs and comments.");
  await form
    .getByRole("textbox", { name: "System prompt" })
    .fill("You write clear, short documentation.");
  await form.getByRole("textbox", { name: "Tools" }).fill("Read, Edit, Write");
  await form.getByRole("button", { name: "Make subagent" }).click();

  await expect(form).toHaveCount(0);
  await expect(main().getByRole("status")).toContainText(
    "Made doc-writer: ~/.dawg/agents/doc-writer.md.",
  );
  const writer = group(/^Yours/).getByRole("listitem", { name: "doc-writer" });
  await expect(writer).toBeVisible();
  await expect(writer).toBeFocused();
  await expect(writer).toContainText("Read, Edit, Write");

  const text = await readFile(path.join(home, ".dawg", "agents", "doc-writer.md"), "utf8");
  // The documented front matter, then the prompt.
  expect(text.startsWith("---\nname: doc-writer\n")).toBe(true);
  expect(text).toMatch(
    /^description: "?Writes and updates the project's docs: guides, READMEs and comments\."?$/m,
  );
  expect(text).toMatch(/^tools: Read, Edit, Write$/m);
  expect(text.endsWith("---\n\nYou write clear, short documentation.\n")).toBe(true);
  // Nothing under any .claude folder was written.
  expect(await readdir(path.join(project, ".claude", "agents"))).toEqual(["test-runner.md"]);
  await expect(readdir(path.join(home, ".claude"))).rejects.toThrow();
  expect(pageErrors).toEqual([]);
});
