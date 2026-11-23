/**
 * Contract between the transcript (this folder and ../cards, ../markdown) and the app shell that
 * renders it. The app shell passes a `TranscriptView` from `selectTranscript` and wires the
 * callbacks to store actions.
 */
import type { PermissionResponse, PlanResponse, QuestionResponse, SessionId } from "@dawg/protocol";
import type { TranscriptView } from "../state/types.ts";

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
  /** Opens a link from model output, after the person has seen the full URL. */
  onOpenLink(url: string): void;
  /** Opens a file in the Changes pane. The link is hidden when absent (the pane comes later). */
  onOpenInChanges?(filePath: string): void;
}
