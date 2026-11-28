/**
 * Subagents end to end, on the real engine with the scripted mock model server (as in
 * skills.spec.ts). The project has `notes/config.txt` with a value only that file holds.
 *
 * - The person asks for the config value; the parent's lane answers with an `Agent` call for an
 *   Explore agent.
 * - The agent's requests have a lane of their own, matched on its system prompt: a Read of the
 *   file, then a final text with the value.
 * - The parent's next request holds the agent's answer, and gets a final text.
 * - The parent's transcript shows the Agent card: Explore, the description, done, the agent's
 *   final message. Opening it shows the agent's own transcript, read-only, with its Read card and
 *   its answer; Esc goes back.
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

/** Only in notes/config.txt, so a request that holds it has read the file (or the answer). */
const VALUE = "quokka-7731";
/** In the Explore agent's system prompt only. */
const EXPLORE_MARKER = "You are the Explore agent";

const PROMPT = "Find the config value in this project";
const DESCRIPTION = "Find the config value";
const AGENT_ANSWER = `The config value is ${VALUE}, in notes/config.txt.`;
const PARENT_ANSWER = `The Explore agent found it: the config value is ${VALUE}.`;

/**
 * Lanes are tried in order. Titles first; then the agent's requests (its second one holds the
 * value too, from the file); then the parent's request that holds the agent's answer; then the
 * person's prompt, by the last thing the person said (the same in both parent requests, so the
 * one with the answer is matched before it).
 */
function script(configFile: string) {
  return {
    server: { model: "e2e-model", contextWindow: 32_768 },
    replies: [],
    lanes: {
      title: { match: { system: "short title" }, replies: [{ text: "Config value" }] },
      explore: {
        match: { system: EXPLORE_MARKER },
        replies: [
          {
            toolCalls: [{ id: "call_read", name: "Read", arguments: { file_path: configFile } }],
          },
          { text: AGENT_ANSWER },
        ],
      },
      answered: { match: { bodyIncludes: VALUE }, replies: [{ text: PARENT_ANSWER }] },
      ask: {
        match: { lastUser: PROMPT },
        replies: [
          {
            toolCalls: [
              {
                id: "call_agent",
                name: "Agent",
                arguments: {
                  description: DESCRIPTION,
                  prompt: "Read notes/config.txt and report the value",
                  subagent_type: "Explore",
                },
              },
            ],
          },
        ],
      },
    },
  };
}

let root: string;
let project: string;
let env: Record<string, string>;
let mock: ChildProcess | null = null;
/** Requests the mock server logged (`--verbose`): which lane answered each. */
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

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-subagents-"));
  project = path.join(root, "tally");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await put(path.join(project, "README.md"), "# Tally\n");
  const configFile = path.join(project, "notes", "config.txt");
  await put(configFile, `# Settings for Tally\nvalue = ${VALUE}\n`);
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(script(configFile)));
  const serverUrl = await startMockServer(scriptFile);

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's agents, skills and settings stay out of the test.
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
const lanes = () => served.filter((r) => r.path === "/v1/chat/completions").map((r) => r.lane);
const AGENT_TITLE = `Explore agent: ${DESCRIPTION}`;

test("an Agent call runs an Explore agent, and its card shows how it went", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();
  await composer().fill(PROMPT);
  await composer().press("Enter");

  // The parent's answer comes once the agent's is in.
  await expect(transcript().getByText(PARENT_ANSWER)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await expect
    .poll(lanes)
    .toEqual(expect.arrayContaining(["ask", "explore", "explore", "answered"]));

  // The card: the agent's type and task, done, and its final message.
  const header = transcript().getByRole("button", { name: new RegExp(`^${AGENT_TITLE}`) });
  await expect(header).toBeVisible();
  await expect(header).toContainText("Explore agent");
  await expect(header).toContainText(DESCRIPTION);
  // `has` is matched inside each candidate, so it takes a locator of its own, not one under the log.
  const card = transcript()
    .locator("[data-state='completed']")
    .filter({ has: page.getByRole("button", { name: new RegExp(`^${AGENT_TITLE}`) }) });
  await expect(card.getByText(/^Done · 1 tool use/)).toBeVisible();
  await expect(card.getByText(AGENT_ANSWER)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("opening the card shows the agent's own transcript, read-only, and Esc goes back", async () => {
  await transcript()
    .getByRole("button", { name: `Open the transcript of ${AGENT_TITLE}` })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: AGENT_TITLE })).toBeVisible();
  const own = transcript();
  // Its Read card and its answer.
  await expect(own.getByRole("button", { name: /^Read notes\/config\.txt/ })).toBeVisible();
  await expect(own.getByText(AGENT_ANSWER)).toBeVisible();
  // Nothing to send from here, and the parent's answer is not in it.
  await expect(composer()).toHaveCount(0);
  await expect(own.getByText(PARENT_ANSWER)).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 2, name: AGENT_TITLE })).toHaveCount(0);
  await expect(transcript().getByText(PARENT_ANSWER)).toBeVisible();
  await expect(composer()).toBeVisible();
  await expect(
    transcript().getByRole("button", { name: `Open the transcript of ${AGENT_TITLE}` }),
  ).toBeFocused();
  expect(pageErrors).toEqual([]);
});
