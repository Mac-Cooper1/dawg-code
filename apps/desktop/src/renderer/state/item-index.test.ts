/**
 * The reducer's item index answers exactly as a scan from the end would, through appends,
 * in-place replacements, reported moves and removals, and it keeps a replay linear.
 */
import { describe, expect, it } from "vitest";
import { findItemIndex, findPermissionIndex, itemsMoved } from "./item-index.ts";
import type { PermissionItem, TranscriptItem } from "./types.ts";

function note(id: string): TranscriptItem {
  return { kind: "note", id, turnId: "t", seq: 1, text: id, tone: "neutral" };
}

function permission(id: string, toolCallId: string): PermissionItem {
  return {
    kind: "permission",
    id,
    turnId: "t",
    seq: 1,
    requestId: id,
    request: {
      requestId: id,
      toolCallId,
      toolName: "Bash",
      input: {},
      title: "Run a shell command",
      reason: "",
      suggestions: [],
    },
    state: "pending",
    response: null,
  };
}

function scan(items: readonly TranscriptItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.id === id) return i;
  return -1;
}

function scanPermission(items: readonly TranscriptItem[], toolCallId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "permission" && item.request.toolCallId === toolCallId) return i;
  }
  return -1;
}

/** mulberry32, so the sequence is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the item index", () => {
  it("answers as a scan would, whatever happens to the array", () => {
    const next = random(7);
    const items: TranscriptItem[] = [];
    let made = 0;
    for (let step = 0; step < 4_000; step++) {
      const roll = next();
      if (roll < 0.6 || items.length < 5) {
        const id = `item-${made++}`;
        items.push(next() < 0.1 ? permission(id, `call-${made % 50}`) : note(id));
      } else if (roll < 0.75) {
        const at = Math.floor(next() * items.length);
        const current = items[at] as TranscriptItem;
        items[at] = { ...current };
      } else if (roll < 0.85) {
        items.splice(Math.floor(next() * items.length), 0, note(`item-${made++}`));
        itemsMoved(items);
      } else {
        items.splice(Math.floor(next() * items.length), 1);
        itemsMoved(items);
      }
      for (let probe = 0; probe < 3; probe++) {
        const id = `item-${Math.floor(next() * (made + 5))}`;
        expect(findItemIndex(items, id)).toBe(scan(items, id));
        const call = `call-${Math.floor(next() * 55)}`;
        expect(findPermissionIndex(items, call)).toBe(scanPermission(items, call));
      }
    }
  });

  it("still answers right after a move nobody reported", () => {
    const items = Array.from({ length: 200 }, (_, i) => note(`item-${i}`));
    expect(findItemIndex(items, "item-10")).toBe(10);
    items.splice(5, 0, note("inserted"));
    expect(findItemIndex(items, "item-10")).toBe(11);
    expect(findItemIndex(items, "inserted")).toBe(5);
    items.splice(0, 3);
    expect(findItemIndex(items, "inserted")).toBe(2);
    expect(findItemIndex(items, "item-0")).toBe(-1);
  });

  it("keeps looking up new items linear in the length of the transcript", () => {
    const time = (count: number) => {
      const items: TranscriptItem[] = [];
      const started = performance.now();
      for (let i = 0; i < count; i++) {
        const id = `item-${i}`;
        if (findItemIndex(items, id) === -1) items.push(note(id));
        findPermissionIndex(items, `call-${i}`);
      }
      return performance.now() - started;
    };
    time(2_000);
    // Quadratic would make 20,000 items take 100 times as long as 2,000; allow 30.
    const small = Math.max(time(2_000), 1);
    expect(time(20_000)).toBeLessThan(small * 30);
  });
});
