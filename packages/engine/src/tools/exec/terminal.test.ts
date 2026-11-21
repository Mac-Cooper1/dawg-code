import { describe, expect, it } from "vitest";
import { collapseCarriageReturns, EscapeStripper, stripTerminalEscapes } from "./terminal.ts";

describe("stripTerminalEscapes", () => {
  it.each([
    ["colours", "\x1b[1;31mred\x1b[0m plain", "red plain"],
    ["cursor movement and line clearing", "\x1b[2K\x1b[1Gdone\x1b[?25h", "done"],
    ["an OSC title ended by BEL", "\x1b]0;my title\x07after", "after"],
    ["an OSC title ended by ST", "\x1b]2;title\x1b\\after", "after"],
    ["a hyperlink", "\x1b]8;;https://example.test\x07link\x1b]8;;\x07", "link"],
    ["character set selection", "\x1b(Bplain\x1b)0", "plain"],
    ["keypad modes", "\x1b=\x1b>text", "text"],
    ["an 8-bit CSI", "\u009b31mred\u009b0m", "red"],
    ["a DCS string", "\x1bPq#0;2;0;0;0\x1b\\text", "text"],
    ["bell and backspace", "a\x07b\x08c", "abc"],
  ])("removes %s", (_name, input, expected) => {
    expect(stripTerminalEscapes(input)).toBe(expected);
  });

  it("keeps text, tabs, newlines, carriage returns and non-ASCII characters", () => {
    const text = "héllo\tworld ✓ 日本語\r\nnext 🙂\n";
    expect(stripTerminalEscapes(text)).toBe(text);
  });

  it("handles a sequence split across chunks", () => {
    const stripper = new EscapeStripper();
    const parts = ["before \x1b", "[3", "1mred\x1b]0;ti", "tle\x07 after"];
    expect(parts.map((p) => stripper.push(p)).join("")).toBe("before red after");
  });

  it("treats a malformed sequence's next character as text", () => {
    expect(stripTerminalEscapes("a\x1b[\nb")).toBe("a\nb");
    expect(stripTerminalEscapes("a\x1b\nb")).toBe("a\nb");
  });

  it("drops a sequence cut off at the end of the stream", () => {
    const stripper = new EscapeStripper();
    expect(stripper.push("text\x1b[3")).toBe("text");
    expect(stripper.flush()).toBe("");
    expect(stripper.push("1m")).toBe("1m");
  });
});

describe("collapseCarriageReturns", () => {
  it("keeps what a terminal would show after progress updates", () => {
    expect(collapseCarriageReturns("10%\r50%\r100%\ndone\n")).toBe("100%\ndone\n");
  });

  it("turns CRLF line endings into LF", () => {
    expect(collapseCarriageReturns("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("leaves text without carriage returns alone", () => {
    expect(collapseCarriageReturns("plain\ntext")).toBe("plain\ntext");
  });
});
