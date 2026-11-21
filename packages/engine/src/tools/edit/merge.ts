/**
 * A character-level three-way merge for one line: apply the model's change (base → theirs) to
 * the file's actual text (ours), where the file differs from the model's copy only cosmetically
 * (spacing inside the line, curly quotes). Unchanged stretches keep the file's characters.
 */
import { diffChars } from "diff";

interface Hunk {
  /** Start and end in `base`. */
  start: number;
  end: number;
  /** What replaces base[start, end). */
  text: string;
}

/** Long or very different lines are not worth a character diff; the caller falls back. */
const MAX_EDIT_LENGTH = 400;
const MAX_LINE = 4000;

function hunks(base: string, other: string): Hunk[] | null {
  const changes = diffChars(base, other, { maxEditLength: MAX_EDIT_LENGTH });
  if (changes === undefined) return null;
  const out: Hunk[] = [];
  let pos = 0;
  let current: Hunk | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (current !== null) out.push(current);
      current = null;
      pos += change.value.length;
      continue;
    }
    current ??= { start: pos, end: pos, text: "" };
    if (change.removed) {
      current.end += change.value.length;
      pos += change.value.length;
    } else {
      current.text += change.value;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

function conflicts(a: Hunk, b: Hunk): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start;
  // An insertion at the edge of a replacement does not conflict with it; inside it does.
  if (aInsert) return b.start < a.start && a.start < b.end;
  if (bInsert) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * Returns `ours` with the change from `base` to `theirs` applied, or null if the lines are too
 * long or too different to merge sensibly. Where both sides changed the same characters, the
 * model's text (theirs) wins.
 */
export function mergeLine(base: string, ours: string, theirs: string): string | null {
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  if (Math.max(base.length, ours.length, theirs.length) > MAX_LINE) return null;
  const fromOurs = hunks(base, ours);
  const fromTheirs = hunks(base, theirs);
  if (fromOurs === null || fromTheirs === null) return null;
  const kept = fromOurs.filter((h) => !fromTheirs.some((t) => conflicts(h, t)));
  const all = [
    ...kept.map((h) => ({ ...h, side: 0 })),
    ...fromTheirs.map((h) => ({ ...h, side: 1 })),
  ].sort((x, y) => x.start - y.start || x.end - y.end || x.side - y.side);
  let out = "";
  let pos = 0;
  for (const h of all) {
    out += base.slice(pos, h.start) + h.text;
    pos = Math.max(pos, h.end);
  }
  return out + base.slice(pos);
}
