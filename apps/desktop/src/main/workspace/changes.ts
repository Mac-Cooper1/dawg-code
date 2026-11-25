/**
 * What differs from a base commit: committed since, staged, unstaged and untracked (not ignored),
 * as git sees it. Paths here are relative to the repository's top level.
 */
import { open } from "node:fs/promises";
import path from "node:path";
import type { ChangedFile } from "../../shared/bridge.ts";
import { runGit, splitNul } from "./git.ts";

export interface RelativeChange {
  path: string;
  oldPath: string | null;
  status: ChangedFile["status"];
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Flags that keep the person's git config from changing what `git diff` prints. */
const DIFF_FLAGS = ["--no-relative", "--no-ext-diff", "--no-textconv", "--no-color", "-M"];

const STATUS_BY_LETTER: Record<string, ChangedFile["status"]> = {
  A: "added",
  C: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
  U: "modified",
};

/** Tracked changes (base → working tree), with renames. */
export async function trackedChanges(root: string, base: string): Promise<RelativeChange[]> {
  const [names, counts] = await Promise.all([
    runGit(["diff", "-z", "--name-status", ...DIFF_FLAGS, base, "--"], { cwd: root }),
    runGit(["diff", "-z", "--numstat", ...DIFF_FLAGS, base, "--"], { cwd: root }),
  ]);

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const countFields = splitNul(counts.stdout);
  for (let i = 0; i < countFields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(countFields[i] ?? "");
    if (!match) continue;
    const [, added = "0", deleted = "0", inline = ""] = match;
    let target = inline;
    if (inline === "") {
      // A rename: the old and new paths follow as fields of their own.
      target = countFields[i + 2] ?? "";
      i += 2;
    }
    const binary = added === "-" || deleted === "-";
    stats.set(target, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    });
  }

  const changes: RelativeChange[] = [];
  const nameFields = splitNul(names.stdout);
  for (let i = 0; i < nameFields.length; ) {
    const letter = (nameFields[i] ?? "").charAt(0);
    const twoPaths = letter === "R" || letter === "C";
    const oldPath = twoPaths ? (nameFields[i + 1] ?? null) : null;
    const filePath = (twoPaths ? nameFields[i + 2] : nameFields[i + 1]) ?? "";
    i += twoPaths ? 3 : 2;
    if (filePath === "") continue;
    const stat = stats.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
    changes.push({
      path: filePath,
      oldPath: letter === "R" ? oldPath : null,
      status: STATUS_BY_LETTER[letter] ?? "modified",
      ...stat,
    });
  }
  return changes;
}

/** Untracked files that are not ignored. Nested repositories ("dir/") are left out. */
export async function untrackedFiles(root: string): Promise<string[]> {
  const { stdout } = await runGit(["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: root,
  });
  return splitNul(stdout).filter((name) => name !== "" && !name.endsWith("/"));
}

/** Most bytes read to count a new file's lines. */
const MAX_COUNT_BYTES = 64 * 1024 * 1024;

/** A new file's lines (all additions), read in chunks; binary when git would call it binary. */
export async function countFileLines(
  file: string,
): Promise<{ additions: number; binary: boolean }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, "r");
    if (!(await handle.stat()).isFile()) return { additions: 0, binary: false };
    const buffer = Buffer.alloc(64 * 1024);
    let lines = 0;
    let total = 0;
    let last = -1;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (total < 8000 && buffer.subarray(0, Math.min(bytesRead, 8000 - total)).includes(0)) {
        return { additions: 0, binary: true };
      }
      for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) lines++;
      last = buffer[bytesRead - 1] ?? -1;
      total += bytesRead;
      if (total >= MAX_COUNT_BYTES) break;
    }
    if (total > 0 && last !== 10) lines++;
    return { additions: lines, binary: false };
  } catch {
    return { additions: 0, binary: false };
  } finally {
    await handle?.close();
  }
}

/** Runs `task` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function joinRelative(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}
