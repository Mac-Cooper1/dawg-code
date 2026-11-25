/**
 * Outside git there is no base to compare with, so the Changes pane lists the edits dawg made in
 * this session (from the transcript's diffs) and rebuilds each file's text from before them by
 * undoing those edits, newest first, on the file as it is now.
 */
import type { ChangedFile } from "../../../shared/bridge.ts";
import { reverseHunks } from "../../code/diff.ts";
import type { AgentEdit } from "../../code/session.ts";

/** Each file dawg edited, as the change list shows it (sorted by path). */
export function editedFiles(edits: readonly AgentEdit[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const edit of edits) {
    const existing = byPath.get(edit.path);
    if (existing) {
      existing.additions += edit.additions;
      existing.deletions += edit.deletions;
      continue;
    }
    byPath.set(edit.path, {
      path: edit.path,
      oldPath: null,
      status: edit.created ? "added" : "modified",
      additions: edit.additions,
      deletions: edit.deletions,
      binary: false,
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The edits dawg made to one file, in order. */
export function editsOf(edits: readonly AgentEdit[], path: string): AgentEdit[] {
  return edits.filter((edit) => edit.path === path);
}

/**
 * The file's text before the session's edits: "" when dawg created it. Null when the file has
 * changed in other ways since, so the edits no longer undo cleanly.
 */
export function textBeforeEdits(current: string, edits: readonly AgentEdit[]): string | null {
  let text = current;
  try {
    for (let i = edits.length - 1; i >= 0; i--) {
      text = reverseHunks(text, (edits[i] as AgentEdit).hunks);
    }
  } catch {
    return null;
  }
  if (edits[0]?.created) return text === "" ? "" : null;
  return text;
}
