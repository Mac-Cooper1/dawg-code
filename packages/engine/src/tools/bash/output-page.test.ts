import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOutputPage } from "./background.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-page-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(content: string): Promise<string> {
  const p = path.join(root, "out.txt");
  await writeFile(p, content);
  return p;
}

/** Reads the whole file page by page, as a client does. */
async function pages(p: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await readOutputPage(p, offset, limit);
    if (page.nextOffset === offset) return out;
    out.push(page.text);
    offset = page.nextOffset;
  }
}

describe("readOutputPage", () => {
  it("reads pages from an offset and says where the next one starts", async () => {
    const p = await file("line one\nline two\n");
    expect(await readOutputPage(p, 0, 9)).toEqual({
      text: "line one\n",
      nextOffset: 9,
      totalBytes: 18,
    });
    expect(await readOutputPage(p, 9, 100)).toEqual({
      text: "line two\n",
      nextOffset: 18,
      totalBytes: 18,
    });
    // At the end, and past it: nothing more.
    expect(await readOutputPage(p, 18, 100)).toEqual({ text: "", nextOffset: 18, totalBytes: 18 });
    expect(await readOutputPage(p, 50, 100)).toEqual({ text: "", nextOffset: 18, totalBytes: 18 });
  });

  it("never splits a character across a page edge", async () => {
    // "é" is two bytes and "🐶" four: limit 4 ends inside each of them in turn.
    const content = "abé🐶cd🐶";
    const p = await file(content);
    const first = await readOutputPage(p, 0, 4);
    expect(first).toEqual({ text: "abé", nextOffset: 4, totalBytes: Buffer.byteLength(content) });
    const second = await readOutputPage(p, first.nextOffset, 5);
    expect(second.text).toBe("🐶c");
    const all = await pages(p, 3);
    expect(all.join("")).toBe(content);
    for (const page of all) expect(page).not.toContain("�");
  });

  it("returns a whole character even when the limit is smaller", async () => {
    const p = await file("🐶🐶");
    expect(await readOutputPage(p, 0, 1)).toEqual({ text: "🐶", nextOffset: 4, totalBytes: 8 });
    expect(await pages(p, 2)).toEqual(["🐶", "🐶"]);
  });

  it("moves an offset inside a character on to the next one", async () => {
    const p = await file("é!");
    expect(await readOutputPage(p, 1, 10)).toEqual({ text: "!", nextOffset: 3, totalBytes: 3 });
  });

  it("waits for a character that is only partly written", async () => {
    const p = path.join(root, "partial.txt");
    await writeFile(p, Buffer.from([0x61, 0xf0, 0x9f]));
    expect(await readOutputPage(p, 0, 10)).toEqual({ text: "a", nextOffset: 1, totalBytes: 3 });
    expect(await readOutputPage(p, 1, 10)).toEqual({ text: "", nextOffset: 1, totalBytes: 3 });
  });

  it("reads a missing file as empty", async () => {
    expect(await readOutputPage(path.join(root, "gone.txt"), 0, 10)).toEqual({
      text: "",
      nextOffset: 0,
      totalBytes: 0,
    });
  });
});
