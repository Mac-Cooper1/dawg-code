/**
 * The web tools end to end, on the real engine with the scripted mock model server (as in
 * real-engine.spec.ts).
 *
 * - A WebFetch call to an address on this Mac is refused without asking or connecting, and the
 *   transcript says why; the model is given the same reason.
 * - Before a search service is set, sessions are not offered WebSearch.
 * - Settings → Web: SearXNG at a local test instance (a tiny server in this file answering in
 *   SearXNG's JSON shape), "Check it works", Save.
 * - A session opened after that is offered WebSearch; the call asks first, and its card lists
 *   the results as links.
 *
 * No request leaves the machine: the model, the SearXNG stand-in and the refused address are all
 * on 127.0.0.1.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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

const LOCAL_URL = "http://127.0.0.1:9/admin";
const REFUSED_REPLY = "That address is on this Mac, so WebFetch refused it.";
const EARLY_REPLY = "WebSearch was offered before a search service was set.";
const FOUND_REPLY = "Found the timers guide.";
/** Only in the SearXNG stand-in's results: a request holding it has the search results. */
const RESULT_TITLE = "Fake timers guide (fixture)";

/** Lanes are tried in order: titles; follow-ups by what the tool result holds; then prompts. */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [],
  lanes: {
    title: {
      match: { system: "short title" },
      replies: [{ text: "Reading the admin page" }, { text: "Searching for timers" }],
    },
    refused: {
      match: { bodyIncludes: "does not fetch local or private addresses" },
      replies: [{ text: REFUSED_REPLY }],
    },
    early: {
      match: { bodyIncludes: '"name":"WebSearch"', lastUser: "Read the admin page" },
      replies: [{ text: EARLY_REPLY }],
    },
    fetchLocal: {
      match: { lastUser: "Read the admin page" },
      replies: [
        {
          toolCalls: [
            {
              id: "call_fetch",
              name: "WebFetch",
              arguments: { url: LOCAL_URL, prompt: "What is on it?" },
            },
          ],
        },
      ],
    },
    searched: { match: { bodyIncludes: RESULT_TITLE }, replies: [{ text: FOUND_REPLY }] },
    search: {
      // Answered only when the request offers WebSearch.
      match: { bodyIncludes: '"name":"WebSearch"', lastUser: "Search the web for timers" },
      replies: [
        {
          toolCalls: [
            { id: "call_search", name: "WebSearch", arguments: { query: "vitest timers" } },
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
let searx: Server | null = null;
let searxUrl = "";
const searxQueries: string[] = [];
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

/** A stand-in SearXNG instance: `/search?format=json` answers in SearXNG's JSON shape. */
async function startSearx(): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/search" || url.searchParams.get("format") !== "json") {
      res.writeHead(403);
      res.end();
      return;
    }
    searxQueries.push(url.searchParams.get("q") ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        query: url.searchParams.get("q"),
        results: [
          {
            url: "https://vitest.dev/guide/mocking/timers",
            title: RESULT_TITLE,
            content: "Control time in tests.",
          },
          { url: "https://jestjs.io/docs/timer-mocks", title: "Timer mocks", content: "" },
        ],
      }),
    );
  });
  searx = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, project);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-web-"));
  project = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "README.md"), "# A test project\n");
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);
  searxUrl = await startSearx();

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE;
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  env.HOME = home;
  env.DAWG_TEST_SERVER_URL = serverUrl;
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  mock?.kill("SIGTERM");
  searx?.closeAllConnections();
  searx?.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (pageErrors.length > 0) console.log(`Errors in the page:\n${pageErrors.join("\n")}`);
});

const transcript = () => page.getByRole("log", { name: "Transcript" });
const composer = () => page.getByRole("textbox", { name: "Message to dawg" });
const settingsPage = (name: string) =>
  page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name, exact: true });

async function newSession(): Promise<void> {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  // The new session is shown (its empty transcript), not the one that was open before.
  await expect(transcript().getByText(/Nothing here yet/)).toBeVisible();
  await expect(composer()).toBeVisible();
}

async function send(text: string): Promise<void> {
  await composer().fill(text);
  await composer().press("Enter");
}

test("a WebFetch call to an address on this Mac is refused, and the transcript says why", async () => {
  await expect(page.getByRole("button", { name: /Ready\. Model settings$/ })).toBeVisible({
    timeout: 30_000,
  });
  await newSession();
  await send("Read the admin page");

  // The failed call opens by itself, showing the URL asked for and the reason.
  const card = transcript().getByRole("button", { name: /^Fetched 127\.0\.0\.1:9\/admin, failed/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(
    transcript().getByText(
      /WebFetch does not fetch local or private addresses: 127\.0\.0\.1 is this machine \(loopback\)/,
    ),
  ).toBeVisible();
  // The model was told the same, and answered from the "refused" lane.
  await expect(transcript().getByText(REFUSED_REPLY)).toBeVisible();
  // Nothing asked the person: a URL refused outright needs no approval.
  await expect(page.getByRole("button", { name: /^Allow once/ })).toHaveCount(0);
  await expect(transcript().getByText(EARLY_REPLY)).toHaveCount(0);
  const lanes = served.filter((r) => r.path === "/v1/chat/completions").map((r) => r.lane);
  expect(lanes).toEqual(expect.arrayContaining(["fetchLocal", "refused"]));
  expect(lanes).not.toContain("early");
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
});

test("Settings → Web sets up SearXNG and checks it works", async () => {
  await page.keyboard.press("Meta+Comma");
  await settingsPage("Web").click();
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Web");
  await expect(main.getByText("Web search is off.")).toBeVisible();
  await main.getByRole("radio", { name: /^SearXNG/ }).click();
  await main.getByLabel("Instance address").fill(searxUrl);
  await main.getByRole("button", { name: "Check it works" }).click();
  await expect(main.getByText("SearXNG answered with 2 results.")).toBeVisible({ timeout: 20_000 });
  await main.getByRole("button", { name: "Save" }).click();
  await expect(main.getByText("Web search uses SearXNG.")).toBeVisible();
  await expect(main.getByText("Saved. New sessions search with SearXNG.")).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
});

test("a session opened afterwards searches, asking first, and lists the results as links", async () => {
  await newSession();
  await send("Search the web for timers");

  // WebSearch asks by default.
  const allow = page.getByRole("button", { name: /^Allow once/, disabled: false });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Search the web", { exact: true })).toBeVisible();
  await allow.click();

  await expect(transcript().getByText(FOUND_REPLY)).toBeVisible({ timeout: 30_000 });
  expect(searxQueries).toContain("vitest timers");
  const card = transcript().getByRole("button", {
    name: /^Searched the web vitest timers, 2 results/,
  });
  await card.click();
  const results = transcript().getByRole("list", { name: "Results from SearXNG" });
  await expect(results.getByRole("button", { name: RESULT_TITLE })).toBeVisible();
  await expect(results.getByText("vitest.dev")).toBeVisible();
  // A result link asks before opening the browser.
  await results.getByRole("button", { name: RESULT_TITLE }).click();
  await expect(page.getByText("https://vitest.dev/guide/mocking/timers").first()).toBeVisible();
  await page.keyboard.press("Escape");
});
