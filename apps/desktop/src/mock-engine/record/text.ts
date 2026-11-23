/**
 * Small helpers for authoring recordings: a seeded random source (so regenerating the fixtures
 * gives identical files), streaming chunks, token estimates, and the line and diff formats the
 * real tools produce.
 */
import type { DiffDisplay, DiffHunk } from "@dawg/protocol";

/** A seeded random source (mulberry32): tiny, fast and good enough for timing jitter. */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Lowercase hex digits, for ids that look like the real engine's. */
  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.int(0, 15).toString(16);
    return out;
  }

  /** An independent copy that continues the same sequence, for a branch of a recording. */
  clone(): Random {
    const copy = new Random(0);
    copy.#state = this.#state;
    return copy;
  }
}

/**
 * Splits text into pieces of `min` to `max` words, each keeping the whitespace that follows it,
 * so the pieces join back into exactly the original text. This is roughly what a model streams.
 */
export function chunkWords(text: string, random: Random, min = 1, max = 3): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const size = random.int(min, max);
    chunks.push(words.slice(i, i + size).join(""));
    i += size;
  }
  return chunks;
}

/** About 3.6 characters per token, which is close for English prose and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** Lines as `Read` numbers them: `<n>→<text>`, numbers right-aligned to the widest. */
export function numberLines(lines: readonly string[], first: number): string {
  const width = String(first + Math.max(lines.length - 1, 0)).length;
  return lines.map((line, i) => `${String(first + i).padStart(width)}→${line}`).join("\n");
}

/**
 * A diff hunk from unified-diff lines (each starting with " ", "+" or "-"); the line counts are
 * worked out from them.
 */
export function hunk(oldStart: number, newStart: number, lines: readonly string[]): DiffHunk {
  let oldLines = 0;
  let newLines = 0;
  for (const line of lines) {
    const sign = line[0];
    if (sign === " " || sign === "-") oldLines += 1;
    if (sign === " " || sign === "+") newLines += 1;
    if (sign !== " " && sign !== "+" && sign !== "-") {
      throw new Error(`Diff line without a prefix: ${JSON.stringify(line)}`);
    }
  }
  return { oldStart, oldLines, newStart, newLines, lines: [...lines] };
}

export function diffDisplay(
  filePath: string,
  hunks: readonly DiffHunk[],
  created = false,
): DiffDisplay {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { kind: "diff", filePath, created, hunks: [...hunks], additions, deletions };
}

/**
 * The changed part of a hunk before and after, for an Edit call's old_string and new_string:
 * from the first changed line to the last, without the surrounding context.
 */
export function hunkSides(h: DiffHunk): { before: string; after: string } {
  const first = h.lines.findIndex((line) => !line.startsWith(" "));
  const last = h.lines.findLastIndex((line) => !line.startsWith(" "));
  const before: string[] = [];
  const after: string[] = [];
  for (const line of h.lines.slice(Math.max(first, 0), last + 1)) {
    const body = line.slice(1);
    if (!line.startsWith("+")) before.push(body);
    if (!line.startsWith("-")) after.push(body);
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

/** "1 line", "3 lines" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
