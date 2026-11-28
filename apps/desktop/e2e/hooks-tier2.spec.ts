/**
 * Tier 2 hooks end to end, on the real engine: a project whose `.claude/settings.json` has a
 * PermissionRequest hook on Bash (a `.sh` script that allows `touch`, as a policy script would)
 * is opened and approved. A scripted Bash call that would ask in the default mode then runs with
 * no permission card: the hook answered for the person, and the transcript says so. Settings →
 * Hooks shows each hook's handler type and what it reaches.
 *
 * The scripted mock model server stands in for a model (as in hooks.spec.ts).
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

const ANSWER = "Made the file; the project's hook approved it.";

/** Reads the request on stdin and allows `touch`, so nobody is asked; anything else is left alone. */
const ALLOW_TOUCH = `#!/bin/sh
input=$(cat)
case "$input" in
  *'"command":"touch '*)
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    ;;
esac
exit 0
`;

const SCRIPT = {
  server: { model: "e2e-model", contextWindow: 32_768 },
  replies: [
    {
      toolCalls: [
        {
          id: "call_touch",
          name: "Bash",
          arguments: { command: "touch made-by-hook.txt", description: "Create a file" },
        },
      ],
    },
    { text: ANSWER },
  ],
  lanes: { title: { match: { system: "short title" }, replies: [{ text: "Making a file" }] } },
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
  root = await mkdtemp(path.join(tmpdir(), "dawg-hooks-tier2-"));
  project = path.join(root, "tally");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await put(path.join(project, "README.md"), "# tally\n");
  await put(
    path.join(project, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PermissionRequest: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: ".claude/hooks/allow-touch.sh" }],
          },
        ],
        // Listed in Settings → Hooks with what it reaches; the scripted turn never stops on it.
        PostToolUseFailure: [
          {
            matcher: "Bash",
            hooks: [{ type: "http", url: "http://127.0.0.1:9/hooks/failure" }],
          },
        ],
      },
    }),
  );
  const script = path.join(project, ".claude", "hooks", "allow-touch.sh");
  await put(script, ALLOW_TOUCH);
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

test("the project's hooks wait for approval, and Approve lets them run", async () => {
  await page
    .getByRole("button", { name: /^New session/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Approve the hooks in tally?" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("PermissionRequest on Bash: .claude/hooks/allow-touch.sh"),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Sends each event to http:\/\/127\.0\.0\.1:9\/hooks\/failure/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a PermissionRequest hook allows the command, so no prompt card appears", async () => {
  await expect(composer()).toBeVisible();
  await composer().fill("Make a file");
  await composer().press("Enter");
  await expect(transcript().getByText(ANSWER)).toBeVisible({ timeout: 30_000 });

  // The command ran: the hook answered in the person's place.
  expect(await exists(path.join(project, "made-by-hook.txt"))).toBe(true);
  await expect(page.getByRole("button", { name: /^Allow/ })).toHaveCount(0);

  const line = transcript().getByRole("button", { name: /^PermissionRequest hook allowed Bash/ });
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await line.click();
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(transcript().getByText(".claude/hooks/allow-touch.sh").first()).toBeVisible();
});

test("Settings → Hooks names each hook's type and what it reaches", async () => {
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
  await expect(list.getByText(".claude/hooks/allow-touch.sh").first()).toBeVisible();
  const http = list.getByRole("listitem").filter({ hasText: "PostToolUseFailure on Bash" });
  await expect(http.getByText("HTTP", { exact: true })).toBeVisible();
  await expect(http.getByText("Posts to 127.0.0.1:9")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
