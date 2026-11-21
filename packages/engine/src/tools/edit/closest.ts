/**
 * When old_string matches nowhere: the part of the file it most resembles, and how the two
 * differ, shown so the model can see exactly what to copy.
 */
import { diffArrays } from "diff";
import { LOOK_ALIKES } from "./normalize.ts";
import { similarity } from "./similarity.ts";

export interface ClosestRegion {
  /** 0-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Average line similarity, 0 to 1. */
  score: number;
}

/** Below this the "closest" text is not worth showing. */
const MIN_SCORE = 0.35;
const MAX_CANDIDATES = 40;
/** Past this many lines, only exact line matches are used to find candidates. */
const MAX_FUZZY_LINES = 200_000;

function key(line: string): string {
  let out = "";
  for (const ch of line) out += LOOK_ALIKES.get(ch) ?? ch;
  return out.trim().replace(/\s+/g, " ");
}

export function findClosestRegion(
  fileLines: readonly string[],
  oldLines: readonly string[],
): ClosestRegion | null {
  const m = oldLines.length;
  const n = fileLines.length;
  if (n === 0 || m === 0) return null;
  const fileKeys = fileLines.map(key);
  const oldKeys = oldLines.map(key);
  if (oldKeys.every((k) => k === "")) return null;

  const votes = new Map<number, number>();
  const index = new Map<string, number[]>();
  fileKeys.forEach((k, i) => {
    if (k === "") return;
    const list = index.get(k);
    if (list === undefined) index.set(k, [i]);
    else list.push(i);
  });
  oldKeys.forEach((k, j) => {
    const positions = index.get(k);
    if (k === "" || positions === undefined) return;
    // A line that occurs everywhere ("}") says little about where the block is.
    const weight = 1 / positions.length;
    for (const p of positions) votes.set(p - j, (votes.get(p - j) ?? 0) + weight);
  });

  if (n <= MAX_FUZZY_LINES) {
    const anchors = oldKeys
      .map((k, j) => [k, j] as const)
      .filter(([k]) => k.length >= 4)
      .sort((a, b) => b[0].length - a[0].length)
      .slice(0, 2);
    for (const [k, j] of anchors) {
      for (let p = 0; p < n; p++) {
        const s = similarity(fileKeys[p] as string, k);
        if (s >= 0.5) votes.set(p - j, Math.max(votes.get(p - j) ?? 0, 0) + s / 2);
      }
    }
  }

  const candidates = [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_CANDIDATES)
    .map(([start]) => start);
  let best: ClosestRegion | null = null;
  for (const start of candidates) {
    let total = 0;
    for (let j = 0; j < m; j++) {
      const p = start + j;
      if (p < 0 || p >= n) continue;
      total += similarity(fileKeys[p] as string, oldKeys[j] as string);
    }
    const score = total / m;
    if (best === null || score > best.score) {
      best = {
        startLine: Math.max(0, start),
        endLine: Math.min(n - 1, start + m - 1),
        score,
      };
    }
  }
  return best !== null && best.score >= MIN_SCORE ? best : null;
}

/**
 * The lines of `oldLines` and of the region that differ, as JSON strings so tabs, trailing
 * spaces and odd characters are visible. File lines carry their line numbers.
 */
export function describeRegionDifferences(
  fileLines: readonly string[],
  region: ClosestRegion,
  oldLines: readonly string[],
  maxRows = 16,
): string {
  const window = fileLines.slice(region.startLine, region.endLine + 1);
  const changes = diffArrays([...oldLines], window);
  const rows: string[] = [];
  let fileLine = region.startLine + 1;
  let hidden = 0;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      fileLine += change.count;
      continue;
    }
    for (const line of change.value) {
      const row = change.added
        ? `+ ${JSON.stringify(line)}  (line ${fileLine++})`
        : `- ${JSON.stringify(line)}`;
      if (rows.length < maxRows) rows.push(row);
      else hidden++;
    }
  }
  if (hidden > 0) rows.push(`… and ${hidden} more differing lines`);
  return rows.join("\n");
}
