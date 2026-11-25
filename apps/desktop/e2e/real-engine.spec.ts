/**
 * The real engine end to end: the built app with DAWG_ENGINE unset, talking to the scripted mock
 * model server (`packages/mock-model`). Main's test hook, DAWG_TEST_SERVER_URL, adds that server
 * as a remote server and makes its model the default, so nothing is downloaded.
 *
 * A session opens on a temporary folder, a prompt's reply streams in, and after quitting and
 * launching again the session and its transcript are still there.
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

const PROMPT = "Say hello to the test.";
/** Sent in pieces, half a second apart, so the reply is seen while it streams. */
const REPLY = ["Hello ", "from ", "the ", "scripted ", "mock ", "model."];
const TITLE = "Greeting the test";

/** The mock server's script: one reply for the conversation, one for the session's title. */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [{ text: REPLY, pacing: { firstEventDelayMs: 300, delayMs: 500 } }],
  lanes: { title: { match: { system: "short title" }, replies: [{ text: TITLE }] } },
};

let root: string;
let project: string;
let env: Record<string, string>;
let mock: ChildProcess | null = null;
/** Requests the mock server logged (`--verbose`), one JSON object each. */
const served: { path: string; lane?: string }[] = [];
let app: ElectronApplication | null = null;
let page: Page;
const pageErrors: string[] = [];

test.describe.configure({ mode: "serial" });

/** Starts the mock model server and resolves with its OpenAI root (`http://127.0.0.1:n/v1`). */
async function startMockServer(scriptFile: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [mockCli, "--script", scriptFile, "--port", "0", "--verbose"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
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

async function launch(): Promise<void> {
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
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-real-"));
  project = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# A test project\n");
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
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  mock?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (pageErrors.length > 0) console.log(`Errors in the page:\n${pageErrors.join("\n")}`);
});

const transcript = () => page.getByRole("log", { name: "Transcript" });
const composer = () => page.getByRole("textbox", { name: "Message to dawg" });
const row = (title: string) => page.getByRole("button", { name: new RegExp(`^${title}`) });

test("the app reports the real engine", async () => {
  const engine = await page.evaluate(
    () =>
      (window as Window & { dawgPreload?: { platform: { engine: string } } }).dawgPreload?.platform
        .engine,
  );
  expect(engine).toBe("real");
});

test("a new session streams the model's reply", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();
  await composer().fill(PROMPT);
  await composer().press("Enter");

  await expect(transcript().getByText(PROMPT)).toBeVisible();
  // Part of the reply shows while the turn is still running...
  await expect(transcript().getByText(/Hello from/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stop/ })).toBeVisible();
  // ...then all of it, and the turn ends.
  await expect(transcript().getByText(REPLY.join(""))).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  // The title came from the model's title lane.
  await expect(row(TITLE)).toBeVisible();

  const lanes = () => served.filter((r) => r.path === "/v1/chat/completions").map((r) => r.lane);
  await expect.poll(lanes).toEqual(expect.arrayContaining(["main", "title"]));
});

test("after quitting and launching again, the session and its transcript are there", async () => {
  await app?.close();
  app = null;
  await launch();

  await expect(row(TITLE)).toBeVisible();
  await row(TITLE).click();
  await expect(transcript().getByText(PROMPT)).toBeVisible();
  await expect(transcript().getByText(REPLY.join(""))).toBeVisible();
  // Viewing a stored session asks the model nothing.
  expect(served.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(2);
});
