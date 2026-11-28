/**
 * Custom commands and skills end to end, on the real engine with the scripted mock model server
 * (as in real-engine.spec.ts). The project has `.claude/commands/greet.md` and
 * `.claude/skills/review/SKILL.md`, written from Claude Code's docs (skills).
 *
 * - The composer's `/` menu lists `/greet` with its argument hint and a "project" tag.
 * - `/greet Ada` sends the expanded prompt: the transcript shows the command as typed, and the
 *   mock answers from the lane that matches the expansion.
 * - A scripted `Skill` call loads the review skill's body, and the next request holds it: only
 *   a request with the body in it is answered "Reviewed".
 * - Settings → Skills and commands lists both, with their files.
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

/** Only in the review skill's body: a request that holds it has loaded the skill. */
const BODY_MARKER = "Check that every public function has a test";

const GREETED = "Hello, Ada! Welcome aboard.";
const REVIEWED = "Reviewed: every public function has a test.";

/**
 * Lanes are tried in order. Titles first; then a request that holds the skill's body; then the
 * prompts themselves, by the last thing the person said.
 */
const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [],
  lanes: {
    title: {
      match: { system: "short title" },
      replies: [{ text: "Greeting Ada" }, { text: "Reviewing" }],
    },
    loaded: { match: { bodyIncludes: BODY_MARKER }, replies: [{ text: REVIEWED }] },
    greet: { match: { lastUser: "Say hello to Ada warmly" }, replies: [{ text: GREETED }] },
    review: {
      match: { lastUser: "Review the project, please" },
      replies: [
        {
          toolCalls: [{ id: "call_skill", name: "Skill", arguments: { skill: "review" } }],
        },
      ],
    },
  },
};

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
  root = await mkdtemp(path.join(tmpdir(), "dawg-skills-"));
  project = path.join(root, "tally");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await put(path.join(project, "README.md"), "# Tally\n");
  await put(
    path.join(project, ".claude", "commands", "greet.md"),
    "---\ndescription: Greet someone by name\nargument-hint: [name]\n---\nSay hello to $ARGUMENTS warmly.\n",
  );
  await put(
    path.join(project, ".claude", "skills", "review", "SKILL.md"),
    [
      "---",
      "name: review",
      "description: Review the project's code against its checklist. Use when asked for a review.",
      "---",
      "",
      `${BODY_MARKER}, and that names say what things are.`,
      "",
      "The full checklist is in checklist.md beside this file.",
      "",
    ].join("\n"),
  );
  await put(path.join(project, ".claude", "skills", "review", "checklist.md"), "- Tests.\n");
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, which reads the files above.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's skills and commands stay out of the test.
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

test("the / menu lists the project's command and skill, tagged, with the argument hint", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  await expect(composer()).toBeVisible();
  await composer().fill("/");
  const menu = page.getByRole("listbox", { name: "Commands" });
  await expect(menu).toBeVisible();
  const greet = menu.getByRole("option", {
    name: "/greet [name], the project's command, Greet someone by name",
  });
  await expect(greet).toBeVisible();
  await expect(greet).toContainText("project");
  await expect(menu.getByRole("option", { name: /^\/review, the project's skill/ })).toBeVisible();
  // dawg's own commands are still there.
  await expect(menu.getByRole("option", { name: /^\/compact/ })).toBeVisible();
  await composer().fill("");
});

test("/greet Ada sends the expanded prompt and shows the command as typed", async () => {
  await composer().fill("/greet Ada");
  await composer().press("Enter");
  await expect(transcript().getByText("/greet Ada", { exact: true })).toBeVisible();
  await expect(transcript().getByText(GREETED)).toBeVisible();
  // The expansion is what the mock matched on.
  await expect.poll(lanes).toContain("greet");
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
});

test("a scripted Skill call loads the skill's body, and the next request holds it", async () => {
  await composer().fill("Review the project, please");
  await composer().press("Enter");
  await expect(transcript().getByText(REVIEWED)).toBeVisible();
  // Only a request with the body in it is answered from the "loaded" lane.
  await expect.poll(lanes).toEqual(expect.arrayContaining(["review", "loaded"]));
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
});

test("Settings → Skills and commands lists both, with their files", async () => {
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: "Search actions and sessions" })
    .fill("skills and commands");
  await expect(
    palette.getByRole("option", { name: /^Settings: Skills and commands/ }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Skills and commands");
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(project);
  const skills = main.getByRole("list", { name: /^Skills/ });
  await expect(skills.getByText("/review", { exact: true })).toBeVisible();
  await expect(skills.getByText(`${project}/.claude/skills/review/SKILL.md`)).toBeVisible();
  await expect(
    skills.getByText("You run it with /review; the agent loads it when a task fits."),
  ).toBeVisible();
  const commands = main.getByRole("list", { name: /^Commands/ });
  await expect(commands.getByText("/greet [name]")).toBeVisible();
  await expect(commands.getByText("Greet someone by name")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
