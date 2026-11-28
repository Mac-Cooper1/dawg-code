/**
 * Contract between the transcript (this folder and ../cards, ../markdown) and the app shell that
 * renders it. The app shell passes a `TranscriptView` from `selectTranscript` and wires the
 * callbacks to store actions.
 */
import type { PermissionResponse, PlanResponse, QuestionResponse, SessionId } from "@dawg/protocol";
import type { ElicitationAnswer, TranscriptView } from "../state/types.ts";
import type { ForkMarkerView } from "./ForkMarker.tsx";

export interface TranscriptProps {
  sessionId: SessionId;
  view: TranscriptView;
  /** For shortening paths outside the session's directory to "~/…". */
  homeDir: string;
  /**
   * True when the composer is empty: a newly pending card may then take focus (its primary
   * action), so ⏎ / ⌘⏎ / esc answer it. With text in the composer, focus stays there.
   */
  autoFocusPendingCard: boolean;
  onSetItemOpen(itemId: string, open: boolean): void;
  onShowCardAgain(requestId: string, shown: boolean): void;
  onRespondPermission(requestId: string, response: PermissionResponse): void;
  onRespondQuestion(requestId: string, response: QuestionResponse): void;
  onRespondPlan(requestId: string, response: PlanResponse): void;
  /** Answers an MCP server's request for input (a form, or a page it asks to open). */
  onRespondElicitation(requestId: string, answer: ElicitationAnswer): void;
  /** Opens a link from model output, after the person has seen the full URL. */
  onOpenLink(url: string): void;
  /** Opens a file in the Changes pane. The link is hidden when absent (the pane comes later). */
  onOpenInChanges?(filePath: string): void;
  /** Opens the project trust dialog, for hooks that wait for approval. Hidden when absent. */
  onReviewProjectCode?(projectDir: string): void;
  /** Shows a subagent's transcript, from its card. "Open transcript" is hidden when absent. */
  onOpenSubagent?(agentId: string): void;
  /**
   * For a forked session (a rewind's, or a plain fork): where it came from, for the marker where
   * its own conversation starts. Null or absent for any other session.
   */
  fork?: ForkMarkerView | null;
  /** Opens the session a fork came from, from the marker. Its button is hidden when absent. */
  onOpenOriginal?(): void;
}
