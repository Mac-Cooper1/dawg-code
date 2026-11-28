/**
 * Settings → Subagents and `/agents` (Phase 4, round 3): the listing's precedence and statuses,
 * writing a new agent file only under `.dawg` and never over one that is there, and `/agents`
 * through the protocol as the app and `dawg` run it.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Setup, setup } from "../host/__fixtures__/setup.ts";
import type { CodeTrust } from "../trust/index.ts";
import { createTrustStore, NO_CODE_TRUST } from "../trust/index.ts";
import { createSubagent } from "./create.ts";
import { projectSubagents } from "./list.ts";

let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function put(file: string, text: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

const agent = (name: string, more = "") =>
  `---\nname: ${name}\ndescription: The ${name} agent\n${more}---\nYou are ${name}.\n`;

/** A trust that approves every project's code. */
const APPROVED: CodeTrust = { ...NO_CODE_TRUST, allows: async () => true };

async function layout(root: Setup): Promise<void> {
  await mkdir(path.join(root.project, ".git"), { recursive: true });
  await put(path.join(root.home, ".claude", "agents", "helper.md"), agent("helper"));
  await put(
    path.join(root.home, ".dawg", "agents", "helper.md"),
    agent("helper", "memory: user\n"),
  );
  await put(
    path.join(root.home, ".dawg", "agents", "mine.md"),
    agent("mine", "tools: Read, Bash(ls *)\n"),
  );
  await put(path.join(root.project, ".claude", "agents", "helper.md"), agent("helper"));
  await put(
    path.join(root.project, ".claude", "agents", "runner.md"),
    agent("runner", "tools: Read, Bash(npm test *)\n"),
  );
  await put(
    path.join(root.project, ".claude", "agents", "browser.md"),
    agent(
      "browser",
      "memory: project\nmcpServers:\n  - playwright:\n      command: npx\n      args: [playwright-mcp]\n  - github\n",
    ),
  );
  await put(path.join(root.project, ".claude", "agents", "broken.md"), "---\nname: broken\n---\n");
  await put(path.join(root.project, ".dawg", "agents", "explore.md"), agent("Explore"));
}

describe("the listing", () => {
  it("lists the built-ins and every file, with precedence and statuses", async () => {
    s = await setup();
    await layout(s);
    const listing = await projectSubagents({
      homeDir: s.home,
      storeRoot: s.storeRoot,
      projectDir: s.project,
      trust: NO_CODE_TRUST,
    });
    const rows = listing.agents.map((a) => [
      a.name,
      a.builtIn ? "built-in" : `${a.source?.scope}:${a.source?.origin}`,
      a.status,
    ]);
    expect(rows).toEqual([
      ["Explore", "built-in", "overridden"],
      ["Plan", "built-in", "loaded"],
      ["general-purpose", "built-in", "loaded"],
      ["helper", "user:claude", "overridden"],
      ["helper", "user:dawg", "overridden"],
      ["mine", "user:dawg", "loaded"],
      ["broken", "project:claude", "invalid"],
      ["browser", "project:claude", "needs-approval"],
      ["helper", "project:claude", "loaded"],
      ["runner", "project:claude", "needs-approval"],
      ["Explore", "project:dawg", "loaded"],
    ]);
    const byPath = (name: string, scope: string) =>
      listing.agents.find((a) => a.name === name && a.source?.scope === scope);
    // The project's helper wins over both of the person's, and says so on theirs.
    const projectHelper = path.join(s.project, ".claude", "agents", "helper.md");
    expect(listing.agents.filter((a) => a.name === "helper" && a.source?.scope === "user")).toEqual(
      [
        expect.objectContaining({ overriddenBy: projectHelper }),
        expect.objectContaining({ overriddenBy: projectHelper }),
      ],
    );
    // A built-in replaced by a file names the file.
    expect(listing.agents[0]).toMatchObject({
      overriddenBy: path.join(s.project, ".dawg", "agents", "explore.md"),
      readOnly: true,
      permissionMode: "plan",
    });
    expect(byPath("broken", "project")?.notes.join(" ")).toContain("Needs a description");
    // Power a project file supplies waits; the person's own grants do not.
    expect(byPath("runner", "project")?.notes[0]).toBe(
      "It loads, but its tool grants (Bash(npm test *)) wait for you to approve the project's code.",
    );
    const browser = byPath("browser", "project");
    expect(browser).toMatchObject({
      memory: "project",
      memoryDirectory: path.join(s.project, ".dawg", "agent-memory", "browser"),
      mcpServers: [
        { name: "playwright", inline: true },
        { name: "github", inline: false },
      ],
    });
    expect(browser?.notes[0]).toContain("its MCP server playwright waits for you to approve");
    expect(byPath("helper", "user")).toBeDefined();
    const userHelper = listing.agents.find(
      (a) => a.name === "helper" && a.source?.origin === "dawg",
    );
    expect(userHelper?.memoryDirectory).toBe(path.join(s.storeRoot, "agent-memory", "helper"));
    expect(listing.folders).toEqual({
      user: path.join(s.home, ".dawg", "agents"),
      project: path.join(s.project, ".dawg", "agents"),
    });

    // Approved, the project's agents simply load.
    const approved = await projectSubagents({
      homeDir: s.home,
      storeRoot: s.storeRoot,
      projectDir: s.project,
      trust: APPROVED,
    });
    expect(approved.agents.find((a) => a.name === "runner")?.status).toBe("loaded");
  });

  it("lists only the built-ins and the person's own without a project", async () => {
    s = await setup();
    await layout(s);
    const listing = await projectSubagents({
      homeDir: s.home,
      storeRoot: s.storeRoot,
      projectDir: null,
      trust: NO_CODE_TRUST,
    });
    expect(listing.agents.map((a) => `${a.name}:${a.status}`)).toEqual([
      "Explore:loaded",
      "Plan:loaded",
      "general-purpose:loaded",
      "helper:overridden",
      "helper:loaded",
      "mine:loaded",
    ]);
    expect(listing.folders.project).toBeNull();
  });
});

describe("a new agent file", () => {
  it("writes the documented front matter in ~/.dawg/agents, and never over a file", async () => {
    s = await setup();
    const input = { homeDir: s.home, storeRoot: s.storeRoot, trust: NO_CODE_TRUST };
    const created = await createSubagent(input, {
      projectDir: s.project,
      scope: "user",
      name: "code-reviewer",
      description: "Reviews code for quality",
      prompt: "You review code.\n",
      tools: ["Read", "Grep", " "],
      memory: "user",
    });
    const file = path.join(s.home, ".dawg", "agents", "code-reviewer.md");
    expect(created.path).toBe(file);
    expect(await readFile(file, "utf8")).toBe(
      "---\nname: code-reviewer\ndescription: Reviews code for quality\ntools: Read, Grep\nmemory: user\n---\n\nYou review code.\n",
    );
    expect(created.agent).toMatchObject({
      name: "code-reviewer",
      status: "loaded",
      source: { path: file, origin: "dawg", scope: "user" },
      tools: ["Read", "Grep"],
      memory: "user",
    });
    // The same name again is refused, and the file is left as it was.
    await writeFile(file, "kept");
    const again = await createSubagent(input, {
      projectDir: null,
      scope: "user",
      name: "code-reviewer",
      description: "Another",
      prompt: "",
    }).catch((error: unknown) => error);
    expect(again).toMatchObject({ code: "InvalidState" });
    expect(String((again as Error).message)).toContain("already exists");
    expect(await readFile(file, "utf8")).toBe("kept");
  });

  it("refuses bad names, an empty description and a project file without a project", async () => {
    s = await setup();
    const input = { homeDir: s.home, storeRoot: s.storeRoot, trust: NO_CODE_TRUST };
    const base = { projectDir: s.project, scope: "user" as const, prompt: "" };
    for (const [name, description, why] of [
      ["Code Reviewer", "d", "lowercase letters"],
      ["fork", "d", "copy of the conversation"],
      ["Plan", "d", "lowercase"],
      ["ok-name", "  ", "description"],
    ] as const) {
      const error = await createSubagent(input, { ...base, name, description }).catch(
        (e: unknown) => e,
      );
      expect(error, name).toMatchObject({ code: "InvalidParams" });
      expect(String((error as Error).message), name).toContain(why);
    }
    const noProject = await createSubagent(input, {
      ...base,
      projectDir: null,
      scope: "project",
      name: "x",
      description: "X",
    }).catch((e: unknown) => e);
    expect(noProject).toMatchObject({ code: "InvalidParams" });
  });

  it("writes a project's file under its .dawg, never .claude, and its grants wait", async () => {
    s = await setup();
    const input = { homeDir: s.home, storeRoot: s.storeRoot, trust: NO_CODE_TRUST };
    const created = await createSubagent(input, {
      projectDir: s.project,
      scope: "project",
      name: "test-runner",
      description: "Runs the tests",
      prompt: "Run the tests.",
      tools: ["Read", "Bash(npm test *)"],
    });
    expect(created.path).toBe(path.join(s.project, ".dawg", "agents", "test-runner.md"));
    expect(created.agent.status).toBe("needs-approval");
    // A .dawg folder that leads into .claude is Claude Code's.
    const other = path.join(s.root, "other");
    await mkdir(path.join(other, ".claude", "agents"), { recursive: true });
    await mkdir(path.join(other, ".dawg"), { recursive: true });
    await symlink(path.join(other, ".claude", "agents"), path.join(other, ".dawg", "agents"));
    const refused = await createSubagent(input, {
      projectDir: other,
      scope: "project",
      name: "x",
      description: "X",
      prompt: "",
    }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "InvalidState" });
    expect(String((refused as Error).message)).toContain("never writes");
  });
});

describe("through the protocol", () => {
  it("answers project.subagents and subagent.create, and /agents prints the listing", async () => {
    s = await setup();
    await layout(s);
    const c = await s.connect();
    const listing = await c.client.request("project.subagents", { projectDir: s.project });
    expect(listing.agents.map((a) => a.name)).toContain("runner");
    await expect(
      c.client.request("project.subagents", { projectDir: "relative/dir" }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    const created = await c.client.request("subagent.create", {
      projectDir: s.project,
      scope: "user",
      name: "notes-keeper",
      description: "Keeps notes",
      prompt: "Keep notes.",
    });
    expect(created.path).toBe(path.join(s.home, ".dawg", "agents", "notes-keeper.md"));
    const twice = await c.client
      .request("subagent.create", {
        projectDir: s.project,
        scope: "user",
        name: "notes-keeper",
        description: "Keeps notes",
      })
      .catch((e: unknown) => e);
    expect(twice).toBeInstanceOf(RpcError);
    expect((twice as RpcError).code).toBe(ErrorCodes.InvalidState);
    const bad = await c.client
      .request("subagent.create", { projectDir: null, scope: "user", name: "-x", description: "X" })
      .catch((e: unknown) => e);
    expect((bad as RpcError).code).toBe(ErrorCodes.InvalidParams);

    const { session } = await c.client.request("session.create", { cwd: s.project });
    const result = await c.client.request("session.command", {
      sessionId: session.id,
      name: "agents",
      args: "",
    });
    const output = result.output ?? "";
    expect(output).toContain("Built in\n  Explore (not used)");
    expect(output).toContain("  notes-keeper  ~/.dawg/agents/notes-keeper.md");
    expect(output).toContain("This project's (.claude/agents, .dawg/agents)");
    expect(output).toContain("  runner (waits for approval)  .claude/agents/runner.md");
    expect(output).toContain("memory: project; MCP: playwright (own), github");
    expect(output).toContain("New sessions pick up changes");
    expect(c.problems).toEqual([]);
  });
});

describe("servers of their own in Claude Code's agent files in the home folder", () => {
  const withServer = (name: string, arg: string) =>
    agent(
      name,
      `tools: Read, Bash(ls *)\nmcpServers:\n  - pw:\n      command: npx\n      args: [playwright-mcp, ${arg}]\n`,
    );

  it("wait for approval once for every project, ask again when changed; ~/.dawg's need none", async () => {
    s = await setup();
    await mkdir(path.join(s.project, ".git"), { recursive: true });
    const file = await put(
      path.join(s.home, ".claude", "agents", "browser.md"),
      withServer("browser", "first"),
    );
    await put(path.join(s.home, ".dawg", "agents", "mine.md"), withServer("mine", "x"));
    const trust = createTrustStore({ storeRoot: s.storeRoot, homeDir: s.home });
    const source = { path: file, origin: "claude", scope: "user" } as const;
    const list = async (projectDir: string | null) =>
      projectSubagents({
        homeDir: s?.home ?? "",
        storeRoot: s?.storeRoot ?? "",
        projectDir,
        trust,
      });

    const approval = await trust.approval(s.project);
    // Only the servers are asked about: the person's own dawg file and that file's grants are not.
    expect(approval?.items).toEqual([
      expect.objectContaining({
        kind: "agent",
        name: "browser",
        status: "needs-approval",
        notes: [
          "Starts an MCP server of its own, pw: npx playwright-mcp first.",
          "From Claude Code's agent files in your home folder; approving it covers every project.",
        ],
      }),
    ]);
    expect(await trust.allows(source, s.project)).toBe(false);
    // Asked about with no project too, as Claude Code's user hooks are.
    expect((await trust.approval(null))?.items.map((i) => i.name)).toEqual(["browser"]);
    let browser = (await list(s.project)).agents.find((a) => a.name === "browser");
    expect(browser?.status).toBe("needs-approval");
    expect(browser?.notes[0]).toBe(
      "It loads, but its MCP server pw waits for your approval: Claude Code's agent files in your home folder run code dawg did not write.",
    );
    expect((await list(s.project)).agents.find((a) => a.name === "mine")?.status).toBe("loaded");
    expect(
      await trust.allows(
        { ...source, path: path.join(s.home, ".dawg", "agents", "mine.md"), origin: "dawg" },
        s.project,
      ),
    ).toBe(true);

    await trust.decide(s.project, approval?.hash ?? "", true);
    // Approved once, for every project.
    expect(await trust.allows(source, path.join(s.root, "elsewhere"))).toBe(true);
    expect(await trust.allows(source, null)).toBe(true);
    browser = (await list(s.project)).agents.find((a) => a.name === "browser");
    expect(browser?.status).toBe("loaded");

    // A change to its server asks again.
    await writeFile(file, withServer("browser", "second"));
    expect(await trust.allows(source, s.project)).toBe(false);
    expect((await trust.approval(s.project))?.approved).toBe(false);
    expect((await list(null)).agents.find((a) => a.name === "browser")?.status).toBe(
      "needs-approval",
    );
    // Approved again, rewording its prompt or changing its grants does not ask again.
    await trust.decide(s.project, (await trust.approval(s.project))?.hash ?? "", true);
    await writeFile(
      file,
      withServer("browser", "second")
        .replace("You are browser.", "Be brief.")
        .replace("Bash(ls *)", "Bash(pwd)"),
    );
    expect(await trust.allows(source, s.project)).toBe(true);
  });
});
