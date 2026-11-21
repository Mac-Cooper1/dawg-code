import type { CatalogEntry, HardwareProfile } from "../types.ts";

function isEntryList(
  value: readonly CatalogEntry[] | { entries: readonly CatalogEntry[] },
): value is readonly CatalogEntry[] {
  return Array.isArray(value);
}

/** True when an entry is meant for this machine: enough memory and a matching Apple Silicon chip class. */
export function fitsMachine(entry: CatalogEntry, profile: HardwareProfile): boolean {
  if (profile.arch !== "arm64" || profile.chipClass === "intel") return false;
  if (entry.minMemoryBytes > profile.memoryBytes) return false;
  return entry.chipClasses === undefined || entry.chipClasses.includes(profile.chipClass);
}

/**
 * Entries that fit the machine, best first: highest `rank`, then the larger memory tier,
 * then id for a stable order. The first element is the recommendation. Intel Macs and
 * machines below the smallest tier get an empty list.
 */
export function recommend(
  profile: HardwareProfile,
  catalog: readonly CatalogEntry[] | { entries: readonly CatalogEntry[] },
): CatalogEntry[] {
  const entries: readonly CatalogEntry[] = isEntryList(catalog) ? catalog : catalog.entries;
  return entries
    .filter((entry) => fitsMachine(entry, profile))
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.minMemoryBytes - a.minMemoryBytes ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
