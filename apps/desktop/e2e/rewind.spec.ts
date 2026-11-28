/**
 * Rewind on the real engine, against the scripted mock model server (`packages/mock-model`).
 *
 * The model edits notes.txt in two turns ("original" → "first" → "second"). Esc twice in the
 * empty composer opens the rewind dialog; the first checkpoint (just before the first message) is
 * chosen with the keyboard, and "Restore files and conversation". Then notes.txt is back to its
 * first state, "original", and the window has moved to the fork: its transcript shows where it
 * was rewound from, with neither turn in it, and the first message is back in the composer. The
 * original conversation is still in the sidebar, both turns intact.
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

const FIRST_PROMPT = "Change the notes to say first.";
const SECOND_PROMPT = "Now make them say second.";
const FIRST_REPLY = "The notes now say first.";
const SECOND_REPLY = "The notes now say second.";
const TITLE = "Editing the notes";

const call = (name: string, args: Record<string, unknown>) => ({
  toolCalls: [{ name, arguments: args }],
});

/** Two turns that edit notes.txt, then the title. */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [
    call("Read", { file_path: "notes.txt" }),
    call("Edit", { file_path: "notes.txt", old_string: "original", new_string: "first" }),
    { text: FIRST_REPLY },
    call("Edit", { file_path: "notes.txt", old_string: "first", new_string: "second" }),
    { text: SECOND_REPLY },
  ],
  lanes: {
    title: { match: { system: "short title" }, replies: [{ text: TITLE }, { text: TITLE }] },
  },
};

let root: string;
let project: string;
let mock: ChildProcess | null = null;
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

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
  root = await mkdtemp(path.join(tmpdir(), "dawg-rewind-"));
  project = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(path.join(project, ".dawg"), { recursive: true });
  await mkdir(home);
  await writeFile(path.join(project, "notes.txt"), "original\n");
  // Edits run without a card, so the test is about rewinding them.
  await writeFile(
    path.join(project, ".dawg", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
  );
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE;
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's settings and instruction files stay out of the test.
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = serverUrl;

  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // The folder picker answers with the test's project folder instead of opening.
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
const stop = () => page.getByRole("button", { name: /^Stop/ });
const notes = () => readFile(path.join(project, "notes.txt"), "utf8");

test("the model edits the notes in two turns", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();

  await composer().fill(FIRST_PROMPT);
  await composer().press("Enter");
  await expect(transcript().getByText(FIRST_REPLY)).toBeVisible();
  await expect(stop()).toHaveCount(0);
  expect(await notes()).toBe("first\n");
  await expect(page.getByRole("button", { name: new RegExp(`^${TITLE}`) })).toBeVisible();

  await composer().fill(SECOND_PROMPT);
  await composer().press("Enter");
  await expect(transcript().getByText(SECOND_REPLY)).toBeVisible();
  await expect(stop()).toHaveCount(0);
  expect(await notes()).toBe("second\n");
});

test("Esc twice opens rewind; the first checkpoint, files and conversation, rewinds both", async () => {
  await composer().focus();
  await composer().press("Escape");
  await composer().press("Escape");
  const dialog = page.getByRole("dialog", { name: "Rewind" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(/Only changes made by dawg’s file tools are tracked/),
  ).toBeVisible();

  // Newest first: the second message, then the first.
  const list = dialog.getByRole("listbox", { name: "Your messages, newest first" });
  await expect(list).toBeFocused();
  const options = list.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText(SECOND_PROMPT);
  await expect(options.nth(1)).toContainText(FIRST_PROMPT);
  await expect(options.nth(1)).toContainText("Changed 1 file: notes.txt");

  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  const both = dialog.getByRole("button", { name: /Restore files and conversation/ });
  await expect(both).toBeFocused();
  await expect(dialog.getByRole("list", { name: "Files a restore changes" })).toContainText(
    "notes.txt",
  );
  await page.keyboard.press("1");
  await expect(dialog).toHaveCount(0);

  // The file is back to its first state.
  await expect.poll(notes).toBe("original\n");

  // The window moved to the fork: it says where it came from, and holds neither turn.
  const fork = page.getByRole("button", { name: new RegExp(`^${TITLE} \\(rewound\\)`) });
  await expect(fork).toBeVisible();
  const marker = transcript().getByRole("note");
  await expect(marker).toContainText(`Rewound from “${TITLE}”`);
  await expect(transcript().getByText(FIRST_PROMPT)).toHaveCount(0);
  await expect(transcript().getByText(SECOND_PROMPT)).toHaveCount(0);
  // The first message is back in the composer, to send again or change.
  await expect(composer()).toHaveValue(FIRST_PROMPT);
});

test("the original conversation is kept as it was", async () => {
  await transcript().getByRole("button", { name: "Open the original" }).click();
  await expect(transcript().getByText(FIRST_PROMPT)).toBeVisible();
  await expect(transcript().getByText(SECOND_PROMPT)).toBeVisible();
  await expect(transcript().getByText(SECOND_REPLY)).toBeVisible();
  await expect(transcript().getByRole("note")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("/memory lists the files and shows the project's memory in the Files pane", async () => {
  await composer().fill("/memory");
  await composer().press("Enter");
  await expect(transcript().getByText(/Memory for this project:/)).toBeVisible();
  const dock = page.getByRole("complementary", { name: "Side panes" });
  const tree = dock.getByRole("tree", { name: "Files" });
  await expect(tree.getByRole("treeitem", { name: /^Project memory/ })).toBeVisible();
  // MEMORY.md, made by the command, is open, under the data root rather than the project.
  await expect(dock.getByRole("list", { name: "Open files" })).toContainText("MEMORY.md");
  await expect(tree.getByRole("treeitem", { name: /^MEMORY\.md/ })).toBeVisible();
  const memory = await readFile(
    path.join(
      root,
      "data",
      "projects",
      project.replace(/[^A-Za-z0-9]/g, "-"),
      "memory",
      "MEMORY.md",
    ),
    "utf8",
  );
  expect(memory).toBe("");
  expect(pageErrors).toEqual([]);
});
