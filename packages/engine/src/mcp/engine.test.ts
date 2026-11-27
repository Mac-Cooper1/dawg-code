/**
 * MCP in whole sessions, against the scripted model and the test server (__fixtures__): the tool
 * list decided before the first request, in both modes; consent for a project's servers; the
 * dispatcher and ToolSearch; permission rules and hooks on `mcp__` names; the result cap;
 * resources and prompts; sharing; and the protocol's methods, the import included.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { setup } from "../host/__fixtures__/setup.ts";
import { createPromptAssembler } from "../prompt/assembler.ts";
import { type Harness, startHarness } from "../runtime/__fixtures__/harness.ts";
import { createTrustStore } from "../trust/index.ts";
import { TEST_SERVER } from "./__fixtures__/servers.ts";

const FAST = { restartDelaysMs: [50], lingerMs: 0, connectTimeoutMs: 10_000 };

let h: Harness | null = null;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

function stdio(...extra: string[]) {
  return { command: process.execPath, args: [TEST_SERVER, ...extra] };
}

/** The person's servers and settings, in the harness's home. */
async function personal(
  home: string,
  servers: Record<string, unknown>,
  settings: Record<string, unknown> = { permissions: { allow: ["mcp__test"] } },
): Promise<void> {
  await writeJson(path.join(home, ".dawg", "mcp.json"), { mcpServers: servers });
  await writeJson(path.join(home, ".dawg", "settings.json"), settings);
}

function toolNames(request: { body: unknown } | undefined): string[] {
  const tools = (request?.body as { tools?: { function: { name: string } }[] } | undefined)?.tools;
  return (tools ?? []).map((t) => t.function.name);
}

function lastToolText(harness: Harness, sessionId: string, index = -1): string {
  const finished = harness.ofType(sessionId, "tool.finished").at(index);
  const payload = finished?.payload as { content?: { type: string; text?: string }[] } | undefined;
  const content = payload?.content;
  return (content ?? []).map((p) => p.text ?? "").join("\n");
}

const prompt = (words: string) => ({ content: [{ type: "text" as const, text: words }] });

describe("MCP tools in a session", () => {
  it("lists a small server's tools before the first request, and shows a call's result", async () => {
    h = await startHarness({
      script: [toolCall("mcp__test__echo", { text: "hi" }), text("Done.")],
      engine: {
        mcp: FAST,
        capabilities: { permissionPrompts: false },
        assembler: createPromptAssembler(),
      },
    });
    await personal(h.home, { test: stdio() });
    const s = await h.engine.createSession({ cwd: h.project });
    const outcome = await s.run(prompt("Echo hi"));
    expect(outcome.stopReason).toBe("completed");
    const names = toolNames(h.mock.chatRequests[0]);
    expect(names).toEqual(expect.arrayContaining(["Read", "mcp__test__add", "mcp__test__echo"]));
    expect(names).not.toContain("ToolSearch");
    // Server instructions are in the prefix; the tools are not listed twice.
    expect(s.prefix.system.content).toContain("Use the test server's tools for tests.");
    expect(s.prefix.system.content).not.toContain("MCP tools to search for");
    const finished = h.ofType(s.id, "tool.finished")[0]?.payload;
    expect(finished).toMatchObject({
      toolName: "mcp__test__echo",
      outcome: "success",
      display: { kind: "mcp", server: "test", tool: "echo", text: "echo: hi", isError: false },
    });
    // The list sent with the second request is the first's: it never changes in a session.
    expect(toolNames(h.mock.chatRequests[1])).toEqual(names);
    expect(h.problems).toEqual([]);
  });

  it("searches for a large server's tools; the dispatcher checks arguments; rules and hooks see the real name", async () => {
    h = await startHarness({
      script: [
        toolCall("ToolSearch", { query: "select:mcp__test__echo" }),
        toolCall("CallMcpTool", { name: "mcp__test__echo", arguments: {} }),
        toolCall("CallMcpTool", { name: "mcp__test__echo", arguments: { text: "via" } }),
        toolCall("mcp__test__add", { a: 1, b: 2 }),
        toolCall("CallMcpTool", { name: "mcp__test__fail", arguments: {} }),
        toolCall("CallMcpTool", { name: "mcp__test__picture", arguments: {} }),
        toolCall("CallMcpTool", { name: "mcp__nope__x", arguments: {} }),
        text("Done."),
      ],
      engine: {
        mcp: FAST,
        capabilities: { permissionPrompts: false },
        assembler: createPromptAssembler(),
      },
    });
    await personal(
      h.home,
      { test: stdio("--tools", "60") },
      {
        permissions: { allow: ["mcp__test"], deny: ["mcp__test__fail"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__test__pic.*",
              hooks: [{ type: "command", command: "echo 'no pictures here' >&2; exit 2" }],
            },
          ],
        },
      },
    );
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Use the test server"));
    const names = toolNames(h.mock.chatRequests[0]);
    expect(names).toEqual(expect.arrayContaining(["ToolSearch", "CallMcpTool"]));
    expect(names.filter((n) => n.startsWith("mcp__"))).toEqual([]);
    const system = s.prefix.system.content;
    expect(system).toContain("## MCP tools to search for");
    expect(system).toContain("- mcp__test__echo: Echoes the text back.");
    expect(system).not.toContain("A second line the listing leaves out");

    const results = h.ofType(s.id, "tool.finished").map(
      (e) =>
        e.payload as unknown as {
          toolName: string;
          outcome: string;
          content: { text?: string }[];
        },
    );
    expect(results.map((r) => [r.toolName, r.outcome])).toEqual([
      ["ToolSearch", "success"],
      ["CallMcpTool", "invalid"],
      ["CallMcpTool", "success"],
      ["CallMcpTool", "success"],
      ["CallMcpTool", "denied"],
      ["CallMcpTool", "denied"],
      ["CallMcpTool", "invalid"],
    ]);
    const textOf = (i: number) => results[i]?.content.map((p) => p.text ?? "").join("\n") ?? "";
    expect(textOf(0)).toContain('Input schema: {"type":"object"');
    expect(textOf(0)).toContain("mcp__test__echo");
    expect(textOf(1)).toMatch(/do not match its schema.*text/);
    expect(textOf(2)).toBe("echo: via");
    // Called by its listed name, it went through the dispatcher.
    expect(textOf(3)).toBe("3");
    expect(textOf(4)).toMatch(/denied|Denied/);
    expect(textOf(5)).toContain("PreToolUse hook blocked this mcp__test__picture call");
    expect(textOf(5)).toContain("no pictures here");
    expect(textOf(6)).toContain("no MCP tool named mcp__nope__x");
    const hooks = h
      .ofType(s.id, "hook.ran")
      .map((e) => (e.payload as unknown as { outcome: string }).outcome);
    expect(hooks).toEqual(["blocked"]);
  });

  it("saves a result too long for the conversation to a file", async () => {
    h = await startHarness({
      script: [toolCall("mcp__test__big", { chars: 60_000 }), text("Done.")],
      engine: { mcp: FAST, capabilities: { permissionPrompts: false } },
    });
    await personal(h.home, { test: stdio() });
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Get a lot"));
    const finished = h.ofType(s.id, "tool.finished")[0]?.payload as unknown as {
      display: { savedTo: string; chars: number };
    };
    expect(finished.display.chars).toBe(60_000);
    const saved = await readFile(finished.display.savedTo, "utf8");
    expect(saved).toBe("x".repeat(60_000));
    const given = lastToolText(h, s.id);
    expect(given.length).toBeLessThan(3_000);
    expect(given).toContain(`It was saved to ${finished.display.savedTo}`);
  });

  it("reads a resource the person mentions, and runs a prompt as a slash command", async () => {
    const st = await setup({
      script: [text("Read it."), text("Reviewed.")],
      engine: { mcp: FAST },
    });
    cleanups.push(() => st.close());
    await personal(st.home, { test: stdio() });
    const c = await st.connect();
    const snap = await c.client.request("session.create", { cwd: st.project });
    const sessionId = snap.session.id;
    await expect
      .poll(async () => (await c.client.request("mcp.session", { sessionId })).prompts.length)
      .toBe(1);
    const offered = await c.client.request("mcp.session", { sessionId });
    expect(offered.resources.map((r) => [r.name, r.mention])).toEqual([
      ["Read me", "@test:docs://readme"],
      ["data", "@test:docs://data.json"],
    ]);
    expect(offered.prompts[0]).toMatchObject({
      name: "mcp__test__review",
      argumentHint: "<target> [focus]",
      description: "Review something carefully (MCP)",
    });

    const { turnId } = await c.client.request("session.prompt", {
      sessionId,
      prompt: prompt("What does @test:docs://readme say?"),
    });
    await c.waitFor((e) => e.event === "turn.finished" && e.payload.turnId === turnId);
    const sent = JSON.stringify(st.mock.messages(0).at(-1));
    expect(sent).toContain("Contents of the MCP resource docs://readme from test");
    expect(sent).toContain("The test project.");

    const ran = await c.client.request("session.command", {
      sessionId,
      name: "mcp__test__review",
      args: "parser.ts tests",
    });
    expect(ran.turnId).not.toBeNull();
    await c.waitFor((e) => e.event === "turn.finished" && e.payload.turnId === ran.turnId);
    expect(JSON.stringify(st.mock.messages(1).at(-1))).toContain(
      "Review parser.ts, looking at tests.",
    );
    const started = c.events.find(
      (e) => e.event === "turn.started" && e.payload.turnId === ran.turnId,
    );
    expect(started?.payload).toMatchObject({
      command: { name: "mcp__test__review", args: "parser.ts tests" },
    });
    // `/mcp` lists the session's servers.
    const listed = await c.client.request("session.command", { sessionId, name: "mcp", args: "" });
    expect(listed.output).toContain("**test** (yours, stdio): connected, 6 tools");
  });
});

describe("consent and lifecycle", () => {
  it("never starts an unapproved project server; approval starts it, and search reaches it", async () => {
    h = await startHarness({
      script: [
        text("Nothing yet."),
        toolCall("ToolSearch", { query: "echo" }),
        toolCall("CallMcpTool", { name: "mcp__test__echo", arguments: { text: "late" } }),
        text("Done."),
      ],
      engine: { mcp: FAST, capabilities: { permissionPrompts: false } },
    });
    const log = path.join(h.root, "server.log");
    await writeJson(path.join(h.project, ".mcp.json"), {
      mcpServers: { test: stdio("--log", log) },
    });
    await writeJson(path.join(h.home, ".dawg", "settings.json"), {
      permissions: { allow: ["mcp__test"] },
    });
    const trust = createTrustStore({ storeRoot: h.storeRoot, homeDir: h.home });
    const engine = h.newEngine({ trust, mcp: FAST, capabilities: { permissionPrompts: false } });
    const s = await engine.createSession({ cwd: h.project });
    await s.run(prompt("Anything?"));
    await expect(stat(log)).rejects.toThrow();
    expect(s.mcp.infos()).toMatchObject([{ name: "test", state: "needs-approval" }]);
    // The server could come later, so the session can search for it.
    expect(toolNames(h.mock.chatRequests[0])).toEqual(
      expect.arrayContaining(["ToolSearch", "CallMcpTool"]),
    );

    const approval = await trust.approval(h.project);
    expect(approval?.items).toMatchObject([{ kind: "mcp-server", name: "test" }]);
    await trust.decide(h.project, approval?.hash ?? "", true);
    await engine.mcp.refresh(h.project);
    await expect.poll(() => s.mcp.infos()[0]?.state, { timeout: 10_000 }).toBe("connected");
    await s.run(prompt("Now?"));
    expect(lastToolText(h, s.id)).toBe("echo: late");
    expect(await readFile(log, "utf8")).toContain('call echo {"text":"late"}');
  });

  it("keeps a project server off without the trust store, whatever the session does", async () => {
    h = await startHarness({ script: [text("ok")], engine: { mcp: FAST } });
    const log = path.join(h.root, "server.log");
    await writeJson(path.join(h.project, ".mcp.json"), {
      mcpServers: { test: stdio("--log", log) },
    });
    const s = await h.engine.createSession({ cwd: h.project });
    await s.run(prompt("Hello"));
    await s.mcp.refresh();
    await new Promise((r) => setTimeout(r, 200));
    await expect(stat(log)).rejects.toThrow();
  });

  it("shares one server between a folder's sessions, and stops it when the last closes", async () => {
    h = await startHarness({ script: [], engine: { mcp: FAST } });
    const log = path.join(h.root, "server.log");
    await personal(h.home, { test: stdio("--log", log) });
    const a = await h.engine.createSession({ cwd: h.project });
    const b = await h.engine.createSession({ cwd: h.project });
    await expect.poll(() => b.mcp.infos()[0]?.state, { timeout: 10_000 }).toBe("connected");
    expect(a.mcp.infos()[0]?.state).toBe("connected");
    const starts = (await readFile(log, "utf8")).split("\n").filter((l) => l.startsWith("start"));
    expect(starts).toHaveLength(1);
    await a.close();
    expect((await h.engine.mcp.list(h.project))[0]?.state).toBe("connected");
    await b.close();
    expect((await h.engine.mcp.list(h.project))[0]).toMatchObject({ state: "off" });
  });

  it("turns a server off and on, and restarts one no session uses", async () => {
    h = await startHarness({ script: [], engine: { mcp: FAST } });
    await personal(h.home, { test: stdio() });
    const s = await h.engine.createSession({ cwd: h.project });
    await expect.poll(() => s.mcp.infos()[0]?.state, { timeout: 10_000 }).toBe("connected");
    await h.engine.mcp.setEnabled(h.project, "test", false);
    expect(s.mcp.infos()[0]).toMatchObject({ state: "off", enabled: false });
    expect(await readFile(path.join(h.storeRoot, "mcp-switches.json"), "utf8")).toContain("test");
    await h.engine.mcp.setEnabled(h.project, "test", true);
    await expect.poll(() => s.mcp.infos()[0]?.state, { timeout: 10_000 }).toBe("connected");
    await s.close();
    const restarted = await h.engine.mcp.restart(h.project, "test");
    expect(restarted).toMatchObject({ state: "connected" });
    expect(restarted.tools.map((t) => t.name)).toContain("mcp__test__echo");
  });
});

describe("the protocol's MCP methods", () => {
  it("lists servers, and imports Claude Code's only as shown", async () => {
    const st = await setup({ engine: { mcp: FAST } });
    cleanups.push(() => st.close());
    await writeJson(path.join(st.home, ".claude.json"), {
      mcpServers: {
        github: { command: "npx", args: ["-y", "gh"], env: { GITHUB_TOKEN: "ghp_x" } },
      },
    });
    await writeJson(path.join(st.project, ".mcp.json"), { mcpServers: { db: stdio() } });
    const c = await st.connect();
    const listed = await c.client.request("mcp.list", { projectDir: st.project });
    expect(listed.importable).toBe(1);
    expect(listed.servers).toMatchObject([
      { name: "db", scope: "project", transport: "stdio", state: "needs-approval" },
    ]);
    const plan = await c.client.request("mcp.importPreview", {});
    expect(plan.items).toMatchObject([
      { name: "github", action: "copy", secrets: ["env GITHUB_TOKEN"] },
    ]);
    await expect(c.client.request("mcp.import", { hash: "sha256:stale" })).rejects.toMatchObject({
      message: expect.stringContaining("changed since the list was shown"),
    });
    const done = await c.client.request("mcp.import", { hash: plan.hash ?? "" });
    expect(done).toEqual({ imported: 1, path: path.join(st.home, ".dawg", "mcp.json") });
    const after = await c.client.request("mcp.list", { projectDir: st.project });
    expect(after.importable).toBe(0);
    expect(after.servers.map((s) => [s.name, s.scope])).toEqual([
      ["db", "project"],
      ["github", "user"],
    ]);
    await expect(
      c.client.request("mcp.setEnabled", { projectDir: st.project, name: "nope", enabled: false }),
    ).rejects.toMatchObject({ message: expect.stringContaining("No MCP server is named nope") });
  });
});
