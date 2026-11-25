/**
 * The side panes and worktree sessions, end to end, on the real engine against a real git
 * repository. The scripted mock model (`packages/mock-model`) reads and edits a file and leaves a
 * command running in the background; the test then works through the panes: the edit in Changes
 * (and reverting it), a file opened, edited and saved in Files, a shell in Terminal, the command in
 * Tasks (and stopping it), and a session in a worktree that goes away when it is archived.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

const PROMPT = "Make the answer 42, then start a timer in the background.";
const FINAL = "The answer is 42 now, and a timer is running.";
const TITLE = "Panes test";

let root: string;
let project: string;
let projectReal: string;
let env: Record<string, string>;
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
  root = await mkdtemp(path.join(tmpdir(), "dawg-panes-"));
  project = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# Panes test\n");
  await writeFile(path.join(project, "src", "answer.ts"), "export const answer = 41;\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "dawg e2e");
  git("config", "user.email", "e2e@example.invalid");
  git("add", ".");
  git("commit", "-q", "-m", "Start");
  projectReal = await realpath(project);

  const answerFile = path.join(projectReal, "src", "answer.ts");
  const script = {
    server: { model: "e2e-model", contextWindow: 32_768 },
    replies: [
      { toolCalls: [{ name: "Read", arguments: { file_path: answerFile } }] },
      {
        toolCalls: [
          {
            name: "Edit",
            arguments: { file_path: answerFile, old_string: "41", new_string: "42" },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "Bash",
            arguments: {
              command: "sleep 120",
              description: "A two-minute timer",
              run_in_background: true,
            },
          },
        ],
      },
      { text: FINAL },
    ],
    lanes: { title: { match: { system: "short title" }, replies: [{ text: TITLE }] } },
  };
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(script));
  const serverUrl = await startMockServer(scriptFile);

  env = {};
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
  if (root) {
    try {
      git("worktree", "prune");
    } catch {
      // The repository may be gone already.
    }
    await rm(root, { recursive: true, force: true });
  }
  if (pageErrors.length > 0) console.log(`Errors in the page:\n${pageErrors.join("\n")}`);
});

const transcript = () => page.getByRole("log", { name: "Transcript" });
const composer = () => page.getByRole("textbox", { name: "Message to dawg" });
const paneButtons = () => page.getByRole("navigation", { name: "Side panes" });
const dock = () => page.getByRole("complementary", { name: "Side panes" });
const dialog = () => page.getByRole("dialog");
const alert = () => page.getByRole("alertdialog");

async function showPane(name: "Changes" | "Files" | "Terminal" | "Plan" | "Tasks") {
  if (await dock().isVisible()) {
    await dock()
      .getByRole("tab", { name: new RegExp(`^${name}`) })
      .click();
  } else {
    await paneButtons()
      .getByRole("button", { name: new RegExp(`^${name}`) })
      .click();
  }
  await expect(dock().getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("a git project offers a worktree; without one the session starts in the folder", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(dialog().getByText("Run in a worktree")).toBeVisible();
  await dialog()
    .getByRole("button", { name: /^Start session/ })
    .click();
  await expect(dialog()).toHaveCount(0);
  await expect(composer()).toBeVisible();
});

test("the agent reads, edits after asking, and leaves a command running", async () => {
  await composer().fill(PROMPT);
  await composer().press("Enter");
  await expect(transcript().getByText(PROMPT)).toBeVisible();
  // The edit asks first. `sleep` changes nothing, so the command runs without asking.
  const allow = page.getByRole("button", { name: /^Allow once/, disabled: false });
  await expect(allow).toBeVisible({ timeout: 20_000 });
  await allow.click();
  await expect(transcript().getByText(FINAL)).toBeVisible({ timeout: 30_000 });
  expect(await readFile(path.join(project, "src", "answer.ts"), "utf8")).toBe(
    "export const answer = 42;\n",
  );
});

test("Changes shows the edit against the start of the session, and reverts it", async () => {
  await showPane("Changes");
  const list = dock().getByRole("list", { name: "Changed files" });
  const file = list.getByRole("button", { name: /^src\/answer\.ts, modified/ });
  await expect(file).toBeVisible();
  await file.click();
  await expect(dock().getByRole("region", { name: /^Diff of src\/answer\.ts/ })).toBeVisible();

  await dock().getByRole("button", { name: "Revert file" }).click();
  await alert().getByRole("button", { name: "Revert file" }).click();
  await expect
    .poll(() => readFile(path.join(project, "src", "answer.ts"), "utf8"))
    .toBe("export const answer = 41;\n");
  await expect(list.getByRole("button", { name: /^src\/answer\.ts/ })).toHaveCount(0);
});

test("Files lists the project, and an edit made there is saved to disk", async () => {
  await showPane("Files");
  const tree = dock().getByRole("tree", { name: "Files" });
  await expect(tree.getByRole("treeitem", { name: /README\.md/ })).toBeVisible();
  await tree.getByRole("treeitem", { name: /README\.md/ }).click();
  const editor = dock().locator(".monaco-editor").first();
  await expect(editor.locator(".view-lines")).toContainText("Panes test");

  await editor.locator(".view-lines").click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("Edited in the Files pane.");
  await page.keyboard.press("Meta+s");
  await expect
    .poll(() => readFile(path.join(project, "README.md"), "utf8"))
    .toContain("Edited in the Files pane.");
});

test("Terminal runs the person's shell in the session's folder", async () => {
  await showPane("Terminal");
  await dock().getByRole("button", { name: "New terminal" }).click();
  const screen = dock().locator(".xterm-rows");
  await expect(screen).toBeVisible();
  await dock().locator(".xterm").first().click();
  await page.keyboard.type("pwd && echo dawg-e2e-$((40 + 2))");
  await page.keyboard.press("Enter");
  await expect(screen).toContainText("dawg-e2e-42", { timeout: 15_000 });
  // The shell prints the folder as it was given (macOS's /var is /private/var).
  await expect(screen).toContainText(/dawg-panes-[^/]+\/project/);
});

test("Tasks shows the background command, and Stop ends it", async () => {
  await showPane("Tasks");
  const stop = dock().getByRole("button", { name: /^Stop / });
  await expect(stop).toBeVisible();
  await stop.click();
  await alert().getByRole("button", { name: "Stop the command" }).click();
  await expect(dock().getByRole("button", { name: /^Stop / })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(
    dock()
      .getByText(/stopped/i)
      .first(),
  ).toBeVisible();
});

test("a worktree session runs in .dawg/worktrees, and archiving it removes the worktree", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await dialog().getByText("Run in a worktree").click();
  const name = dialog().getByLabel("Worktree name");
  await name.fill("e2e-tree");
  await dialog()
    .getByRole("button", { name: /^Start session/ })
    .click();
  await expect(dialog()).toHaveCount(0, { timeout: 20_000 });
  await expect(composer()).toBeVisible();

  const worktree = path.join(project, ".dawg", "worktrees", "e2e-tree");
  expect(existsSync(worktree)).toBe(true);
  expect(git("worktree", "list")).toContain("e2e-tree");
  expect(git("branch", "--list", "dawg/e2e-tree")).toContain("dawg/e2e-tree");
  await expect(page.getByText(/worktree · e2e-tree/)).toBeVisible();

  // The new session has no title yet; it is the selected row.
  const row = page.getByRole("button", { name: /^New session, / }).first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText("Removed the worktree.")).toBeVisible({ timeout: 20_000 });
  expect(existsSync(worktree)).toBe(false);
});

test("no errors in the page", () => {
  expect(pageErrors).toEqual([]);
});
