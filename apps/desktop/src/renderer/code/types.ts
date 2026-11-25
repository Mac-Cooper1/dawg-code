/** What the code views (`editors.tsx`) and the panes using them share. */
import type { TextDocument } from "./documents.ts";

/** The two sides of a diff: the base version and the working tree's. */
export type DiffSide = "original" | "modified";

/** Whole lines, 1-based and inclusive, on one side of a diff. */
export interface LineRange {
  side: DiffSide;
  startLine: number;
  endLine: number;
}

/** A line range to mark in a diff (a comment waiting to be sent). */
export interface LineMark extends LineRange {
  id: string;
  /** For the tooltip. */
  text: string;
}

/** A request to bring a line into view; a new `nonce` repeats it. */
export interface RevealRequest {
  side: DiffSide;
  line: number;
  nonce: number;
}

export interface CodeEditorProps {
  document: TextDocument;
  /** The accessible name: "Edit src/tally/money.py". */
  label: string;
  readOnly?: boolean;
  /** ⌘S inside the editor. */
  onSave?(): void;
}

export interface DiffEditorProps {
  /** The file's path, for its language. */
  path: string;
  /** The base version ("" for a new file). */
  original: string;
  /** The working tree's version ("" for a deleted file). */
  modified: string;
  /** One column with removed lines above added ones, instead of two side by side. */
  inline: boolean;
  /** The accessible name: "Changes to src/tally/money.py". */
  label: string;
  marks: readonly LineMark[];
  reveal: RevealRequest | null;
  /** The lines the cursor or selection covers, in the side that has focus. */
  onSelectLines(range: LineRange): void;
  /** The "+" beside a line was pressed: comment on that line, or on the selection holding it. */
  onCommentRequest(range: LineRange): void;
}
