// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP definitions write ${VAR} variables literally
/**
 * MCP configuration (Phase 4 spec, MCP; code.claude.com/docs/en/mcp): reading each definition,
 * variable expansion, the precedence of the places servers are defined, the settings keys, and
 * the import of Claude Code's own servers.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandVariables, parseServer } from "./config.ts";
import { applyMcpImport, McpImportError, planMcpImport, secretsIn } from "./import.ts";
import { approvedBySettings, blockedBySettings, readMcpSettings } from "./settings.ts";
import { effectiveDefinitions, readMcpSources } from "./sources.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "dawg-compat-mcp-")));
  home = join(root, "home");
  project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

describe("variable expansion", () => {
  const env = { HOST: "example.com", EMPTY: "", TOKEN: "t0k" };

  it("expands ${VAR} and ${VAR:-default}, an empty value counting as set", () => {
    const missing: string[] = [];
    expect(expandVariables("https://${HOST}/mcp", { env }, missing)).toBe(
      "https://example.com/mcp",
    );
    expect(expandVariables("${PORT:-8080}", { env }, missing)).toBe("8080");
    expect(expandVariables("[${EMPTY:-x}]", { env }, missing)).toBe("[]");
    expect(missing).toEqual([]);
  });

  it("leaves a variable with no value or default as written, and names it", () => {
    const missing: string[] = [];
    expect(expandVariables("${NOPE}/${NOPE}/${ALSO}", { env }, missing)).toBe(
      "${NOPE}/${NOPE}/${ALSO}",
    );
    expect(missing).toEqual(["NOPE", "ALSO"]);
  });

  it("withholds credentials from a project's remote server", () => {
    const parsed = parseServer(
      {
        type: "http",
        url: "https://${HOST}/mcp",
        headers: { Authorization: "Bearer ${ANTHROPIC_API_KEY}", "X-Token": "${TOKEN}" },
      },
      {
        env: { ...env, ANTHROPIC_API_KEY: "sk-secret" },
        withheld: new Set(["ANTHROPIC_API_KEY"]),
      },
    );
    expect(parsed.config).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer ", "X-Token": "t0k" },
    });
  });
});

describe("a server definition", () => {
  const env = { HOME_DIR: "/Users/me", KEY: "k" };

  it("reads a local server, expanding its command, arguments and environment", () => {
    const parsed = parseServer(
      { command: "${HOME_DIR}/bin/srv", args: ["--key", "${KEY}", 3], env: { A: "${KEY}", B: 1 } },
      { env },
    );
    expect(parsed).toMatchObject({
      status: "ok",
      transport: "stdio",
      target: "${HOME_DIR}/bin/srv --key ${KEY} 3",
      config: {
        type: "stdio",
        command: "/Users/me/bin/srv",
        args: ["--key", "k", "3"],
        env: { A: "k", B: "1" },
      },
      notes: [],
    });
  });

  it("reads remote servers, streamable HTTP and SSE, with timeout and alwaysLoad", () => {
    expect(
      parseServer(
        { type: "streamable-http", url: "https://a.example/mcp", timeout: 5000 },
        { env },
      ),
    ).toMatchObject({ status: "ok", transport: "http", timeoutMs: 5000 });
    expect(
      parseServer(
        { type: "sse", url: "https://u:p@a.example/sse?key=1", alwaysLoad: true },
        { env },
      ),
    ).toMatchObject({
      status: "ok",
      transport: "sse",
      target: "https://a.example/sse",
      alwaysLoad: true,
    });
  });

  it("notes what dawg does not use, and a variable that is not set", () => {
    const parsed = parseServer(
      {
        type: "http",
        url: "https://${MISSING_HOST}/mcp",
        headersHelper: "get-headers.sh",
        oauth: { clientId: "x" },
        colour: "blue",
      },
      { env },
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.notes).toEqual([
      "Its headersHelper command is not run yet, so only its fixed headers are sent.",
      "dawg does not use “colour”.",
      "${MISSING_HOST} is not set, so it stays as written.",
    ]);
    expect(parsed.config).toMatchObject({
      oauth: { clientId: "x", callbackPort: null, authServerMetadataUrl: null, scopes: null },
    });
  });

  it("reads a remote server's oauth settings in the documented fields", () => {
    const parsed = parseServer(
      {
        type: "http",
        url: "https://mcp.example.com/mcp",
        oauth: {
          clientId: " my-app ",
          callbackPort: 8080,
          authServerMetadataUrl: "https://auth.example.com/.well-known/openid-configuration",
          scopes: "channels:read   chat:write",
        },
      },
      { env },
    );
    expect(parsed.notes).toEqual([]);
    expect(parsed.config).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: {},
      oauth: {
        clientId: "my-app",
        callbackPort: 8080,
        authServerMetadataUrl: "https://auth.example.com/.well-known/openid-configuration",
        scopes: "channels:read chat:write",
      },
    });
    // Without an oauth object the definition stays as it was, so its connection key does too.
    expect(parseServer({ type: "http", url: "https://a.example/mcp" }, { env }).config).toEqual({
      type: "http",
      url: "https://a.example/mcp",
      headers: {},
    });
  });

  it("leaves out oauth fields that are not valid, and never reads a secret from the file", () => {
    const parsed = parseServer(
      {
        type: "sse",
        url: "https://mcp.example.com/sse",
        oauth: {
          clientId: 7,
          callbackPort: 70_000,
          authServerMetadataUrl: "http://auth.example.com/meta",
          scopes: ["a"],
          clientSecret: "s3cret",
          audience: "x",
        },
      },
      { env },
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.config).toMatchObject({
      oauth: { clientId: null, callbackPort: null, authServerMetadataUrl: null, scopes: null },
    });
    expect(JSON.stringify(parsed.config)).not.toContain("s3cret");
    expect(parsed.notes).toEqual([
      "“oauth.clientId” should be text, so dawg registers itself instead.",
      "“oauth.callbackPort” should be a port number, so a free port is used.",
      "“oauth.authServerMetadataUrl” should be an https:// address, so discovery is used.",
      "“oauth.scopes” should be text, scopes separated by spaces.",
      "“oauth.clientSecret” is not read from the file: set MCP_CLIENT_SECRET when you sign in.",
      "dawg does not use “oauth.audience”.",
    ]);
    expect(
      parseServer({ type: "http", url: "https://a.example", oauth: "yes" }, { env }).notes,
    ).toEqual(["“oauth” should be an object, so signing in works the default way."]);
  });

  it("refuses what is not a definition, and what dawg cannot run", () => {
    expect(parseServer({ url: "https://a.example" }, { env }).status).toBe("invalid");
    expect(parseServer({ type: "http" }, { env }).status).toBe("invalid");
    expect(parseServer({ type: "http", url: "ftp://a.example" }, { env }).status).toBe("invalid");
    expect(parseServer({ command: "x", args: "--flag" }, { env }).status).toBe("invalid");
    expect(parseServer({ type: "ws", url: "wss://a.example" }, { env }).status).toBe(
      "not-supported",
    );
    expect(parseServer("npx srv", { env }).status).toBe("invalid");
  });
});

describe("where servers come from", () => {
  it("uses one definition per name: session, then local, then project, then user", async () => {
    await put(join(project, ".mcp.json"), {
      mcpServers: { shared: { command: "project-shared" }, onlyProject: { command: "p" } },
    });
    await put(join(home, ".dawg", "mcp.json"), {
      mcpServers: {
        shared: { command: "user-shared" },
        onlyUser: { command: "u" },
        mine: { command: "m" },
      },
      projects: { [project]: { mcpServers: { mine: { command: "local-mine" } } } },
    });
    await put(join(home, ".claude.json"), {
      mcpServers: { claudeOnly: { command: "c" } },
      projects: {
        [project]: { mcpServers: { claudeLocal: { type: "http", url: "https://x.example" } } },
      },
    });
    const sources = await readMcpSources({
      cwd: project,
      homeDir: home,
      env: {},
      sessionServers: { onlyUser: { command: "session-wins" } },
    });
    const used = effectiveDefinitions(sources).map((d) => [d.name, d.scope, d.parsed.target]);
    expect(used).toEqual([
      ["onlyUser", "session", "session-wins"],
      ["mine", "local", "local-mine"],
      ["shared", "project", "project-shared"],
      ["onlyProject", "project", "p"],
    ]);
    const shadowed = sources.definitions.filter((d) => d.shadowedBy !== null);
    expect(shadowed.map((d) => [d.name, d.scope, d.shadowedBy?.scope])).toEqual([
      ["shared", "user", "project"],
      ["onlyUser", "user", "session"],
      ["mine", "user", "local"],
    ]);
    // Claude Code's own servers are read, never used.
    expect(sources.claude.map((d) => [d.name, d.project])).toEqual([
      ["claudeOnly", null],
      ["claudeLocal", project],
    ]);
  });

  it("with strict, reads only the session's own servers, and names where they came from", async () => {
    await put(join(project, ".mcp.json"), { mcpServers: { db: { command: "db-mcp" } } });
    await put(join(home, ".dawg", "mcp.json"), {
      mcpServers: { mine: { command: "m" } },
      projects: { [project]: { mcpServers: { local: { command: "l" } } } },
    });
    await put(join(home, ".claude.json"), { mcpServers: { claudeOnly: { command: "c" } } });
    const sources = await readMcpSources({
      cwd: project,
      homeDir: home,
      env: {},
      sessionServers: { docs: { type: "http", url: "https://docs.example.com/mcp" } },
      sessionSource: join(project, "servers.json"),
      strict: true,
    });
    expect(sources.definitions.map((d) => [d.name, d.scope, d.source])).toEqual([
      ["docs", "session", { path: join(project, "servers.json"), origin: "dawg", scope: "flags" }],
    ]);
    // Still listed for the import offer, never started.
    expect(sources.claude.map((d) => d.name)).toEqual(["claudeOnly"]);
  });

  it("names a file that is not JSON, and an mcpServers that is not a table", async () => {
    await put(join(project, ".mcp.json"), "{ nope");
    await put(join(home, ".dawg", "mcp.json"), { mcpServers: ["a"] });
    const sources = await readMcpSources({ cwd: project, homeDir: home, env: {} });
    expect(sources.definitions).toEqual([]);
    expect(sources.problems.map((p) => p.path)).toEqual([
      join(project, ".mcp.json"),
      join(home, ".dawg", "mcp.json"),
    ]);
  });
});

describe("settings keys", () => {
  it("lets only the person's own files approve, and any file turn off", async () => {
    await put(join(project, ".claude", "settings.json"), {
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["db"],
      disabledMcpjsonServers: ["noisy"],
    });
    await put(join(home, ".claude", "settings.json"), { enabledMcpjsonServers: ["docs"] });
    const settings = await readMcpSettings({ projectDir: project, homeDir: home });
    expect(approvedBySettings(settings, "db")).toBe(false);
    expect(approvedBySettings(settings, "docs")).toBe(true);
    expect(blockedBySettings(settings, "noisy", null, true)).toContain("disabledMcpjsonServers");
    expect(blockedBySettings(settings, "noisy", null, false)).toBeNull();
  });

  it("keeps out servers by name, command and URL", async () => {
    await put(join(home, ".dawg", "settings.json"), {
      deniedMcpServers: [{ serverName: "bad" }, { serverUrl: "https://*.evil.example/*" }],
      allowedMcpServers: [
        { serverName: "good" },
        { serverCommand: ["npx", "srv"] },
        { serverUrl: "https://*" },
      ],
    });
    const settings = await readMcpSettings({ projectDir: null, homeDir: home });
    const stdio = (command: string, args: string[]) => ({
      type: "stdio" as const,
      command,
      args,
      env: {},
    });
    const http = (url: string) => ({ type: "http" as const, url, headers: {} });
    expect(blockedBySettings(settings, "bad", null, false)).toContain("deniedMcpServers");
    expect(blockedBySettings(settings, "x", http("https://a.evil.example/mcp"), false)).toContain(
      "deniedMcpServers",
    );
    expect(blockedBySettings(settings, "good", stdio("other", []), false)).toBeNull();
    expect(blockedBySettings(settings, "x", stdio("npx", ["srv"]), false)).toBeNull();
    expect(blockedBySettings(settings, "x", stdio("npx", ["other"]), false)).toContain(
      "allowedMcpServers",
    );
    expect(blockedBySettings(settings, "x", http("https://ok.example/mcp"), false)).toBeNull();
  });
});

describe("importing Claude Code's servers", () => {
  beforeEach(async () => {
    await put(join(home, ".claude.json"), {
      numStartups: 3,
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "gh-mcp"],
          env: { GITHUB_TOKEN: "ghp_secret", HOME_X: "${HOME}" },
        },
        stripe: {
          type: "http",
          url: "https://mcp.stripe.com?key=abc",
          headers: { Authorization: "Bearer sk" },
        },
        socket: { type: "ws", url: "wss://a.example" },
      },
      projects: { [project]: { mcpServers: { db: { command: "db-mcp" } } }, "/elsewhere": {} },
    });
  });

  it("shows what would be copied and names the secrets without their values", async () => {
    const plan = await planMcpImport(home);
    expect(plan.from).toBe(join(home, ".claude.json"));
    expect(plan.to).toBe(join(home, ".dawg", "mcp.json"));
    expect(plan.hash).toMatch(/^sha256:/);
    expect(plan.items).toEqual([
      expect.objectContaining({
        name: "github",
        project: null,
        action: "copy",
        secrets: ["env GITHUB_TOKEN"],
      }),
      expect.objectContaining({
        name: "stripe",
        target: "https://mcp.stripe.com/",
        secrets: ["header Authorization", "a query in the URL"],
        action: "copy",
      }),
      expect.objectContaining({ name: "socket", action: "skip" }),
      expect.objectContaining({ name: "db", project, action: "copy", secrets: [] }),
    ]);
    expect(JSON.stringify(plan)).not.toContain("ghp_secret");
    expect(secretsIn({ env: { A: "${A}" } })).toEqual([]);
  });

  it("copies exactly what was shown, owner-only, keeping dawg's own of the same name", async () => {
    await put(join(home, ".dawg", "mcp.json"), {
      mcpServers: { github: { command: "mine" } },
      other: 1,
    });
    const plan = await planMcpImport(home);
    expect(plan.items.find((i) => i.name === "github")?.action).toBe("skip");
    const claudeBefore = await readFile(join(home, ".claude.json"), "utf8");
    const result = await applyMcpImport(home, plan.hash as string);
    expect(result).toEqual({ imported: 2, path: join(home, ".dawg", "mcp.json") });
    const written = JSON.parse(await readFile(result.path, "utf8"));
    expect(written).toEqual({
      mcpServers: {
        github: { command: "mine" },
        stripe: {
          type: "http",
          url: "https://mcp.stripe.com?key=abc",
          headers: { Authorization: "Bearer sk" },
        },
      },
      other: 1,
      projects: { [project]: { mcpServers: { db: { command: "db-mcp" } } } },
    });
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    // Claude Code's file is never written.
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(claudeBefore);
    // Once copied, there is nothing left to import, and the copies are dawg's servers.
    expect((await planMcpImport(home)).hash).toBeNull();
    const sources = await readMcpSources({ cwd: project, homeDir: home, env: {} });
    expect(
      effectiveDefinitions(sources)
        .map((d) => `${d.name}:${d.scope}`)
        .sort(),
    ).toEqual(["db:local", "github:user", "stripe:user"]);
  });

  it("refuses when Claude Code's servers changed since they were shown", async () => {
    const plan = await planMcpImport(home);
    await put(join(home, ".claude.json"), { mcpServers: { github: { command: "changed" } } });
    await expect(applyMcpImport(home, plan.hash as string)).rejects.toBeInstanceOf(McpImportError);
    await expect(stat(join(home, ".dawg", "mcp.json"))).rejects.toThrow();
  });
});
