/**
 * Subagent files read as Claude Code documents them (code.claude.com/docs/en/sub-agents): the
 * fields dawg honours, the ones it notes, what makes a file invalid, and which file a name means.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgents } from "./loader.ts";
import { isProjectAgentCode, readAgentFile, toolGrants, toolNameOf } from "./read.ts";

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
    const notes = def.notes.join("\n");
    for (const part of [
      "hooks in an agent file are not run yet",
      "memory is ignored",
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
