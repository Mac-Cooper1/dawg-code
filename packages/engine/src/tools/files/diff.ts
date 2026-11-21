import type { DiffDisplay, DiffHunk } from "@dawg/protocol";
import { structuredPatch } from "diff";

/** Above this many characters on either side the diff is skipped rather than risk a slow one. */
const MAX_DIFF_CHARS = 10 * 1024 * 1024;
const DIFF_TIMEOUT_MS = 2000;

/**
 * The diff a client shows for a change to `filePath`. `before` is null when the file was created.
 * Line endings are compared as "\n" so a CRLF file does not show "\r" in every line.
 */
export function buildDiffDisplay(
  filePath: string,
  before: string | null,
  after: string,
): DiffDisplay {
  const oldText = (before ?? "").replace(/\r\n/g, "\n");
  const newText = after.replace(/\r\n/g, "\n");
  const empty: DiffDisplay = {
    kind: "diff",
    filePath,
    created: before === null,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
  if (oldText === newText || oldText.length > MAX_DIFF_CHARS || newText.length > MAX_DIFF_CHARS) {
    return empty;
  }
  const patch = structuredPatch("", "", oldText, newText, undefined, undefined, {
    context: 3,
    timeout: DIFF_TIMEOUT_MS,
  });
  if (patch === undefined) return empty;
  let additions = 0;
  let deletions = 0;
  const hunks: DiffHunk[] = patch.hunks.map((h) => {
    // jsdiff adds "\ No newline at end of file" markers; the display format has no place for them.
    const lines = h.lines.filter((l) => l[0] === " " || l[0] === "+" || l[0] === "-");
    for (const l of lines) {
      if (l[0] === "+") additions++;
      else if (l[0] === "-") deletions++;
    }
    return {
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines,
    };
  });
  return { ...empty, hunks, additions, deletions };
}
