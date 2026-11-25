/**
 * Watching a session's folders. `fs.watch` with `recursive` (FSEvents on macOS) reports each
 * change; this drops git's own files and other noise and batches the rest, so the panes refresh
 * once per burst instead of once per write.
 */
import { watch } from "node:fs";
import path from "node:path";

export interface Watcher {
  close(): void;
}

/**
 * Starts watching a folder and everything under it. `onEvent` gets the changed path relative to
 * the folder, or null when the platform does not say which.
 */
export type WatchFactory = (
  dir: string,
  onEvent: (relative: string | null) => void,
  onError: (error: Error) => void,
) => Watcher;

export const watchRecursive: WatchFactory = (dir, onEvent, onError) => {
  const watcher = watch(dir, { recursive: true, persistent: false }, (_type, filename) => {
    onEvent(filename === null ? null : String(filename));
  });
  watcher.on("error", onError);
  return watcher;
};

/** Folders whose changes the panes never show. */
const NOISE_SEGMENTS = new Set([".git", "node_modules", ".DS_Store"]);

/** True for changes inside `.git`, `node_modules`, Finder's files and other sessions' worktrees. */
export function isNoise(relative: string): boolean {
  const segments = relative.split(path.sep);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    if (NOISE_SEGMENTS.has(segment)) return true;
    if (segment === ".dawg" && segments[i + 1] === "worktrees" && segments.length > i + 2) {
      return true;
    }
  }
  return false;
}

/** More paths than this in one batch are reported as "something changed". */
export const MAX_PATHS_PER_EVENT = 500;

/**
 * Collects paths and flushes them `delayMs` after the last one, or `maxWaitMs` after the first
 * when changes keep coming (a build that writes for a minute still refreshes the panes).
 */
export function createBatcher(
  flush: (paths: string[]) => void,
  delayMs: number,
  maxWaitMs: number,
): { add(path: string | null): void; cancel(): void } {
  let paths = new Set<string>();
  let unknown = false;
  let timer: NodeJS.Timeout | null = null;
  let firstAt = 0;

  function fire(): void {
    timer = null;
    const list = unknown || paths.size > MAX_PATHS_PER_EVENT ? [] : [...paths];
    paths = new Set();
    unknown = false;
    flush(list);
  }

  return {
    add(changed) {
      if (changed === null) unknown = true;
      else paths.add(changed);
      const now = Date.now();
      if (timer === null) firstAt = now;
      else clearTimeout(timer);
      const wait = Math.max(0, Math.min(delayMs, firstAt + maxWaitMs - now));
      timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      paths = new Set();
      unknown = false;
    },
  };
}
