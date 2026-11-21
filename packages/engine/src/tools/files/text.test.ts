import { describe, expect, it } from "vitest";
import {
  applyLineEnding,
  countLines,
  decodeText,
  displayLines,
  encodeText,
  lineEndingStats,
  REPLACEMENT_CHAR,
  splitLines,
} from "./text.ts";

describe("decodeText and encodeText", () => {
  const samples = ["", "plain\n", "ünïcödé 日本 🎉\r\n", "no newline"];
  const encodings = [
    ["utf8", false],
    ["utf8", true],
    ["utf16le", true],
    ["utf16be", true],
  ] as const;

  for (const [encoding, bom] of encodings) {
    it(`round-trips ${encoding}${bom ? " with a BOM" : ""}`, () => {
      for (const sample of samples) {
        const bytes = encodeText(sample, encoding, bom);
        const decoded = decodeText(bytes);
        expect(decoded).toEqual({ kind: "text", text: sample, encoding, bom, invalid: false });
        expect(Buffer.from(encodeText(sample, encoding, bom))).toEqual(Buffer.from(bytes));
      }
    });
  }

  it("treats NUL bytes as binary", () => {
    expect(decodeText(Buffer.from([0x41, 0x00, 0x42]))).toEqual({ kind: "binary" });
  });

  it("only looks for NUL bytes near the start", () => {
    const bytes = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    expect(decodeText(bytes).kind).toBe("text");
  });

  it("flags invalid UTF-8 but not a real U+FFFD", () => {
    expect(decodeText(Buffer.from([0x63, 0xe9]))).toMatchObject({ kind: "text", invalid: true });
    expect(decodeText(Buffer.from(`a${REPLACEMENT_CHAR}b`, "utf8"))).toMatchObject({
      invalid: false,
    });
  });

  it("flags a UTF-16 file with an odd number of bytes", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("ab", "utf16le"),
      Buffer.from([0x41]),
    ]);
    expect(decodeText(bytes)).toMatchObject({ encoding: "utf16le", invalid: true });
  });
});

describe("lines", () => {
  it("splits on LF and CRLF, keeping a lone CR as content", () => {
    expect(splitLines("a\r\nb\nc\rd")).toEqual({
      lines: ["a", "b", "c\rd"],
      terminators: ["\r\n", "\n", ""],
      offsets: [0, 3, 5],
    });
    expect(splitLines("x\n").lines).toEqual(["x", ""]);
    expect(splitLines("").lines).toEqual([""]);
  });

  it("counts lines as an editor does", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\n\n")).toBe(2);
    expect(countLines("\n")).toBe(1);
    expect(countLines("a\r\nb")).toBe(2);
    expect(displayLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(displayLines("")).toEqual([]);
  });

  it("finds the dominant line ending", () => {
    expect(lineEndingStats("a\r\nb\r\nc\n")).toEqual({ lf: 1, crlf: 2, dominant: "\r\n" });
    expect(lineEndingStats("a\nb\r\n")).toEqual({ lf: 1, crlf: 1, dominant: "\n" });
    expect(lineEndingStats("none")).toEqual({ lf: 0, crlf: 0, dominant: "\n" });
  });

  it("converts bare LF to CRLF without doubling existing CRLF", () => {
    expect(applyLineEnding("a\nb\r\nc\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
    expect(applyLineEnding("a\nb", "\n")).toBe("a\nb");
  });
});
