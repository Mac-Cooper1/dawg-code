/**
 * Hooks end to end, on the real engine: a project whose `.claude/settings.json` has a PreToolUse
 * hook on Bash (a `.sh` script that blocks `rm`, as in Claude Code's hooks guide) is opened. The
 * trust dialog asks before any of it runs; once approved, a scripted Bash call to `rm` is blocked
 * by the hook, the file stays, and the transcript says why. Settings → Hooks lists the hook.
 *
 * The scripted mock model server stands in for a model (as in real-engine.spec.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const BLOCKED = "rm is not allowed in this project";
const ANSWER = "The project's hook stopped me from removing keep.txt.";

/** Reads the hook input on stdin and refuses `rm` (exit 2: the reason goes to the model). */
const BLOCK_RM = `#!/bin/sh
input=$(cat)
case "$input" in
  *'"command":"rm '*) echo "${BLOCKED}" >&2; exit 2 ;;
esac
exit 0
`;

const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [
    {
      toolCalls: [
        {
          id: "call_rm",
          name: "Bash",
          arguments: { command: "rm keep.txt", description: "Remove keep.txt" },
        },
      ],
    },
    { text: ANSWER },
  ],
  lanes: { title: { match: { system: "short title" }, replies: [{ text: "Removing a file" }] } },
};

let root: string;
let project: string;
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
  root = await mkdtemp(path.join(tmpdir(), "dawg-hooks-"));
  project = path.join(root, "tally");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await put(path.join(project, "keep.txt"), "precious\n");
  await put(
    path.join(project, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: ".claude/hooks/block-rm.sh" }] },
        ],
      },
    }),
  );
  const script = path.join(project, ".claude", "hooks", "block-rm.sh");
  await put(script, BLOCK_RM);
  await chmod(script, 0o755);
  const scriptFile = path.join(root, "script.json");
  await writeFile(scriptFile, JSON.stringify(SCRIPT));
  const serverUrl = await startMockServer(scriptFile);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RENDERER_URL;
  delete env.DAWG_ENGINE; // The real engine, with its trust store and hook runner.
  delete env.DAWG_MOCK_SPEED;
  env.DAWG_HOME = path.join(root, "data");
  // A home of its own, so the person's own settings and hooks stay out of the test.
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

test("opening the project asks before its hook may run, and Approve lets it", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Approve the hooks in tally?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("PreToolUse on Bash: .claude/hooks/block-rm.sh")).toBeVisible();
  await expect(dialog.getByText("Runs a command from the project's files.")).toBeVisible();
  // Not now is where focus starts: nothing runs by accident.
  await expect(dialog.getByRole("button", { name: "Not now" })).toBeFocused();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toHaveCount(0);
});

test("the approved hook blocks a scripted rm, and the transcript shows it", async () => {
  await expect(composer()).toBeVisible();
  await composer().fill("Remove keep.txt");
  await composer().press("Enter");
  await expect(transcript().getByText(ANSWER)).toBeVisible({ timeout: 30_000 });

  const line = transcript().getByRole("button", { name: /^PreToolUse hook blocked Bash/ });
  await expect(line).toBeVisible();
  await expect(line).toContainText(BLOCKED);
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await line.click();
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(transcript().getByText(".claude/hooks/block-rm.sh").first()).toBeVisible();
  await expect(transcript().getByText("Exit code")).toBeVisible();

  // The file is still there: the hook stopped the call before it ran.
  expect(await exists(path.join(project, "keep.txt"))).toBe(true);
  // No permission card: a hook's deny comes before any prompt.
  await expect(page.getByRole("button", { name: /^Allow/ })).toHaveCount(0);
});

test("Settings → Hooks lists the hook with its source and consent", async () => {
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: "Search actions and sessions" })
    .fill("Settings: Hooks");
  await expect(palette.getByRole("option", { name: /^Settings: Hooks/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Hooks");
  const list = main.getByRole("list", { name: "Hooks" });
  await expect(list.getByText(".claude/hooks/block-rm.sh").first()).toBeVisible();
  await expect(list.getByRole("switch").first()).toBeChecked();
  expect(pageErrors).toEqual([]);
});
