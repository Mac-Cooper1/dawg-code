/**
 * The command line's MCP additions (round 3): `--mcp-config` from a file and from inline JSON,
 * invalid input, `--strict-mcp-config`, and precedence over the project's and the person's
 * servers; and signing in from the terminal (`/mcp login`, with the browser played by a script
 * and `fetch`), which a `-p` run never starts. No test opens a browser or reaches the Keychain:
 * the harness sets BROWSER=none and DAWG_CREDENTIAL_STORE=file.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { text } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { parseArgs } from "./args.ts";
import { EXIT } from "./exit-codes.ts";
import { McpConfigError, readMcpConfigs } from "./mcp-config.ts";
import { browserCommand } from "./mcp-sign-in.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../../engine/src/mcp/__fixtures__");
const TEST_SERVER = path.join(FIXTURES, "test-server.ts");

interface AuthState {
  registrations: unknown[];
  authorizeRequests: unknown[];
  tokenRequests: { grant: string }[];
  issued: string[];
}

/** The engine's test authorization server and the MCP server it protects, in a process. */
async function startOAuthServer(): Promise<{ mcpUrl: string; state(): Promise<AuthState> }> {
  const child = spawn(process.execPath, [path.join(FIXTURES, "oauth-server.ts")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(async () => {
    child.kill("SIGTERM");
  });
  const line = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    createInterface({ input: child.stdout }).once("line", resolve);
  });
  const { mcpUrl, issuer } = JSON.parse(line) as { mcpUrl: string; issuer: string };
  return {
    mcpUrl,
    state: async () => (await (await fetch(`${issuer}/test/state`)).json()) as AuthState,
  };
}
const stdio = (name: string) => ({
  command: process.execPath,
  args: [TEST_SERVER, "--name", name],
});

let h: Harness | null = null;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function options(argv: string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== "options") throw new Error(JSON.stringify(parsed));
  return parsed.options;
}

describe("--mcp-config and --strict-mcp-config", () => {
  it("take files and JSON strings, several after one flag or the flag again", () => {
    const parsed = options([
      "-p",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
      "--mcp-config",
      "servers.json",
      "fix the bug",
    ]);
    expect(parsed.mcpConfigs).toEqual(['{"mcpServers":{}}', "servers.json"]);
    expect(parsed.strictMcpConfig).toBe(true);
    expect(parsed.prompt).toBe("fix the bug");
    expect(options(["-p", "hi"])).toMatchObject({ mcpConfigs: [], strictMcpConfig: false });
    expect(parseArgs(["serve", "--mcp-config", "{}"])).toEqual({
      kind: "error",
      message: "dawg serve does not take --mcp-config: clients send those.",
    });
  });

  it("read the servers, a later value winning for a name, and say what is wrong in plain words", async () => {
    h = await startHarness();
    const file = path.join(h.root, "servers.json");
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { a: { command: "a-file" }, b: { command: "b" } } }),
    );
    expect(
      await readMcpConfigs(["servers.json", '{"mcpServers":{"a":{"command":"a-inline"}}}'], h.root),
    ).toEqual({ a: { command: "a-inline" }, b: { command: "b" } });
    expect(await readMcpConfigs([], h.root)).toBeNull();
    await expect(readMcpConfigs(["missing.json"], h.root)).rejects.toThrow(
      "--mcp-config: there is no file missing.json.",
    );
    await expect(readMcpConfigs(["{ nope"], h.root)).rejects.toThrow(
      /^--mcp-config: the JSON given to --mcp-config is not valid JSON/,
    );
    await expect(readMcpConfigs(['{"servers":{}}'], h.root)).rejects.toThrow(
      '--mcp-config: the JSON given to --mcp-config should hold an "mcpServers" object, as .mcp.json does.',
    );
    await expect(readMcpConfigs(["{}"], h.root)).rejects.toBeInstanceOf(McpConfigError);
  });

  it("give the session its own servers, over the project's and yours; strict leaves those out", async () => {
    h = await startHarness();
    await writeFile(
      path.join(h.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { db: stdio("db-project"), notes: stdio("notes") } }),
    );
    await mkdir(path.join(h.home, ".dawg"), { recursive: true });
    await writeFile(
      path.join(h.home, ".dawg", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: stdio("mine") } }),
    );
    await writeFile(
      path.join(h.project, "servers.json"),
      JSON.stringify({ mcpServers: { db: stdio("db-session") } }),
    );
    const inline = JSON.stringify({ mcpServers: { own: stdio("own") } });
    const run = await h.run([
      "-p",
      "--endpoint",
      h.mock.baseUrl,
      "--mcp-config",
      "servers.json",
      inline,
      "/mcp",
    ]);
    expect(run.code).toBe(EXIT.ok);
    // The session's db needs no approval, though the project's db would.
    expect(run.stdout).toMatch(/\*\*db\*\* \(this session's, stdio\): (starting|connected)/);
    expect(run.stdout).toMatch(/\*\*own\*\* \(this session's, stdio\): (starting|connected)/);
    expect(run.stdout).toContain(
      "**notes** (the project's .mcp.json, stdio): waits for your approval",
    );
    expect(run.stdout).toMatch(/\*\*mine\*\* \(yours, stdio\)/);

    const strict = await h.run([
      "-p",
      "--endpoint",
      h.mock.baseUrl,
      "--mcp-config",
      inline,
      "--strict-mcp-config",
      "/mcp",
    ]);
    expect(strict.code).toBe(EXIT.ok);
    expect(strict.stdout).toContain("**own** (this session's, stdio)");
    expect(strict.stdout).not.toContain("**notes**");
    expect(strict.stdout).not.toContain("**mine**");
    expect(strict.stdout).not.toContain("**db**");

    const invalid = await h.run([
      "-p",
      "--endpoint",
      h.mock.baseUrl,
      "--mcp-config",
      "{ nope",
      "hi",
    ]);
    expect(invalid.code).toBe(EXIT.usage);
    expect(invalid.stderr).toContain(
      "--mcp-config: the JSON given to --mcp-config is not valid JSON",
    );
  });
});

describe("signing in from the terminal", () => {
  it("opens the address with $BROWSER, or open on macOS, or prints it only", () => {
    expect(browserCommand({ BROWSER: "none" }, "darwin")).toBeNull();
    expect(browserCommand({ BROWSER: "firefox --new-tab" }, "darwin")).toEqual([
      "firefox",
      "--new-tab",
    ]);
    expect(browserCommand({}, "darwin")).toEqual(["open"]);
    expect(browserCommand({}, "linux")).toEqual(["xdg-open"]);
    expect(browserCommand({}, "win32")).toBeNull();
  });

  it("signs in with /mcp login, opens the browser, connects, and signs out with /mcp logout", async () => {
    const auth = await startOAuthServer();
    h = await startHarness();
    const opened = path.join(h.root, "opened.txt");
    const recorder = path.join(h.root, "browser.mjs");
    await writeFile(
      recorder,
      'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], process.argv[3] + "\\n");\n',
    );
    const servers = JSON.stringify({ mcpServers: { secure: { type: "http", url: auth.mcpUrl } } });
    const child = h.spawn(["--endpoint", h.mock.baseUrl, "--mcp-config", servers], {
      env: { BROWSER: `${process.execPath} ${recorder} ${opened}` },
    });
    const stdin = child.process.stdin;
    if (stdin === null) throw new Error("no stdin");
    stdin.write("/mcp login secure\n");
    await child.waitForStdout("dawg waits five minutes for the browser to come back");
    expect(child.stdout()).toContain("Finish signing in to secure in your browser.");
    // The browser was asked to open the very address printed.
    await expect
      .poll(() => readFile(opened, "utf8").catch(() => ""), { timeout: 10_000 })
      .toMatch(/^http/);
    const url = (await readFile(opened, "utf8")).trim();
    expect(child.stdout()).toContain(url);
    const authorize = await fetch(url, { redirect: "manual" });
    const page = await fetch(authorize.headers.get("location") ?? "");
    expect(await page.text()).toBe("Signed in to secure. You can close this tab.\n");
    await child.waitForStdout("Signed in to secure.\n");
    // The sign-in is kept in the data root's file, never in the Keychain, for the next run.
    const kept = await readFile(path.join(h.dawgHome, "mcp-credentials.json"), "utf8");
    const { issued } = await auth.state();
    expect(kept).toContain(issued[0] as string);

    stdin.write("/mcp\n");
    await child.waitForStdout(
      /\*\*secure\*\* \(this session's, http\): connected, 1 tool\. Signed in\./,
    );
    stdin.write("/mcp logout secure\n");
    await child.waitForStdout("Signed out of secure");
    stdin.end();
    const result = await child.exited;
    expect(result.code).toBe(EXIT.ok);
    for (const secret of issued) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
    const after = JSON.parse(await readFile(path.join(h.dawgHome, "mcp-credentials.json"), "utf8"));
    expect(after.servers).toEqual({});
  });

  it("never starts a sign-in in a -p run, and says which servers it went without", async () => {
    const auth = await startOAuthServer();
    h = await startHarness({ script: [text("Done.")] });
    const servers = JSON.stringify({ mcpServers: { secure: { type: "http", url: auth.mcpUrl } } });
    const run = await h.run(["-p", "--endpoint", h.mock.baseUrl, "--mcp-config", servers, "hi"]);
    expect(run.code).toBe(EXIT.ok);
    expect(run.stderr).toContain(
      "The MCP server secure needs sign-in, so this run went without it. Sign in with /mcp login secure in dawg, or in Settings → MCP servers.",
    );
    const login = await h.run([
      "-p",
      "--endpoint",
      h.mock.baseUrl,
      "--mcp-config",
      servers,
      "/mcp login secure",
    ]);
    expect(login.stderr).toContain("Nobody is here to finish signing in");
    const state = await auth.state();
    expect(state.authorizeRequests).toEqual([]);
    expect(state.registrations).toEqual([]);
  });
});
