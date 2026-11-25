/**
 * Text helpers for the workspace: deciding what is text, reading unified diffs into hunks, and
 * taking one hunk back out of a file.
 */
import type { Hunk } from "../../shared/bridge.ts";

/** Files over this size are not shown or diffed. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Git's own test: a NUL byte in the first 8,000 bytes makes a file binary. */
const BINARY_SNIFF_BYTES = 8000;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * The text of a file, or null when it is binary or not valid UTF-8 (saving a file read with
 * replacement characters would damage it). A byte order mark is kept, so a save keeps it too.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (looksBinary(bytes)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Lines the way git counts them: a last line without a newline still counts. */
export function countLines(text: string): number {
  if (text === "") return 0;
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return text.endsWith("\n") ? count : count + 1;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of `git diff` output. Header lines are skipped, and so are "\ No newline at end of
 * file" markers (the hunk format has no place for them).
 */
export function parseUnifiedDiff(output: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = output.split("\n");
  let i = 0;
  while (i < lines.length) {
    const match = HUNK_HEADER.exec(lines[i] ?? "");
    i++;
    if (!match) continue;
    const hunk: Hunk = {
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
    };
    let oldLeft = hunk.oldLines;
    let newLeft = hunk.newLines;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i]?.startsWith("\\"))) {
      const line = lines[i] ?? "";
      i++;
      if (line.startsWith("\\")) continue;
      // `diff.suppressBlankEmpty` drops the space of an empty context line.
      const kind = line === "" ? " " : line[0];
      const body = line === "" ? "" : line.slice(1);
      if (kind === "+") newLeft--;
      else if (kind === "-") oldLeft--;
      else if (kind === " ") {
        oldLeft--;
        newLeft--;
      } else break;
      hunk.lines.push(`${kind}${body}`);
    }
    hunks.push(hunk);
  }
  return hunks;
}

export interface SplitText {
  lines: string[];
  finalNewline: boolean;
}

export function splitText(text: string): SplitText {
  if (text === "") return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, finalNewline };
}

export function joinText({ lines, finalNewline }: SplitText): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

export class HunkMismatchError extends Error {
  constructor() {
    super("This change no longer matches the file. Refresh the diff and try again.");
    this.name = "HunkMismatchError";
  }
}

/**
 * Takes one hunk (base → working tree) back out of the working-tree text. Refuses a hunk whose
 * new side is not exactly where it says. `baseFinalNewline` decides the last line's newline when
 * the hunk reaches the end of the file (null: the file is new, keep what it has).
 */
export function revertHunk(current: string, hunk: Hunk, baseFinalNewline: boolean | null): string {
  const oldSide: string[] = [];
  const newSide: string[] = [];
  for (const line of hunk.lines) {
    const body = line.slice(1);
    if (line.startsWith(" ")) {
      oldSide.push(body);
      newSide.push(body);
    } else if (line.startsWith("-")) oldSide.push(body);
    else if (line.startsWith("+")) newSide.push(body);
    else throw new HunkMismatchError();
  }
  if (oldSide.length !== hunk.oldLines || newSide.length !== hunk.newLines) {
    throw new HunkMismatchError();
  }
  const text = splitText(current);
  // An empty side starts after the line it names ("+3,0" sits after line 3).
  const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
  if (start < 0 || start + newSide.length > text.lines.length) throw new HunkMismatchError();
  for (let k = 0; k < newSide.length; k++) {
    if (text.lines[start + k] !== newSide[k]) throw new HunkMismatchError();
  }
  const reachesEnd = start + newSide.length === text.lines.length;
  text.lines.splice(start, newSide.length, ...oldSide);
  if (reachesEnd && baseFinalNewline !== null) text.finalNewline = baseFinalNewline;
  return joinText(text);
}
