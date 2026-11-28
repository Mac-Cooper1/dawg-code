/**
 * Subagent memory scopes and MCP tools for typed agents (Phase 4, round 3), end to end on the
 * engine against the scripted mock model and the MCP test server:
 *
 * - `memory: project` puts the agent's MEMORY.md and how to keep it in its prompt, gives it
 *   Read, Write and Edit, and its writes there need no prompt; nothing happens with auto memory
 *   off.
 * - An agent with no `tools` list gets the session's MCP tools; a list narrows them, with
 *   wildcards and servers alone; `disallowedTools` takes them away; `mcpServers` grants a server
 *   whole and starts one of its own; in deferred mode ToolSearch and CallMcpTool reach only what
 *   the agent may use.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stalled, text, toolCall, toolCalls } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_SERVER } from "../mcp/__fixtures__/servers.ts";
import { createPromptAssembler } from "../prompt/index.ts";
import {
  type Harness,
  type HarnessOptions,
  startHarness,
} from "../runtime/__fixtures__/harness.ts";
import { createTrustStore } from "../trust/index.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const FAST = { restartDelaysMs: [50], lingerMs: 0, connectTimeoutMs: 10_000 };

function start(options: HarnessOptions): Promise<Harness> {
  return startHarness({
    ...options,
    mock: { contextWindow: 200_000, ...options.mock },
    engine: {
      subagents: true,
      assembler: createPromptAssembler(),
      capabilities: { permissionPrompts: false },
      mcp: FAST,
      ...options.engine,
    },
  });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

function server(name: string, ...extra: string[]) {
  return { command: process.execPath, args: [TEST_SERVER, "--name", name, ...extra] };
}

type Body = { messages: { content: unknown }[]; tools?: { function: { name: string } }[] };

function laneBody(harness: Harness, lane: string): Body | undefined {
  return harness.mock.chatRequests.find((r) => r.lane === lane)?.body as Body | undefined;
}

function toolNames(body: Body | undefined): string[] {
  return (body?.tools ?? []).map((t) => t.function.name).sort();
}

function agentFile(name: string, fields: string): string {
  return `---\nname: ${name}\ndescription: The ${name} agent\n${fields}---\nYou help with ${name}.\n`;
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe("an agent's own memory", () => {
  it("loads MEMORY.md into its prompt, gives it the file tools, and writes there without asking", async () => {
    h = await start({
      engine: { autoMemory: true },
      files: { ".claude/agents/scribe.md": agentFile("scribe", "tools: Grep\nmemory: project\n") },
      script: {
        lanes: {
          scribe: {
            match: { system: "You are the scribe agent" },
            replies: [
              toolCall("Write", {
                file_path: ".dawg/agent-memory/scribe/style.md",
                content: "Tabs, not spaces.\n",
              }),
              text("Saved the style."),
            ],
          },
          after: { match: { bodyIncludes: "Saved the style." }, replies: [text("Noted.")] },
          parent: {
            match: { lastUser: "Remember" },
            replies: [
              toolCall("Agent", {
                description: "Save",
                prompt: "Save it.",
                subagent_type: "scribe",
              }),
            ],
          },
        },
      },
    });
    const folder = path.join(h.project, ".dawg", "agent-memory", "scribe");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "MEMORY.md"), "- [Style](style.md): the house style\n");
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Remember the style"));
    const body = laneBody(h, "scribe");
    const system = String(body?.messages[0]?.content);
    expect(system).toContain("# Your memory");
    expect(system).toContain(
      `memory folder of your own that lasts from one task and session to the next: ${folder}`,
    );
    expect(system).toContain("meant to be shared with the team through version control");
    expect(system).toContain("- [Style](style.md): the house style");
    // Read, Write and Edit come with memory, beside the one tool its file lists.
    expect(toolNames(body)).toEqual(["Edit", "Grep", "Read", "Write"]);
    // Nobody could answer a prompt here, so the write went through without one.
    expect(await readFile(path.join(folder, "style.md"), "utf8")).toBe("Tabs, not spaces.\n");
    // The main session's prompt has no agent's memory in it.
    expect(session.prefix.system.content).not.toContain("# Your memory");
  });

  it("does nothing with auto memory off", async () => {
    h = await start({
      engine: { autoMemory: false },
      files: { ".claude/agents/scribe.md": agentFile("scribe", "tools: Grep\nmemory: user\n") },
      script: {
        lanes: {
          scribe: { match: { system: "You are the scribe agent" }, replies: [text("Nothing.")] },
          after: { match: { bodyIncludes: "Nothing." }, replies: [text("ok")] },
          parent: {
            match: { lastUser: "Go" },
            replies: [
              toolCall("Agent", { description: "Go", prompt: "Go.", subagent_type: "scribe" }),
            ],
          },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Go"));
    const body = laneBody(h, "scribe");
    expect(String(body?.messages[0]?.content)).not.toContain("# Your memory");
    expect(toolNames(body)).toEqual(["Grep"]);
    expect(await exists(path.join(h.storeRoot, "agent-memory"))).toBe(false);
  });
});

describe("MCP tools for typed agents", () => {
  it("gives each agent the MCP tools its file allows", async () => {
    h = await start({
      files: {
        ".claude/agents/everything.md": agentFile("everything", ""),
        ".claude/agents/narrow.md": agentFile("narrow", "tools: Read, mcp__test__echo\n"),
        ".claude/agents/wild.md": agentFile("wild", "tools: mcp__other__*\n"),
        ".claude/agents/no-other.md": agentFile("no-other", "disallowedTools: mcp__other, Bash\n"),
        ".claude/agents/granted.md": agentFile("granted", "tools: Read\nmcpServers: [other]\n"),
      },
      script: {
        lanes: {
          everything: {
            match: { system: "You are the everything agent" },
            replies: [text("everything done")],
          },
          narrow: { match: { system: "You are the narrow agent" }, replies: [text("narrow done")] },
          wild: {
            match: { system: "You are the wild agent" },
            replies: [toolCall("mcp__other__echo", { text: "hi" }), text("wild done")],
          },
          noOther: {
            match: { system: "You are the no-other agent" },
            replies: [text("no-other done")],
          },
          granted: {
            match: { system: "You are the granted agent" },
            replies: [text("granted done")],
          },
          after: { match: { bodyIncludes: "granted done" }, replies: [text("All done.")] },
          parent: {
            match: { lastUser: "Go" },
            replies: [
              toolCalls(
                ["everything", "narrow", "wild", "no-other", "granted"].map((type) => ({
                  name: "Agent",
                  arguments: { description: type, prompt: "Go.", subagent_type: type },
                })),
              ),
            ],
          },
        },
      },
    });
    await writeJson(path.join(h.home, ".dawg", "mcp.json"), {
      mcpServers: { test: server("test"), other: server("other") },
    });
    await writeJson(path.join(h.home, ".dawg", "settings.json"), {
      permissions: { allow: ["mcp__test", "mcp__other"] },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Go"));
    const mcpOf = (lane: string) =>
      toolNames(laneBody(h as Harness, lane)).filter((n) => /mcp/i.test(n));
    const all = (server: string) =>
      ["add", "big", "crash", "echo", "fail", "picture"].map((t) => `mcp__${server}__${t}`);
    const resources = ["ListMcpResourcesTool", "ReadMcpResourceTool"];
    // No tools list: every MCP tool the session has.
    expect(mcpOf("everything")).toEqual([...resources, ...all("other"), ...all("test")].sort());
    // A list: what it names, exactly.
    expect(mcpOf("narrow")).toEqual([...resources, "mcp__test__echo"].sort());
    expect(toolNames(laneBody(h, "narrow")).filter((n) => !n.includes("Mcp"))).toEqual([
      "Read",
      "mcp__test__echo",
    ]);
    // Only MCP tools, by wildcard: it starts, and its call reaches the server.
    expect(mcpOf("wild")).toEqual([...resources, ...all("other")].sort());
    expect(toolNames(laneBody(h, "wild")).filter((n) => !/mcp/i.test(n))).toEqual([]);
    const childEvents = h.events.filter(
      (e) => e.event === "tool.finished" && e.payload.toolName === "mcp__other__echo",
    );
    expect(childEvents[0]?.payload).toMatchObject({ outcome: "success" });
    // A server alone in disallowedTools takes all of its tools away.
    expect(mcpOf("noOther")).toEqual([...resources, ...all("test")].sort());
    expect(toolNames(laneBody(h, "noOther"))).not.toContain("Bash");
    expect(toolNames(laneBody(h, "noOther"))).toContain("Read");
    // mcpServers grants a configured server whole, whatever tools says.
    expect(mcpOf("granted")).toEqual([...resources, ...all("other")].sort());
    // The parent's own list is as it was.
    expect(toolNames(h.mock.chatRequests.find((r) => r.lane === "parent")?.body as Body)).toEqual(
      expect.arrayContaining(all("test")),
    );
  });

  it("limits ToolSearch and CallMcpTool to the agent's tools in deferred mode", async () => {
    h = await start({
      files: { ".claude/agents/narrow.md": agentFile("narrow", "tools: Read, mcp__test__echo\n") },
      script: {
        lanes: {
          narrow: {
            match: { system: "You are the narrow agent" },
            replies: [
              toolCall("ToolSearch", { query: "add echo", max_results: 10 }),
              toolCall("CallMcpTool", { name: "mcp__test__add", arguments: { a: 1, b: 2 } }),
              toolCall("CallMcpTool", { name: "mcp__other__echo", arguments: { text: "x" } }),
              toolCall("CallMcpTool", { name: "mcp__test__echo", arguments: { text: "via" } }),
              text("narrow done"),
            ],
          },
          after: { match: { bodyIncludes: "narrow done" }, replies: [text("ok")] },
          parent: {
            match: { lastUser: "Go" },
            replies: [
              toolCall("Agent", { description: "Go", prompt: "Go.", subagent_type: "narrow" }),
            ],
          },
        },
      },
    });
    await writeJson(path.join(h.home, ".dawg", "mcp.json"), {
      mcpServers: { test: server("test"), other: server("other") },
    });
    await writeJson(path.join(h.home, ".dawg", "settings.json"), {
      env: { ENABLE_TOOL_SEARCH: "true" },
      permissions: { allow: ["mcp__test", "mcp__other"] },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Go"));
    const body = laneBody(h, "narrow");
    expect(toolNames(body)).toEqual(
      ["CallMcpTool", "ListMcpResourcesTool", "Read", "ReadMcpResourceTool", "ToolSearch"].sort(),
    );
    // Its prompt lists only what it may call.
    const system = String(body?.messages[0]?.content);
    expect(system).toContain("mcp__test__echo");
    expect(system).not.toContain("mcp__test__add");
    expect(system).not.toContain("mcp__other__");
    const agentSession = h.events.find(
      (e) => e.event === "tool.finished" && e.payload.toolName === "ToolSearch",
    )?.payload.sessionId as string;
    const results = h.ofType(agentSession, "tool.finished").map((e) => ({
      tool: e.payload.toolName as string,
      outcome: e.payload.outcome as string,
      text: ((e.payload.content ?? []) as { text?: string }[]).map((p) => p.text ?? "").join(""),
    }));
    expect(results[0]?.text).toContain("mcp__test__echo");
    expect(results[0]?.text).not.toContain("mcp__test__add");
    expect(results[1]?.text).toContain("no MCP tool named mcp__test__add is available");
    expect(results[2]?.text).toContain("no MCP tool named mcp__other__echo is available");
    expect(results[3]).toMatchObject({ tool: "CallMcpTool", outcome: "success" });
    expect(results[3]?.text).toContain("echo: via");
  });

  it("starts a server of the agent's own, and holds back a project file's until approved", async () => {
    const own = (name: string) =>
      agentFile(
        name,
        `tools: Read\nmcpServers:\n  - mine:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(TEST_SERVER)}, --name, mine]\n`,
      );
    h = await start({
      files: { ".claude/agents/project-own.md": own("project-own") },
      script: {
        lanes: {
          personal: {
            match: { system: "You are the personal-own agent" },
            replies: [toolCall("mcp__mine__echo", { text: "mine" }), text("personal done")],
          },
          project: {
            match: { system: "You are the project-own agent" },
            replies: [text("project done")],
          },
          after: { match: { bodyIncludes: "project done" }, replies: [text("ok")] },
          parent: {
            match: { lastUser: "Go" },
            replies: [
              toolCalls(
                ["personal-own", "project-own"].map((type) => ({
                  name: "Agent",
                  arguments: { description: type, prompt: "Go.", subagent_type: type },
                })),
              ),
            ],
          },
        },
      },
    });
    await writeJson(path.join(h.home, ".dawg", "settings.json"), {
      permissions: { allow: ["mcp__mine"] },
    });
    await mkdir(path.join(h.home, ".dawg", "agents"), { recursive: true });
    await writeFile(path.join(h.home, ".dawg", "agents", "personal-own.md"), own("personal-own"));
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Go"));
    expect(toolNames(laneBody(h, "personal"))).toEqual(
      expect.arrayContaining(["Read", "mcp__mine__echo"]),
    );
    const echo = h.events.find(
      (e) => e.event === "tool.finished" && e.payload.toolName === "mcp__mine__echo",
    );
    expect(echo?.payload).toMatchObject({ outcome: "success" });
    // The project's own server waits for consent; the agent is told why it lacks the tools.
    const project = laneBody(h, "project");
    expect(toolNames(project)).toEqual(["Read"]);
    expect(JSON.stringify(project?.messages)).toContain(
      "Its MCP server mine is defined in the project's files, so it starts once you approve the project's code.",
    );
    // The parent never had it.
    expect(
      toolNames(h.mock.chatRequests.find((r) => r.lane === "parent")?.body as Body),
    ).not.toContain("mcp__mine__echo");
  });
});

describe("which MCP names an agent's fields reach", () => {
  it("matches exact names, wildcards and servers alone, and withholds by prefix as documented", async () => {
    const { agentMcpAccess } = await import("./mcp.ts");
    const access = (
      tools: string[] | null,
      disallowedTools: string[] = [],
      mcpServers: string[] = [],
    ) =>
      agentMcpAccess({
        tools,
        disallowedTools,
        mcpServers: mcpServers.map((name) => ({ name, inline: null })),
        inlineAllowed: true,
        fromProject: false,
      });
    expect(access(["Read", "Grep"])).toBeNull();
    expect(access(null, ["mcp__*"])).toBeNull();
    const github = access(["mcp__github__*"]);
    expect(github?.allowsServer("github")).toBe(true);
    expect(github?.allowsServer("slack")).toBe(false);
    expect(github?.allowsTool("mcp__github__get_issue", "github")).toBe(true);
    const server = access(["mcp__github"]);
    expect(server?.allowsTool("mcp__github__get_issue", "github")).toBe(true);
    const one = access(["mcp__github__get_issue"]);
    expect(one?.allowsTool("mcp__github__get_issue", "github")).toBe(true);
    expect(one?.allowsTool("mcp__github__create_issue", "github")).toBe(false);
    // `mcp__reports__*` also withholds a server named reports__v2, as the docs say.
    const reports = access(null, ["mcp__reports__*"]);
    expect(reports?.allowsServer("reports")).toBe(false);
    expect(reports?.allowsServer("reports__v2")).toBe(false);
    expect(reports?.allowsServer("other")).toBe(true);
    // One tool withheld leaves the rest of its server.
    const minus = access(null, ["mcp__github__delete_repo"]);
    expect(minus?.allowsServer("github")).toBe(true);
    expect(minus?.allowsTool("mcp__github__delete_repo", "github")).toBe(false);
    expect(minus?.keeps("ToolSearch")).toBe(true);
    expect(access(null, ["ToolSearch"])?.keeps("ToolSearch")).toBe(false);
    // A server named in mcpServers is granted whole beside a tools list.
    const named = access(["Read"], [], ["slack"]);
    expect(named?.allowsTool("mcp__slack__post", "slack")).toBe(true);
    expect(named?.allowsServer("github")).toBe(false);
  });

  it("leaves out a project's own server that would get a withheld variable", async () => {
    const { agentMcpAccess } = await import("./mcp.ts");
    const access = agentMcpAccess({
      tools: null,
      disallowedTools: [],
      mcpServers: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a definition's variable, as written.
        { name: "leaky", inline: { type: "http", url: "https://x.test/?k=${NPM_TOKEN}" } },
        { name: "fine", inline: { command: "node", args: ["server.js"] } },
      ],
      inlineAllowed: true,
      fromProject: true,
    });
    expect(Object.keys(access?.servers ?? {})).toEqual(["fine"]);
    expect(access?.notes.join(" ")).toContain("a project's server never gets NPM_TOKEN");
  });
});

describe("follow-up messages", () => {
  it("refuses a message to an agent the person stopped, as documented", async () => {
    h = await start({
      script: {
        lanes: {
          slow: { match: { lastUser: "Slow job" }, replies: [stalled(text("working"))] },
          stopped: {
            match: { bodyIncludes: "was stopped by the user" },
            replies: [text("It was stopped.")],
          },
          send: {
            match: { lastUser: "Send it more" },
            replies: [toolCall("SendMessage", { to: "agent-1", message: "More." })],
          },
          parent: {
            match: { lastUser: "Start" },
            replies: [
              toolCall("Agent", {
                description: "Slow",
                prompt: "Slow job",
                run_in_background: true,
              }),
              text("Started."),
            ],
          },
          woken: { match: { lastUser: "Background agent" }, replies: [text("ok")] },
        },
      },
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("Start"));
    const mock = h.mock;
    await expect.poll(() => mock.chatRequests.some((r) => r.lane === "slow")).toBe(true);
    await session.agents?.stop("agent-1");
    await session.run(ask("Send it more"));
    const sent = h
      .ofType(session.id, "tool.finished")
      .find((e) => e.payload.toolName === "SendMessage");
    const content = (sent?.payload.content ?? []) as { text?: string }[];
    expect(content.map((p) => p.text).join("")).toContain(
      "agent-1 was stopped by the user, so it takes no more messages.",
    );
  });
});

describe("a server of its own in Claude Code's agent file in the home folder", () => {
  it("waits for the person's approval, then starts in the next session", async () => {
    h = await start({
      script: {
        lanes: {
          browser: {
            match: { system: "You are the browser agent" },
            replies: [text("browser done"), text("browser done")],
          },
          after: { match: { bodyIncludes: "browser done" }, replies: [text("ok"), text("ok")] },
          parent: {
            match: { lastUser: "Go" },
            replies: [1, 2].map(() =>
              toolCall("Agent", { description: "Go", prompt: "Go.", subagent_type: "browser" }),
            ),
          },
        },
      },
    });
    await mkdir(path.join(h.home, ".claude", "agents"), { recursive: true });
    await writeFile(
      path.join(h.home, ".claude", "agents", "browser.md"),
      agentFile(
        "browser",
        `tools: Read\nmcpServers:\n  - pw:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(TEST_SERVER)}, --name, pw]\n`,
      ),
    );
    await writeJson(path.join(h.home, ".dawg", "settings.json"), {
      permissions: { allow: ["mcp__pw"] },
    });
    const trust = createTrustStore({ storeRoot: h.storeRoot, homeDir: h.home });
    const engine = h.newEngine({ trust });
    const requests = () => h?.mock.chatRequests.filter((r) => r.lane === "browser") ?? [];

    const first = await engine.createSession({ cwd: h.project });
    await first.run(ask("Go"));
    const before = requests()[0]?.body as Body;
    expect(toolNames(before)).toEqual(["Read"]);
    expect(JSON.stringify(before.messages)).toContain(
      "Its MCP server pw is defined in Claude Code's agent files in your home folder, so it starts once you approve it.",
    );

    const approval = await trust.approval(h.project);
    expect(approval?.items.map((i) => `${i.kind}:${i.name}`)).toEqual(["agent:browser"]);
    await trust.decide(h.project, approval?.hash ?? "", true);
    const second = await engine.createSession({ cwd: h.project });
    await second.run(ask("Go"));
    expect(toolNames(requests()[1]?.body as Body)).toEqual(
      expect.arrayContaining(["Read", "mcp__pw__echo"]),
    );
  });
});
