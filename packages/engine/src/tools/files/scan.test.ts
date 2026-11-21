import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutLine } from "./format.ts";
import { scanTextFile } from "./scan.ts";
import { countLines, displayLines, encodeText, REPLACEMENT_CHAR } from "./text.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-scan-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Text that puts CRLF pairs, multi-byte characters and long lines across chunk boundaries. */
function awkwardText(): string {
  const pieces = ["short", "ünïcödé ✓ 日本語 🎉", "x".repeat(9000), "", "tab\tline", "end"];
  const out: string[] = [];
  for (let i = 0; i < 4000; i++) {
    out.push(`${i}:${pieces[i % pieces.length]}${i % 3 === 0 ? "\r\n" : "\n"}`);
  }
  return out.join("");
}

async function fileWith(name: string, bytes: Uint8Array): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

const OPTIONS = { maxLineChars: 100, maxOutputChars: Number.MAX_SAFE_INTEGER, chunkBytes: 8000 };

describe("scanTextFile", () => {
  it("matches a whole-file decode for every range, in small chunks", async () => {
    const text = awkwardText();
    const bytes = encodeText(text, "utf8", false);
    const file = await fileWith("awkward.txt", bytes);
    const expected = displayLines(text).map((l) => cutLine(l, 100));
    for (const [start, count] of [
      [1, 10],
      [995, 20],
      [3990, 50],
      [1, 4000],
    ] as const) {
      const scan = await scanTextFile(file, { ...OPTIONS, startLine: start, maxLines: count });
      if (scan.kind !== "text") throw new Error("expected text");
      expect(scan.totalLines).toBe(countLines(text));
      expect(scan.lines).toEqual(expected.slice(start - 1, start - 1 + count));
      expect(scan.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(scan.invalid).toBe(false);
    }
  });

  it("handles UTF-16 in small chunks", async () => {
    const text = awkwardText().slice(0, 60_000);
    const file = await fileWith("wide.txt", encodeText(text, "utf16le", true));
    const scan = await scanTextFile(file, { ...OPTIONS, startLine: 1, maxLines: 10_000 });
    if (scan.kind !== "text") throw new Error("expected text");
    expect(scan.encoding).toBe("utf16le");
    expect(scan.lines).toEqual(displayLines(text).map((l) => cutLine(l, 100)));
    expect(scan.invalid).toBe(false);
  });

  it("counts lines without collecting any", async () => {
    const file = await fileWith("count.txt", Buffer.from("a\nb\nc"));
    const scan = await scanTextFile(file, { ...OPTIONS, startLine: 1, maxLines: 0 });
    expect(scan).toMatchObject({ kind: "text", totalLines: 3, lines: [] });
  });

  it("strips the CR of a CRLF split across two reads", async () => {
    const file = await fileWith("split.txt", Buffer.from(`${"a".repeat(7999)}\r\nb\r\n`));
    const scan = await scanTextFile(file, {
      ...OPTIONS,
      maxLineChars: 10_000,
      startLine: 1,
      maxLines: 5,
    });
    if (scan.kind !== "text") throw new Error("expected text");
    expect(scan.lines).toEqual(["a".repeat(7999), "b"]);
  });

  it("stops before the output limit but always returns one line", async () => {
    const file = await fileWith("limit.txt", Buffer.from("aaaa\nbbbb\ncccc\n"));
    // Each line costs its text, its number and two characters: 7 here.
    const scan = await scanTextFile(file, {
      ...OPTIONS,
      maxOutputChars: 14,
      startLine: 1,
      maxLines: 10,
    });
    expect(scan).toMatchObject({ lines: ["aaaa", "bbbb"], stoppedForSize: true });
    const tiny = await scanTextFile(file, {
      ...OPTIONS,
      maxOutputChars: 1,
      startLine: 1,
      maxLines: 10,
    });
    expect(tiny).toMatchObject({ lines: ["aaaa"], stoppedForSize: true });
  });

  it("reports binary content with its first bytes", async () => {
    const file = await fileWith("bin", Buffer.from([1, 0, 2]));
    expect(await scanTextFile(file, { ...OPTIONS, startLine: 1, maxLines: 1 })).toMatchObject({
      kind: "binary",
      size: 3,
    });
  });

  it("notices invalid UTF-8 split across reads", async () => {
    const file = await fileWith(
      "bad.txt",
      Buffer.concat([Buffer.alloc(7999, 0x61), Buffer.from([0xe9, 0x0a])]),
    );
    const scan = await scanTextFile(file, { ...OPTIONS, startLine: 1, maxLines: 1 });
    expect(scan).toMatchObject({ kind: "text", invalid: true });
  });

  it("does not mistake a real U+FFFD split across reads for invalid text", async () => {
    const bytes = Buffer.concat([
      Buffer.alloc(7999, 0x61),
      Buffer.from(`${REPLACEMENT_CHAR}\n`, "utf8"),
    ]);
    const file = await fileWith("ok.txt", bytes);
    const scan = await scanTextFile(file, { ...OPTIONS, startLine: 1, maxLines: 1 });
    expect(scan).toMatchObject({ kind: "text", invalid: false });
  });

  it("stops when aborted", async () => {
    const file = await fileWith("abort.txt", Buffer.from("a\n"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanTextFile(file, { ...OPTIONS, startLine: 1, maxLines: 1, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
