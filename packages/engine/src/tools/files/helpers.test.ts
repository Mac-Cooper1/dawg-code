import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDiffDisplay } from "./diff.ts";
import { cutLine, formatBytes, formatNumberedLines, listNumbers } from "./format.ts";
import { detectImage } from "./image.ts";
import { binaryKindFor, shellQuote, unsupportedKindFor } from "./kinds.ts";
import { stripLineNumberPrefixes, stripPrefixesWhereFound } from "./line-prefixes.ts";
import { resolveToolPath } from "./paths.ts";
import { editDistance, nameSimilarity } from "./suggest.ts";

describe("resolveToolPath", () => {
  const cwd = "/work/project";
  const home = "/home/someone";
  it.each([
    ["src/a.ts", "/work/project/src/a.ts"],
    ["./src/../lib/b.ts", "/work/project/lib/b.ts"],
    ["/abs/c.ts", "/abs/c.ts"],
    ["~", home],
    ["~/notes.md", "/home/someone/notes.md"],
    ["~user/x", "/work/project/~user/x"],
    ["  src/padded.ts \n", "/work/project/src/padded.ts"],
    ['"src/quoted.ts"', "/work/project/src/quoted.ts"],
    ["`src/ticked.ts`", "/work/project/src/ticked.ts"],
    ["file:///abs/url.ts", "/abs/url.ts"],
    ["", "/work/project"],
  ])("%j resolves to %s", (input, expected) => {
    expect(resolveToolPath(input, cwd, home)).toBe(expected);
  });
});

describe("format", () => {
  it("numbers lines, right-aligned", () => {
    expect(formatNumberedLines(["a", "b"], 9, 100).text).toBe(" 9→a\n10→b");
    expect(formatNumberedLines([], 1, 100).text).toBe("");
  });

  it("cuts long lines without splitting a surrogate pair", () => {
    expect(cutLine("abcdef", 3)).toBe("abc… [line cut: 6 characters in total]");
    expect(cutLine("ab🎉cd", 3)).toBe("ab… [line cut: 6 characters in total]");
    expect(cutLine("abc", 3)).toBe("abc");
  });

  it("formats sizes and lists", () => {
    expect(formatBytes(512)).toBe("512 bytes");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(256 * 1024)).toBe("256 KB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(listNumbers([1])).toBe("1");
    expect(listNumbers([1, 2, 3])).toBe("1, 2 and 3");
    expect(listNumbers([1, 2, 3, 4], 2)).toBe("1, 2 and 2 more");
  });
});

describe("line-number prefixes", () => {
  it("recognises Read's format and cat -n's", () => {
    expect(stripLineNumberPrefixes("  9→a\n 10→\tb\n")).toEqual({
      text: "a\n\tb\n",
      firstNumber: 9,
      separator: "→",
    });
    expect(stripLineNumberPrefixes("     4\tx\n     5\t\ty")).toMatchObject({
      text: "x\n\ty",
      firstNumber: 4,
      separator: "\t",
    });
    expect(stripLineNumberPrefixes("12→only")).toMatchObject({ text: "only" });
  });

  it("ignores numbers that do not count up, and single tab-separated lines", () => {
    expect(stripLineNumberPrefixes("1→a\n3→b")).toBeNull();
    expect(stripLineNumberPrefixes("1\tdata")).toBeNull();
    expect(stripLineNumberPrefixes("plain text")).toBeNull();
    expect(stripLineNumberPrefixes("")).toBeNull();
  });

  it("strips prefixes only where present", () => {
    expect(stripPrefixesWhereFound("1→a\nnew line\n2→b", "→")).toBe("a\nnew line\nb");
  });
});

describe("file suggestions", () => {
  it("measures edits with swaps counted once", () => {
    expect(editDistance("main", "mian")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });

  it("scores similar names", () => {
    expect(nameSimilarity("README.md", "readme.md")).toBe(100);
    expect(nameSimilarity("config.json", "config.yaml")).toBe(80);
    expect(nameSimilarity("utils.ts", "util.ts")).toBeGreaterThan(0);
    expect(nameSimilarity("index.ts", "server.go")).toBe(0);
  });
});

describe("file kinds", () => {
  it("knows binary and unsupported extensions", () => {
    expect(binaryKindFor("/a/b.ZIP")?.label).toBe("an archive");
    expect(binaryKindFor("/a/server.key")).toBeNull();
    expect(binaryKindFor("/a/b.ts")).toBeNull();
    expect(unsupportedKindFor("/a/b.pdf")).toBe("pdf");
    expect(unsupportedKindFor("/a/b.ipynb")).toBe("notebook");
  });

  it("quotes paths for shell commands only when needed", () => {
    expect(shellQuote("/a/b.txt")).toBe("/a/b.txt");
    expect(shellQuote("/a/my file's.txt")).toBe("'/a/my file'\\''s.txt'");
  });
});

describe("detectImage", () => {
  it("reads sizes from PNG, GIF, JPEG and WebP headers", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from("IHDR"),
      Buffer.from([0, 0, 1, 0, 0, 0, 0, 200]),
    ]);
    expect(detectImage(png)).toEqual({
      mediaType: "image/png",
      format: "PNG",
      width: 256,
      height: 200,
    });

    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 20, 0])]);
    expect(detectImage(gif)).toMatchObject({ mediaType: "image/gif", width: 10, height: 20 });

    // SOI, an APP0 segment of length 4, then SOF0 with height 30 and width 40.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0,
    ]);
    expect(detectImage(jpeg)).toMatchObject({ mediaType: "image/jpeg", width: 40, height: 30 });

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0);
    webp.write("WEBP", 8);
    webp.write("VP8X", 12);
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(detectImage(webp)).toMatchObject({ mediaType: "image/webp", width: 100, height: 50 });
  });

  it("returns null for other content", () => {
    expect(detectImage(Buffer.from("hello"))).toBeNull();
  });
});

describe("buildDiffDisplay", () => {
  it("shows a created file as all additions", () => {
    expect(buildDiffDisplay("/f", null, "a\nb\n")).toEqual({
      kind: "diff",
      filePath: "/f",
      created: true,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }],
      additions: 2,
      deletions: 0,
    });
  });

  it("ignores CRLF and leaves out no-newline markers", () => {
    const display = buildDiffDisplay(path.join("/", "f"), "a\r\nb", "a\r\nc");
    expect(display.hunks).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+c"] },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(buildDiffDisplay("/f", "same", "same")).toMatchObject({ hunks: [], additions: 0 });
  });
});
