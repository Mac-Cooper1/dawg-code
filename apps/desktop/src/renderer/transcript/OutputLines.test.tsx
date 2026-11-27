/**
 * Tool output VoiceOver can move through: each block is a group named for what it is, with one
 * element per line, and the text stays exactly the text (blank lines and newlines included).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { PLAIN_STYLE } from "./ansi.ts";
import { lineSegments, OutputLines } from "./OutputLines.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { bashFailure, editItem, grepItem, makeEnv, readItem } from "./testing.ts";

/** The line elements of a group, in order. */
function lines(group: HTMLElement): string[] {
  return Array.from(group.children).map((line) => line.textContent ?? "");
}

describe("lineSegments", () => {
  it("splits at newlines, keeps blank lines and drops the empty line after a final newline", () => {
    const plain = (text: string) =>
      lineSegments([{ text, style: PLAIN_STYLE }]).map((line) => line.map((s) => s.text).join(""));
    expect(plain("a\n\nb\nc")).toEqual(["a", "", "b", "c"]);
    expect(plain("a\nb\n")).toEqual(["a", "b"]);
    expect(plain("")).toEqual([""]);
  });

  it("keeps each segment's style on both sides of a newline", () => {
    const red = { ...PLAIN_STYLE, fg: "red" as const };
    const split = lineSegments([
      { text: "one ", style: PLAIN_STYLE },
      { text: "two\nthree", style: red },
    ]);
    expect(split).toEqual([
      [
        { text: "one ", style: PLAIN_STYLE },
        { text: "two", style: red },
      ],
      [{ text: "three", style: red }],
    ]);
  });
});

describe("OutputLines", () => {
  it("is a named group with one element per line and the exact text", () => {
    const text = "first\n\nthird <b>not html</b>\n";
    render(<OutputLines text={text} label="Output" />);
    const group = screen.getByRole("group", { name: "Output, 3 lines" });
    expect(group.textContent).toBe(text);
    expect(lines(group)).toEqual(["first\n", "\n", "third <b>not html</b>\n"]);
    expect(group.querySelector("b")).toBeNull();
    expect(group).not.toHaveAttribute("tabindex");
  });

  it("can be reached with the keyboard when it scrolls", () => {
    render(<OutputLines text="one line" label="Results" focusable />);
    expect(screen.getByRole("group", { name: "Results, 1 line" })).toHaveAttribute("tabindex", "0");
  });
});

describe.each(THEMES)("tool output for VoiceOver (%s)", (theme) => {
  it("gives a command's output a group of lines, colours kept", () => {
    renderInTheme(<ToolCard item={bashFailure()} open env={makeEnv()} />, theme);
    const group = screen.getByRole("group", { name: "Output, 2 lines" });
    expect(lines(group)).toEqual(["===== FAILURES =====\n", "E       AssertionError"]);
    expect(group.querySelector('[class*="fgRed"]')?.textContent).toContain("AssertionError");
  });

  it("names the lines of a file it read", () => {
    renderInTheme(<ToolCard item={readItem()} open env={makeEnv()} />, theme);
    const group = screen.getByRole("group", { name: "Lines 1–15" });
    expect(group.children).toHaveLength(15);
  });

  it("gives search results and an edit's diff groups of their own", () => {
    const { unmount } = renderInTheme(<ToolCard item={grepItem()} open env={makeEnv()} />, theme);
    const results = screen.getByRole("group", { name: /^Results, \d+ lines?$/ });
    expect(results.children.length).toBeGreaterThan(0);
    unmount();
    renderInTheme(<ToolCard item={editItem()} open env={makeEnv()} />, theme);
    expect(screen.getByRole("group", { name: /^Diff, \d+ lines$/ })).toBeInTheDocument();
  });
});
