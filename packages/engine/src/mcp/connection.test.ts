/**
 * One server over each transport (Phase 4 spec, Testing: "a test MCP server over each
 * transport, including … a crash"): stdio, streamable HTTP and the older SSE; a server that
 * crashes and is started again; one that never starts; one that wants a sign-in.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer, TEST_SERVER } from "./__fixtures__/servers.ts";
import { McpConnection } from "./connection.ts";

const children: ChildProcess[] = [];
const connections: McpConnection[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of connections.splice(0)) await c.stop();
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function connection(
  config: ConstructorParameters<typeof McpConnection>[0]["config"],
  restartDelaysMs: number[] = [],
): McpConnection {
  const made = new McpConnection({
    name: "test",
    config,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    connectTimeoutMs: 10_000,
    restartDelaysMs,
    clientInfo: { name: "dawg-test", version: "0.0.0" },
  });
  connections.push(made);
  return made;
}

async function connected(c: McpConnection): Promise<void> {
  c.start();
  await c.whenSettled(10_000);
  expect(c.reason).toBeNull();
  expect(c.state).toBe("connected");
}

const signal = () => new AbortController().signal;

describe("an MCP server", () => {
  it("over stdio: lists its tools, resources and prompts, and answers calls", async () => {
    const c = connection({
      type: "stdio",
      command: process.execPath,
      args: [TEST_SERVER],
      env: {},
    });
    await connected(c);
    expect(c.tools.map((t) => t.name)).toEqual(["echo", "add", "big", "fail", "picture", "crash"]);
    expect(c.resources.map((r) => r.uri)).toEqual(["docs://readme", "docs://data.json"]);
    expect(c.prompts.map((p) => p.name)).toEqual(["review"]);
    expect(c.instructions).toBe("Use the test server's tools for tests.");
    const result = await c.callTool("echo", { text: "hi" }, { signal: signal(), timeoutMs: 5000 });
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
    const read = await c.readResource("docs://readme", signal());
    expect(read.contents[0]).toMatchObject({ text: "The test project." });
    const prompt = await c.getPrompt("review", { target: "the diff" }, signal());
    expect(prompt.messages[0]?.content).toEqual({ type: "text", text: "Review the diff." });
  });

  it("over stdio: starts with its env, and the project folder named", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-mcp-env-"));
    dirs.push(dir);
    const log = path.join(dir, "log.txt");
    const c = connection({
      type: "stdio",
      command: process.execPath,
      args: [TEST_SERVER, "--log", log],
      env: { TEST_SECRET: "s3cret" },
    });
    await connected(c);
    expect(await readFile(log, "utf8")).toMatch(/env\.TEST_SECRET=s3cret/);
  });

  for (const transport of ["http", "sse"] as const) {
    it(`over ${transport === "http" ? "streamable HTTP" : "SSE"}: sends its headers and answers calls`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "dawg-mcp-http-"));
      dirs.push(dir);
      const log = path.join(dir, "log.txt");
      const server = await startHttpServer(transport, ["--log", log]);
      children.push(server.child);
      const c = connection({
        type: transport,
        url: server.url,
        headers: { "X-Test-Secret": "hdr" },
      });
      await connected(c);
      const result = await c.callTool("add", { a: 2, b: 3 }, { signal: signal(), timeoutMs: 5000 });
      expect(result.content).toEqual([{ type: "text", text: "5" }]);
      expect(await readFile(log, "utf8")).toMatch(/secret=hdr/);
    });
  }

  it("that crashes is started again after a pause", async () => {
    const c = connection(
      {
        type: "stdio",
        command: process.execPath,
        args: [TEST_SERVER, "--crash-on", "crash"],
        env: {},
      },
      [50, 50],
    );
    await connected(c);
    const states: string[] = [];
    c.onChange(() => states.push(c.state));
    await expect(c.callTool("crash", {}, { signal: signal(), timeoutMs: 5000 })).rejects.toThrow();
    await expect.poll(() => states.includes("failed"), { timeout: 5000 }).toBe(true);
    await expect.poll(() => c.state, { timeout: 10_000 }).toBe("connected");
    const result = await c.callTool(
      "echo",
      { text: "back" },
      { signal: signal(), timeoutMs: 5000 },
    );
    expect(result.content).toEqual([{ type: "text", text: "echo: back" }]);
  });

  it("that cannot start fails with its reason once the tries run out", async () => {
    const c = connection(
      {
        type: "stdio",
        command: process.execPath,
        args: ["-e", "console.error('no config'); process.exit(4)"],
        env: {},
      },
      [20],
    );
    c.start();
    await expect
      .poll(() => c.state === "failed" && !/tries again/.test(c.reason ?? ""), { timeout: 10_000 })
      .toBe(true);
    expect(c.reason).toMatch(/Could not start it/);
    await expect(c.callTool("echo", {}, { signal: signal(), timeoutMs: 1000 })).rejects.toThrow(
      /not connected/,
    );
  });

  it("that wants a sign-in says so; a refused header of its own is a failure", async () => {
    const server = await startHttpServer("http", ["--auth", "right"]);
    children.push(server.child);
    const bare = connection({ type: "http", url: server.url, headers: {} });
    bare.start();
    await bare.whenSettled(10_000);
    expect(bare.state).toBe("needs-sign-in");
    const wrong = connection({
      type: "http",
      url: server.url,
      headers: { Authorization: "Bearer wrong" },
    });
    wrong.start();
    await wrong.whenSettled(10_000);
    expect(wrong.state).toBe("failed");
    expect(wrong.reason).toMatch(/refused the Authorization header/);
    const right = connection({
      type: "http",
      url: server.url,
      headers: { Authorization: "Bearer right" },
    });
    await connected(right);
  });
});
