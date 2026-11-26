/**
 * Actions recently run from the command palette, most recent first. They float to the top of
 * the palette. Kept in this window's local storage: a convenience, not something to sync.
 */

const STORAGE_KEY = "dawg.palette.recent";
export const MAX_RECENT = 5;

/** Used when local storage is unavailable. */
let fallback: string[] = [];

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function recentCommandIds(): string[] {
  const store = storage();
  if (!store) return fallback;
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function rememberCommand(id: string): void {
  const ids = [id, ...recentCommandIds().filter((other) => other !== id)].slice(0, MAX_RECENT);
  fallback = ids;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage full or unavailable: remembered for this window only.
  }
}
