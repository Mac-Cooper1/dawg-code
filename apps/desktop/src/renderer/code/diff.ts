/**
 * Line diffs and unified-diff hunks, in plain TypeScript: the browser fallback's workspace uses
 * them to diff and revert its files, and the Changes pane uses them to rebuild a file's original
 * text from the session's own edits when the session is not in a git repository.
 */
import type { Hunk } from "../../shared/bridge.ts";

/** A text split into lines, remembering whether it ended with a newline. */
export interface Lines {
  lines: string[];
  finalNewline: boolean;
}

export function splitLines(text: string): Lines {
  if (text === "") return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, finalNewline };
}

export function joinLines({ lines, finalNewline }: Lines): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

type Op = { type: " " | "-" | "+"; line: string };

/**
 * Past this many differences the middle of the two texts is shown as one replaced block, so a
 * diff of two unrelated large files stays quick.
 */
const MAX_EDIT_DISTANCE = 2000;

/** The shortest edit script from `a` to `b` (Myers), as kept, removed and added lines. */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: " ", line: a[i] as string });
  ops.push(...middleOps(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) ops.push({ type: " ", line: a[i] as string });
  return ops;
}

function middleOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: "+", line }));
  if (m === 0) return a.map((line) => ({ type: "-", line }));
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** V before each step d, for indexes -(d + 1)..(d + 1). */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
      let x = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return [
    ...a.map((line): Op => ({ type: "-", line })),
    ...b.map((line): Op => ({ type: "+", line })),
  ];
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): Op[] {
  const reversed: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d] as Int32Array;
    const at = (k: number) => snapshot[k + d + 1] as number;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: " ", line: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (down) reversed.push({ type: "+", line: b[y - 1] as string });
      else reversed.push({ type: "-", line: a[x - 1] as string });
    }
    x = prevX;
    y = prevY;
  }
  return reversed.reverse();
}

/** Unified-diff hunks between two texts (null is a missing file), with `context` lines around. */
export function makeHunks(original: string | null, modified: string | null, context = 3): Hunk[] {
  const ops = diffLines(splitLines(original ?? "").lines, splitLines(modified ?? "").lines);
  const hunks: Hunk[] = [];
  let index = 0;
  while (index < ops.length) {
    // The next change.
    while (index < ops.length && ops[index]?.type === " ") index++;
    if (index >= ops.length) break;
    const from = Math.max(0, index - context);
    // Extend while the next change is within twice the context.
    let to = index;
    let scan = index;
    while (scan < ops.length) {
      if (ops[scan]?.type !== " ") {
        to = scan;
        scan++;
        continue;
      }
      let gap = scan;
      while (gap < ops.length && ops[gap]?.type === " ") gap++;
      if (gap >= ops.length || gap - scan > context * 2) break;
      scan = gap;
    }
    const end = Math.min(ops.length, to + 1 + context);
    hunks.push(hunkOf(ops, from, end));
    index = end;
  }
  return hunks;
}

function hunkOf(ops: readonly Op[], from: number, end: number): Hunk {
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < from; i++) {
    const type = ops[i]?.type;
    if (type !== "+") oldLine++;
    if (type !== "-") newLine++;
  }
  const lines: string[] = [];
  let oldLines = 0;
  let newLines = 0;
  for (let i = from; i < end; i++) {
    const op = ops[i] as Op;
    lines.push(op.type + op.line);
    if (op.type !== "+") oldLines++;
    if (op.type !== "-") newLines++;
  }
  // As git writes it: an empty side starts at the line before.
  return {
    oldStart: oldLines === 0 ? oldLine - 1 : oldLine,
    oldLines,
    newStart: newLines === 0 ? newLine - 1 : newLine,
    newLines,
    lines,
  };
}

/** Lines added and removed in some hunks. */
export function countChanges(hunks: readonly Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { additions, deletions };
}

/** How far from its recorded line a hunk is looked for, when the file moved a little. */
const FUZZ_LINES = 40;

function sideOf(hunk: Hunk, side: "old" | "new"): string[] {
  const skip = side === "old" ? "+" : "-";
  return hunk.lines.filter((line) => !line.startsWith(skip)).map((line) => line.slice(1));
}

function matchesAt(lines: readonly string[], at: number, wanted: readonly string[]): boolean {
  if (at < 0 || at + wanted.length > lines.length) return false;
  for (let i = 0; i < wanted.length; i++) if (lines[at + i] !== wanted[i]) return false;
  return true;
}

/** Where the hunk's `side` lines are in `lines`: at the recorded line, or the nearest nearby. */
function locate(lines: readonly string[], hunk: Hunk, side: "old" | "new"): number | null {
  const wanted = sideOf(hunk, side);
  const start = side === "old" ? hunk.oldStart : hunk.newStart;
  const count = side === "old" ? hunk.oldLines : hunk.newLines;
  // An empty side sits after line `start`; otherwise it begins at line `start`.
  const expected = count === 0 ? start : start - 1;
  for (let delta = 0; delta <= FUZZ_LINES; delta++) {
    if (matchesAt(lines, expected - delta, wanted)) return expected - delta;
    if (delta > 0 && matchesAt(lines, expected + delta, wanted)) return expected + delta;
  }
  return null;
}

/**
 * Undoes one hunk in a file that has it applied: its new lines become its old lines again.
 * Throws when the file no longer holds the hunk's new lines.
 */
export function reverseHunk(text: string, hunk: Hunk): string {
  const split = splitLines(text);
  const at = locate(split.lines, hunk, "new");
  if (at === null) throw new Error("That change no longer matches the file.");
  const lines = [...split.lines];
  lines.splice(at, hunk.newLines, ...sideOf(hunk, "old"));
  const finalNewline = lines.length === 0 ? false : split.finalNewline || split.lines.length === 0;
  return joinLines({ lines, finalNewline });
}

/** Undoes several hunks of one edit (in file order, as an edit lists them). */
export function reverseHunks(text: string, hunks: readonly Hunk[]): string {
  let result = text;
  for (let i = hunks.length - 1; i >= 0; i--) result = reverseHunk(result, hunks[i] as Hunk);
  return result;
}
