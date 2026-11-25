import { describe, expect, it } from "vitest";
import {
  countChanges,
  diffLines,
  joinLines,
  makeHunks,
  reverseHunk,
  reverseHunks,
  splitLines,
} from "./diff.ts";
import { type DocumentBinding, TextDocument } from "./documents.ts";
import { themeFromTokens, toHex } from "./theme.ts";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

describe("diff", () => {
  it("splits and joins lines, keeping the final newline", () => {
    expect(splitLines("a\nb\n")).toEqual({ lines: ["a", "b"], finalNewline: true });
    expect(splitLines("a\nb")).toEqual({ lines: ["a", "b"], finalNewline: false });
    expect(splitLines("")).toEqual({ lines: [], finalNewline: false });
    expect(joinLines(splitLines("a\nb\n"))).toBe("a\nb\n");
  });

  it("finds the shortest edit", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops.map((op) => op.type + op.line)).toEqual([" a", "-b", "+x", " c"]);
  });

  it("makes hunks with three lines of context, as git does", () => {
    const before = lines("1", "2", "3", "4", "5", "6", "7", "8", "9", "10");
    const after = lines("1", "2", "3", "4", "five", "6", "7", "8", "9", "10");
    expect(makeHunks(before, after)).toEqual([
      {
        oldStart: 2,
        oldLines: 7,
        newStart: 2,
        newLines: 7,
        lines: [" 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8"],
      },
    ]);
  });

  it("splits changes far apart into separate hunks and joins close ones", () => {
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const far = [...base];
    far[2] = "changed 3";
    far[25] = "changed 26";
    expect(makeHunks(lines(...base), lines(...far))).toHaveLength(2);
    const near = [...base];
    near[2] = "changed 3";
    near[8] = "changed 9";
    expect(makeHunks(lines(...base), lines(...near))).toHaveLength(1);
  });

  it("writes new and deleted files from line 0, as git does", () => {
    const [added] = makeHunks(null, lines("a", "b"));
    expect(added).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    const [deleted] = makeHunks(lines("a", "b"), null);
    expect(deleted).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
    expect(countChanges([added, deleted].filter((hunk) => hunk !== undefined))).toEqual({
      additions: 2,
      deletions: 2,
    });
  });

  it("undoes a hunk, and refuses one the file no longer holds", () => {
    const before = lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l");
    const after = lines("a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "K", "l");
    const hunks = makeHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(reverseHunks(after, hunks)).toBe(before);
    expect(reverseHunk(after, hunks[1] as never)).toBe(
      lines("a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
    );
    expect(() => reverseHunk(lines("nothing", "alike"), hunks[0] as never)).toThrow(
      "That change no longer matches the file.",
    );
  });

  it("finds a hunk that moved a few lines", () => {
    const before = lines("a", "b", "c");
    const after = lines("a", "x", "c");
    const [hunk] = makeHunks(before, after);
    const shifted = lines("new 1", "new 2", "a", "x", "c");
    expect(reverseHunk(shifted, hunk as never)).toBe(lines("new 1", "new 2", "a", "b", "c"));
  });

  it("diffs 5,000 lines with many changes quickly", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `row ${i}`);
    const changed = base.map((row, i) => (i % 9 === 0 ? `${row} changed` : row));
    const started = performance.now();
    const hunks = makeHunks(lines(...base), lines(...changed));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(countChanges(hunks)).toEqual({ additions: 556, deletions: 556 });
    expect(reverseHunks(lines(...changed), hunks)).toBe(lines(...base));
  });
});

/** A stand-in for a Monaco model: an undo stack of texts. */
function fakeBinding(
  initial: string,
): DocumentBinding & { undo(): void; type(text: string): void } {
  const history = [{ text: initial, version: 1 }];
  let next = 2;
  let index = 0;
  const current = () => history[index] as { text: string; version: number };
  return {
    getText: () => current().text,
    setText(text) {
      history.splice(index + 1);
      history.push({ text, version: next++ });
      index++;
    },
    version: () => current().version,
    dispose() {},
    undo() {
      index = Math.max(0, index - 1);
    },
    type(text) {
      this.setText(text);
    },
  };
}

describe("TextDocument", () => {
  it("is dirty while its text differs from the saved text", () => {
    const document = new TextDocument("k", "/p/a.py", "one");
    expect(document.dirty).toBe(false);
    document.setText("two");
    expect(document.dirty).toBe(true);
    document.markSaved("two");
    expect(document.dirty).toBe(false);
    document.reset("three");
    expect(document.getText()).toBe("three");
    expect(document.dirty).toBe(false);
  });

  it("with a live model, compares versions, so undoing back to the save is clean", () => {
    const document = new TextDocument("k", "/p/a.py", "one");
    const binding = fakeBinding("one");
    document.bind(() => binding);
    let notified = 0;
    document.subscribe(() => notified++);
    binding.type("two");
    document.changed();
    expect(document.dirty).toBe(true);
    binding.undo();
    expect(document.dirty).toBe(false);
    expect(notified).toBe(1);
    // A save that finishes after more typing leaves the document dirty.
    binding.type("three");
    document.markSaved("two");
    expect(document.dirty).toBe(true);
    document.markSaved("three");
    expect(document.dirty).toBe(false);
  });

  it("binds once, and keeps its text after disposing the model", () => {
    const document = new TextDocument("k", "/p/a.py", "one");
    const first = document.bind((text) => fakeBinding(text));
    expect(document.bind(() => fakeBinding("other"))).toBe(first);
    first.setText("edited");
    document.dispose();
    expect(document.disposed).toBe(true);
    expect(document.getText()).toBe("edited");
  });
});

describe("theme", () => {
  it("turns CSS colours into Monaco's hex", () => {
    expect(toHex("#1E1F23")).toBe("#1e1f23");
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("rgba(255, 255, 255, 0.06)")).toBe("#ffffff0f");
    expect(toHex("rgb(200 240 60 / 50%)")).toBe("#c8f03c80");
    expect(toHex("#c8f03c", 0.35)).toBe("#c8f03c59");
    expect(toHex("var(--x)")).toBeNull();
  });

  it("builds the theme from the tokens, on the base that matches", () => {
    const tokens: Record<string, string> = {
      "--panel": "#1e1f23",
      "--ink": "#ecedef",
      "--blue": "#7ea8ff",
      "--add-bg": "rgba(63, 185, 80, 0.15)",
    };
    const dark = themeFromTokens((name) => tokens[name] ?? "", true);
    expect(dark.base).toBe("vs-dark");
    expect(dark.colors["editor.background"]).toBe("#1e1f23");
    expect(dark.colors["diffEditor.insertedLineBackground"]).toBe("#3fb95026");
    expect(dark.rules).toContainEqual({ token: "keyword", foreground: "7ea8ff" });
    // Unknown tokens are left to Monaco's defaults rather than set wrong.
    expect(dark.colors["editor.selectionBackground"]).toBeUndefined();
    expect(themeFromTokens(() => "#ffffff", false).base).toBe("vs");
  });
});
