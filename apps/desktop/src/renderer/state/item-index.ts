/**
 * Where an item is in a transcript, without reading the whole transcript.
 *
 * The reducer looks items up for nearly every event, and every new item starts with a lookup
 * that finds nothing. Scanning from the end finds the latest items at once but reads every item
 * to find nothing, which made replaying a long session quadratic: 0.4 s of a 5,000-item session's
 * open, 1.8 s at 10,000 items, on the reference Intel laptop (README, "Performance").
 *
 * So lookups first scan the newest items, then ask an index of the array: built once per array,
 * extended as items are appended, and dropped when items move (`itemsMoved`, after a splice).
 * Replacing an item with one of the same id, which is how the reducer updates items, keeps it.
 * Every answer from the index is checked against the array before it is used, and a removal or
 * an unreported move rebuilds it, so a stale index costs a scan, never a wrong answer about an
 * item that is there.
 */
import type { PermissionItem, TranscriptItem } from "./types.ts";

/** Lookups scan this many of the newest items before asking the index. */
const NEAR_END = 32;

interface ItemIndex {
  /** Items indexed: positions [0, length). */
  length: number;
  /** The id at `length - 1` when indexed, to notice items that moved without being reported. */
  lastId: string | undefined;
  /** id → its last position, as a scan from the end would find it. */
  ids: Map<string, number>;
  /** toolCallId → the last position of a permission item for that call. */
  permissions: Map<string, number>;
}

const indexes = new WeakMap<readonly TranscriptItem[], ItemIndex>();

function indexOf(items: readonly TranscriptItem[]): ItemIndex {
  let index = indexes.get(items);
  if (
    index === undefined ||
    index.length > items.length ||
    (index.length > 0 && items[index.length - 1]?.id !== index.lastId)
  ) {
    index = { length: 0, lastId: undefined, ids: new Map(), permissions: new Map() };
    indexes.set(items, index);
  }
  for (let position = index.length; position < items.length; position++) {
    const item = items[position];
    if (item === undefined) continue;
    index.ids.set(item.id, position);
    if (item.kind === "permission") index.permissions.set(item.request.toolCallId, position);
  }
  index.length = items.length;
  index.lastId = items[items.length - 1]?.id;
  return index;
}

/** Items in `items` moved (a splice): its index is rebuilt on the next lookup. */
export function itemsMoved(items: readonly TranscriptItem[]): void {
  indexes.delete(items);
}

function lookUp(
  items: readonly TranscriptItem[],
  matches: (item: TranscriptItem) => boolean,
  fromIndex: (index: ItemIndex) => number | undefined,
): number {
  const stop = Math.max(0, items.length - NEAR_END);
  for (let position = items.length - 1; position >= stop; position--) {
    const item = items[position];
    if (item !== undefined && matches(item)) return position;
  }
  if (stop === 0) return -1;
  const position = fromIndex(indexOf(items));
  if (position === undefined) return -1;
  const item = items[position];
  if (position < stop && item !== undefined && matches(item)) return position;
  // Out of step with the array (it cannot be, if every splice is reported): read it all.
  itemsMoved(items);
  for (let at = stop - 1; at >= 0; at--) {
    const candidate = items[at];
    if (candidate !== undefined && matches(candidate)) return at;
  }
  return -1;
}

/** The position of the item with `id`, or -1. */
export function findItemIndex(items: readonly TranscriptItem[], id: string): number {
  return lookUp(
    items,
    (item) => item.id === id,
    (index) => index.ids.get(id),
  );
}

/** The position of the last permission item for the call `toolCallId`, or -1. */
export function findPermissionIndex(items: readonly TranscriptItem[], toolCallId: string): number {
  return lookUp(
    items,
    (item) =>
      item.kind === "permission" && (item as PermissionItem).request.toolCallId === toolCallId,
    (index) => index.permissions.get(toolCallId),
  );
}
