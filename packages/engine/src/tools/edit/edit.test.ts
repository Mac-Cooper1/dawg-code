import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext, ToolOutput } from "../../contracts/index.ts";
import { createStateBag, createTestToolContext } from "../../testing/context.ts";
import { BOM, fileTracker } from "../files/index.ts";
import { readTool } from "../read/read.ts";
import { writeTool } from "../write/write.ts";
import { type EditInput, editTool } from "./edit.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const NBSP = String.fromCharCode(0xa0);

let base: ToolContext;
const dirs: string[] = [];

beforeAll(async () => {
  base = (await createTestToolContext({ cwd: tmpdir() })).ctx;
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dawg-edit-"));
  dirs.push(dir);
  return { dir, ctx: { ...base, cwd: dir, workingDirectories: [dir], state: createStateBag() } };
}

function text(out: ToolOutput, dir: string): string {
  return out.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n")
    .replaceAll(dir, "<dir>");
}

/** Writes a file and reads it with the Read tool, as a model would before editing. */
async function given(ctx: ToolContext, name: string, content: string | Buffer): Promise<string> {
  const file = path.join(ctx.cwd, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await readTool.execute({ file_path: name }, ctx);
  return file;
}

function edit(
  ctx: ToolContext,
  input: Partial<EditInput> & { old_string: string; new_string: string },
) {
  return editTool.execute({ file_path: "f.txt", ...input }, ctx);
}

describe("Edit: the read-before-edit rule", () => {
  it("refuses a file that was not read", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "f.txt"), "a\n");
    const out = await edit(ctx, { old_string: "a", new_string: "b" });
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"You have not read <dir>/f.txt in this session. Read it first (at least the part you want to change), then retry the edit."`,
    );
    expect(await readFile(path.join(dir, "f.txt"), "utf8")).toBe("a\n");
  });

  it("refuses a file changed on disk after it was read", async () => {
    const { dir, ctx } = await setup();
    const file = await given(ctx, "f.txt", "a\n");
    await writeFile(file, "a\nb\n");
    const out = await edit(ctx, { old_string: "a", new_string: "c" });
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/f.txt has changed on disk since you last read it. Read it again, then retry the edit against its current text."`,
    );
    expect(await readFile(file, "utf8")).toBe("a\nb\n");
  });

  it("accepts a partial read, and keeps the record partial", async () => {
    const { dir, ctx } = await setup();
    const file = await given(ctx, "f.txt", "");
    await writeFile(file, "1\n2\n3\n4\n");
    await readTool.execute({ file_path: "f.txt", offset: 3, limit: 1 }, ctx);
    const out = await edit(ctx, { old_string: "3", new_string: "three" });
    expect(out.isError).toBeFalsy();
    expect(fileTracker(ctx.state).get(file)).toMatchObject({ whole: false, via: "edit" });
    const write = await writeTool.execute({ file_path: "f.txt", content: "x" }, ctx);
    expect(write.isError).toBe(true);
    expect(text(write, dir)).toMatchInlineSnapshot(
      `"You have not seen all 4 lines of <dir>/f.txt as it is now; you only edited part of it. Writing would replace lines you have not seen. Read the whole file first, or use Edit to change part of it."`,
    );
  });

  it("counts a file it filled from empty as wholly known", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "f.txt"), "");
    await edit(ctx, { old_string: "", new_string: "one\ntwo\n" });
    const write = await writeTool.execute({ file_path: "f.txt", content: "three\n" }, ctx);
    expect(write.isError).toBeFalsy();
  });

  it("needs no new read for a second edit, or after a Write", async () => {
    const { dir, ctx } = await setup();
    const file = await given(ctx, "f.txt", "one\ntwo\n");
    expect((await edit(ctx, { old_string: "one", new_string: "1" })).isError).toBeFalsy();
    expect((await edit(ctx, { old_string: "two", new_string: "2" })).isError).toBeFalsy();
    expect(await readFile(file, "utf8")).toBe("1\n2\n");
    await writeTool.execute({ file_path: "g.txt", content: "fresh\n" }, ctx);
    const out = await editTool.execute(
      { file_path: "g.txt", old_string: "fresh", new_string: "edited" },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(await readFile(path.join(dir, "g.txt"), "utf8")).toBe("edited\n");
  });
});

describe("Edit: results", () => {
  it("applies an exact edit and returns a numbered snippet and a diff", async () => {
    const { dir, ctx } = await setup();
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const file = await given(ctx, "f.txt", `${lines.join("\n")}\n`);
    const out = await edit(ctx, { old_string: "line 6\n", new_string: "line six\nline six b\n" });
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "Edited <dir>/f.txt.

      Lines 3-10 after the edit:
       3→line 3
       4→line 4
       5→line 5
       6→line six
       7→line six b
       8→line 7
       9→line 8
      10→line 9"
    `);
    expect(out.touched).toEqual({ written: [file] });
    expect(out.display).toMatchObject({ kind: "diff", created: false, additions: 2, deletions: 1 });
  });

  it("notes the tolerance it needed, so the model can learn", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.js", "function f() {\n\tif (x) {  \n\t\treturn 1;\n\t}\n}\n");
    const out = await editTool.execute(
      {
        file_path: "f.js",
        old_string: "    if (x) {\n        return 1;\n    }",
        new_string: "    if (x) {\n        log(x);\n        return 2;\n    }",
      },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "Edited <dir>/f.js.

      Note: old_string did not match the file exactly; it matched after ignoring differences in indentation (the file uses tabs; old_string used 4 spaces per level) and whitespace at the ends of lines. The change was applied to the file's actual text, and new_string was adjusted to the file's style. Check the result below, and copy text exactly next time.

      Lines 1-6 after the edit:
      1→function f() {
      2→	if (x) {  
      3→		log(x);
      4→		return 2;
      5→	}
      6→}"
    `);
    expect(await readFile(path.join(dir, "f.js"), "utf8")).toBe(
      "function f() {\n\tif (x) {  \n\t\tlog(x);\n\t\treturn 2;\n\t}\n}\n",
    );
  });

  it("notes look-alike characters", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.md", "It’s “done”.\n");
    const out = await editTool.execute(
      { file_path: "f.md", old_string: `It's "done".`, new_string: `It's "finished".` },
      ctx,
    );
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "Edited <dir>/f.md.

      Note: old_string did not match the file exactly; it matched after ignoring look-alike characters (the file has ’ (U+2019), “ (U+201C), ” (U+201D) where old_string has plain ASCII). The change was applied to the file's actual text, and new_string was adjusted to the file's style. Check the result below, and copy text exactly next time.

      Line 1 after the edit:
      1→It’s “finished”."
    `);
    expect(await readFile(path.join(dir, "f.md"), "utf8")).toBe("It’s “finished”.\n");
  });

  it("notes line-number prefixes copied from Read", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "alpha\nbeta\n");
    const out = await edit(ctx, { old_string: "2→beta", new_string: "2→BETA" });
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "Edited <dir>/f.txt.

      Note: old_string included line-number prefixes copied from Read output (like "12→"). They were removed before matching; they are never part of the file.

      Lines 1-2 after the edit:
      1→alpha
      2→BETA"
    `);
    expect(await readFile(path.join(dir, "f.txt"), "utf8")).toBe("alpha\nBETA\n");
  });

  it("replaces every match with replace_all and lists where", async () => {
    const { dir, ctx } = await setup();
    const body = Array.from({ length: 60 }, (_, i) => (i % 12 === 0 ? "old()" : `keep ${i}`));
    body[1] = "old() old()";
    await given(ctx, "f.txt", `${body.join("\n")}\n`);
    const out = await edit(ctx, { old_string: "old()", new_string: "new()", replace_all: true });
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "Edited <dir>/f.txt: replaced 7 matches, now on lines 1, 2, 13, 25, 37 and 49.

      Lines 1-5 after the edit:
      1→new()
      2→new() new()
      3→keep 2
      4→keep 3
      5→keep 4

      Lines 10-16 after the edit:
      10→keep 9
      11→keep 10
      12→keep 11
      13→new()
      14→keep 13
      15→keep 14
      16→keep 15

      Lines 22-28 after the edit:
      22→keep 21
      23→keep 22
      24→keep 23
      25→new()
      26→keep 25
      27→keep 26
      28→keep 27

      (2 more changes not shown.)"
    `);
    expect((await readFile(path.join(dir, "f.txt"), "utf8")).includes("old()")).toBe(false);
  });

  it("refuses an ambiguous match and lists the lines", async () => {
    const { dir, ctx } = await setup();
    const file = await given(ctx, "f.txt", "x = 1\ny = 2\nx = 1\n");
    const out = await edit(ctx, { old_string: "x = 1", new_string: "x = 3" });
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"old_string matches 2 places in <dir>/f.txt, at lines 1 and 3. Nothing was changed. Add neighbouring lines to old_string so it matches only one place, or set replace_all to true to change all of them."`,
    );
    expect(await readFile(file, "utf8")).toBe("x = 1\ny = 2\nx = 1\n");
  });

  it("says when ambiguous matches were found by a tolerant step", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "\tgo();\n\t\tgo();\n");
    const out = await edit(ctx, { old_string: "  go();", new_string: "  stop();" });
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"old_string matches 2 places in <dir>/f.txt, at lines 1 and 2. Nothing was changed. Add neighbouring lines to old_string so it matches only one place, or set replace_all to true to change all of them. (These matches ignore indentation.)"`,
    );
  });

  it("shows the closest text and how it differs when nothing matches", async () => {
    const { dir, ctx } = await setup();
    await given(
      ctx,
      "f.js",
      'export const theme = {\n\tcolour:\t"#1e1e1e", \n\taccent: \t"#ff9900",\n};\n',
    );
    const out = await editTool.execute(
      {
        file_path: "f.js",
        old_string: 'export const theme = {\n  colour: "#1e1e1e",\n  accent: "#ff0000",\n};',
        new_string: "x",
      },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "No match: old_string was not found in <dir>/f.js. Nothing was changed.
      The most similar text is at lines 1-4. The lines that differ, as JSON strings so whitespace shows (- old_string, + file):
      - "  colour: \\"#1e1e1e\\","
      - "  accent: \\"#ff0000\\","
      + "\\tcolour:\\t\\"#1e1e1e\\", "  (line 2)
      + "\\taccent: \\t\\"#ff9900\\","  (line 3)
      Copy the text exactly as it is in the file (Read with offset 1 and limit 6 to see it again), then retry."
    `);
  });

  it("says when nothing in the file resembles old_string", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "alpha\nbeta\n");
    const out = await edit(ctx, { old_string: "completely different content", new_string: "x" });
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "No match: old_string was not found in <dir>/f.txt. Nothing was changed.
      Nothing in the file looks like old_string. Read the file again to see its current text, or use Grep to find where the text you want is."
    `);
  });

  it("says when new_string is already in the file", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "timeout = 2500\n");
    const out = await edit(ctx, { old_string: "timeout = 1500", new_string: "timeout = 2500" });
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "No match: old_string was not found in <dir>/f.txt. Nothing was changed.
      new_string already appears in the file at line 1, so this change may have been made already.
      The most similar text is at line 1. The lines that differ, as JSON strings so whitespace shows (- old_string, + file):
      - "timeout = 1500"
      + "timeout = 2500"  (line 1)
      Copy the text exactly as it is in the file (Read with offset 1 and limit 3 to see it again), then retry."
    `);
  });

  it("refuses an edit that would change nothing once fitted to the file", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "\tfoo  \n");
    const out = await edit(ctx, { old_string: "    foo", new_string: "\tfoo" });
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"Nothing was changed: once new_string was fitted to the file's whitespace and characters, it was the same as the text it would replace. Check that new_string contains the change you meant."`,
    );
  });
});

describe("Edit: input mistakes", () => {
  it("refuses identical old_string and new_string", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "a\n");
    const out = await edit(ctx, { old_string: "a", new_string: "a" });
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"old_string and new_string are identical, so the edit would change nothing. Put the replacement text in new_string."`,
    );
  });

  it("creates a missing file when old_string is empty", async () => {
    const { dir, ctx } = await setup();
    const out = await edit(ctx, {
      file_path: "new/file.txt",
      old_string: "",
      new_string: "hello\n",
    });
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toBe("Created <dir>/new/file.txt (1 line).");
    expect(await readFile(path.join(dir, "new/file.txt"), "utf8")).toBe("hello\n");
  });

  it("fills an existing empty file when old_string is empty", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "f.txt"), "");
    const out = await edit(ctx, { old_string: "", new_string: "content\n" });
    expect(out.isError).toBeFalsy();
    expect(await readFile(path.join(dir, "f.txt"), "utf8")).toBe("content\n");
  });

  it("refuses an empty old_string for a file with content", async () => {
    const { dir, ctx } = await setup();
    await given(ctx, "f.txt", "a\n");
    const out = await edit(ctx, { old_string: "", new_string: "b" });
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"old_string is empty, but <dir>/f.txt is not. To insert text, put the line next to where it goes in old_string, and that line plus your new text in new_string. To replace the whole file, use Write."`,
    );
  });

  it("refuses a missing file and points at Write", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "main.py"), "x");
    const out = await edit(ctx, { file_path: "mian.py", old_string: "x", new_string: "y" });
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "File does not exist: <dir>/mian.py
      Did you mean <dir>/main.py?
      To create a new file, use Write."
    `);
  });

  it("refuses a directory", async () => {
    const { dir, ctx } = await setup();
    await mkdir(path.join(dir, "src"));
    const out = await edit(ctx, { file_path: "src", old_string: "x", new_string: "y" });
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/src is a directory, not a file. Edit works on files only. It is empty."`,
    );
  });

  it("refuses binary files and files that are not UTF-8", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const bin = await edit(ctx, { file_path: "bin", old_string: "x", new_string: "y" });
    const latin = await edit(ctx, { file_path: "latin1.txt", old_string: "caf", new_string: "x" });
    expect(text(bin, dir)).toMatchInlineSnapshot(
      `"<dir>/bin is a binary file, so Edit cannot change it."`,
    );
    expect(text(latin, dir)).toMatchInlineSnapshot(
      `"<dir>/latin1.txt is not valid UTF-8 text (it may use a legacy encoding such as Latin-1, Windows-1252 or Shift-JIS). Edit would damage the bytes it cannot decode, so nothing was changed. Make the change with a shell command that keeps the encoding, such as sed, or ask the user whether to convert the file to UTF-8."`,
    );
    expect(await readFile(path.join(dir, "latin1.txt"))).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    );
  });

  it("refuses a file too large to edit", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "huge.log"), "");
    await truncate(path.join(dir, "huge.log"), 65 * 1024 * 1024);
    const out = await edit(ctx, { file_path: "huge.log", old_string: "x", new_string: "y" });
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/huge.log is too large for Edit (65 MB; the limit is 64 MB). Use a shell command such as sed to change it."`,
    );
  });

  it("refuses an empty path", async () => {
    const { dir, ctx } = await setup();
    const out = await edit(ctx, { file_path: "", old_string: "x", new_string: "y" });
    expect(text(out, dir)).toBe("file_path is empty. Give the path of the file to edit.");
  });
});

describe("Edit: what is preserved", () => {
  it("keeps CRLF line endings, the BOM and the final-newline state", async () => {
    const { ctx } = await setup();
    const file = await given(ctx, "f.txt", Buffer.from(`${BOM}one\r\ntwo\r\nthree`, "utf8"));
    const out = await edit(ctx, { old_string: "two\nthree", new_string: "2\n3\n4" });
    expect(out.isError).toBeFalsy();
    expect(await readFile(file)).toEqual(Buffer.from(`${BOM}one\r\n2\r\n3\r\n4`, "utf8"));
  });

  it("keeps the file mode", async () => {
    const { ctx } = await setup();
    const file = await given(ctx, "run.sh", "#!/bin/sh\necho a\n");
    await chmod(file, 0o755);
    await readTool.execute({ file_path: "run.sh" }, ctx);
    await editTool.execute(
      { file_path: "run.sh", old_string: "echo a", new_string: "echo b" },
      ctx,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    expect(await readFile(file, "utf8")).toBe("#!/bin/sh\necho b\n");
  });

  it("keeps UTF-16 encoding", async () => {
    const { ctx } = await setup();
    const file = await given(
      ctx,
      "wide.txt",
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("a\nb\n", "utf16le").swap16()]),
    );
    const out = await editTool.execute(
      { file_path: "wide.txt", old_string: "b", new_string: "β" },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(await readFile(file)).toEqual(
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("a\nβ\n", "utf16le").swap16()]),
    );
  });

  it("leaves bytes outside the change untouched in a messy file", async () => {
    const { ctx } = await setup();
    const messy = `a  \r\n\tb\t\r\nc\n${NBSP}d\r\n\r\ne`;
    const file = await given(ctx, "f.txt", messy);
    await edit(ctx, { old_string: "c", new_string: "C" });
    expect(await readFile(file, "utf8")).toBe(`a  \r\n\tb\t\r\nC\n${NBSP}d\r\n\r\ne`);
  });
});

describe("Edit: eval fixture", () => {
  it("fixes the card deep in a long file from a partial read, with a sloppy old_string", async () => {
    const { dir, ctx } = await setup();
    const task = path.join(REPO, "evals/tasks/change-deep-in-long-file");
    const file = path.join(dir, "cards.py");
    await copyFile(path.join(task, "fixture/cardgame/cards.py"), file);
    const read = await readTool.execute({ file_path: "cards.py", offset: 2590, limit: 12 }, ctx);
    expect(text(read, dir)).toContain("2597→        state.heal(player, taken)");
    const out = await editTool.execute(
      {
        file_path: "cards.py",
        old_string:
          "for opponent in state.opponents(player):\n  taken = state.damage(opponent, self.drain)\nstate.heal(player, taken)",
        new_string:
          "total = 0\nfor opponent in state.opponents(player):\n  total += state.damage(opponent, self.drain)\nstate.heal(player, total)",
      },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toMatchInlineSnapshot(`
      "Edited <dir>/cards.py.

      Note: old_string did not match the file exactly; it matched after ignoring differences in indentation (the file uses 4 spaces per level; old_string used 2 spaces per level). The change was applied to the file's actual text, and new_string was adjusted to the file's style. Check the result below, and copy text exactly next time.

      Lines 2592-2601 after the edit:
      2592→    drain = 2
      2593→
      2594→    def apply(self, state, player, target=None):
      2595→        total = 0
      2596→        for opponent in state.opponents(player):
      2597→            total += state.damage(opponent, self.drain)
      2598→        state.heal(player, total)
      2599→
      2600→
      2601→@register"
    `);
    expect(await readFile(file, "utf8")).toBe(
      await readFile(path.join(task, "solution/cardgame/cards.py"), "utf8"),
    );
  });
});
