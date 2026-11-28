/**
 * Signing in to a remote MCP server with OAuth (oauth.ts, through the manager), against the test
 * authorization server and the MCP server it protects (__fixtures__/oauth-server.ts): the whole
 * sign-in with dynamic registration and PKCE; renewal with the refresh token, and a refused one;
 * sign-out; a wrong `state` and a return after the timeout; a server whose URL moved; a client
 * registered in advance. The browser is played by `fetch`; no browser opens.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_CODE_TRUST } from "../trust/index.ts";
import { type OAuthTestServer, startOAuthTestServer } from "./__fixtures__/oauth-server.ts";
import type { McpConnection } from "./connection.ts";
import {
  FileCredentialStore,
  type McpCredentialStore,
  MemoryCredentialStore,
} from "./credentials.ts";
import { McpManager, type McpServerPlan } from "./manager.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function oauthServer(
  options: Parameters<typeof startOAuthTestServer>[0] = {},
): Promise<OAuthTestServer> {
  const server = await startOAuthTestServer(options);
  cleanups.push(() => server.close());
  return server;
}

interface Setup {
  root: string;
  home: string;
  manager: McpManager;
  store: McpCredentialStore;
  writeServers(servers: Record<string, unknown>): Promise<void>;
  plan(name?: string): Promise<McpServerPlan>;
  /** Starts the server for a session, and waits for it to settle. */
  hold(plan: McpServerPlan, holder?: string): Promise<McpConnection>;
}

async function setup(input: {
  servers: Record<string, unknown>;
  store?: (root: string) => McpCredentialStore;
  signInTimeoutMs?: number;
  env?: Record<string, string>;
}): Promise<Setup> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-oauth-"));
  const home = path.join(root, "home");
  const storeRoot = path.join(root, "data");
  await mkdir(path.join(home, ".dawg"), { recursive: true });
  const store = input.store?.(storeRoot) ?? new MemoryCredentialStore();
  const manager = new McpManager({
    homeDir: home,
    storeRoot,
    trust: NO_CODE_TRUST,
    env: () => ({ PATH: process.env.PATH, ...input.env }),
    connectTimeoutMs: 10_000,
    restartDelaysMs: [],
    lingerMs: 0,
    credentials: store,
    ...(input.signInTimeoutMs === undefined ? {} : { signInTimeoutMs: input.signInTimeoutMs }),
  });
  cleanups.push(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  const writeServers = (servers: Record<string, unknown>) =>
    writeFile(path.join(home, ".dawg", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  await writeServers(input.servers);
  return {
    root,
    home,
    manager,
    store,
    writeServers,
    plan: async (name = "secure") => {
      const plans = await manager.plan({ cwd: null, projectDir: null });
      const found = plans.find((p) => p.name === name);
      if (found === undefined) throw new Error(`no plan ${name}`);
      return found;
    },
    hold: async (plan, holder = "s1") => {
      const connection = manager.acquire(plan, holder, home);
      await connection.whenSettled(10_000);
      return connection;
    },
  };
}

/** The browser's part: the authorization page redirects at once; the return is followed. */
async function follow(url: string): Promise<{ status: number; text: string; back: URL }> {
  const authorize = await fetch(url, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get("location") ?? "");
  const page = await fetch(back);
  return { status: page.status, text: await page.text(), back };
}

async function settles(connection: McpConnection, state: McpConnection["state"]): Promise<void> {
  await expect.poll(() => connection.state, { timeout: 10_000 }).toBe(state);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

/** Whether this machine can listen on ::1 (IPv6 may be off). */
const IPV6 = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen({ port: 0, host: "::1", ipv6Only: true }, () => probe.close(() => resolve(true)));
});

/** The browser's return, sent to another loopback address at the same port. */
function at(back: string, host: string): URL {
  const url = new URL(back);
  url.hostname = host;
  return url;
}

describe("signing in to an MCP server", () => {
  it("registers, signs in with PKCE, connects, and keeps the token out of every answer", async () => {
    const auth = await oauthServer();
    const st = await setup({ servers: { secure: { type: "http", url: auth.mcpUrl } } });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    expect(connection.state).toBe("needs-sign-in");
    expect(connection.reason).toBe("The server wants you to sign in first.");
    // A connection alone never registers dawg or asks for a code.
    expect(auth.registrations).toEqual([]);
    expect(auth.authorizeRequests).toEqual([]);
    const [before] = await st.manager.list(null);
    expect(before).toMatchObject({
      state: "needs-sign-in",
      signIn: { status: "signed-out", problem: null },
    });

    const url = new URL(await st.manager.signIn(plan, null));
    expect(url.origin).toBe(auth.issuer);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(url.searchParams.get("resource")).toBe(auth.mcpUrl);
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("localhost");
    expect(redirect.pathname).toBe("/callback");
    expect(auth.registrations).toEqual([{ clientId: "client-1", redirectUris: [redirect.href] }]);
    expect((await st.manager.list(null))[0]?.signIn).toEqual({
      status: "signing-in",
      problem: null,
    });

    const page = await follow(url.href);
    expect(page.status).toBe(200);
    expect(page.text).toBe("Signed in to secure. You can close this tab.\n");
    await settles(connection, "connected");
    expect(connection.tools.map((t) => t.name)).toEqual(["whoami"]);
    const result = await connection.callTool(
      "whoami",
      {},
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      },
    );
    expect(result.content).toEqual([{ type: "text", text: "You are signed in as test-user." }]);

    const [after] = await st.manager.list(null);
    expect(after).toMatchObject({
      state: "connected",
      signIn: { status: "signed-in", problem: null },
      tools: [{ name: "mcp__secure__whoami" }],
    });
    const shown = JSON.stringify(after);
    for (const secret of auth.issued) expect(shown).not.toContain(secret);
    // The listener took its one return and stopped.
    await expect(fetch(page.back)).rejects.toThrow();
    expect(auth.tokenRequests.map((t) => t.grant)).toEqual(["authorization_code"]);
  });

  it("renews a token that ran out without asking, and asks again when renewal is refused", async () => {
    const auth = await oauthServer();
    const st = await setup({ servers: { secure: { type: "http", url: auth.mcpUrl } } });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    await follow(await st.manager.signIn(plan, null));
    await settles(connection, "connected");
    const first = (await st.store.get(keyOf(plan, auth)))?.tokens?.access_token;

    // The token runs out: the next call is refused once, renewed, and goes through.
    auth.expireAccessTokens();
    const result = await connection.callTool(
      "whoami",
      {},
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      },
    );
    expect(result.isError).not.toBe(true);
    expect(auth.tokenRequests.map((t) => t.grant)).toEqual(["authorization_code", "refresh_token"]);
    const renewed = (await st.store.get(keyOf(plan, auth)))?.tokens?.access_token;
    expect(renewed).toBeDefined();
    expect(renewed).not.toBe(first);

    // Renewal refused: the server needs a sign-in again, and says why.
    auth.refuseRefresh = true;
    auth.expireAccessTokens();
    await expect(
      connection.callTool(
        "whoami",
        {},
        { signal: new AbortController().signal, timeoutMs: 10_000 },
      ),
    ).rejects.toThrow();
    await settles(connection, "needs-sign-in");
    expect(connection.reason).toBe(
      "The sign-in ran out and the server would not renew it. Sign in again.",
    );
    const [server] = await st.manager.list(null);
    expect(server?.signIn?.status).toBe("signed-out");
    // A restart does not help, and does not start a sign-in by itself.
    await connection.restart();
    await connection.whenSettled(10_000);
    expect(connection.state).toBe("needs-sign-in");
    expect(auth.authorizeRequests).toHaveLength(1);
  });

  it("signs out: the tokens and the registration are forgotten, and it needs a sign-in again", async () => {
    const auth = await oauthServer();
    const st = await setup({
      servers: { secure: { type: "http", url: auth.mcpUrl } },
      store: (root) => new FileCredentialStore(root),
    });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    await follow(await st.manager.signIn(plan, null));
    await settles(connection, "connected");
    expect(await st.store.get(keyOf(plan, auth))).not.toBeNull();

    await st.manager.signOut(plan);
    expect(await st.store.get(keyOf(plan, auth))).toBeNull();
    await settles(connection, "needs-sign-in");
    const [server] = await st.manager.list(null);
    expect(server?.signIn).toEqual({ status: "signed-out", problem: null });
    // Signing in again registers dawg again.
    await follow(await st.manager.signIn(plan, null));
    await settles(connection, "connected");
    expect(auth.registrations.map((r) => r.clientId)).toEqual(["client-1", "client-2"]);
  });

  it("refuses a return with the wrong state, and keeps waiting for the right one", async () => {
    const auth = await oauthServer();
    const st = await setup({ servers: { secure: { type: "http", url: auth.mcpUrl } } });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    const url = await st.manager.signIn(plan, null);
    const authorize = await fetch(url, { redirect: "manual" });
    const back = new URL(authorize.headers.get("location") ?? "");
    const forged = new URL(back);
    forged.searchParams.set("state", "not-the-state");
    const refused = await fetch(forged);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe(
      "This is not the sign-in to secure that dawg is waiting for.\n",
    );
    const missing = new URL(back);
    missing.searchParams.delete("state");
    expect((await fetch(missing)).status).toBe(400);
    expect((await fetch(new URL("/elsewhere", back))).status).toBe(404);
    expect(auth.tokenRequests).toEqual([]);
    const page = await fetch(back);
    expect(await page.text()).toBe("Signed in to secure. You can close this tab.\n");
    await settles(connection, "connected");
  });

  it("stops waiting after the timeout: a later return finds nobody listening", async () => {
    const auth = await oauthServer();
    const st = await setup({
      servers: { secure: { type: "http", url: auth.mcpUrl } },
      signInTimeoutMs: 150,
    });
    const plan = await st.plan();
    const url = await st.manager.signIn(plan, null);
    const authorize = await fetch(url, { redirect: "manual" });
    const back = authorize.headers.get("location") ?? "";
    await expect
      .poll(async () => (await st.manager.list(null))[0]?.signIn?.status, { timeout: 5_000 })
      .toBe("signed-out");
    await expect(fetch(back)).rejects.toThrow();
    const [server] = await st.manager.list(null);
    expect(server?.signIn?.problem).toBe(
      "Nobody finished signing in within a second, so dawg stopped waiting. Sign in again.",
    );
    expect(auth.tokenRequests).toEqual([]);
  });

  it("cancels a sign-in on its way, and says when the person declined", async () => {
    const auth = await oauthServer();
    const st = await setup({ servers: { secure: { type: "http", url: auth.mcpUrl } } });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    const url = await st.manager.signIn(plan, null);
    st.manager.cancelSignIn(plan);
    const authorize = await fetch(url, { redirect: "manual" });
    await expect(fetch(authorize.headers.get("location") ?? "")).rejects.toThrow();
    expect((await st.manager.list(null))[0]?.signIn).toEqual({
      status: "signed-out",
      problem: null,
    });

    auth.denyNext = "access_denied";
    const page = await follow(await st.manager.signIn(plan, null));
    expect(page.text).toBe(
      "Signing in to secure did not finish (access_denied). You can close this tab.\n",
    );
    const [server] = await st.manager.list(null);
    expect(server?.signIn?.problem).toBe("The sign-in was declined at the authorization server.");
    // The page's own description is not repeated anywhere.
    expect(JSON.stringify(server)).not.toContain("<b>");
    expect(connection.state).toBe("needs-sign-in");
  });

  it("never sends a server's token to the server its URL moved to", async () => {
    const first = await oauthServer();
    const second = await oauthServer();
    const st = await setup({ servers: { secure: { type: "http", url: first.mcpUrl } } });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    await follow(await st.manager.signIn(plan, null));
    await settles(connection, "connected");

    // Same name, same scope, another origin: another server as far as sign-in goes.
    await st.writeServers({ secure: { type: "http", url: second.mcpUrl } });
    const moved = await st.plan();
    expect(moved.key).not.toBe(plan.key);
    const elsewhere = await st.hold(moved, "s2");
    expect(elsewhere.state).toBe("needs-sign-in");
    expect(second.mcpRequests.length).toBeGreaterThan(0);
    for (const request of second.mcpRequests) {
      if (request.bearer !== null) expect(first.issued).not.toContain(request.bearer);
    }
    const [server] = await st.manager.list(null);
    expect(server?.signIn?.status).toBe("signed-out");
    // The first server's sign-in is still there, for its own origin.
    expect(await st.store.get(keyOf(plan, first))).not.toBeNull();
  });

  it.skipIf(!IPV6)(
    "takes the return on ::1 as well; the first one wins and both listeners close",
    async () => {
      const auth = await oauthServer();
      const st = await setup({ servers: { secure: { type: "http", url: auth.mcpUrl } } });
      const plan = await st.plan();
      const connection = await st.hold(plan);
      const authorize = await fetch(await st.manager.signIn(plan, null), { redirect: "manual" });
      const back = authorize.headers.get("location") ?? "";
      // A wrong state on ::1 is refused there too, and the sign-in keeps waiting.
      const forged = at(back, "[::1]");
      forged.searchParams.set("state", "not-the-state");
      expect((await fetch(forged)).status).toBe(400);
      const page = await fetch(at(back, "[::1]"));
      expect(await page.text()).toBe("Signed in to secure. You can close this tab.\n");
      await settles(connection, "connected");
      // Both listeners closed with the sign-in.
      await expect(fetch(at(back, "127.0.0.1"))).rejects.toThrow();
      await expect(fetch(at(back, "[::1]"))).rejects.toThrow();
      expect(auth.tokenRequests.map((t) => t.grant)).toEqual(["authorization_code"]);
    },
  );

  it.skipIf(!IPV6)("signs in on 127.0.0.1 alone when the port is taken on ::1", async () => {
    const port = await freePort();
    const taken = createServer();
    await new Promise<void>((resolve) =>
      taken.listen({ port, host: "::1", ipv6Only: true }, () => resolve()),
    );
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const auth = await oauthServer();
    const st = await setup({
      servers: { secure: { type: "http", url: auth.mcpUrl, oauth: { callbackPort: port } } },
    });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    const url = new URL(await st.manager.signIn(plan, null));
    expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/callback`);
    const authorize = await fetch(url, { redirect: "manual" });
    const page = await fetch(at(authorize.headers.get("location") ?? "", "127.0.0.1"));
    expect(await page.text()).toBe("Signed in to secure. You can close this tab.\n");
    await settles(connection, "connected");
  });

  it("uses a client registered in advance, its callback port and its secret from MCP_CLIENT_SECRET", async () => {
    const port = await freePort();
    const auth = await oauthServer({
      registration: false,
      clients: {
        "my-app": { secret: "app-secret", redirectUris: [`http://localhost:${port}/callback`] },
      },
    });
    const st = await setup({
      servers: {
        secure: {
          type: "http",
          url: auth.mcpUrl,
          oauth: { clientId: "my-app", callbackPort: port, scopes: "mcp:read" },
        },
      },
      env: { MCP_CLIENT_SECRET: "app-secret" },
    });
    const plan = await st.plan();
    const connection = await st.hold(plan);
    const url = new URL(await st.manager.signIn(plan, null));
    expect(url.searchParams.get("client_id")).toBe("my-app");
    expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}/callback`);
    expect(url.searchParams.get("scope")).toBe("mcp:read");
    await follow(url.href);
    await settles(connection, "connected");
    expect(auth.registrations).toEqual([]);
    expect(auth.tokenRequests).toEqual([
      { grant: "authorization_code", clientId: "my-app", secret: "app-secret" },
    ]);
    // Renewal uses the secret kept with the sign-in, not the environment's.
    auth.expireAccessTokens();
    await connection.callTool(
      "whoami",
      {},
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
      },
    );
    expect(auth.tokenRequests.at(-1)).toEqual({
      grant: "refresh_token",
      clientId: "my-app",
      secret: "app-secret",
    });
  });

  it("refuses to sign in to a local server, or one that sends its own Authorization header", async () => {
    const auth = await oauthServer();
    const st = await setup({
      servers: {
        local: { command: process.execPath, args: ["-e", ""] },
        keyed: { type: "http", url: auth.mcpUrl, headers: { Authorization: "Bearer mine" } },
      },
    });
    await expect(st.manager.signIn(await st.plan("local"), null)).rejects.toThrow(
      "local runs on this computer; only remote servers sign in.",
    );
    await expect(st.manager.signIn(await st.plan("keyed"), null)).rejects.toThrow(
      "keyed sends its own Authorization header",
    );
    const servers = await st.manager.list(null);
    expect(servers.map((s) => [s.name, s.signIn])).toEqual([
      ["keyed", null],
      ["local", null],
    ]);
  });

  it("says plainly when the authorization server cannot be reached", async () => {
    const port = await freePort();
    const st = await setup({
      servers: { secure: { type: "http", url: `http://127.0.0.1:${port}/mcp` } },
    });
    await expect(st.manager.signIn(await st.plan(), null)).rejects.toThrow(
      /^Could not start signing in to secure: /,
    );
    const [server] = await st.manager.list(null);
    expect(server?.signIn?.status).toBe("signed-out");
    expect(server?.signIn?.problem).toMatch(/^Could not start signing in to secure: /);
  });
});

function keyOf(plan: McpServerPlan, auth: OAuthTestServer) {
  return { scope: plan.scope, name: plan.name, origin: new URL(auth.mcpUrl).origin };
}
