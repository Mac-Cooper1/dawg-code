/**
 * Suggestions for a path that does not exist: similarly named files nearby, the same name
 * elsewhere in the project, or the path read relative to the working directory.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface MissingPathHelp {
  /** The first directory on the path that does not exist, when the file's own directory is missing. */
  missingDirectory: string | null;
  /** Existing paths the caller may have meant, best first (absolute). */
  suggestions: string[];
}

export interface SuggestOptions {
  /** The path as the model wrote it. */
  rawInput: string;
  workingDirectories: readonly string[];
  /** Upper bound on directory entries looked at while searching for the same name. */
  searchBudget?: number;
  maxSuggestions?: number;
}

/** Directories that are large and almost never what the model meant. */
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", ".venv", "__pycache__"]);

export async function helpForMissingPath(
  absPath: string,
  options: SuggestOptions,
): Promise<MissingPathHelp> {
  const max = options.maxSuggestions ?? 5;
  const found: string[] = [];
  const add = (p: string) => {
    if (p !== absPath && !found.includes(p)) found.push(p);
  };

  // "/src/app.ts" when the model meant "src/app.ts".
  if (path.isAbsolute(options.rawInput.trim())) {
    for (const dir of options.workingDirectories) {
      const candidate = path.join(dir, options.rawInput.trim());
      if (await isFile(candidate)) add(candidate);
    }
  }

  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  let missingDirectory: string | null = null;
  if (await isDirectory(dir)) {
    for (const name of await similarNames(dir, base, false)) add(path.join(dir, name));
  } else {
    // Find the deepest existing ancestor and try a similarly named directory below it.
    let child = dir;
    let parent = path.dirname(dir);
    while (parent !== child && !(await isDirectory(parent))) {
      child = parent;
      parent = path.dirname(parent);
    }
    missingDirectory = child;
    if (parent !== child) {
      const rest = path.relative(child, absPath);
      for (const name of await similarNames(parent, path.basename(child), true)) {
        const candidate = path.join(parent, name, rest);
        if (await isFile(candidate)) add(candidate);
      }
    }
  }

  if (found.length < max) {
    const sameName = await findByName(
      base,
      options.workingDirectories,
      options.searchBudget ?? 5000,
      max,
    );
    for (const p of sameName) add(p);
  }
  return { missingDirectory, suggestions: found.slice(0, max) };
}

async function similarNames(dir: string, wanted: string, directories: boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const scored: Array<[string, number]> = [];
  for (const entry of entries) {
    if (directories !== entry.isDirectory()) continue;
    const score = nameSimilarity(wanted, entry.name);
    if (score > 0) scored.push([entry.name, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return scored.slice(0, 3).map(([name]) => name);
}

/** 0 for unrelated names; higher is more similar. */
export function nameSimilarity(wanted: string, actual: string): number {
  const a = wanted.toLowerCase();
  const b = actual.toLowerCase();
  if (a === b) return 100;
  const stemA = stem(a);
  const stemB = stem(b);
  if (stemA === stemB && stemA.length > 0) return 80;
  const longest = Math.max(a.length, b.length);
  if (longest <= 64) {
    const distance = editDistance(a, b);
    if (distance <= Math.max(1, Math.floor(longest / 4))) return 70 - distance;
  }
  if (stemA.length >= 3 && stemB.length >= 3 && (stemA.includes(stemB) || stemB.includes(stemA))) {
    return 50;
  }
  return 0;
}

function stem(name: string): string {
  const ext = path.extname(name);
  return ext.length > 0 && ext.length < name.length ? name.slice(0, -ext.length) : name;
}

/**
 * Edits needed to turn `a` into `b`, counting a swap of two neighbouring characters as one edit
 * ("mian" and "main" are one apart), since that is the most common typing slip.
 */
export function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (before[j - 2] ?? 0) + 1);
      }
      current[j] = best;
    }
    before = previous;
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Breadth-first search for files named `name` (ignoring case), looking at no more than `budget` entries. */
async function findByName(
  name: string,
  roots: readonly string[],
  budget: number,
  max: number,
): Promise<string[]> {
  const wanted = name.toLowerCase();
  const results: string[] = [];
  const queue = [...roots];
  let seen = 0;
  while (queue.length > 0 && seen < budget && results.length < max) {
    const dir = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      seen++;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
      } else if (entry.name.toLowerCase() === wanted) {
        results.push(path.join(dir, entry.name));
        if (results.length >= max) break;
      }
    }
  }
  return results;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
