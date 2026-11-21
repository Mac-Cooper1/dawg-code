import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolLimits } from "../../contracts/tools.ts";
import { createTestToolContext, type TestToolContextOptions } from "../../testing/context.ts";
import { type GlobInput, globTool, planGlob } from "./glob.ts";

let root: string;
let cleanups: (() => Promise<void>)[] = [];

/** A test context in the root, removed again after the test. */
async function context(options: Partial<TestToolContextOptions> = {}) {
  const test = await createTestToolContext({ cwd: root, ...options });
  cleanups.push(test.cleanup);
  return test;
}

/** Creates `files` under the root; each gets a modification time `index` minutes in the past. */
async function tree(files: string[]): Promise<void> {
  const now = Date.now() / 1000;
  for (const [index, file] of files.entries()) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, `${file}\n`);
    const time = now - index * 60;
    await utimes(full, time, time);
  }
}

async function run(
  input: GlobInput,
  limits?: Partial<ToolLimits>,
  readDenied?: ToolContext["readDenied"],
) {
  const { ctx } = await context({ limits });
  return globTool.execute(input, readDenied ? { ...ctx, readDenied } : ctx);
}

function text(out: { content: { type: string; text?: string }[] }): string {
  const part = out.content[0];
  return part && part.type === "text" ? (part.text ?? "") : "";
}

function lines(out: { content: { type: string; text?: string }[] }): string[] {
  return text(out)
    .split("\n\n")[0]
    ?.split("\n")
    .filter(Boolean)
    .map((p) => path.relative(root, p)) as string[];
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-glob-test-"));
});
afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
  await rm(root, { recursive: true, force: true });
});

describe("Glob", () => {
  it("returns absolute paths, newest first", async () => {
    await tree(["new.ts", "src/middle.ts", "src/deep/old.ts", "readme.md"]);
    const out = await run({ pattern: "**/*.ts" });
    expect(out.isError).toBeFalsy();
    expect(text(out).split("\n")[0]).toBe(path.join(root, "new.ts"));
    expect(lines(out)).toEqual(["new.ts", "src/middle.ts", "src/deep/old.ts"]);
    expect(out.display).toEqual({
      kind: "search",
      pattern: "**/*.ts",
      resultCount: 3,
      truncated: false,
    });
  });

  it("breaks modification-time ties by path", async () => {
    await tree(["b.txt", "a.txt", "c.txt"]);
    const time = Date.now() / 1000;
    for (const name of ["a.txt", "b.txt", "c.txt"]) await utimes(path.join(root, name), time, time);
    expect(lines(await run({ pattern: "*.txt" }))).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("matches a pattern without a slash in the search directory only", async () => {
    await tree(["top.json", "nested/inner.json", "conf.yaml"]);
    expect(lines(await run({ pattern: "*.{json,yaml}" })).sort()).toEqual([
      "conf.yaml",
      "top.json",
    ]);
  });

  it("searches under the given path", async () => {
    await tree(["src/a.ts", "lib/b.ts"]);
    expect(lines(await run({ pattern: "*.ts", path: "src" }))).toEqual(["src/a.ts"]);
    expect(lines(await run({ pattern: "**/*.ts", path: path.join(root, "lib") }))).toEqual([
      "lib/b.ts",
    ]);
  });

  it("caps the results and says how many matched", async () => {
    await tree(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]);
    const out = await run({ pattern: "*.txt" }, { globMaxResults: 2 });
    expect(lines(out)).toEqual(["f1.txt", "f2.txt"]);
    expect(text(out)).toContain("Showing the 2 most recently modified of 5 matching files");
    expect(out.display).toMatchObject({ resultCount: 5, truncated: true });
  });

  it("includes hidden and git-ignored files but skips .git unless named", async () => {
    await tree([".env.example", ".config/app.json", "ignored.log", ".git/config", "keep.json"]);
    await writeFile(path.join(root, ".gitignore"), "ignored.log\n");
    const all = lines(await run({ pattern: "**/*" })).sort();
    expect(all).toEqual([
      ".config/app.json",
      ".env.example",
      ".gitignore",
      "ignored.log",
      "keep.json",
    ]);
    expect(lines(await run({ pattern: ".git/*" }))).toEqual([".git/config"]);
  });

  it("lists files, not directories", async () => {
    await tree(["dir.d/file.txt"]);
    expect(text(await run({ pattern: "*.d" }))).toBe("No files found matching *.d.");
  });

  it("accepts an absolute pattern", async () => {
    await tree(["src/a.ts"]);
    expect(lines(await run({ pattern: path.join(root, "src", "*.ts") }))).toEqual(["src/a.ts"]);
  });

  it("accepts a pattern with no wildcards", async () => {
    await tree(["src/a.ts"]);
    expect(lines(await run({ pattern: "src/a.ts" }))).toEqual(["src/a.ts"]);
    const missing = await run({ pattern: "src/missing.ts" });
    expect(missing.isError).toBeFalsy();
    expect(text(missing)).toContain("No files found");
  });

  it("treats no matches as a normal result", async () => {
    await tree(["a.txt"]);
    const out = await run({ pattern: "**/*.rs" });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toBe("No files found matching **/*.rs.");
  });

  it("reports a missing or non-directory search path as an error", async () => {
    await tree(["a.txt"]);
    expect((await run({ pattern: "*", path: "nope" })).isError).toBe(true);
    expect((await run({ pattern: "*", path: "a.txt" })).isError).toBe(true);
  });

  it("refuses a null byte", async () => {
    const out = await run({ pattern: "a\0b" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("null byte");
  });

  it("stops when aborted", async () => {
    await tree(["a.txt"]);
    const { ctx, abort } = await context();
    abort();
    await expect(globTool.execute({ pattern: "**/*" }, ctx)).rejects.toBeTruthy();
  });

  it("stops at the session's search time limit with a note", async () => {
    await tree(["a.txt"]);
    const out = await run({ pattern: "**/*" }, { searchTimeoutMs: 0 });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain("stopped after");
  });

  it("silently leaves out files that may not be read", async () => {
    await tree(["new.env", "src/a.ts", "secrets/key.ts", "src/b.ts"]);
    const asked: string[] = [];
    const denied = (file: string) => {
      asked.push(file);
      return file.endsWith(".env") || file.includes(`${path.sep}secrets${path.sep}`);
    };
    const all = await run({ pattern: "**/*" }, undefined, denied);
    expect(lines(all)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(text(all)).not.toMatch(/secret|denied|left out|\.env/);
    expect(all.display).toMatchObject({ resultCount: 2, truncated: false });
    expect(asked.every((file) => path.isAbsolute(file))).toBe(true);
    const capped = await run({ pattern: "**/*" }, { globMaxResults: 1 }, denied);
    expect(text(capped)).toContain("Showing the 1 most recently modified of 2 matching files");
    const literal = await run({ pattern: "new.env" }, undefined, denied);
    expect(text(literal)).toBe("No files found matching new.env.");
  });

  it("asks to read the directory it searches", async () => {
    const { ctx } = await context();
    expect(globTool.permission({ pattern: "**/*.ts" }, ctx)).toEqual({
      kind: "read",
      paths: [root],
    });
    expect(globTool.permission({ pattern: "src/**/*.ts", path: "/elsewhere" }, ctx)).toEqual({
      kind: "read",
      paths: ["/elsewhere/src"],
    });
    expect(globTool.permission({ pattern: "../other/*.md" }, ctx)).toEqual({
      kind: "read",
      paths: [path.resolve(root, "../other")],
    });
  });

  it("has a byte-stable, strict schema", () => {
    expect(globTool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["pattern"],
    });
    expect(globTool.readOnly).toBe(true);
    expect(planGlob({ pattern: "./src/*.ts" }, "/w")).toEqual({
      root: "/w/src",
      glob: "*.ts",
      literal: null,
    });
  });
});
