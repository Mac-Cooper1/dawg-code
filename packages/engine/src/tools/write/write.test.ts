import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext, ToolOutput } from "../../contracts/index.ts";
import { createStateBag, createTestToolContext } from "../../testing/context.ts";
import { atomicWriteFile, BOM, fileTracker, REPLACEMENT_CHAR } from "../files/index.ts";
import { readTool } from "../read/read.ts";
import { writeTool } from "./write.ts";

let base: ToolContext;
const dirs: string[] = [];

beforeAll(async () => {
  base = (await createTestToolContext({ cwd: tmpdir() })).ctx;
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dawg-write-"));
  dirs.push(dir);
  return { dir, ctx: { ...base, cwd: dir, workingDirectories: [dir], state: createStateBag() } };
}

function text(out: ToolOutput, dir: string): string {
  return out.content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n")
    .replaceAll(dir, "<dir>");
}

describe("Write", () => {
  it("creates a file and its missing parent directories", async () => {
    const { dir, ctx } = await setup();
    const out = await writeTool.execute({ file_path: "a/b/new.txt", content: "one\ntwo\n" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toBe("Created <dir>/a/b/new.txt (2 lines).");
    expect(await readFile(path.join(dir, "a/b/new.txt"), "utf8")).toBe("one\ntwo\n");
    expect(out.touched).toEqual({ written: [path.join(dir, "a/b/new.txt")] });
    expect(out.display).toMatchObject({
      kind: "diff",
      filePath: path.join(dir, "a/b/new.txt"),
      created: true,
      additions: 2,
      deletions: 0,
    });
    expect(fileTracker(ctx.state).get(path.join(dir, "a/b/new.txt"))).toMatchObject({
      whole: true,
      via: "write",
    });
  });

  it("creates an empty file", async () => {
    const { dir, ctx } = await setup();
    const out = await writeTool.execute({ file_path: "empty", content: "" }, ctx);
    expect(text(out, dir)).toBe("Created <dir>/empty (0 lines).");
    expect(await readFile(path.join(dir, "empty"), "utf8")).toBe("");
  });

  it("refuses to overwrite a file that was not read", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "original\n");
    const out = await writeTool.execute({ file_path: "a.txt", content: "new\n" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/a.txt already exists, and you have not read it in this session. Read it first, so you do not throw away content you have not seen, then write it again. To change only part of it, use Edit."`,
    );
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("original\n");
  });

  it("overwrites a file after reading it, and shows the diff", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
    await readTool.execute({ file_path: "a.txt" }, ctx);
    const out = await writeTool.execute({ file_path: "a.txt", content: "one\nTWO\nthree\n" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toBe("Wrote <dir>/a.txt (3 lines), replacing its previous contents.");
    expect(out.display).toEqual({
      kind: "diff",
      filePath: path.join(dir, "a.txt"),
      created: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [" one", "-two", "+TWO", "+three"],
        },
      ],
      additions: 2,
      deletions: 1,
    });
  });

  it("refuses when the file changed after it was read", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await readTool.execute({ file_path: "a.txt" }, ctx);
    await writeFile(path.join(dir, "a.txt"), "changed by someone else\n");
    const out = await writeTool.execute({ file_path: "a.txt", content: "mine\n" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"<dir>/a.txt has changed on disk since you last read it. Read it again, then write your new version based on its current contents."`,
    );
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("changed by someone else\n");
  });

  it("accepts a file touched but not changed after it was read", async () => {
    const { dir, ctx } = await setup();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "same\n");
    await readTool.execute({ file_path: "a.txt" }, ctx);
    await writeFile(file, "same\n");
    const out = await writeTool.execute({ file_path: "a.txt", content: "new\n" }, ctx);
    expect(out.isError).toBeFalsy();
  });

  it("refuses when only part of the file was read", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "1\n2\n3\n4\n5\n");
    await readTool.execute({ file_path: "a.txt", offset: 1, limit: 2 }, ctx);
    const out = await writeTool.execute({ file_path: "a.txt", content: "x\n" }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"You have read only lines 1-2 of <dir>/a.txt, which has 5 lines. Writing would replace lines you have not seen. Read the rest of the file first, or use Edit to change part of it."`,
    );
    await readTool.execute({ file_path: "a.txt", offset: 3 }, ctx);
    const again = await writeTool.execute({ file_path: "a.txt", content: "x\n" }, ctx);
    expect(again.isError).toBeFalsy();
  });

  it("needs no new read after its own write", async () => {
    const { dir, ctx } = await setup();
    await writeTool.execute({ file_path: "a.txt", content: "v1\n" }, ctx);
    const out = await writeTool.execute({ file_path: "a.txt", content: "v2\n" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("v2\n");
  });

  it("keeps the file's mode, CRLF line endings and byte order mark", async () => {
    const { dir, ctx } = await setup();
    const file = path.join(dir, "run.sh");
    await writeFile(file, Buffer.from(`${BOM}echo a\r\necho b\r\n`, "utf8"));
    await chmod(file, 0o751);
    await readTool.execute({ file_path: "run.sh" }, ctx);
    const out = await writeTool.execute({ file_path: "run.sh", content: "echo a\necho c\n" }, ctx);
    expect(text(out, dir)).toBe(
      "Wrote <dir>/run.sh (2 lines), replacing its previous contents. Kept the file's CRLF line endings and byte order mark.",
    );
    expect(await readFile(file)).toEqual(Buffer.from(`${BOM}echo a\r\necho c\r\n`, "utf8"));
    expect((await stat(file)).mode & 0o777).toBe(0o751);
  });

  it("keeps UTF-16 encoding", async () => {
    const { dir, ctx } = await setup();
    const file = path.join(dir, "wide.txt");
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("old\n", "utf16le")]),
    );
    await readTool.execute({ file_path: "wide.txt" }, ctx);
    await writeTool.execute({ file_path: "wide.txt", content: "new é\n" }, ctx);
    expect(await readFile(file)).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("new é\n", "utf16le")]),
    );
  });

  it("reports no change for identical content", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "a.txt"), "same\n");
    await readTool.execute({ file_path: "a.txt" }, ctx);
    const out = await writeTool.execute({ file_path: "a.txt", content: "same\n" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(text(out, dir)).toBe("No change: <dir>/a.txt already has exactly this content.");
    expect(out.touched).toBeUndefined();
  });

  it("refuses content carrying Read's line-number prefixes", async () => {
    const { dir, ctx } = await setup();
    const out = await writeTool.execute(
      { file_path: "a.py", content: "1→import os\n2→print(os)\n" },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"Nothing was written: every line of content starts with a line number and "→", copied from Read output. Those prefixes are not part of the file. Remove them and write again."`,
    );
  });

  it("refuses to write U+FFFD over a file that is not valid UTF-8", async () => {
    const { dir, ctx } = await setup();
    const file = path.join(dir, "latin1.txt");
    await writeFile(file, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await readTool.execute({ file_path: "latin1.txt" }, ctx);
    const out = await writeTool.execute(
      { file_path: "latin1.txt", content: `caf${REPLACEMENT_CHAR}!\n` },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"Nothing was written: content contains the character � (U+FFFD), which Read shows in place of bytes it could not decode. <dir>/latin1.txt is not valid UTF-8, so writing this would destroy those bytes for good. Change the file with a shell command that keeps its encoding instead."`,
    );
    const ok = await writeTool.execute({ file_path: "latin1.txt", content: "café\n" }, ctx);
    expect(ok.isError).toBeFalsy();
    expect(await readFile(file, "utf8")).toBe("café\n");
  });

  it("writes through a symbolic link and keeps the link", async () => {
    const { dir, ctx } = await setup();
    await writeFile(path.join(dir, "target.txt"), "old\n");
    await symlink("target.txt", path.join(dir, "link.txt"));
    await readTool.execute({ file_path: "link.txt" }, ctx);
    const out = await writeTool.execute({ file_path: "link.txt", content: "new\n" }, ctx);
    expect(out.isError).toBeFalsy();
    expect((await lstat(path.join(dir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(dir, "target.txt"), "utf8")).toBe("new\n");
  });

  it("refuses a directory, and a path through a file", async () => {
    const { dir, ctx } = await setup();
    await mkdir(path.join(dir, "folder"));
    await writeFile(path.join(dir, "plain"), "x");
    const folder = await writeTool.execute({ file_path: "folder", content: "x" }, ctx);
    const through = await writeTool.execute({ file_path: "plain/child.txt", content: "x" }, ctx);
    expect(folder.isError).toBe(true);
    expect(through.isError).toBe(true);
    expect(text(folder, dir)).toMatchInlineSnapshot(
      `"<dir>/folder is a directory. Give the path of a file to write."`,
    );
    expect(text(through, dir)).toMatchInlineSnapshot(
      `"Cannot create <dir>/plain/child.txt: part of its directory path is a file, not a directory."`,
    );
  });

  it.skipIf(process.getuid?.() === 0)("reports a permission error clearly", async () => {
    const { dir, ctx } = await setup();
    await mkdir(path.join(dir, "locked"));
    await chmod(path.join(dir, "locked"), 0o555);
    const out = await writeTool.execute({ file_path: "locked/a.txt", content: "x" }, ctx);
    await chmod(path.join(dir, "locked"), 0o755);
    expect(out.isError).toBe(true);
    expect(text(out, dir)).toMatchInlineSnapshot(
      `"Permission denied: cannot write <dir>/locked/a.txt."`,
    );
  });

  it("reports the resolved path as an edit for permission checks", async () => {
    const { dir, ctx } = await setup();
    expect(writeTool.permission({ file_path: "out/x.txt", content: "" }, ctx)).toEqual({
      kind: "edit",
      paths: [path.join(dir, "out/x.txt")],
    });
  });
});

describe("atomic writes", () => {
  it("leave the original intact and no temporary file when the write fails", async () => {
    const { dir } = await setup();
    const file = path.join(dir, "a.txt");
    await writeFile(file, "original\n");
    await expect(
      atomicWriteFile(file, Buffer.from("replacement\n"), {
        beforeRename: () => {
          throw new Error("disk went away");
        },
      }),
    ).rejects.toThrow("disk went away");
    expect(await readFile(file, "utf8")).toBe("original\n");
    expect(await readdir(dir)).toEqual(["a.txt"]);
  });

  it("set the mode exactly, regardless of the umask", async () => {
    const { dir } = await setup();
    const file = path.join(dir, "secret");
    await atomicWriteFile(file, Buffer.from("x"), { mode: 0o600 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await atomicWriteFile(file, Buffer.from("y"), { mode: 0o777 });
    expect((await stat(file)).mode & 0o777).toBe(0o777);
  });

  it("create the target of a dangling symbolic link", async () => {
    const { dir } = await setup();
    await symlink("made-later.txt", path.join(dir, "link"));
    await atomicWriteFile(path.join(dir, "link"), Buffer.from("hello"));
    expect(await readFile(path.join(dir, "made-later.txt"), "utf8")).toBe("hello");
    expect((await lstat(path.join(dir, "link"))).isSymbolicLink()).toBe(true);
  });
});
