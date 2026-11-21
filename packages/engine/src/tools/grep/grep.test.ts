import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolLimits, ToolOutput } from "../../contracts/tools.ts";
import { createTestToolContext, type TestToolContextOptions } from "../../testing/context.ts";
import { processesMatching } from "../exec/test-support.ts";
import { RipgrepNotFoundError } from "../ripgrep/resolve.ts";
import { buildRipgrepArgs, createGrepTool, type GrepInput, grepTool } from "./grep.ts";

const execFileAsync = promisify(execFile);

let root: string;
let cleanups: (() => Promise<void>)[] = [];

/** A test context in the root, removed again after the test. */
async function context(options: Partial<TestToolContextOptions> = {}) {
  const test = await createTestToolContext({ cwd: root, ...options });
  cleanups.push(test.cleanup);
  return test;
}

/** Writes files; each gets a modification time `index` minutes in the past. */
async function tree(files: Record<string, string>): Promise<void> {
  const now = Date.now() / 1000;
  for (const [index, [name, content]] of Object.entries(files).entries()) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await utimes(full, now - index * 60, now - index * 60);
  }
}

async function run(
  input: GrepInput,
  limits?: Partial<ToolLimits>,
  readDenied?: ToolContext["readDenied"],
) {
  const { ctx } = await context({ limits });
  return grepTool.execute(input, readDenied ? { ...ctx, readDenied } : ctx);
}

function text(out: ToolOutput): string {
  const part = out.content[0];
  return part?.type === "text" ? part.text : "";
}

/** The result with the root directory removed from paths, for readable assertions. */
function rel(out: ToolOutput): string {
  return text(out).split(`${root}/`).join("");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-grep-test-"));
  // A .git directory makes ripgrep apply .gitignore.
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "HEAD"), "needle in git metadata\n");
});
afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  expect(await processesMatching("dawg-grep-test-")).toEqual([]);
});

describe("Grep output modes", () => {
  beforeEach(async () => {
    await tree({
      "src/newest.ts": "const needle = 1;\nother\n",
      "src/middle.ts": "nothing here\n",
      "lib/oldest.js": "needle one\nneedle two\nneedle three\n",
    });
  });

  it("lists matching files newest first by default", async () => {
    const out = await run({ pattern: "needle" });
    expect(out.isError).toBeFalsy();
    expect(rel(out)).toBe("src/newest.ts\nlib/oldest.js");
    expect(out.display).toEqual({
      kind: "search",
      pattern: "needle",
      resultCount: 2,
      truncated: false,
    });
  });

  it("shows matching lines with line numbers in content mode", async () => {
    const out = await run({ pattern: "needle", output_mode: "content" });
    expect(rel(out)).toBe(
      [
        "lib/oldest.js:1:needle one",
        "lib/oldest.js:2:needle two",
        "lib/oldest.js:3:needle three",
        "src/newest.ts:1:const needle = 1;",
      ].join("\n"),
    );
    expect(out.display).toMatchObject({ resultCount: 4, truncated: false });
  });

  it("hides line numbers when -n is false", async () => {
    const out = await run({ pattern: "const", output_mode: "content", "-n": false });
    expect(rel(out)).toBe("src/newest.ts:const needle = 1;");
  });

  it("counts matches per file with a total", async () => {
    const out = await run({ pattern: "needle", output_mode: "count" });
    expect(rel(out)).toBe("lib/oldest.js:3\nsrc/newest.ts:1\n\nTotal: 4 matches in 2 files.");
  });

  it("pages count rows while keeping the full totals", async () => {
    const first = await run({ pattern: "needle", output_mode: "count", head_limit: 1 });
    expect(rel(first)).toBe(
      "lib/oldest.js:3\n\nTotal: 4 matches in 2 files.\n\nShowing files 1-1 of 2. Pass offset=1 to see more.",
    );
    const out = await run({ pattern: "needle", output_mode: "count", head_limit: 1, offset: 1 });
    expect(rel(out)).toBe("src/newest.ts:1\n\nTotal: 4 matches in 2 files.");
  });

  it("shows only the matched text with -o", async () => {
    const out = await run({ pattern: "needle \\w+", output_mode: "content", "-o": true });
    expect(rel(out)).toBe(
      "lib/oldest.js:1:needle one\nlib/oldest.js:2:needle two\nlib/oldest.js:3:needle three",
    );
  });
});

describe("Grep context, paging and limits", () => {
  it("adds context lines and separates distant groups", async () => {
    await tree({ "a.txt": "1\n2\nmatch A\n4\n5\n6\n7\nmatch B\n9\n" });
    const out = await run({ pattern: "match", output_mode: "content", "-C": 1 });
    expect(rel(out)).toBe(
      [
        "a.txt-2-2",
        "a.txt:3:match A",
        "a.txt-4-4",
        "--",
        "a.txt-7-7",
        "a.txt:8:match B",
        "a.txt-9-9",
      ].join("\n"),
    );
  });

  it("supports -A, -B and context", async () => {
    await tree({ "a.txt": "1\n2\nmatch\n4\n5\n" });
    expect(rel(await run({ pattern: "match", output_mode: "content", "-A": 1 }))).toBe(
      "a.txt:3:match\na.txt-4-4",
    );
    expect(rel(await run({ pattern: "match", output_mode: "content", "-B": 2 }))).toBe(
      "a.txt-1-1\na.txt-2-2\na.txt:3:match",
    );
    expect(rel(await run({ pattern: "match", output_mode: "content", context: 1 }))).toBe(
      "a.txt-2-2\na.txt:3:match\na.txt-4-4",
    );
  });

  it("pages content lines with head_limit and offset", async () => {
    await tree({ "a.txt": Array.from({ length: 10 }, (_, i) => `hit ${i}`).join("\n") });
    const first = await run({ pattern: "hit", output_mode: "content", head_limit: 3 });
    expect(rel(first)).toContain("a.txt:1:hit 0\na.txt:2:hit 1\na.txt:3:hit 2\n\n");
    expect(rel(first)).toContain("Showing lines 1-3 of 10. Pass offset=3 to see more.");
    expect(first.display).toMatchObject({ resultCount: 10, truncated: true });
    const next = await run({ pattern: "hit", output_mode: "content", head_limit: 3, offset: 3 });
    expect(rel(next)).toContain("a.txt:4:hit 3\na.txt:5:hit 4\na.txt:6:hit 5");
    const past = await run({ pattern: "hit", output_mode: "content", offset: 50 });
    expect(past.isError).toBeFalsy();
    expect(rel(past)).toBe("No entries at this offset: the search found 10 lines.");
  });

  it("uses the default head limit from the session's limits", async () => {
    await tree(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, "hit\n"])));
    const out = await run({ pattern: "hit" }, { grepDefaultHeadLimit: 2 });
    expect(rel(out).split("\n").slice(0, 2)).toEqual(["f0.txt", "f1.txt"]);
    expect(rel(out)).toContain("Showing files 1-2 of 5. Pass offset=2 to see more.");
  });

  it("shortens very long lines", async () => {
    await tree({ "min.js": `${"x".repeat(5000)}needle${"y".repeat(5000)}\n` });
    const out = await run({ pattern: "x+", output_mode: "content" });
    expect(text(out).length).toBeLessThan(1000);
    const shorter = await run({ pattern: "x+", output_mode: "content" }, { grepMaxLineChars: 50 });
    expect(rel(shorter)).toMatch(/^min\.js:1:x{50}/);
    expect(rel(shorter).length).toBeLessThan(150);
  });
});

describe("Grep with read-denied files", () => {
  const denied = (file: string) =>
    file === path.join(root, ".env") || file.startsWith(path.join(root, "config", "private"));

  beforeEach(async () => {
    await tree({
      "src/app.ts": "token = 1\nother\ntoken = 2\n",
      ".env": "token = secret\n",
      "config/private/keys.txt": "token = also secret\n",
      "lib/util.ts": "token = 3\n",
    });
  });

  it("leaves their files out of the file list, silently", async () => {
    const out = await run({ pattern: "token" }, undefined, denied);
    expect(rel(out)).toBe("src/app.ts\nlib/util.ts");
    expect(out.display).toMatchObject({ resultCount: 2, truncated: false });
  });

  it("leaves their lines out of content, totals and paging", async () => {
    const out = await run({ pattern: "token", output_mode: "content" }, undefined, denied);
    expect(rel(out)).toBe(
      "lib/util.ts:1:token = 3\nsrc/app.ts:1:token = 1\nsrc/app.ts:3:token = 2",
    );
    expect(text(out)).not.toContain("secret");
    const paged = await run(
      { pattern: "token", output_mode: "content", head_limit: 2 },
      undefined,
      denied,
    );
    expect(rel(paged)).toContain("Showing lines 1-2 of 3.");
    const around = await run(
      { pattern: "secret|token = 3", output_mode: "content", "-C": 1 },
      undefined,
      denied,
    );
    expect(rel(around)).toBe("lib/util.ts:1:token = 3");
  });

  it("leaves their counts out of the rows and the total", async () => {
    const out = await run({ pattern: "token", output_mode: "count" }, undefined, denied);
    expect(rel(out)).toBe("lib/util.ts:1\nsrc/app.ts:2\n\nTotal: 3 matches in 2 files.");
  });

  it("finds nothing in a denied file named directly", async () => {
    const out = await run({ pattern: "token", path: ".env" }, undefined, denied);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toBe("No matches found.");
  });
});

describe("Grep pattern handling", () => {
  it("treats a pattern starting with a dash as a pattern, not a flag", async () => {
    await tree({ "flags.txt": "use --files carefully\n-v is verbose\n" });
    const out = await run({ pattern: "--files", output_mode: "content" });
    expect(rel(out)).toBe("flags.txt:1:use --files carefully");
    expect(rel(await run({ pattern: "-v", output_mode: "content" }))).toBe(
      "flags.txt:2:-v is verbose",
    );
  });

  it("returns ripgrep's explanation for an invalid regex", async () => {
    await tree({ "a.txt": "text\n" });
    const out = await run({ pattern: "foo(" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("regex parse error");
  });

  it("returns ripgrep's explanation for an unknown file type", async () => {
    await tree({ "a.txt": "text\n" });
    const out = await run({ pattern: "text", type: "no-such-type" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("no-such-type");
  });

  it("treats no matches as a normal result", async () => {
    await tree({ "a.txt": "text\n" });
    for (const output_mode of ["content", "files_with_matches", "count"] as const) {
      const out = await run({ pattern: "absent", output_mode });
      expect(out.isError).toBeFalsy();
      expect(text(out)).toBe("No matches found.");
    }
  });

  it("ignores case with -i and matches across lines with multiline", async () => {
    await tree({ "a.txt": "Hello\nWorld\n" });
    expect(rel(await run({ pattern: "hello", output_mode: "content", "-i": true }))).toBe(
      "a.txt:1:Hello",
    );
    expect(text(await run({ pattern: "Hello.World" }))).toBe("No matches found.");
    expect(rel(await run({ pattern: "Hello.World", multiline: true }))).toBe("a.txt");
  });

  it("filters by glob and by type", async () => {
    await tree({ "a.ts": "hit\n", "b.py": "hit\n", "c.md": "hit\n" });
    expect(
      rel(await run({ pattern: "hit", glob: "*.{ts,md}" }))
        .split("\n")
        .sort(),
    ).toEqual(["a.ts", "c.md"]);
    expect(rel(await run({ pattern: "hit", type: "py" }))).toBe("b.py");
  });
});

describe("Grep file selection", () => {
  it("skips git-ignored files unless named, searches hidden files, never .git", async () => {
    await tree({
      ".gitignore": "build/\n",
      "build/out.js": "needle\n",
      ".hidden/conf": "needle\n",
      "src/a.ts": "needle\n",
    });
    expect(
      rel(await run({ pattern: "needle" }))
        .split("\n")
        .sort(),
    ).toEqual([".hidden/conf", "src/a.ts"]);
    expect(rel(await run({ pattern: "needle", path: "build/out.js" }))).toBe("build/out.js");
  });

  it("reports a missing path as an error", async () => {
    const out = await run({ pattern: "x", path: "missing" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("does not exist");
  });

  it("says how to get ripgrep when it cannot be found", async () => {
    const tool = createGrepTool({
      findRipgrep: async () => {
        throw new RipgrepNotFoundError([]);
      },
    });
    const { ctx } = await context();
    const out = await tool.execute({ pattern: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("pnpm fetch-ripgrep");
  });

  it("saves a result over the session's output limit to a file", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `needle ${i} ${"z".repeat(200)}`);
    await tree({ "big.txt": long.join("\n") });
    const { ctx, saved } = await context();
    const out = await grepTool.execute(
      { pattern: "needle", output_mode: "content", head_limit: 0 },
      ctx,
    );
    expect(saved).toHaveLength(1);
    expect(text(out)).toContain(saved[0]?.path ?? "missing");
    expect(text(out).length).toBeLessThan(32_000);

    const small = await context({ limits: { grepMaxOutputChars: 2000 } });
    const cut = await grepTool.execute({ pattern: "needle", output_mode: "content" }, small.ctx);
    expect(small.saved).toHaveLength(1);
    expect(text(cut).length).toBeLessThan(2400);
    expect(text(cut)).toContain("so it was cut here");
  });
});

describe("Grep stopping", () => {
  /** A FIFO with no writer: ripgrep blocks on it until it is killed. */
  async function blockingFifo(): Promise<string> {
    const fifo = path.join(root, "stuck.fifo");
    await execFileAsync("mkfifo", [fifo]);
    return fifo;
  }

  it("kills ripgrep and throws when aborted", async () => {
    const fifo = await blockingFifo();
    const { ctx, abort } = await context();
    const pending = grepTool.execute({ pattern: "x", path: fifo }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await processesMatching(fifo)).not.toEqual([]);
    abort();
    await expect(pending).rejects.toBeTruthy();
    expect(await processesMatching(fifo)).toEqual([]);
  });

  it("stops at the session's search time limit and returns what it has", async () => {
    const fifo = await blockingFifo();
    const out = await run({ pattern: "x", path: fifo }, { searchTimeoutMs: 300 });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain("stopped after");
    expect(out.display).toMatchObject({ truncated: true });
    expect(await processesMatching(fifo)).toEqual([]);
  });
});

describe("Grep definition", () => {
  it("asks to read the search path", async () => {
    const { ctx } = await context();
    expect(grepTool.permission({ pattern: "x" }, ctx)).toEqual({ kind: "read", paths: [root] });
    expect(grepTool.permission({ pattern: "x", path: "src" }, ctx)).toEqual({
      kind: "read",
      paths: [path.join(root, "src")],
    });
  });

  it("passes the pattern with --regexp and ends options before the path", () => {
    const args = buildRipgrepArgs({ pattern: "-e", output_mode: "content" }, "/search", 120);
    expect(args.slice(-3)).toEqual(["--regexp=-e", "--", "/search"]);
    expect(args).toContain("--max-columns=120");
  });

  it("has a strict schema with the documented inputs", () => {
    const schema = grepTool.inputSchema as { properties: object; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        "-A",
        "-B",
        "-C",
        "-i",
        "-n",
        "-o",
        "context",
        "glob",
        "head_limit",
        "multiline",
        "offset",
        "output_mode",
        "path",
        "pattern",
        "type",
      ].sort(),
    );
  });
});
