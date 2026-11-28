import type { CatalogEntry, HardwareProfile } from "../types.ts";

type EntryList = readonly CatalogEntry[] | { entries: readonly CatalogEntry[] };

function isEntryList(value: EntryList): value is readonly CatalogEntry[] {
  return Array.isArray(value);
}

function entriesOf(catalog: EntryList): readonly CatalogEntry[] {
  return isEntryList(catalog) ? catalog : catalog.entries;
}

/** True for a helper: a tiny model for side requests, never offered as the main model. */
export function isHelperEntry(entry: CatalogEntry): boolean {
  return entry.role === "helper";
}

/** The entries a person can choose to chat with: everything but helpers. */
export function mainEntries(catalog: EntryList): CatalogEntry[] {
  return entriesOf(catalog).filter((entry) => !isHelperEntry(entry));
}

/** The helper entries, best first (highest rank, then id). */
export function helperEntries(catalog: EntryList): CatalogEntry[] {
  return entriesOf(catalog)
    .filter(isHelperEntry)
    .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** True when an entry is meant for this machine: enough memory and a matching Apple Silicon chip class. */
export function fitsMachine(entry: CatalogEntry, profile: HardwareProfile): boolean {
  if (profile.arch !== "arm64" || profile.chipClass === "intel") return false;
  if (entry.minMemoryBytes > profile.memoryBytes) return false;
  return entry.chipClasses === undefined || entry.chipClasses.includes(profile.chipClass);
}

/**
 * Main entries that fit the machine, best first: highest `rank`, then the larger memory tier,
 * then id for a stable order. The first element is the recommendation. Intel Macs and
 * machines below the smallest tier get an empty list. Helpers are never in it.
 */
export function recommend(profile: HardwareProfile, catalog: EntryList): CatalogEntry[] {
  return mainEntries(catalog)
    .filter((entry) => fitsMachine(entry, profile))
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.minMemoryBytes - a.minMemoryBytes ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/**
 * The helper to offer on this machine beside its main model: the best-ranked helper that fits,
 * or null. A helper's `minMemoryBytes` is the smallest Mac where it runs beside that Mac's
 * main model without taking much of the main model's context.
 */
export function recommendHelper(profile: HardwareProfile, catalog: EntryList): CatalogEntry | null {
  return helperEntries(catalog).find((entry) => fitsMachine(entry, profile)) ?? null;
}

/** The helper the app uses: the best-ranked helper entry, whether or not it fits. */
export function catalogHelper(catalog: EntryList): CatalogEntry | null {
  return helperEntries(catalog)[0] ?? null;
}
