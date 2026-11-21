import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext, ToolLimits, ToolOutput } from "../../contracts/index.ts";
import { createStateBag, createTestToolContext } from "../../testing/context.ts";
import { BOM, fileTracker, REPLACEMENT_CHAR } from "../files/index.ts";
import { readTool } from "./read.ts";

let base: ToolContext;
const dirs: string[] = [];

beforeAll(async () => {
  base = (await createTestToolContext({ cwd: tmpdir() })).ctx;
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(
  options: { vision?: boolean; limits?: Partial<ToolLimits> } = {},
): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dawg-read-"));
  dirs.push(dir);
  const ctx: ToolContext = {
    ...base,
    cwd: dir,
    workingDirectories: [dir],
    state: createStateBag(),
    vision: options.vision ?? false,
    limits: { ...base.limits, ...options.limits },
  };
  return { dir, ctx };
}

function text(out: ToolOutput, dir?: string): string {
  const joined = out.content
    .map((p) => (p.type === "text" ? p.text : `<image ${p.mediaType}>`))
    .join("\n");
  return dir === undefined ? joined : joined.replaceAll(dir, "<dir>");
}

function numbered(count: number, from = 1): string {
  return Array.from({ length: count }, (_, i) => `line ${from + i}`).join("\n");
}

/** A PNG header for a 3x2 image; enough for detection. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
  Buffer.from([0, 0, 0, 0]),
]);

describe("Read", () => {
  it("returns numbered lines and records the whole file as read", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "alpha\n\tbeta  \ngamma\n");
    const out = await readTool.execute({ file_path: "a.txt" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toBe("1→alpha\n2→\tbeta  \n3→gamma");
    expect(out.display).toEqual({
      kind: "file",
      filePath: path.join(dir, "a.txt"),
      startLine: 1,
      lineCount: 3,
      totalLines: 3,
      truncated: false,
    });
    expect(out.touched).toEqual({ read: [path.join(dir, "a.txt")] });
    const record = fileTracker(ctx.state).get(path.join(dir, "a.txt"));
    expect(record).toMatchObject({ whole: true, totalLines: 3, ranges: [[1, 3]], via: "read" });
  });

  it("reads a range and says how to continue", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), `${numbered(10)}\n`);
    const out = await readTool.execute({ file_path: "a.txt", offset: 3, limit: 3 }, ctx);
    expect(text(out)).toBe(
      "3→line 3\n4→line 4\n5→line 5\n\n[Lines 3-5 of 10 shown. To continue, Read with offset 6.]",
    );
    expect(fileTracker(ctx.state).get(path.join(dir, "a.txt"))).toMatchObject({
      whole: false,
      ranges: [[3, 5]],
    });
  });

  it("marks the file whole once its ranges cover it", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), numbered(10));
    await readTool.execute({ file_path: "a.txt", offset: 1, limit: 6 }, ctx);
    const out = await readTool.execute({ file_path: "a.txt", offset: 7 }, ctx);
    expect(text(out)).toContain("[Lines 7-10 of 10 shown, to the end of the file.]");
    expect(fileTracker(ctx.state).get(path.join(dir, "a.txt"))).toMatchObject({
      whole: true,
      ranges: [[1, 10]],
    });
  });

  it("treats offset 0 as the first line", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "x\ny\n");
    const out = await readTool.execute({ file_path: "a.txt", offset: 0, limit: 1 }, ctx);
    expect(text(out)).toContain("1→x");
  });

  it("stops at the default line cap", async () => {
    const { dir, ctx } = await setup({ limits: { readDefaultLines: 4 } });
    await writeFile(path.join(dir, "a.txt"), numbered(9));
    const out = await readTool.execute({ file_path: "a.txt" }, ctx);
    expect(text(out)).toBe(
      "1→line 1\n2→line 2\n3→line 3\n4→line 4\n\n[Lines 1-4 of 9 shown. To continue, Read with offset 5.]",
    );
    expect(out.display).toMatchObject({ truncated: true, lineCount: 4, totalLines: 9 });
  });

  it("pads line numbers to the widest one shown", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), numbered(12));
    const out = await readTool.execute({ file_path: "a.txt", offset: 8, limit: 3 }, ctx);
    expect(text(out).split("\n").slice(0, 3)).toEqual([" 8→line 8", " 9→line 9", "10→line 10"]);
  });

  it("cuts over-long lines and says so", async () => {
    const { dir, ctx } = await setup({ limits: { readMaxLineChars: 10 } });
    await writeFile(path.join(dir, "a.txt"), `short\n${"x".repeat(25)}\n`);
    const out = await readTool.execute({ file_path: "a.txt" }, ctx);
    expect(text(out)).toBe(
      "1→short\n2→xxxxxxxxxx… [line cut: 25 characters in total]\n\n[1 line longer than 10 characters was cut.]",
    );
  });

  it("refuses a whole file over the size limit, with its size and line count", async () => {
    const { dir, ctx } = await setup({ limits: { readMaxBytes: 100 } });
    await writeFile(path.join(dir, "big.txt"), `${numbered(30)}\n`);
    const out = await readTool.execute({ file_path: "big.txt" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/big.txt is too large to read at once: 231 bytes, 30 lines (the limit for reading a whole file is 100 bytes). Read it in parts with offset and limit, for example offset 1 and limit 2000, or use Grep to find the lines you need."`,
    );
    expect(fileTracker(ctx.state).get(path.join(dir, "big.txt"))).toBeUndefined();
  });

  it("reads a range of a file over the size limit, stopping when the output is full", async () => {
    const { dir, ctx } = await setup({ limits: { readMaxBytes: 60 } });
    await writeFile(path.join(dir, "big.txt"), `${numbered(30)}\n`);
    const out = await readTool.execute({ file_path: "big.txt", offset: 20, limit: 10 }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toMatchInlineSnapshot(`
      "20→line 20
      21→line 21
      22→line 22
      23→line 23
      24→line 24

      [Lines 20-24 of 30 shown; the rest did not fit in one result. To continue, Read with offset 25.]"
    `);
  });

  it("reads files with CRLF endings, a BOM, or UTF-16", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "crlf.txt"), "a\r\nb\r\n");
    await writeFile(path.join(dir, "bom.txt"), Buffer.from(`${BOM}bom\n`, "utf8"));
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("wide é\nline\n", "utf16le"),
    ]);
    await writeFile(path.join(dir, "u16.txt"), utf16);
    expect(text(await readTool.execute({ file_path: "crlf.txt" }, ctx))).toBe("1→a\n2→b");
    expect(text(await readTool.execute({ file_path: "bom.txt" }, ctx))).toBe("1→bom");
    expect(text(await readTool.execute({ file_path: "u16.txt" }, ctx))).toBe("1→wide é\n2→line");
  });

  it("shows invalid UTF-8 with replacement characters and a note", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const out = await readTool.execute({ file_path: "latin1.txt" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out)).toMatchInlineSnapshot(`
      "1→caf�

      [This file is not valid UTF-8: bytes that could not be decoded are shown as �. Edit cannot change it; use a shell command that keeps its encoding.]"
    `);
  });

  it("does not flag a file that really contains U+FFFD", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "ok.txt"), `replacement ${REPLACEMENT_CHAR} char\n`);
    expect(text(await readTool.execute({ file_path: "ok.txt" }, ctx))).toBe(
      `1→replacement ${REPLACEMENT_CHAR} char`,
    );
  });

  it("notes an empty file without an error", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "empty.txt"), "");
    const out = await readTool.execute({ file_path: "empty.txt" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toBe("The file <dir>/empty.txt exists but is empty.");
    expect(fileTracker(ctx.state).get(path.join(dir, "empty.txt"))).toMatchObject({ whole: true });
  });

  it("refuses an offset past the end", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
    const out = await readTool.execute({ file_path: "a.txt", offset: 5 }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"offset 5 is past the end of <dir>/a.txt, which has 2 lines. Use an offset from 1 to 2."`,
    );
  });

  it("returns an image part when the model can see images", async () => {
    const { dir, ctx } = await setup({ vision: true });
    await writeFile(path.join(dir, "pic.png"), PNG);
    const out = await readTool.execute({ file_path: "pic.png" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content[0]).toEqual({
      type: "text",
      text: `Image ${path.join(dir, "pic.png")} (PNG, 3x2, 33 bytes):`,
    });
    expect(out.content[1]).toEqual({
      type: "image",
      mediaType: "image/png",
      data: PNG.toString("base64"),
    });
    expect(fileTracker(ctx.state).get(path.join(dir, "pic.png"))).toMatchObject({ whole: true });
  });

  it("describes an image in words when the model cannot see images", async () => {
    const { dir, ctx } = await setup({ vision: false });
    await writeFile(path.join(dir, "pic.png"), PNG);
    const out = await readTool.execute({ file_path: "pic.png" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).toHaveLength(1);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/pic.png is an image (PNG, 3x2, 33 bytes). The current model cannot see images, so its contents are not shown."`,
    );
  });

  it("recognises an image by its bytes when the name has no image extension", async () => {
    const { dir, ctx } = await setup({ vision: true });
    await writeFile(path.join(dir, "screenshot"), PNG);
    const out = await readTool.execute({ file_path: "screenshot" }, ctx);
    expect(out.content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("reads a text file with an image extension as text", async () => {
    const { dir, ctx } = await setup({ vision: true });
    await writeFile(path.join(dir, "fake.png"), "not really\n");
    expect(text(await readTool.execute({ file_path: "fake.png" }, ctx))).toBe("1→not really");
  });

  it("refuses an image too large to send", async () => {
    const { dir, ctx } = await setup({ vision: true });
    const file = path.join(dir, "huge.png");
    await writeFile(file, PNG);
    await truncate(file, 21 * 1024 * 1024);
    const out = await readTool.execute({ file_path: "huge.png" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/huge.png is too large to read as an image: 21 MB (the limit is 20 MB). Make a smaller copy first, for example \`sips -Z 2000 <dir>/huge.png --out /tmp/small.png\`, and read that."`,
    );
  });

  it("refuses binary files", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "blob.dat"), Buffer.from([1, 2, 0, 3, 4]));
    await writeFile(path.join(dir, "bundle.zip"), "PK");
    const blob = await readTool.execute({ file_path: "blob.dat" }, ctx);
    const zip = await readTool.execute({ file_path: "bundle.zip" }, ctx);
    expect(blob.isError).toBe(true);
    expect(zip.isError).toBe(true);
    expect(text(blob, dir)).toMatchInlineSnapshot(
      `"<dir>/blob.dat looks like a binary file (it contains NUL bytes), so Read will not show it. To inspect it, run \`file <dir>/blob.dat\` or \`xxd <dir>/blob.dat | head\`."`,
    );
    expect(text(zip, dir)).toMatchInlineSnapshot(
      `"<dir>/bundle.zip is an archive, which Read cannot show as text. To inspect it, list it with \`tar -tf <dir>/bundle.zip\` or \`unzip -l <dir>/bundle.zip\`."`,
    );
  });

  it("says PDFs and notebooks are not supported yet", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "doc.pdf"), "%PDF-1.4");
    await writeFile(path.join(dir, "nb.ipynb"), "{}");
    const pdf = await readTool.execute({ file_path: "doc.pdf" }, ctx);
    const nb = await readTool.execute({ file_path: "nb.ipynb" }, ctx);
    expect(pdf.isError).toBe(true);
    expect(nb.isError).toBe(true);
    expect(text(pdf, dir)).toMatchInlineSnapshot(
      `"Reading PDF files is not supported yet. If poppler is installed, \`pdftotext <dir>/doc.pdf -\` prints the text."`,
    );
    expect(text(nb, dir)).toMatchInlineSnapshot(
      `"Reading Jupyter notebooks (.ipynb) is not supported yet. A notebook is JSON, so a shell command such as \`jq '.cells' <dir>/nb.ipynb\` can show its cells."`,
    );
  });

  it("suggests similarly named files for a missing file", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "config.json"), "{}");
    await writeFile(path.join(dir, "config.yaml"), "a: 1");
    const out = await readTool.execute({ file_path: "confg.json" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "File does not exist: <dir>/confg.json
      Did you mean <dir>/config.json?"
    `);
  });

  it("points out a missing directory and a similarly named one", async () => {
    const { dir, ctx } = await setup();
    await mkdir(path.join(dir, "src/components"), { recursive: true });
    await writeFile(path.join(dir, "src/components/Button.tsx"), "x");
    const out = await readTool.execute({ file_path: "src/compnents/Button.tsx" }, ctx);
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "File does not exist: <dir>/src/compnents/Button.tsx
      The directory <dir>/src/compnents does not exist either.
      Did you mean <dir>/src/components/Button.tsx?"
    `);
  });

  it("finds the file when a relative path was written as absolute", async () => {
    const { dir, ctx } = await setup();
    await mkdir(path.join(dir, "lib"));
    await writeFile(path.join(dir, "lib/util.ts"), "x");
    const out = await readTool.execute({ file_path: "/lib/util.ts" }, ctx);
    expect(text(out, dir)).toContain("Did you mean <dir>/lib/util.ts?");
  });

  it("says when nothing similar exists", async () => {
    const { dir, ctx } = await setup();
    const out = await readTool.execute({ file_path: "nothing-here.md" }, ctx);
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "File does not exist: <dir>/nothing-here.md
      No similarly named file was found nearby. Use Glob to search for it."
    `);
  });

  it("refuses a directory and lists what is in it", async () => {
    const { dir, ctx } = await setup();
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src/a.ts"), "");
    await mkdir(path.join(dir, "src/lib"));
    const out = await readTool.execute({ file_path: "src" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/src is a directory, not a file. Read works on files only. It contains: a.ts, lib/."`,
    );
  });

  it.skipIf(process.platform === "win32")("refuses a pipe instead of blocking on it", async () => {
    const { dir, ctx } = await setup();
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    const out = await readTool.execute({ file_path: "pipe" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/pipe is not a regular file (it is a pipe, socket or device), so Read cannot show it."`,
    );
  });

  it("refuses an empty path", async () => {
    const { ctx } = await setup();
    const out = await readTool.execute({ file_path: "  " }, ctx);
    expect(text(out)).toBe("file_path is empty. Give the path of the file to read.");
  });

  it("reports the resolved path for permission checks", async () => {
    const { dir, ctx } = await setup();
    expect(readTool.permission({ file_path: "src/a.ts" }, ctx)).toEqual({
      kind: "read",
      paths: [path.join(dir, "src/a.ts")],
    });
    expect(readTool.permission({ file_path: "~/notes.md" }, ctx)).toEqual({
      kind: "read",
      paths: [path.join(homedir(), "notes.md")],
    });
    expect(readTool.permission({ file_path: "/etc/../etc/hosts" }, ctx)).toEqual({
      kind: "read",
      paths: ["/etc/hosts"],
    });
  });

  it("has a schema that rejects unknown fields", () => {
    expect(readTool.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["file_path"],
    });
    expect(readTool.readOnly).toBe(true);
  });
});
