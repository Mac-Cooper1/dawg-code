/**
 * Subagent files read as Claude Code documents them (code.claude.com/docs/en/sub-agents): the
 * fields dawg honours, the ones it notes, what makes a file invalid, and which file a name means.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgents } from "./loader.ts";
import {
  agentServersNeedConsent,
  isProjectAgentCode,
  readAgentFile,
  toolGrants,
  toolNameOf,
} from "./read.ts";
import { newAgentNameProblem, renderAgentFile } from "./write.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-agents-"));
  home = join(root, "home");
  project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(file: string, text: string): Promise<string> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
  return file;
}

const projectSource = (path: string) => ({
  path,
  origin: "claude" as const,
  scope: "project" as const,
});

describe("one agent file", () => {
  it("reads every honoured field", async () => {
    const file = await put(
      join(project, ".claude", "agents", "worker.md"),
      [
        "---",
        "name: worker",
        "description: Does the work",
        "tools: Read, Grep, Bash(npm test *)",
        "disallowedTools: [Write]",
        "model: sonnet",
        "permissionMode: acceptEdits",
        "maxTurns: 12",
        "skills: [lint]",
        "background: true",
        "isolation: worktree",
        "---",
        "",
        "You work.",
        "",
      ].join("\n"),
    );
    const def = await readAgentFile(file, projectSource(file));
    expect(def).toMatchObject({
      name: "worker",
      description: "Does the work",
      tools: ["Read", "Grep", "Bash(npm test *)"],
      disallowedTools: ["Write"],
      model: "sonnet",
      permissionMode: "acceptEdits",
      maxTurns: 12,
      skills: ["lint"],
      background: true,
      isolation: "worktree",
      prompt: "You work.",
      status: "loaded",
    });
    expect(def.notes.join("\n")).toContain("model “sonnet” is mapped to the session's model");
    // A project file that grants tools and loosens the mode is project code.
    expect(isProjectAgentCode(def)).toBe(true);
    expect(toolGrants(def)).toEqual(["Bash(npm test *)"]);
    expect(def.notes.join("\n")).toContain("tool grants and permissionMode acceptEdits");
    expect(toolNameOf("Bash(npm test *)")).toBe("Bash");
  });

  it("notes the fields dawg does not honour yet, and maps manual to default", async () => {
    const file = await put(
      join(project, ".claude", "agents", "x.md"),
      "---\nname: x\ndescription: X\npermissionMode: manual\nhooks: {}\nmemory: project\ncolor: blue\neffort: high\nflavour: mint\n---\nBody\n",
    );
    const def = await readAgentFile(file, projectSource(file));
    expect(def.status).toBe("partly-supported");
    expect(def.permissionMode).toBe("default");
    expect(def.memory).toBe("project");
    const notes = def.notes.join("\n");
    for (const part of [
      "hooks in an agent file are not run yet",
      "color is not shown",
      "effort is ignored",
      "Unknown field “flavour”",
    ]) {
      expect(notes).toContain(part);
    }
    expect(isProjectAgentCode(def)).toBe(false);
  });

  it("is invalid without a name or a description, with bad YAML, or with a refused name", async () => {
    const cases: [string, string][] = [
      ["---\ndescription: d\n---\n", "Needs a name"],
      ["---\nname: n\n---\n", "Needs a description"],
      ["Just text.\n", "Needs a name and a description"],
      ["---\nname: [x\n---\n", "not valid YAML"],
      ["---\nname: a:b\ndescription: d\n---\n", "plugin agents"],
      ["---\nname: -a\ndescription: d\n---\n", "starts with"],
    ];
    for (const [i, [text, note]] of cases.entries()) {
      const file = await put(join(project, ".claude", "agents", `bad${i}.md`), text);
      const def = await readAgentFile(file, projectSource(file));
      expect(def.status, text).toBe("invalid");
      expect(def.notes.join("\n"), text).toContain(note);
    }
  });
});

describe("memory and MCP servers", () => {
  it("reads a memory scope, and notes one that is not documented", async () => {
    for (const [value, expected] of [
      ["user", "user"],
      ["Local", "local"],
      ["project", "project"],
      ["team", null],
    ] as const) {
      const file = await put(
        join(project, ".claude", "agents", `m-${value}.md`),
        `---\nname: m\ndescription: M\nmemory: ${value}\n---\n`,
      );
      const def = await readAgentFile(file, projectSource(file));
      expect(def.memory, value).toBe(expected);
      if (expected === null) {
        expect(def.status).toBe("partly-supported");
        expect(def.notes.join("\n")).toContain("memory “team” is not user, project or local");
      }
    }
  });

  it("reads mcpServers as references and inline definitions, the documented list form", async () => {
    const file = await put(
      join(project, ".claude", "agents", "browser.md"),
      [
        "---",
        "name: browser-tester",
        "description: Tests features in a real browser",
        "mcpServers:",
        "  - playwright:",
        "      type: stdio",
        "      command: npx",
        '      args: ["-y", "@playwright/mcp@latest"]',
        "  - github",
        "  - 42",
        "---",
        "Use the browser.",
      ].join("\n"),
    );
    const def = await readAgentFile(file, projectSource(file));
    expect(def.mcpServers).toEqual([
      {
        name: "playwright",
        inline: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
      { name: "github", inline: null },
    ]);
    expect(def.status).toBe("partly-supported");
    expect(def.notes.join("\n")).toContain("neither a server's name nor a definition");
    // A server of its own, from a project file, runs a program: project code.
    expect(isProjectAgentCode(def)).toBe(true);
    expect(def.notes.join("\n")).toContain("its MCP server playwright take effect only once");
    // The same file in the person's folder is theirs.
    const mine = await readAgentFile(file, { path: file, origin: "dawg", scope: "user" });
    expect(isProjectAgentCode(mine)).toBe(false);
    expect(agentServersNeedConsent(mine)).toBe(false);
    // Claude Code's own file in the home folder runs code dawg did not write: it waits too.
    const claude = await readAgentFile(file, { path: file, origin: "claude", scope: "user" });
    expect(isProjectAgentCode(claude)).toBe(false);
    expect(agentServersNeedConsent(claude)).toBe(true);
    expect(claude.notes.join("\n")).toContain(
      "Its MCP server playwright starts only once you approve it",
    );
  });

  it("reads a map of servers, and a reference alone is not project code", async () => {
    const file = await put(
      join(project, ".claude", "agents", "map.md"),
      "---\nname: m\ndescription: M\nmcpServers:\n  docs:\n    type: http\n    url: https://example.com/mcp\n---\n",
    );
    const def = await readAgentFile(file, projectSource(file));
    expect(def.mcpServers).toEqual([
      { name: "docs", inline: { type: "http", url: "https://example.com/mcp" } },
    ]);
    const refs = await put(
      join(project, ".claude", "agents", "refs.md"),
      "---\nname: r\ndescription: R\nmcpServers: [github, slack]\n---\n",
    );
    const ref = await readAgentFile(refs, projectSource(refs));
    expect(ref.mcpServers.map((s) => s.name)).toEqual(["github", "slack"]);
    expect(ref.status).toBe("loaded");
    expect(isProjectAgentCode(ref)).toBe(false);
  });
});

describe("a new agent file", () => {
  it("checks names: lowercase words with hyphens, not a built-in's or the fork's", () => {
    expect(newAgentNameProblem("code-reviewer")).toBeNull();
    expect(newAgentNameProblem("v2-checker")).toBeNull();
    for (const bad of ["", "Code", "a b", "-a", "a--b", "a-", "a/b", "ü", "x".repeat(65)]) {
      expect(newAgentNameProblem(bad), bad).not.toBeNull();
    }
    expect(newAgentNameProblem("fork")).toContain("copy of the conversation");
    expect(newAgentNameProblem("general-purpose")).toContain("built-in");
  });

  it("writes the documented front matter, which reads back as written", async () => {
    const text = renderAgentFile({
      name: "code-reviewer",
      description: "Reviews code: quality,\n security and tests",
      prompt: "You are a code reviewer.\n\nGive specific feedback.",
      tools: ["Read", "Grep", "Bash(npm test *)"],
      disallowedTools: [],
      model: "sonnet",
      permissionMode: null,
      memory: "project",
      background: false,
      isolation: null,
    });
    expect(text).toBe(
      [
        "---",
        "name: code-reviewer",
        'description: "Reviews code: quality, security and tests"',
        "tools: Read, Grep, Bash(npm test *)",
        "model: sonnet",
        "memory: project",
        "---",
        "",
        "You are a code reviewer.",
        "",
        "Give specific feedback.",
        "",
      ].join("\n"),
    );
    const file = await put(join(home, ".dawg", "agents", "code-reviewer.md"), text);
    const def = await readAgentFile(file, { path: file, origin: "dawg", scope: "user" });
    expect(def).toMatchObject({
      name: "code-reviewer",
      description: "Reviews code: quality, security and tests",
      tools: ["Read", "Grep", "Bash(npm test *)"],
      model: "sonnet",
      memory: "project",
      prompt: "You are a code reviewer.\n\nGive specific feedback.",
      status: "loaded",
    });
  });
});

describe("which file a name means", () => {
  it("puts the project over the person, the nearer folder over the higher, .dawg over .claude", async () => {
    await put(join(home, ".claude", "agents", "a.md"), "---\nname: a\ndescription: mine\n---\n");
    await put(join(home, ".dawg", "agents", "b.md"), "---\nname: b\ndescription: mine\n---\n");
    await put(join(project, ".claude", "agents", "a.md"), "---\nname: a\ndescription: top\n---\n");
    await put(
      join(project, ".claude", "agents", "c.md"),
      "---\nname: c\ndescription: claude\n---\n",
    );
    await put(
      join(project, ".dawg", "agents", "nested", "c.md"),
      "---\nname: c\ndescription: dawg\n---\n",
    );
    const sub = join(project, "packages", "api");
    await put(join(sub, ".claude", "agents", "a.md"), "---\nname: a\ndescription: nearest\n---\n");
    const set = await loadAgents({ homeDir: home, cwd: sub });
    expect(set.active.map((d) => [d.name, d.description])).toEqual([
      ["a", "nearest"],
      ["b", "mine"],
      ["c", "dawg"],
    ]);
    const shadowed = set.all.filter((d) => d.shadowedBy !== null).map((d) => d.description);
    expect(shadowed.sort()).toEqual(["claude", "mine", "top"]);
    // A person's own file is never project code.
    expect(set.active.find((d) => d.name === "b")?.source.scope).toBe("user");
  });

  it("keeps the first file of a name within one folder", async () => {
    await put(
      join(project, ".claude", "agents", "one.md"),
      "---\nname: twin\ndescription: one\n---\n",
    );
    await put(
      join(project, ".claude", "agents", "two.md"),
      "---\nname: twin\ndescription: two\n---\n",
    );
    const set = await loadAgents({ homeDir: home, cwd: project });
    expect(set.active.map((d) => d.description)).toEqual(["one"]);
    expect(set.all.find((d) => d.description === "two")?.notes.join("\n")).toContain(
      "in the same folder is also named “twin”",
    );
  });
});
