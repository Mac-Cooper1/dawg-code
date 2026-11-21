/**
 * What the model has been told, read back from its view.
 *
 * Facts that change after the session starts (the mode, the date) reach the model as appended
 * notes. To know whether a new note is due, the runtime compares the current fact with the last
 * one the model was told. That last fact is read from the view itself rather than kept on the
 * side, by matching note messages against the assembler's rendering of each possible note: the
 * rendering is deterministic, so a live session and the same session resumed from its file always
 * agree on what the model knows, and so on what the next request holds.
 */
import type { PermissionMode } from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { PromptAssembler } from "../contracts/prompt.ts";

const MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

function key(message: Message): string | null {
  if (message.role !== "user" || message.kind !== "note") return null;
  return JSON.stringify(message.content);
}

/** The mode the model was last told about; "default" when it was never told. */
export function knownMode(view: readonly Message[], assembler: PromptAssembler): PermissionMode {
  const renders = new Map<string, PermissionMode>();
  for (const mode of MODES) {
    for (const note of [
      assembler.note({ type: "mode_changed", mode }),
      assembler.note({ type: "plan_approved", mode }),
    ]) {
      const k = key(note);
      if (k !== null) renders.set(k, mode);
    }
  }
  let known: PermissionMode = "default";
  for (const message of view) {
    const k = key(message);
    const mode = k === null ? undefined : renders.get(k);
    if (mode !== undefined) known = mode;
  }
  return known;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MAX_DAYS = 3660;

/**
 * The date the model was last told: the session's start date, or a later one from a
 * "date changed" note. Only dates from the start up to `today` can have been noted.
 */
export function knownDate(
  view: readonly Message[],
  assembler: PromptAssembler,
  startDate: string,
  today: string,
): string {
  const renders = new Map<string, string>();
  const [y, m, d] = startDate.split("-").map(Number);
  // Noon avoids skipping or repeating a day across daylight-saving changes.
  const cursor = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  for (let i = 0; i < MAX_DAYS; i++) {
    const date = localDate(cursor.getTime());
    if (date > today) break;
    const k = key(assembler.note({ type: "date_changed", date }));
    if (k !== null) renders.set(k, date);
    cursor.setDate(cursor.getDate() + 1);
  }
  let known = startDate;
  for (const message of view) {
    const k = key(message);
    const date = k === null ? undefined : renders.get(k);
    if (date !== undefined) known = date;
  }
  return known;
}
