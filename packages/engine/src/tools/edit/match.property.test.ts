/**
 * Properties of the matcher, checked on generated files. The generator is seeded, so a failure
 * names an iteration that can be replayed.
 */
import { describe, expect, it } from "vitest";
import { FileText, planEdit } from "./match.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["foo", "bar", "baz", "x", "=", "(", ")", "{", "}", ";", "return", "if", "1", "'s'"];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

describe("exact unique match", () => {
  it("always produces exactly the expected text", () => {
    let tested = 0;
    for (let iteration = 0; iteration < 400; iteration++) {
      const random = rng(iteration + 1);
      const lineCount = int(random, 1, 12);
      const fileLines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        const words = Array.from({ length: int(random, 0, 6) }, () => pick(random, WORDS));
        fileLines.push(" ".repeat(int(random, 0, 2) * 2) + words.join(" "));
      }
      const text = fileLines.join("\n") + (random() < 0.5 ? "\n" : "");
      if (text.length < 2) continue;
      const start = int(random, 0, text.length - 1);
      const end = int(random, start + 1, Math.min(text.length, start + 40));
      const oldString = text.slice(start, end);
      if (text.indexOf(oldString) !== start || text.indexOf(oldString, start + 1) !== -1) continue;
      const newString = `<${pick(random, WORDS)}\n${pick(random, WORDS)}>`;
      if (newString === oldString) continue;
      const result = planEdit(new FileText(text), oldString, newString, false);
      expect(result.kind, `iteration ${iteration}`).toBe("matched");
      if (result.kind === "matched") {
        expect(result.step).toBe("exact");
        expect(result.newText).toBe(text.slice(0, start) + newString + text.slice(end));
      }
      tested++;
    }
    expect(tested).toBeGreaterThan(150);
  });
});

interface StyledFile {
  text: string;
  lines: string[];
  terminators: string[];
  /** Each line's indentation depth, body and trailing whitespace. */
  depth: number[];
  body: string[];
  trailing: string[];
}

/** A file in a random style: tabs or spaces, LF or CRLF, trailing whitespace here and there. */
function styledFile(random: () => number): StyledFile {
  const useTabs = random() < 0.5;
  const unit = useTabs ? "\t" : " ".repeat(pick(random, [2, 4]));
  const eol = random() < 0.4 ? "\r\n" : "\n";
  const count = int(random, 4, 14);
  const depth: number[] = [];
  const body: string[] = [];
  const trailing: string[] = [];
  const lines: string[] = [];
  let d = 0;
  for (let i = 0; i < count; i++) {
    d = Math.max(0, Math.min(4, d + int(random, -1, 1)));
    depth.push(d);
    // A unique token per line keeps every block unique.
    body.push(`${pick(random, WORDS)} tok${i} ${pick(random, WORDS)}`);
    trailing.push(random() < 0.3 ? pick(random, [" ", "  ", "\t", " \t"]) : "");
    lines.push(unit.repeat(d) + body[i] + trailing[i]);
  }
  const finalNewline = random() < 0.7;
  const terminators = lines.map((_, i) => (i < count - 1 || finalNewline ? eol : ""));
  const text = lines.map((l, i) => l + terminators[i]).join("");
  return { text, lines, terminators, depth, body, trailing };
}

/** How a model might copy lines: other indentation unit, no trailing whitespace, LF. */
function sloppyCopy(file: StyledFile, from: number, to: number, random: () => number): string[] {
  const unit = pick(random, ["  ", "    ", "\t"]);
  const shift = int(random, 0, 1);
  const base = Math.min(...file.depth.slice(from, to + 1));
  return file.body
    .slice(from, to + 1)
    .map((b, k) => unit.repeat(Math.max(0, (file.depth[from + k] as number) - base + shift)) + b);
}

describe("tolerant matches", () => {
  it("change only the edited line, and keep its indentation, trailing whitespace and ending", () => {
    const steps = new Map<string, number>();
    for (let iteration = 0; iteration < 300; iteration++) {
      const random = rng(10_000 + iteration);
      const file = styledFile(random);
      const from = int(random, 0, file.lines.length - 1);
      const to = Math.min(file.lines.length - 1, from + int(random, 0, 3));
      const oldLines = sloppyCopy(file, from, to, random);
      const changed = int(random, 0, to - from);
      const newLines = oldLines.map((l, k) => (k === changed ? l.replace(/tok(\d+)/, "TOK$1") : l));
      const result = planEdit(
        new FileText(file.text),
        oldLines.join("\n"),
        newLines.join("\n"),
        false,
      );
      expect(result.kind, `iteration ${iteration}`).toBe("matched");
      if (result.kind !== "matched") continue;
      steps.set(result.step, (steps.get(result.step) ?? 0) + 1);

      const expected = file.lines
        .map((line, i) => (i === from + changed ? line.replace(/tok(\d+)/, "TOK$1") : line))
        .map((line, i) => line + file.terminators[i])
        .join("");
      expect(result.newText, `iteration ${iteration}`).toBe(expected);
    }
    // The generator must reach the tolerant steps, not just exact matches.
    expect(steps.get("indentation") ?? 0).toBeGreaterThan(50);
    expect(steps.get("trailing-whitespace") ?? 0).toBeGreaterThan(5);
    expect(steps.get("line-endings") ?? 0).toBeGreaterThan(5);
  });

  it("an edit followed by its inverse restores the file byte for byte", () => {
    for (let iteration = 0; iteration < 300; iteration++) {
      const random = rng(20_000 + iteration);
      const file = styledFile(random);
      const from = int(random, 0, file.lines.length - 1);
      const to = Math.min(file.lines.length - 1, from + int(random, 0, 3));
      const oldLines = sloppyCopy(file, from, to, random);
      const changed = int(random, 0, to - from);
      const newLines = oldLines.map((l, k) => (k === changed ? l.replace(/tok(\d+)/, "TOK$1") : l));
      const forward = planEdit(
        new FileText(file.text),
        oldLines.join("\n"),
        newLines.join("\n"),
        false,
      );
      if (forward.kind !== "matched") throw new Error(`iteration ${iteration}: no forward match`);
      const back = planEdit(
        new FileText(forward.newText),
        newLines.join("\n"),
        oldLines.join("\n"),
        false,
      );
      if (back.kind !== "matched") throw new Error(`iteration ${iteration}: no inverse match`);
      expect(back.newText, `iteration ${iteration}`).toBe(file.text);
    }
  });

  it("an exact edit followed by its inverse restores the file", () => {
    for (let iteration = 0; iteration < 200; iteration++) {
      const random = rng(30_000 + iteration);
      const file = styledFile(random);
      const line = int(random, 0, file.lines.length - 1);
      const oldString = file.body[line] as string;
      const newString = `${oldString} /* ${pick(random, WORDS)} */\nextra${iteration}`;
      const forward = planEdit(new FileText(file.text), oldString, newString, false);
      if (forward.kind !== "matched") throw new Error(`iteration ${iteration}: no forward match`);
      expect(forward.step).toBe("exact");
      // The inverse old_string is the replacement as it now appears in the file.
      const written = forward.edits[0]?.replacement as string;
      const back = planEdit(new FileText(forward.newText), written, oldString, false);
      if (back.kind !== "matched") throw new Error(`iteration ${iteration}: no inverse match`);
      expect(back.newText, `iteration ${iteration}`).toBe(file.text);
    }
  });
});
