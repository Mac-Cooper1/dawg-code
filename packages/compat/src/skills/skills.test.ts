import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseSkillFrontMatter } from "./frontmatter.ts";
import { commandNameOf, DAWG_COMMAND_NAMES, loadNestedSkills, loadSkills } from "./loader.ts";
import { isProjectCode, listingDescription, refusedName } from "./read.ts";
import { skillsReportProvider } from "./report.ts";
import type { SkillDefinition } from "./types.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-compat-skills-"));
  home = join(root, "home");
  project = join(root, "work", "proj");
  await mkdir(home, { recursive: true });
  // The repository root, so the project's levels stop here.
  await mkdir(join(project, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const skill = (base: string, name: string, text: string) =>
  put(join(base, "skills", name, "SKILL.md"), text);
const command = (base: string, rel: string, text: string) => put(join(base, "commands", rel), text);

const load = (extra: Partial<Parameters<typeof loadSkills>[0]> = {}) =>
  loadSkills({ homeDir: home, cwd: project, ...extra });

const byName = (defs: readonly SkillDefinition[], name: string) => {
  const found = defs.find((def) => def.name === name);
  if (!found) throw new Error(`no ${name} in ${defs.map((d) => d.name).join(", ")}`);
  return found;
};

describe("front matter", () => {
  test("reads every documented field", async () => {
    await skill(
      join(project, ".claude"),
      "review",
      [
        "---",
        "name: review-pr",
        "description: Review a pull request",
        "when_to_use: When the user asks for a review",
        "argument-hint: [pr-number]",
        "arguments: pr focus",
        "disable-model-invocation: yes",
        "user-invocable: On",
        "allowed-tools: Bash(gh pr diff *) Read, Grep",
        "disallowed-tools:",
        "  - Write",
        "model: sonnet",
        "license: MIT",
        "metadata:",
        "  owner: me",
        "---",
        "Review PR $pr.",
      ].join("\n"),
    );
    const set = await load();
    const def = byName(set.active, "review-pr");
    expect(def).toMatchObject({
      kind: "skill",
      description: "Review a pull request",
      descriptionFrom: "front-matter",
      whenToUse: "When the user asks for a review",
      argumentHint: "[pr-number]",
      argumentNames: ["pr", "focus"],
      modelInvocable: false,
      userInvocable: true,
      allowedTools: ["Bash(gh pr diff *)", "Read", "Grep"],
      disallowedTools: ["Write"],
      model: "sonnet",
      fork: false,
      body: "Review PR $pr.",
      status: "loaded",
      source: { origin: "claude", scope: "project" },
    });
    expect(def.notes).toEqual([
      "model “sonnet” is mapped to the session's model: model names are mapped, not obeyed.",
      "Project code: its allowed-tools take effect only once you approve the project's code.",
    ]);
    expect(def.inlineShell).toBe(false);
    expect(isProjectCode(def)).toBe(true);
  });

  test("project code is inline shell or allowed-tools from the project's files, never the person's", async () => {
    await skill(join(project, ".claude"), "shell", "Status: !`git status`");
    await skill(join(project, ".claude"), "plain", "Just words.");
    await skill(join(home, ".claude"), "mine", "---\nallowed-tools: Bash\n---\nDate: !`date`");
    const set = await load();
    expect(byName(set.active, "shell")).toMatchObject({ inlineShell: true });
    expect(byName(set.active, "shell").notes).toEqual([
      "Project code: its inline shell commands take effect only once you approve the project's code.",
    ]);
    expect(set.active.map((d) => [d.name, isProjectCode(d)])).toEqual([
      ["mine", false],
      ["plain", false],
      ["shell", true],
    ]);
  });

  test("a command using $N is flagged: arguments count from 0 now", async () => {
    await command(join(project, ".claude"), "old.md", "Compare $1 with $2.");
    await command(join(project, ".claude"), "fresh.md", "Fix $ARGUMENTS, costs \\$5.");
    const set = await load();
    expect(byName(set.active, "old").notes.join(" ")).toContain("arguments count from 0");
    expect(byName(set.active, "fresh").notes).toEqual([]);
  });

  test("an argument hint with two bracketed words and a description with a colon", () => {
    const parsed = parseSkillFrontMatter(
      "---\ndescription: Fix it: carefully\nargument-hint: [file] [format]\n---\nBody",
    );
    expect(parsed.error).toBeNull();
    expect(parsed.fields).toMatchObject({
      description: "Fix it: carefully",
      "argument-hint": "[file] [format]",
    });
    expect(parsed.body).toBe("Body");
  });

  test("a block description still reads as YAML", () => {
    const parsed = parseSkillFrontMatter(
      "---\ndescription: >\n  Long text\n  over lines\nuser-invocable: false\n---\nx",
    );
    expect(parsed.fields).toMatchObject({
      description: "Long text over lines\n",
      "user-invocable": false,
    });
  });

  test("front matter that cannot be read loads the body with no fields", async () => {
    await skill(
      join(project, ".claude"),
      "broken",
      "---\nname: [unclosed\n  - : :\n---\nDo the thing.\n",
    );
    const def = byName((await load()).active, "broken");
    expect(def.status).toBe("partly-supported");
    expect(def.description).toBe("Do the thing.");
    expect(def.descriptionFrom).toBe("body");
    expect(def.notes[0]).toMatch(/not valid YAML.*loads with no fields/);
  });

  test("the first line of the body stands in for a missing description", async () => {
    await command(join(project, ".claude"), "lint.md", "\n# Run the linter\n\nThen fix.\n");
    const def = byName((await load()).active, "lint");
    expect(def).toMatchObject({ description: "Run the linter", descriptionFrom: "body" });
  });

  test("fields dawg does not run yet are named", async () => {
    await skill(
      join(project, ".claude"),
      "deep",
      [
        "---",
        "description: Deep research",
        "context: fork",
        "agent: Explore",
        "effort: high",
        "paths: src/**",
        "hooks:",
        "  PreToolUse: []",
        "shell: powershell",
        "version: 2",
        "---",
        "Body",
      ].join("\n"),
    );
    const def = byName((await load()).active, "deep");
    expect(def.status).toBe("partly-supported");
    expect(def.fork).toBe(true);
    expect(def.agent).toBe("Explore");
    const notes = def.notes.join("\n");
    for (const part of [
      "the agent is asked to start the subagent",
      "effort is ignored",
      "paths is ignored",
      "hooks in a skill are not run yet",
      "shell: powershell",
      "Unknown field “version”",
    ]) {
      expect(notes).toContain(part);
    }
  });

  test("a boolean that is not one is noted and the default kept", async () => {
    await skill(join(project, ".claude"), "odd", "---\nuser-invocable: maybe\n---\nx");
    const def = byName((await load()).active, "odd");
    expect(def.userInvocable).toBe(true);
    expect(def.notes.join(" ")).toContain("user-invocable is not true or false");
  });

  test("model: inherit needs no note", async () => {
    await skill(join(project, ".claude"), "same", "---\nmodel: inherit\n---\nx");
    const def = byName((await load()).active, "same");
    expect(def.model).toBeNull();
    expect(def.notes).toEqual([]);
  });
});

describe("where skills and commands come from", () => {
  test("commands take their namespace from their folders", async () => {
    await command(join(project, ".claude"), "frontend/component.md", "Make a component");
    await command(join(project, ".claude"), "deploy.md", "---\nname: ship\n---\nDeploy");
    const set = await load();
    expect(set.active.map((d) => d.name)).toEqual(["deploy", "frontend:component"]);
    const deploy = byName(set.active, "deploy");
    expect(deploy.kind).toBe("command");
    expect(deploy.notes.join(" ")).toContain("name is not used in a command file");
    expect(commandNameOf("frontend:component")).toBe("frontend:component");
  });

  test("the person's skill beats the project's, .dawg beats .claude, a skill beats a command", async () => {
    await skill(join(home, ".claude"), "review", "---\ndescription: mine\n---\nx");
    await skill(join(project, ".claude"), "review", "---\ndescription: project\n---\nx");
    await skill(join(project, ".claude"), "fmt", "---\ndescription: claude\n---\nx");
    await skill(join(project, ".dawg"), "fmt", "---\ndescription: dawg\n---\nx");
    await command(join(home, ".claude"), "fmt.md", "a command");
    const set = await load();
    expect(byName(set.active, "review").description).toBe("mine");
    expect(byName(set.active, "fmt").description).toBe("dawg");
    const shadowed = set.all.filter((d) => d.shadowedBy !== null);
    expect(shadowed.map((d) => [d.kind, d.name, d.source.origin, d.source.scope])).toEqual([
      ["skill", "fmt", "claude", "project"],
      ["skill", "review", "claude", "project"],
      ["command", "fmt", "claude", "user"],
    ]);
    expect(shadowed[1]?.notes.at(-1)).toMatch(
      /^Not used: ~\/\.claude\/skills\/review\/SKILL\.md defines “review” too and takes its place\.$/,
    );
  });

  test("folders from the repository root down to the working directory; same names are qualified", async () => {
    const app = join(project, "apps", "web");
    await skill(join(project, ".claude"), "deploy", "root");
    await skill(join(app, ".claude"), "deploy", "web");
    await skill(join(app, ".claude"), "only-web", "web");
    const set = await loadSkills({ homeDir: home, cwd: app });
    expect(set.active.map((d) => d.name)).toEqual(["apps/web:deploy", "deploy", "only-web"]);
    expect(byName(set.active, "apps/web:deploy").body).toBe("web");
  });

  test("a worktree without its own skills takes the project's", async () => {
    const worktree = join(root, "work", "proj-wt");
    await put(join(worktree, ".git"), "gitdir: elsewhere\n");
    await skill(join(project, ".claude"), "review", "x");
    const set = await loadSkills({ homeDir: home, cwd: worktree, projectDir: project });
    expect(set.active.map((d) => d.name)).toEqual(["review"]);
  });

  test("nested folders: listed for the report, loaded one folder at a time for a session", async () => {
    await skill(join(project, ".claude"), "deploy", "root");
    await skill(join(project, "apps", "web", ".claude"), "deploy", "web");
    await skill(join(project, "apps", "web", ".dawg"), "preview", "web");
    expect((await load()).active.map((d) => d.name)).toEqual(["deploy"]);
    const all = await load({ nested: true });
    expect(all.active.map((d) => [d.name, d.source.scope])).toEqual([
      ["apps/web:deploy", "nested"],
      ["deploy", "project"],
      ["preview", "nested"],
    ]);
    expect(byName(all.active, "preview").notes.join(" ")).toContain(
      "Loads once the agent reads or edits a file in apps/web",
    );
    const later = await loadNestedSkills({
      homeDir: home,
      cwd: project,
      rel: "apps/web",
      taken: new Set(["deploy"]),
    });
    expect(later.map((d) => d.name)).toEqual(["preview", "apps/web:deploy"]);
  });

  test("only the person's own, without a project", async () => {
    await skill(join(home, ".dawg"), "mine", "x");
    await skill(join(project, ".claude"), "theirs", "x");
    expect((await loadSkills({ homeDir: home, cwd: null })).active.map((d) => d.name)).toEqual([
      "mine",
    ]);
  });

  test("a project in the home folder is the person's own, read once", async () => {
    await skill(join(home, ".claude"), "mine", "x");
    const set = await loadSkills({ homeDir: home, cwd: home, nested: true });
    expect(set.all.map((d) => [d.name, d.source.scope])).toEqual([["mine", "user"]]);
  });

  test("a folder linked twice loads once; hidden folders and folders without SKILL.md are not skills", async () => {
    await skill(join(project, ".claude"), "real", "x");
    await symlink(
      join(project, ".claude", "skills", "real"),
      join(project, ".claude", "skills", "zlink"),
    );
    await put(join(project, ".claude", "skills", ".trash", "old", "SKILL.md"), "x");
    await mkdir(join(project, ".claude", "skills", "empty"), { recursive: true });
    expect((await load()).all.map((d) => d.name)).toEqual(["real"]);
  });
});

describe("names", () => {
  test("refused characters make a skill invalid", async () => {
    await skill(join(project, ".claude"), "bad", "---\nname: a<b\n---\nx");
    const set = await load();
    expect(set.active).toEqual([]);
    expect(set.all[0]).toMatchObject({ status: "invalid", name: "a<b" });
    expect(refusedName("two  spaces")).not.toBeNull();
    expect(refusedName("one space")).toBeNull();
    expect(refusedName("zero​width")).not.toBeNull();
  });

  test("a name that cannot be typed is for the agent only; a name dawg uses is a conflict", async () => {
    await skill(join(project, ".claude"), "spaced", "---\nname: My Skill\n---\nx");
    await command(join(project, ".claude"), "compact.md", "x");
    await command(
      join(project, ".claude"),
      "clear.md",
      "---\ndisable-model-invocation: true\n---\nx",
    );
    const set = await load();
    expect(byName(set.active, "My Skill").notes.at(-1)).toContain(
      "cannot be typed as a command here",
    );
    expect(byName(set.active, "compact")).toMatchObject({ status: "partly-supported" });
    expect(byName(set.active, "compact").notes.at(-1)).toContain(
      "/compact is one of dawg's own commands",
    );
    expect(byName(set.active, "clear").notes.at(-1)).toContain("it cannot run");
    expect(DAWG_COMMAND_NAMES).toContain("allowed-tools");
  });
});

describe("listing text", () => {
  test("description and when_to_use on one line, cut at 1,536 characters", () => {
    expect(listingDescription({ description: "Line one\nline two", whenToUse: "Use it." })).toBe(
      "Line one line two Use it.",
    );
    const long = listingDescription({ description: "x".repeat(2000), whenToUse: null });
    expect(long).toHaveLength(1536);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the report", () => {
  test("every skill and command, nested and unused ones included", async () => {
    await skill(join(home, ".claude"), "review", "---\ndescription: mine\nmodel: haiku\n---\nx");
    await skill(join(project, ".claude"), "review", "x");
    await skill(join(project, ".claude"), "background", "---\nuser-invocable: false\n---\nx");
    await command(join(project, ".claude"), "frontend/test.md", "x");
    await skill(join(project, "pkg", ".claude"), "pkg-only", "x");
    const items = await skillsReportProvider({ projectDir: project, homeDir: home });
    expect(items.map((i) => [i.kind, i.name, i.source.scope, i.status])).toEqual([
      ["skill", "/review", "user", "loaded"],
      ["skill", "background", "project", "loaded"],
      ["skill", "/review", "project", "loaded"],
      ["skill", "/pkg-only", "nested", "loaded"],
      ["command", "/frontend:test", "project", "loaded"],
    ]);
    expect(items[0]?.notes.join(" ")).toContain("mapped to the session's model");
    expect(items[2]?.notes.join(" ")).toContain("Not used");
  });
});
