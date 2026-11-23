import { describe, expect, it } from "vitest";
import {
  applyCarriageReturns,
  applySgr,
  color256,
  nearestColor,
  PLAIN_STYLE,
  parseAnsi,
  stripAnsi,
} from "./ansi.ts";

describe("parseAnsi", () => {
  it("returns plain text unchanged as one segment", () => {
    expect(parseAnsi("8 passed in 0.19s")).toEqual([
      { text: "8 passed in 0.19s", style: PLAIN_STYLE },
    ]);
  });

  it("splits coloured runs and resets", () => {
    const segments = parseAnsi("ok \u001b[31mFAILED\u001b[0m done");
    expect(segments.map((s) => [s.text, s.style.fg])).toEqual([
      ["ok ", null],
      ["FAILED", "red"],
      [" done", null],
    ]);
  });

  it("handles bold, dim, italic, underline and their resets", () => {
    const segments = parseAnsi("\u001b[1;3;4mA\u001b[22mB\u001b[2mC\u001b[23;24mD");
    expect(segments.map((s) => ({ text: s.text, ...s.style }))).toEqual([
      { text: "A", fg: null, bg: null, bold: true, dim: false, italic: true, underline: true },
      { text: "B", fg: null, bg: null, bold: false, dim: false, italic: true, underline: true },
      { text: "C", fg: null, bg: null, bold: false, dim: true, italic: true, underline: true },
      { text: "D", fg: null, bg: null, bold: false, dim: true, italic: false, underline: false },
    ]);
  });

  it("maps the 16 basic colours, backgrounds and the default resets", () => {
    const s = parseAnsi("\u001b[32;41mx\u001b[92my\u001b[90mz\u001b[39;49mw");
    expect(s.map((x) => [x.text, x.style.fg, x.style.bg])).toEqual([
      // Bright green is still the theme's green, so the runs merge.
      ["xy", "green", "red"],
      ["z", "gray", "red"],
      ["w", null, null],
    ]);
  });

  it("approximates 256-colour and true-colour codes", () => {
    const s = parseAnsi("\u001b[38;5;196mred\u001b[38;2;40;120;255mblue\u001b[48;5;22mbg");
    expect(s.map((x) => [x.text, x.style.fg, x.style.bg])).toEqual([
      ["red", "red", null],
      ["blue", "blue", null],
      ["bg", "blue", "green"],
    ]);
  });

  it("ignores malformed and unknown codes safely", () => {
    expect(parseAnsi("\u001b[38;5mA").map((x) => x.text)).toEqual(["A"]);
    expect(parseAnsi("\u001b[38;9;1;31mB")[0]?.style.fg).toBeNull();
    expect(parseAnsi("\u001b[999mC")[0]?.style).toEqual(PLAIN_STYLE);
    expect(parseAnsi("\u001b[?25lD\u001b[?25h")).toEqual([{ text: "D", style: PLAIN_STYLE }]);
  });

  it("removes other escape sequences and control characters but keeps the text", () => {
    const text =
      "\u001b]0;title\u0007\u001b[2K\u001b[1Gline\u001b]8;;https://x.dev\u001b\\link\u001b]8;;\u001b\\\u0007\b";
    expect(stripAnsi(text)).toBe("linelink");
  });

  it("never interprets output as markup", () => {
    expect(stripAnsi("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });

  it("applies carriage returns like a terminal", () => {
    expect(applyCarriageReturns("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
    expect(stripAnsi("a\rb")).toBe("b");
  });
});

describe("colours", () => {
  it("maps RGB to the nearest named colour", () => {
    expect(nearestColor(255, 0, 0)).toBe("red");
    expect(nearestColor(0, 200, 0)).toBe("green");
    expect(nearestColor(250, 200, 0)).toBe("yellow");
    expect(nearestColor(0, 200, 220)).toBe("cyan");
    expect(nearestColor(200, 0, 200)).toBe("magenta");
    expect(nearestColor(128, 128, 128)).toBe("gray");
    expect(nearestColor(10, 10, 10)).toBe("black");
    expect(nearestColor(250, 250, 250)).toBe("white");
  });

  it("covers the whole 256-colour palette", () => {
    expect(color256(1)).toBe("red");
    expect(color256(9)).toBe("red");
    expect(color256(8)).toBe("gray");
    expect(color256(21)).toBe("blue");
    expect(color256(232)).toBe("black");
    expect(color256(255)).toBe("white");
  });

  it("starts over on an empty SGR", () => {
    expect(applySgr({ ...PLAIN_STYLE, bold: true, fg: "red" }, [])).toEqual(PLAIN_STYLE);
  });
});
