/**
 * The Changes pane's state that outlives the pane (the dock unmounts hidden panes): review
 * comments waiting to be sent and the selected file, per session, and the diff layout.
 *
 * Kept in a small store of its own rather than the app store: it is UI state only this pane uses.
 */
import type { SessionId } from "@dawg/protocol";
import { createStore, useStore } from "zustand";
import type { DiffSide } from "../../code/types.ts";
import { displayPath } from "../../lib/format.ts";

export interface ReviewComment {
  id: string;
  /** Absolute. */
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  text: string;
  /** The lines commented on, as they read then, quoted for dawg. */
  quote: string[];
}

export type DiffLayout = "side-by-side" | "inline";

/** A line to bring into view once its file shows. */
export interface RevealTarget {
  path: string;
  side: DiffSide;
  line: number;
  /** Repeats the same request. */
  nonce: number;
}

interface ReviewState {
  comments: Record<SessionId, ReviewComment[]>;
  selected: Record<SessionId, string>;
  reveal: Record<SessionId, RevealTarget>;
  layout: DiffLayout;
}

const INITIAL: ReviewState = { comments: {}, selected: {}, reveal: {}, layout: "side-by-side" };

export const reviewStore = createStore<ReviewState>(() => INITIAL);

const NO_COMMENTS: ReviewComment[] = [];

export function useReview<T>(selector: (state: ReviewState) => T): T {
  return useStore(reviewStore, selector);
}

export function commentsOf(state: ReviewState, sessionId: SessionId): ReviewComment[] {
  return state.comments[sessionId] ?? NO_COMMENTS;
}

let nextId = 1;

export function addComment(sessionId: SessionId, comment: Omit<ReviewComment, "id">): void {
  reviewStore.setState((state) => ({
    comments: {
      ...state.comments,
      [sessionId]: [...commentsOf(state, sessionId), { ...comment, id: `comment-${nextId++}` }],
    },
  }));
}

export function removeComment(sessionId: SessionId, id: string): void {
  reviewStore.setState((state) => ({
    comments: {
      ...state.comments,
      [sessionId]: commentsOf(state, sessionId).filter((comment) => comment.id !== id),
    },
  }));
}

export function clearComments(sessionId: SessionId): void {
  reviewStore.setState((state) => {
    const { [sessionId]: _cleared, ...rest } = state.comments;
    return { comments: rest };
  });
}

export function selectFile(sessionId: SessionId, path: string): void {
  reviewStore.setState((state) => ({ selected: { ...state.selected, [sessionId]: path } }));
}

let nextReveal = 1;

/** Selects a file and shows one of its lines. */
export function revealLine(sessionId: SessionId, path: string, side: DiffSide, line: number): void {
  reviewStore.setState((state) => ({
    selected: { ...state.selected, [sessionId]: path },
    reveal: { ...state.reveal, [sessionId]: { path, side, line, nonce: nextReveal++ } },
  }));
}

export function setDiffLayout(layout: DiffLayout): void {
  reviewStore.setState({ layout });
}

/** Tests: back to no comments and no selection. */
export function resetReview(): void {
  reviewStore.setState(INITIAL, true);
}

/** "14" or "14-16". */
export function lineLabel(comment: Pick<ReviewComment, "startLine" | "endLine">): string {
  return comment.startLine === comment.endLine
    ? String(comment.startLine)
    : `${comment.startLine}-${comment.endLine}`;
}

/** How many quoted lines a comment carries before "…". */
const QUOTE_LINES = 6;

/**
 * The comments as one message for dawg: each as `path:line` (relative to the session's folder),
 * the lines it is about, quoted, and the comment.
 */
export function reviewMessage(
  comments: readonly ReviewComment[],
  cwd: string,
  homeDir: string,
): string {
  const blocks = comments.map((comment) => {
    const where = `${displayPath(comment.path, cwd, homeDir)}:${lineLabel(comment)}`;
    const heading =
      comment.side === "original" ? `${where} (the lines as they were before the change)` : where;
    const quoted = comment.quote.slice(0, QUOTE_LINES).map((line) => `> ${line}`);
    if (comment.quote.length > QUOTE_LINES) quoted.push("> …");
    return [heading, ...quoted, comment.text.trim()].join("\n");
  });
  const intro = comments.length === 1 ? "A comment on the changes:" : "Comments on the changes:";
  return [intro, ...blocks].join("\n\n");
}
