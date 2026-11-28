/**
 * Round 3 over the protocol: a session's own MCP servers (`session.create`'s `mcpServers` and
 * `strictMcpConfig`), and signing in (`mcp.signIn`, `mcp.signOut`, `mcp.cancelSignIn`, and
 * `/mcp login|logout`), against the scripted model, the stdio test server and the test
 * authorization server. The browser is played by `fetch`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Setup, setup } from "../host/__fixtures__/setup.ts";
import { type OAuthTestServer, startOAuthTestServer } from "./__fixtures__/oauth-server.ts";
import { TEST_SERVER } from "./__fixtures__/servers.ts";

const FAST = { restartDelaysMs: [], lingerMs: 0, connectTimeoutMs: 10_000 };
const NOBODY = { permissionPrompts: false, questions: false, planApproval: false };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(): Promise<Setup> {
  const st = await setup({ engine: { mcp: FAST } });
  cleanups.push(() => st.close());
  return st;
}

async function oauthServer(): Promise<OAuthTestServer> {
  const server = await startOAuthTestServer();
  cleanups.push(() => server.close());
  return server;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

const stdio = (name: string) => ({
  command: process.execPath,
  args: [TEST_SERVER, "--name", name],
});

/** The browser's part: the authorization page redirects at once; the return is followed. */
async function follow(url: string): Promise<string> {
  const authorize = await fetch(url, { redirect: "manual" });
  const page = await fetch(authorize.headers.get("location") ?? "");
  return page.text();
}

describe("a session's own MCP servers", () => {
  it("come first, need no approval, and show with scope session", async () => {
    const st = await start();
    await writeJson(path.join(st.project, ".mcp.json"), {
      mcpServers: { db: stdio("db"), shared: stdio("shared-project") },
    });
    await writeJson(path.join(st.home, ".dawg", "mcp.json"), {
      mcpServers: { mine: stdio("mine") },
    });
    const c = await st.connect();
    const snap = await c.client.request("session.create", {
      cwd: st.project,
      mcpServers: { own: stdio("own"), shared: stdio("shared-session"), broken: { type: "http" } },
    });
    const sessionId = snap.session.id;
    const listed = async () =>
      (await c.client.request("mcp.list", { projectDir: st.project, sessionId })).servers;
    await expect
      .poll(async () => (await listed()).find((s) => s.name === "own")?.state, { timeout: 10_000 })
      .toBe("connected");
    const servers = await listed();
    expect(servers.map((s) => [s.name, s.scope, s.state])).toEqual([
      ["broken", "session", "failed"],
      ["db", "project", "needs-approval"],
      ["mine", "user", expect.stringMatching(/^(starting|connected)$/)],
      ["own", "session", "connected"],
      ["shared", "session", expect.stringMatching(/^(starting|connected)$/)],
    ]);
    expect(servers.find((s) => s.name === "shared")?.notes).toEqual([
      `Takes the place of the definition in ${path.join(st.project, ".mcp.json")}.`,
    ]);
    expect(servers.find((s) => s.name === "broken")?.reason).toMatch(
      /^Its definition is not valid/,
    );
    // The project's list, without the session, does not hold them.
    const project = await c.client.request("mcp.list", { projectDir: st.project });
    expect(project.servers.map((s) => s.name)).toEqual(["db", "mine", "shared"]);
    // `/mcp` shows them as this session's.
    const shown = await c.client.request("session.command", { sessionId, name: "mcp", args: "" });
    expect(shown.output).toContain("**own** (this session's, stdio): connected, 6 tools");
  });

  it("with strictMcpConfig, are the only servers the session gets", async () => {
    const st = await start();
    await writeJson(path.join(st.project, ".mcp.json"), { mcpServers: { db: stdio("db") } });
    await writeJson(path.join(st.home, ".dawg", "mcp.json"), {
      mcpServers: { mine: stdio("mine") },
    });
    const c = await st.connect();
    const snap = await c.client.request("session.create", {
      cwd: st.project,
      mcpServers: { own: stdio("own") },
      strictMcpConfig: true,
    });
    const listed = await c.client.request("mcp.list", {
      projectDir: st.project,
      sessionId: snap.session.id,
    });
    expect(listed.servers.map((s) => [s.name, s.scope])).toEqual([["own", "session"]]);
    // A session without them still gets the others.
    const other = await c.client.request("session.create", { cwd: st.project });
    const its = await c.client.request("mcp.list", {
      projectDir: st.project,
      sessionId: other.session.id,
    });
    expect(its.servers.map((s) => s.name)).toEqual(["db", "mine"]);
  });

  it("are refused when they are not an mcpServers object", async () => {
    const st = await start();
    const c = await st.connect();
    await expect(
      c.client.request("session.create", { cwd: st.project, mcpServers: ["own"] as never }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("signing in over the protocol", () => {
  it("starts in a client someone answers, never in one nobody does", async () => {
    const auth = await oauthServer();
    const st = await start();
    await writeJson(path.join(st.home, ".dawg", "mcp.json"), {
      mcpServers: { secure: { type: "http", url: auth.mcpUrl } },
    });
    const headless = await st.connect({ capabilities: NOBODY });
    await expect(
      headless.client.request("mcp.signIn", { projectDir: null, name: "secure" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Nobody is here to finish signing in"),
    });
    expect(auth.authorizeRequests).toEqual([]);

    const c = await st.connect();
    const { url } = await c.client.request("mcp.signIn", { projectDir: null, name: "secure" });
    const signingIn = await c.client.request("mcp.list", { projectDir: null });
    expect(signingIn.servers[0]?.signIn).toEqual({ status: "signing-in", problem: null });
    expect(await follow(url)).toBe("Signed in to secure. You can close this tab.\n");
    // No session uses it: it is started to show it connected, with its tools.
    await expect
      .poll(async () => (await c.client.request("mcp.list", { projectDir: null })).servers[0], {
        timeout: 10_000,
      })
      .toMatchObject({
        state: "connected",
        tools: [{ name: "mcp__secure__whoami" }],
        signIn: { status: "signed-in", problem: null },
      });

    const out = await c.client.request("mcp.signOut", { projectDir: null, name: "secure" });
    expect(out.server.signIn).toEqual({ status: "signed-out", problem: null });
    await expect
      .poll(
        async () => (await c.client.request("mcp.list", { projectDir: null })).servers[0]?.state,
        {
          timeout: 10_000,
        },
      )
      .toBe("needs-sign-in");

    await c.client.request("mcp.signIn", { projectDir: null, name: "secure" });
    const cancelled = await c.client.request("mcp.cancelSignIn", {
      projectDir: null,
      name: "secure",
    });
    expect(cancelled.server.signIn).toEqual({ status: "signed-out", problem: null });
    await expect(
      c.client.request("mcp.signIn", { projectDir: null, name: "nope" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("reaches an open session through search once the server connects after sign-in", async () => {
    const auth = await oauthServer();
    const st = await start();
    await writeJson(path.join(st.home, ".dawg", "mcp.json"), {
      mcpServers: { secure: { type: "http", url: auth.mcpUrl } },
    });
    const c = await st.connect();
    const snap = await c.client.request("session.create", { cwd: st.project });
    const sessionId = snap.session.id;
    const runtime = st.engine.get(sessionId);
    if (runtime === undefined) throw new Error("not open");
    await expect
      .poll(
        async () =>
          (await c.client.request("mcp.list", { projectDir: st.project, sessionId })).servers[0]
            ?.state,
        { timeout: 10_000 },
      )
      .toBe("needs-sign-in");
    const decision = await runtime.mcp.decide({ contextWindow: 32_768, estimate: () => 10 });
    const before = decision.tools.map((t) => t.name);
    expect(before).toEqual(expect.arrayContaining(["ToolSearch", "CallMcpTool"]));

    const login = await c.client.request("session.command", {
      sessionId,
      name: "mcp",
      args: "login secure",
    });
    expect(login.output).toContain("Open this address in your browser to sign in to **secure**:");
    const url = /<(http[^>]+)>/.exec(login.output ?? "")?.[1] ?? "";
    expect(await follow(url)).toContain("Signed in to secure.");
    await expect
      .poll(() => runtime.mcp.searchText("whoami", 5), { timeout: 10_000 })
      .toContain("mcp__secure__whoami");
    // The tool list stayed as it was decided.
    const again = await runtime.mcp.decide({ contextWindow: 32_768, estimate: () => 10 });
    expect(again.tools.map((t) => t.name)).toEqual(before);
    const listed = await c.client.request("session.command", { sessionId, name: "mcp", args: "" });
    expect(listed.output).toContain("**secure** (yours, http): connected, 1 tool. Signed in.");

    const logout = await c.client.request("session.command", {
      sessionId,
      name: "mcp",
      args: "logout secure",
    });
    expect(logout.output).toBe(
      "Signed out of secure: dawg forgot its tokens and its registration with the server.",
    );
    const after = await c.client.request("session.command", { sessionId, name: "mcp", args: "" });
    await expect
      .poll(
        async () =>
          (await c.client.request("session.command", { sessionId, name: "mcp", args: "" })).output,
      )
      .toContain("To sign in, run `/mcp login secure`.");
    expect(after.output).not.toContain("Signed in.");
    for (const secret of auth.issued) {
      expect(JSON.stringify(c.events)).not.toContain(secret);
    }
  });

  it("refuses /mcp login in a run nobody answers", async () => {
    const auth = await oauthServer();
    const st = await start();
    await writeJson(path.join(st.home, ".dawg", "mcp.json"), {
      mcpServers: { secure: { type: "http", url: auth.mcpUrl } },
    });
    const c = await st.connect({ capabilities: NOBODY });
    const snap = await c.client.request("session.create", { cwd: st.project });
    await expect(
      c.client.request("session.command", {
        sessionId: snap.session.id,
        name: "mcp",
        args: "login secure",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Nobody is here to finish") });
    expect(auth.authorizeRequests).toEqual([]);
  });
});
