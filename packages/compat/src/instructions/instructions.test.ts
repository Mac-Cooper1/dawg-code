import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadInstructions } from "./loader.ts";
import { MAX_INSTRUCTION_FILE_BYTES } from "./read.ts";
import { renderInstructions } from "./render.ts";
import type { InstructionFile } from "./types.ts";

let root: string;
let home: string;
let work: string;
let project: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-compat-instr-"));
  home = join(root, "home");
  work = join(root, "work");
  project = join(work, "proj");
  cwd = join(project, "packages", "app");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const load = (extra: Partial<Parameters<typeof loadInstructions>[0]> = {}) =>
  loadInstructions({ cwd, homeDir: home, projectDir: project, ...extra });

const summary = (files: readonly InstructionFile[]) =>
  files.map((f) => [f.kind, f.path.slice(root.length + 1)]);

describe("discovery at session start", () => {
  test("documented order from a nested working directory", async () => {
    await put(join(home, ".claude", "CLAUDE.md"), "user memory");
    await put(join(home, ".claude", "rules", "style.md"), "user rule");
    await put(join(work, "CLAUDE.md"), "above project");
    await put(join(project, "CLAUDE.md"), "project root");
    await put(join(project, ".claude", "CLAUDE.md"), "project dot-claude");
    await put(join(project, "CLAUDE.local.md"), "project local");
    await put(join(project, ".claude", "rules", "b.md"), "rule b");
    await put(join(project, ".claude", "rules", "a", "z.md"), "rule a/z");
    await put(join(project, ".claude", "rules", "notes.txt"), "not a rule");
    await put(join(project, "packages", "CLAUDE.local.md"), "packages local");
    await put(join(cwd, "CLAUDE.md"), "cwd memory");
    await put(join(cwd, "AGENTS.md"), "agents is not read when CLAUDE.md exists");
    await put(join(cwd, "sub", "CLAUDE.md"), "below cwd: on demand only");

    const set = await load();
    expect(summary(set.files)).toEqual([
      ["user", "home/.claude/CLAUDE.md"],
      ["user-rule", "home/.claude/rules/style.md"],
      ["project", "work/CLAUDE.md"],
      ["project", "work/proj/CLAUDE.md"],
      ["project", "work/proj/.claude/CLAUDE.md"],
      ["project-rule", "work/proj/.claude/rules/a/z.md"],
      ["project-rule", "work/proj/.claude/rules/b.md"],
      ["local", "work/proj/CLAUDE.local.md"],
      ["local", "work/proj/packages/CLAUDE.local.md"],
      ["project", "work/proj/packages/app/CLAUDE.md"],
    ]);
    expect(set.files.map((f) => f.content)).toContain("project dot-claude");
    expect(set.problems).toEqual([]);
    expect(set.totalSize).toBe(set.files.reduce((n, f) => n + f.size, 0));
    expect(set.files[0]?.size).toBe(Buffer.byteLength("user memory"));
  });

  test("the home directory as an ancestor does not load the user's files twice", async () => {
    const nestedCwd = join(home, "code", "app");
    await mkdir(nestedCwd, { recursive: true });
    await put(join(home, ".claude", "CLAUDE.md"), "user memory");
    await put(join(home, ".claude", "rules", "r.md"), "user rule");
    await put(join(home, "CLAUDE.md"), "home project file");
    const set = await loadInstructions({ cwd: nestedCwd, homeDir: home });
    expect(summary(set.files)).toEqual([
      ["user", "home/.claude/CLAUDE.md"],
      ["user-rule", "home/.claude/rules/r.md"],
      ["project", "home/CLAUDE.md"],
    ]);
  });

  test("block-level HTML comments are stripped outside code blocks", async () => {
    await put(
      join(cwd, "CLAUDE.md"),
      [
        "keep",
        "<!-- maintainer note -->",
        "<!--",
        "multi-line",
        "-->",
        "inline <!-- stays --> here",
        "```",
        "<!-- inside code stays -->",
        "```",
        "<!-- unclosed comment stays",
      ].join("\n"),
    );
    const set = await load();
    expect(set.files[0]?.content).toBe(
      [
        "keep",
        "inline <!-- stays --> here",
        "```",
        "<!-- inside code stays -->",
        "```",
        "<!-- unclosed comment stays",
      ].join("\n"),
    );
  });

  test("an oversized file is skipped and reported, not truncated", async () => {
    await put(join(cwd, "CLAUDE.md"), "x".repeat(MAX_INSTRUCTION_FILE_BYTES + 1));
    await put(join(project, "CLAUDE.md"), "small");
    const set = await load();
    expect(summary(set.files)).toEqual([["project", "work/proj/CLAUDE.md"]]);
    expect(set.problems).toEqual([
      expect.objectContaining({ kind: "too-large", path: join(cwd, "CLAUDE.md") }),
    ]);
  });
});

describe("AGENTS.md fallback", () => {
  test("read wherever CLAUDE.md would be when no CLAUDE.md applies", async () => {
    await put(join(home, ".claude", "CLAUDE.md"), "user memory does not count");
    await put(join(project, "AGENTS.md"), "project agents");
    await put(join(project, ".claude", "AGENTS.md"), "dot-claude agents");
    await put(join(cwd, "AGENTS.md"), "cwd agents");
    await put(join(project, ".claude", "rules", "r.md"), "rules still load");
    const set = await load();
    expect(summary(set.files)).toEqual([
      ["user", "home/.claude/CLAUDE.md"],
      ["agents", "work/proj/AGENTS.md"],
      ["agents", "work/proj/.claude/AGENTS.md"],
      ["project-rule", "work/proj/.claude/rules/r.md"],
      ["agents", "work/proj/packages/app/AGENTS.md"],
    ]);
  });

  test("any CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md at or above cwd turns it off", async () => {
    await put(join(project, "AGENTS.md"), "project agents");
    await put(join(work, "CLAUDE.local.md"), "personal notes above the project");
    const set = await load();
    expect(summary(set.files)).toEqual([["local", "work/CLAUDE.local.md"]]);
  });

  test("subdirectories: AGENTS.md on demand only when the session reads AGENTS.md", async () => {
    await put(join(cwd, "AGENTS.md"), "cwd agents");
    await put(join(cwd, "a", "AGENTS.md"), "a agents");
    await put(join(cwd, "b", "AGENTS.md"), "b agents, not read");
    await put(join(cwd, "b", "CLAUDE.md"), "b claude");
    const set = await load();
    expect(summary(set.files)).toEqual([["agents", "work/proj/packages/app/AGENTS.md"]]);
    expect(summary((await set.forFile(join(cwd, "a", "x.ts"))).files)).toEqual([
      ["agents", "work/proj/packages/app/a/AGENTS.md"],
    ]);
    expect(summary((await set.forFile(join(cwd, "b", "x.ts"))).files)).toEqual([
      ["project", "work/proj/packages/app/b/CLAUDE.md"],
    ]);
  });
});

describe("imports", () => {
  test("relative to the importing file, with nested imports placed after the naming line", async () => {
    await put(join(cwd, "CLAUDE.md"), "Intro\nSee @docs/guide.md for more.\nEnd");
    await put(join(cwd, "docs", "guide.md"), "Guide text\n@../shared/part.md\n");
    await put(join(cwd, "shared", "part.md"), "Part text");
    const set = await load();
    const file = set.files[0];
    expect(file?.imports).toEqual([join(cwd, "docs", "guide.md"), join(cwd, "shared", "part.md")]);
    expect(file?.content).toBe(
      [
        "Intro",
        "See @docs/guide.md for more.",
        `<import source="${join(cwd, "docs", "guide.md")}">`,
        "Guide text",
        "@../shared/part.md",
        `<import source="${join(cwd, "shared", "part.md")}">`,
        "Part text",
        "</import>",
        "</import>",
        "End",
      ].join("\n"),
    );
    expect(set.problems).toEqual([]);
  });

  test("escaped spaces, trailing punctuation and absolute paths", async () => {
    await put(join(cwd, "Design Docs", "api.md"), "API");
    await put(join(cwd, "README"), "Readme");
    await put(join(project, "abs.md"), "Absolute");
    await put(
      join(cwd, "CLAUDE.md"),
      `- conventions @Design\\ Docs/api.md\nSee @README.\nAlso @${join(project, "abs.md")}`,
    );
    const set = await load();
    expect(set.files[0]?.imports).toEqual([
      join(cwd, "Design Docs", "api.md"),
      join(cwd, "README"),
      join(project, "abs.md"),
    ]);
  });

  test("not expanded inside code spans, fenced blocks, quotes or e-mail addresses", async () => {
    await put(join(cwd, "a.md"), "SHOULD NOT APPEAR");
    await put(
      join(cwd, "CLAUDE.md"),
      [
        "Literal `@a.md` here and ``@a.md`` too.",
        "```",
        "@a.md",
        "```",
        "~~~md",
        "@a.md",
        "~~~",
        'Quoted @"a.md" and someone@a.md',
      ].join("\n"),
    );
    const set = await load();
    expect(set.files[0]?.imports).toEqual([]);
    expect(set.files[0]?.content).not.toContain("SHOULD NOT APPEAR");
  });

  test("at most four hops below the loaded file (five files deep)", async () => {
    await put(join(cwd, "CLAUDE.md"), "root\n@i1.md");
    for (let i = 1; i <= 5; i++) await put(join(cwd, `i${i}.md`), `level ${i}\n@i${i + 1}.md`);
    const set = await load();
    expect(set.files[0]?.imports).toEqual([1, 2, 3, 4].map((i) => join(cwd, `i${i}.md`)));
    expect(set.files[0]?.content).toContain("level 4");
    expect(set.files[0]?.content).not.toContain("level 5");
    expect(set.problems).toEqual([
      expect.objectContaining({ kind: "import-too-deep", target: join(cwd, "i5.md") }),
    ]);
  });

  test("cycles and missing files are skipped quietly", async () => {
    await put(join(cwd, "CLAUDE.md"), "root\n@a.md\n@missing.md\n@CLAUDE.md");
    await put(join(cwd, "a.md"), "A\n@b.md");
    await put(join(cwd, "b.md"), "B\n@a.md\n@../app/CLAUDE.md");
    const set = await load();
    const file = set.files[0];
    expect(file?.imports).toEqual([join(cwd, "a.md"), join(cwd, "b.md")]);
    expect(file?.content).not.toContain(`<import source="${join(cwd, "CLAUDE.md")}`);
    // The reference stays as written; nothing about the missing file is added.
    expect(file?.content).not.toContain(`<import source="${join(cwd, "missing.md")}`);
    expect(file?.content.match(/<import /g)).toHaveLength(2);
    expect(file?.content.split("\n").filter((l) => l === "A")).toHaveLength(1);
    expect(set.problems.map((p) => p.kind).sort()).toEqual(
      ["import-cycle", "import-cycle", "import-cycle", "missing-import"].sort(),
    );
  });

  test("home imports: always from the user's files, only with approval from project files", async () => {
    await put(join(home, "notes.md"), "Personal notes");
    await put(join(home, ".claude", "CLAUDE.md"), "user\n@~/notes.md");
    await put(join(cwd, "CLAUDE.local.md"), "local\n@~/notes.md");
    await put(join(project, "inside.md"), "Inside the project");
    await put(join(cwd, "CLAUDE.md"), "@../../inside.md");

    const blocked = await load();
    expect(blocked.files.map((f) => f.imports)).toEqual([
      [join(home, "notes.md")],
      [join(project, "inside.md")],
      [],
    ]);
    expect(blocked.externalFiles).toHaveLength(1);
    expect(blocked.externalFiles[0]).toMatch(/notes\.md$/);
    expect(blocked.problems).toEqual([
      expect.objectContaining({ kind: "external-import", path: join(cwd, "CLAUDE.local.md") }),
    ]);

    const allowed = await load({ externalImports: "allow" });
    expect(allowed.files[2]?.imports).toEqual([join(home, "notes.md")]);
    expect(allowed.externalFiles).toEqual([]);
  });
});

describe("rules", () => {
  test("with and without paths front matter", async () => {
    await put(join(project, ".claude", "rules", "always.md"), "---\ntitle: ignored\n---\nAlways");
    await put(
      join(project, ".claude", "rules", "api.md"),
      '---\npaths:\n  - "packages/app/src/**/*.{ts,tsx}"\n---\nAPI rule',
    );
    await put(
      join(project, ".claude", "rules", "md.md"),
      '---\npaths: "*.md, /top.txt"\n---\nMD rule',
    );
    await put(
      join(project, ".claude", "rules", "broken.md"),
      "---\npaths: [unclosed\n---\nBroken FM",
    );
    await put(
      join(project, ".claude", "rules", "bad.md"),
      '---\npaths: ["photos [2024/**"]\n---\nNever',
    );
    await put(
      join(home, ".claude", "rules", "user-ts.md"),
      "---\npaths: src/**/*.ts\n---\nUser TS",
    );

    const set = await load();
    expect(summary(set.files)).toEqual([
      ["project-rule", "work/proj/.claude/rules/always.md"],
      ["project-rule", "work/proj/.claude/rules/broken.md"],
    ]);
    expect(set.files[0]?.content).toBe("Always");
    expect(set.files[1]?.paths).toBeNull();
    expect(set.problems).toEqual([expect.objectContaining({ kind: "front-matter" })]);

    const ts = await set.forFile(join(cwd, "src", "x.tsx"));
    expect(summary(ts.files)).toEqual([["project-rule", "work/proj/.claude/rules/api.md"]]);
    expect(ts.files[0]?.paths).toEqual(["packages/app/src/**/*.{ts,tsx}"]);
    expect(ts.files[0]?.content).toBe("API rule");

    // User rule patterns are relative to the working directory.
    const userTs = await set.forFile(join(cwd, "src", "deep", "y.ts"));
    expect(summary(userTs.files)).toEqual([["user-rule", "home/.claude/rules/user-ts.md"]]);

    expect(summary((await set.forFile(join(project, "top.txt"))).files)).toEqual([
      ["project-rule", "work/proj/.claude/rules/md.md"],
    ]);
    expect((await set.forFile(join(project, "a", "photos [2024", "p.png"))).files).toEqual([]);
    // Outside every rule's base directory: nothing matches.
    expect((await set.forFile(join(root, "elsewhere.md"))).files).toEqual([]);
  });

  test("a rule linked from outside the project needs approval, then loads only if unconditional", async () => {
    await put(join(root, "shared", "always.md"), "Shared always");
    await put(join(root, "shared", "scoped.md"), "---\npaths: ['**/*.ts']\n---\nShared scoped");
    await mkdir(join(project, ".claude", "rules"), { recursive: true });
    await symlink(join(root, "shared"), join(project, ".claude", "rules", "shared"));

    const blocked = await load();
    expect(blocked.files).toEqual([]);
    expect(blocked.externalFiles).toHaveLength(2);

    const allowed = await load({ externalImports: "allow" });
    expect(summary(allowed.files)).toEqual([
      ["project-rule", "work/proj/.claude/rules/shared/always.md"],
    ]);
    expect((await allowed.forFile(join(cwd, "x.ts"))).files).toEqual([]);
  });
});

describe("on-demand discovery", () => {
  test("returns each file once, top down, with nested rules and matching path rules", async () => {
    await put(join(cwd, "CLAUDE.md"), "cwd");
    await put(join(cwd, "lib", "CLAUDE.md"), "lib");
    await put(join(cwd, "lib", "deep", "CLAUDE.md"), "deep");
    await put(join(cwd, "lib", "deep", "CLAUDE.local.md"), "deep local");
    await put(join(cwd, "lib", ".claude", "rules", "lib-rule.md"), "lib rule");
    await put(
      join(cwd, "lib", ".claude", "rules", "lib-ts.md"),
      "---\npaths: ['**/*.ts']\n---\nlib ts",
    );
    await put(join(cwd, "other", "CLAUDE.md"), "other");

    const set = await load();
    expect(summary(set.files)).toEqual([["project", "work/proj/packages/app/CLAUDE.md"]]);

    const first = await set.forFile(join(cwd, "lib", "deep", "file.ts"));
    expect(summary(first.files)).toEqual([
      ["project", "work/proj/packages/app/lib/CLAUDE.md"],
      ["project-rule", "work/proj/packages/app/lib/.claude/rules/lib-rule.md"],
      ["project", "work/proj/packages/app/lib/deep/CLAUDE.md"],
      ["local", "work/proj/packages/app/lib/deep/CLAUDE.local.md"],
      ["project-rule", "work/proj/packages/app/lib/.claude/rules/lib-ts.md"],
    ]);
    expect((await set.forFile(join(cwd, "lib", "deep", "file.ts"))).files).toEqual([]);
    expect((await set.forFile(join(cwd, "lib", "other.ts"))).files).toEqual([]);
    // Relative paths resolve against the working directory; files at or above it add nothing.
    expect(summary((await set.forFile("other/x.js")).files)).toEqual([
      ["project", "work/proj/packages/app/other/CLAUDE.md"],
    ]);
    expect((await set.forFile(join(cwd, "top.ts"))).files).toEqual([]);
    expect((await set.forFile(join(project, "x.ts"))).files).toEqual([]);
  });

  test("concurrent calls never return the same file twice", async () => {
    await put(join(cwd, "sub", "CLAUDE.md"), "sub");
    const set = await load();
    const results = await Promise.all(
      ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => set.forFile(join(cwd, "sub", f))),
    );
    expect(results.flatMap((r) => r.files)).toHaveLength(1);
  });
});

describe("renderInstructions", () => {
  async function buildTree(order: "forward" | "reverse"): Promise<string> {
    const entries: [string, string][] = [
      [join(home, ".claude", "CLAUDE.md"), "user\n@~/notes.md"],
      [join(home, "notes.md"), "notes"],
      [join(home, ".claude", "rules", "z.md"), "user z"],
      [join(home, ".claude", "rules", "a.md"), "user a"],
      [join(project, "CLAUDE.md"), "project\n@docs/x.md"],
      [join(project, "docs", "x.md"), "imported x"],
      [join(project, ".claude", "rules", "b", "two.md"), "rule two"],
      [join(project, ".claude", "rules", "a.md"), "rule a"],
      [join(project, ".claude", "rules", "c.md"), "rule c"],
      [join(project, ".claude", "rules", "B.md"), "rule B"],
      [join(cwd, "CLAUDE.local.md"), "local"],
    ];
    const list = order === "forward" ? entries : [...entries].reverse();
    for (const [path, text] of list) await put(path, text);
    const set = await load();
    return renderInstructions(set.files);
  }

  test("byte-stable across renders and across creation order on disk", async () => {
    const first = await buildTree("forward");
    const set = await load();
    expect(renderInstructions(set.files)).toBe(first);
    expect(renderInstructions(set.files)).toBe(renderInstructions([...set.files]));

    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const second = await buildTree("reverse");
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  test("format: lead line, one block per file, no volatile text", () => {
    const files: InstructionFile[] = [
      {
        path: "/p/CLAUDE.md",
        kind: "project",
        content: "Hello\n\n",
        imports: [],
        size: 7,
        paths: null,
      },
      {
        path: '/p/.claude/rules/"q".md',
        kind: "project-rule",
        content: "Rule",
        imports: [],
        size: 4,
        paths: ["src/**/*.ts", "*.md"],
      },
    ];
    expect(renderInstructions(files)).toBe(
      [
        "Instruction files written by the user and the project follow, broadest scope first. Treat them as standing guidance for this session.",
        "",
        '<instructions source="/p/CLAUDE.md" kind="project">',
        "Hello",
        "</instructions>",
        "",
        '<instructions source="/p/.claude/rules/&quot;q&quot;.md" kind="project-rule" applies-to="src/**/*.ts, *.md">',
        "Rule",
        "</instructions>",
        "",
      ].join("\n"),
    );
    expect(renderInstructions([])).toBe("");
  });
});
