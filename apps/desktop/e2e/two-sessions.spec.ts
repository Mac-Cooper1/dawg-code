/**
 * "Two sessions can run at once in separate worktrees without interfering"
 * (docs/specs/phase-3-desktop-app.md, Done when), on the real engine against the scripted mock
 * model server (`packages/mock-model`).
 *
 * Two worktree sessions of one git project each run a turn that reads and edits the same file,
 * `notes.txt`, at the same time. They share one model the way sessions share the bundled
 * runtime (DAWG_TEST_SERVER_SLOTS: one conversation slot, scheduled by the engine), so while one
 * request streams the other session waits its turn, and the sidebar says which one is queued.
 * Both finish; each worktree holds its own edit only, the project's own checkout none, and each
 * session's Changes pane shows its own change.
 *
 * The model's replies are matched on a word in each session's prompt (`bodyIncludes`), and are
 * slow to start, so the two turns overlap.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const appDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const mockCli = path.join(repoRoot, "packages", "mock-model", "src", "cli.ts");

const WORKTREES = {
  alpha: { prompt: "Put alpha in the notes (kw-alpha).", title: "Alpha notes" },
  beta: { prompt: "Put beta in the notes (kw-beta).", title: "Beta notes" },
} as const;
type Tree = keyof typeof WORKTREES;

/** Each reply takes a few seconds to start, so the other session's request waits for the slot. */
const SLOW = { firstEventDelayMs: 2500, delayMs: 100 };

function lane(tree: Tree) {
  return {
    match: { bodyIncludes: `kw-${tree}` },
    replies: [
      { toolCalls: [{ name: "Read", arguments: { file_path: "notes.txt" } }], pacing: SLOW },
      {
        toolCalls: [
          {
            name: "Edit",
            arguments: { file_path: "notes.txt", old_string: "start", new_string: tree },
          },
        ],
        pacing: SLOW,
      },
      { text: `Put ${tree} in the notes.`, pacing: SLOW },
    ],
  };
}

const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  lanes: {
    // Titles first: their requests carry the prompt too.
    "title-alpha": {
      match: { system: "short title", bodyIncludes: "kw-alpha" },
      replies: [{ text: WORKTREES.alpha.title }],
    },
    "title-beta": {
      match: { system: "short title", bodyIncludes: "kw-beta" },
      replies: [{ text: WORKTREES.beta.title }],
    },
    alpha: lane("alpha"),
    beta: lane("beta"),
  },
};

let root: string;
let project: string;
let env: Record<string, string>;
let mock: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function worktreeOf(tree: Tree): string {
  return path.join(project, ".dawg", "worktrees", tree);
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
  root = await mkdtemp(path.join(tmpdir(), "dawg-two-"));
  project = path.join(root, "shop");
  const home = path.join(root, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "notes.txt"), "start\n");
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "user.name", "dawg e2e");
  git(project, "config", "user.email", "e2e@example.invalid");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "Start");

  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL; // Always the built page, even when run from a dev shell.
  delete env.DAWG_ENGINE; // The real engine.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's settings and instruction files stay out of the test.
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = serverUrl;
  // The sessions share the server's slots as they would share the bundled runtime's.
  env.DAWG_TEST_SERVER_SLOTS = "1";

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
const dialog = () => page.getByRole("dialog");
const dock = () => page.getByRole("complementary", { name: "Side panes" });
const sessions = () => page.getByRole("navigation", { name: "Sessions" });

/** Session ids by worktree, read from the window's store once each session exists. */
const ids: Partial<Record<Tree, string>> = {};

/**
 * The session's sidebar row. Rows are told apart by their title once the model named them, and
 * before that by which one is selected (a new session is selected when it starts).
 */
function row(tree: Tree): Locator {
  return sessions().getByRole("button", {
    name: new RegExp(`^${WORKTREES[tree].title}, `),
  });
}

/** Starts a session in a new worktree named after `tree`, in Accept edits mode, and prompts it. */
async function startInWorktree(tree: Tree): Promise<void> {
  await page.getByRole("button", { name: /^New session$/ }).click();
  const checkbox = dialog().getByRole("checkbox", { name: /Run in a worktree/ });
  await expect(checkbox).toBeVisible();
  if (!(await checkbox.isChecked())) await checkbox.check();
  await dialog().getByLabel("Worktree name").fill(tree);
  await dialog()
    .getByRole("button", { name: /^Start session/ })
    .click();
  await expect(dialog()).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(new RegExp(`worktree · ${tree}`))).toBeVisible();
  // Edits go ahead without a card, so both turns run on their own.
  await composer().click();
  await composer().press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Permission mode: Accept edits" })).toBeVisible();
  await composer().fill(WORKTREES[tree].prompt);
  await composer().press("Enter");
  await expect(transcript().getByText(WORKTREES[tree].prompt)).toBeVisible();
  ids[tree] = await page.evaluate(() => {
    const field = document.querySelector("[data-session]");
    return field?.getAttribute("data-session") ?? "";
  });
}

test("two worktree sessions start turns at once, and the second waits for the model", async () => {
  await startInWorktree("alpha");
  // Alpha's first request holds the model's only conversation slot for a few seconds.
  await expect(sessions().getByRole("button", { name: /^New session, Working/ })).toBeVisible();

  await startInWorktree("beta");
  // Beta, now selected, waits for the slot; alpha has it.
  await expect(sessions().getByRole("button", { name: /^New session, Queued/ })).toBeVisible();
  await expect(sessions().getByRole("button", { name: /^New session, Working/ })).toBeVisible();
  // The running model's footer counts them.
  await expect(sessions().getByText(/1 running, 1 queued/)).toBeVisible();
});

test("both turns finish, and each worktree holds only its own edit", async () => {
  await expect(transcript().getByText("Put beta in the notes.")).toBeVisible({ timeout: 60_000 });
  // Titles arrive once each turn has finished.
  await expect(row("alpha")).toBeVisible({ timeout: 60_000 });
  await expect(row("beta")).toBeVisible();
  await expect(row("alpha")).toHaveAccessibleName(/Done, not opened yet/);
  await expect(sessions().getByRole("button", { name: /Working|Queued/ })).toHaveCount(0);

  expect(await readFile(path.join(worktreeOf("alpha"), "notes.txt"), "utf8")).toBe("alpha\n");
  expect(await readFile(path.join(worktreeOf("beta"), "notes.txt"), "utf8")).toBe("beta\n");
  // The project's own checkout is untouched, and each branch differs from main by its edit only.
  expect(await readFile(path.join(project, "notes.txt"), "utf8")).toBe("start\n");
  expect(git(worktreeOf("alpha"), "status", "--porcelain")).toBe(" M notes.txt\n");
  expect(git(worktreeOf("beta"), "status", "--porcelain")).toBe(" M notes.txt\n");
  expect(git(project, "status", "--porcelain")).not.toContain("notes.txt");
  expect(git(worktreeOf("alpha"), "diff")).toContain("+alpha");
  expect(git(worktreeOf("alpha"), "diff")).not.toContain("beta");
  expect(git(worktreeOf("beta"), "diff")).toContain("+beta");
  expect(git(worktreeOf("beta"), "diff")).not.toContain("alpha");
});

async function showChanges(): Promise<void> {
  const tab = dock().getByRole("tab", { name: /^Changes/ });
  if (await tab.isVisible()) {
    await tab.click();
  } else {
    await page
      .getByRole("navigation", { name: "Side panes" })
      .getByRole("button", { name: /^Changes/ })
      .click();
  }
  await expect(dock().getByRole("tab", { name: /^Changes/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

for (const tree of ["alpha", "beta"] as const) {
  test(`${tree}'s Changes pane shows its own change only`, async () => {
    await row(tree).click();
    await expect(transcript().getByText(`Put ${tree} in the notes.`)).toBeVisible();
    await showChanges();
    const list = dock().getByRole("list", { name: "Changed files" });
    await expect(list.getByRole("button", { name: /^notes\.txt, modified/ })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await list.getByRole("button", { name: /^notes\.txt/ }).click();
    const diff = dock().getByRole("region", { name: /^Diff of notes\.txt/ });
    await expect(diff).toBeVisible();
    const other = tree === "alpha" ? "beta" : "alpha";
    await expect(diff).toContainText(tree);
    await expect(diff).not.toContainText(other);
  });
}

test("no errors in the page", () => {
  expect(pageErrors).toEqual([]);
  expect(ids.alpha).not.toBe(ids.beta);
});
