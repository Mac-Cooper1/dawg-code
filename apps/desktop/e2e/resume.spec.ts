/**
 * "Quitting mid-turn and relaunching restores every session, its transcript and its pending
 * prompts" (docs/specs/phase-3-desktop-app.md, Done when), on the real engine against the
 * scripted mock model server (`packages/mock-model`).
 *
 * Four sessions, each in a folder of its own so the sidebar tells them apart, are left mid-turn:
 * one waiting for permission to write a file, one on a question, one on a plan, and one whose
 * reply is still streaming. The app quits and launches again with the same data folder. The
 * three cards are there, and answering each carries its turn on; the streamed reply is kept and
 * the turn says it was interrupted, and the session carries on. Then what the spec promises
 * about messages sent while dawg works: queued ones go when the turn ends, and stopping the turn
 * holds them until Send now. Last, a person's unsent words survive a quit: a draft and a queued
 * message come back after a relaunch, the message held until Send now.
 *
 * The model's replies are matched on a word in each session's first prompt (`bodyIncludes`), so
 * every request of a session, before and after the relaunch, goes to that session's lane.
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
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const appDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const mockCli = path.join(repoRoot, "packages", "mock-model", "src", "cli.ts");

/** One folder, prompt and title per session. */
const SESSIONS = {
  permission: {
    prompt: "Write the release note (kw-permission).",
    title: "Release note",
  },
  question: { prompt: "Pick a colour for the logo (kw-question).", title: "Logo colour" },
  plan: { prompt: "Plan the cleanup first (kw-plan).", title: "Cleanup plan" },
  stream: { prompt: "Tell me the long story (kw-stream).", title: "Long story" },
} as const;
type SessionKey = keyof typeof SESSIONS;

/** A reply long enough to quit in the middle of: one word every 300 ms. */
const STORY = Array.from({ length: 60 }, (_, i) => `word${i} `);
const SLOW = { firstEventDelayMs: 200, delayMs: 300 };

const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  lanes: {
    // Titles first: their requests carry the first prompt too.
    ...Object.fromEntries(
      Object.entries(SESSIONS).map(([key, s]) => [
        `title-${key}`,
        {
          match: { system: "short title", bodyIncludes: `kw-${key}` },
          replies: [{ text: s.title }],
        },
      ]),
    ),
    permission: {
      match: { bodyIncludes: "kw-permission" },
      replies: [
        {
          toolCalls: [
            {
              name: "Write",
              arguments: { file_path: "release-note.md", content: "Fixed the split.\n" },
            },
          ],
        },
        { text: "Wrote the release note." },
      ],
    },
    question: {
      match: { bodyIncludes: "kw-question" },
      replies: [
        {
          toolCalls: [
            {
              name: "AskUserQuestion",
              arguments: {
                questions: [
                  {
                    question: "Which colour should the logo be?",
                    options: [{ label: "Lime" }, { label: "Graphite" }],
                  },
                ],
              },
            },
          ],
        },
        { text: "Graphite it is." },
      ],
    },
    plan: {
      match: { bodyIncludes: "kw-plan" },
      replies: [
        { toolCalls: [{ name: "EnterPlanMode", arguments: {} }] },
        {
          toolCalls: [
            {
              name: "ExitPlanMode",
              arguments: { plan: "1. Remove the dead code\n2. Run the tests" },
            },
          ],
        },
        { text: "The plan is approved; starting on it." },
      ],
    },
    stream: {
      match: { bodyIncludes: "kw-stream" },
      replies: [
        // Cut off by quitting.
        { text: STORY, pacing: SLOW },
        // After the relaunch: a slow reply, so a message can be queued behind it.
        {
          text: ["Carrying ", "on ", "from ", "where ", "it ", "stopped."],
          pacing: { firstEventDelayMs: 1500, delayMs: 300 },
        },
        { text: "Got the queued message." },
        // Stopped by the person, with a message waiting behind it.
        { text: STORY, pacing: SLOW },
        { text: "Got the held message." },
        // Cut off by quitting again, with a message queued behind it and a draft typed.
        { text: STORY, pacing: SLOW },
        { text: "Got the message kept across the relaunch." },
      ],
    },
  },
};

let root: string;
let env: Record<string, string>;
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

function folderOf(key: SessionKey): string {
  return path.join(root, key);
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: [appDir], cwd: appDir, env, timeout: 30_000 });
  app.process().stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  app.process().stderr?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
}

async function relaunch(): Promise<void> {
  await app?.close();
  app = null;
  await launch();
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-resume-"));
  const home = path.join(root, "home");
  await mkdir(home);
  for (const key of Object.keys(SESSIONS) as SessionKey[]) {
    await mkdir(folderOf(key));
    await writeFile(path.join(folderOf(key), "README.md"), `# ${key}\n`);
  }
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
const stopButton = () => page.getByRole("button", { name: /^Stop/ });
const waiting = () => page.getByRole("list", { name: "Waiting messages" });

/** The session's row: the only one in its folder's group. */
function row(key: SessionKey): Locator {
  return page
    .getByRole("list", { name: key, exact: true })
    .getByRole("button", { name: new RegExp(`^(New session|${SESSIONS[key].title}), `) });
}

/** Starts a session in the key's folder and sends its first prompt. */
async function startSession(key: SessionKey): Promise<void> {
  if (!app) throw new Error("the app is not running");
  // The folder picker answers with this session's folder instead of opening.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, folderOf(key));
  await page.getByRole("button", { name: /^New session$/ }).click();
  await expect(row(key)).toBeVisible();
  await expect(composer()).toBeVisible();
  await composer().fill(SESSIONS[key].prompt);
  await composer().press("Enter");
  await expect(transcript().getByText(SESSIONS[key].prompt)).toBeVisible();
}

test("four sessions are left mid-turn: three on a card, one streaming", async () => {
  await startSession("permission");
  await expect(page.getByRole("region", { name: /^Permission needed/ })).toBeVisible();
  await expect(row("permission")).toHaveAccessibleName(/Needs you/);

  await startSession("question");
  await expect(page.getByRole("region", { name: /^dawg is asking/ })).toBeVisible();
  await expect(row("question")).toHaveAccessibleName(/Needs you: answer a question/);

  await startSession("plan");
  await expect(page.getByRole("region", { name: /^Plan ready for review/ })).toBeVisible();
  await expect(row("plan")).toHaveAccessibleName(/Needs you: approve a plan/);

  await startSession("stream");
  await expect(transcript().getByText(/word0 word1 word2/)).toBeVisible();
  await expect(stopButton()).toBeVisible();
});

test("after quitting and launching again, each session and its transcript are there", async () => {
  await relaunch();
  for (const key of ["permission", "question", "plan"] as const) {
    await expect(row(key)).toHaveAccessibleName(/Needs you/);
  }
  await expect(row("stream")).toBeVisible();
  await expect(row("stream")).not.toHaveAccessibleName(/Needs you|Working/);
});

test("the permission card is there, and allowing it carries the turn on", async () => {
  await row("permission").click();
  await expect(transcript().getByText(SESSIONS.permission.prompt)).toBeVisible();
  const card = page.getByRole("region", { name: /^Permission needed/ });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /^Allow once/ }).click();
  await expect(transcript().getByText("Wrote the release note.")).toBeVisible();
  await expect(stopButton()).toHaveCount(0);
  expect(await readFile(path.join(folderOf("permission"), "release-note.md"), "utf8")).toBe(
    "Fixed the split.\n",
  );
  await expect(row("permission")).toHaveAccessibleName(new RegExp(`^${SESSIONS.permission.title}`));
});

test("the question card is there, and a message from the composer answers it", async () => {
  await row("question").click();
  await expect(page.getByRole("region", { name: /^dawg is asking/ })).toBeVisible();
  // Text sent while a card is open answers that card (the spec's Decision cards).
  await expect(composer()).toHaveAttribute("placeholder", /answers the question/);
  await composer().fill("Graphite, please");
  await composer().press("Enter");
  await expect(transcript().getByText("Graphite it is.")).toBeVisible();
  await expect(page.getByRole("region", { name: /^dawg is asking/ })).toHaveCount(0);
});

test("the plan card is there, and approving it carries the turn on", async () => {
  await row("plan").click();
  const card = page.getByRole("region", { name: /^Plan ready for review/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("Remove the dead code")).toBeVisible();
  await card.getByRole("button", { name: /^Approve(?! and)/ }).click();
  await expect(transcript().getByText("The plan is approved; starting on it.")).toBeVisible();
  await expect(stopButton()).toHaveCount(0);
});

test("the streamed reply is kept, the turn says it was interrupted, and the session carries on", async () => {
  await row("stream").click();
  await expect(transcript().getByText(/word0 word1 word2/)).toBeVisible();
  await expect(transcript().getByText(/^Interrupted/)).toBeVisible();
  await expect(stopButton()).toHaveCount(0);

  // A message sent while dawg works is queued, and goes when the turn ends.
  await composer().fill("carry on");
  await composer().press("Enter");
  await expect(stopButton()).toBeVisible();
  await composer().fill("and then the queued one");
  await composer().press("Enter");
  await expect(waiting().getByText(/^Queued: and then the queued one/)).toBeVisible();
  await expect(transcript().getByText("Carrying on from where it stopped.")).toBeVisible();
  await expect(transcript().getByText("Queued message sent")).toBeVisible();
  await expect(transcript().getByText("Got the queued message.")).toBeVisible();
  await expect(waiting()).toHaveCount(0);
});

test("stopping a turn holds the queued message until Send now", async () => {
  await composer().fill("the long story again");
  await composer().press("Enter");
  await expect(stopButton()).toBeVisible();
  // The second telling streams under the first, cut-off one.
  await expect(transcript().getByText(/word0 word1/)).toHaveCount(2);
  await composer().fill("the held one");
  await composer().press("Enter");
  await expect(waiting().getByText(/^Queued: the held one/)).toBeVisible();
  await stopButton().click();
  await expect(transcript().getByText(/^Interrupted by you/)).toBeVisible();
  const held = waiting().getByRole("listitem").filter({ hasText: "the held one" });
  await expect(held.getByText(/^Held: /)).toBeVisible();
  await expect(held.getByRole("button", { name: "Remove" })).toBeVisible();
  await held.getByRole("button", { name: "Send now" }).click();
  await expect(transcript().getByText("Got the held message.")).toBeVisible();
  await expect(waiting()).toHaveCount(0);
});

test("a draft and a queued message survive a quit, the message held until Send now", async () => {
  await composer().fill("the story a third time");
  await composer().press("Enter");
  await expect(stopButton()).toBeVisible();
  await expect(transcript().getByText(/word0 word1/)).toHaveCount(3);
  await composer().fill("queued before quitting");
  await composer().press("Enter");
  await expect(waiting().getByText(/^Queued: queued before quitting/)).toBeVisible();
  await composer().fill("a draft to keep");
  // Both are in the window state on disk once the debounced save has run.
  const stateFile = path.join(env.DAWG_HOME as string, "state.json");
  await expect
    .poll(async () => readFile(stateFile, "utf8").catch(() => ""))
    .toMatch(
      /a draft to keep[\s\S]*queued before quitting|queued before quitting[\s\S]*a draft to keep/,
    );

  await relaunch();
  await row("stream").click();
  await expect(composer()).toHaveValue("a draft to keep");
  const kept = waiting().getByRole("listitem").filter({ hasText: "queued before quitting" });
  await expect(kept).toContainText("Held: queued before quitting · not sent before dawg-code quit");
  await expect(kept.getByRole("button", { name: "Remove" })).toBeVisible();
  // Nothing is sent after a relaunch without the person asking.
  await page.waitForTimeout(1500);
  await expect(transcript().getByText("queued before quitting")).toHaveCount(0);
  await kept.getByRole("button", { name: "Send now" }).click();
  await expect(transcript().getByText("Got the message kept across the relaunch.")).toBeVisible();
  await expect(waiting()).toHaveCount(0);
  // The draft is still there, unsent.
  await expect(composer()).toHaveValue("a draft to keep");
});
