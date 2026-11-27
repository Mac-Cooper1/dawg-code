/**
 * What every transcript item may need besides its own data: paths for display and the actions
 * it can take. The transcript builds one stable object per session, so memoised items do not
 * re-render when the app shell passes new callback functions.
 */
import type { PermissionResponse, PlanResponse, QuestionResponse } from "@dawg/protocol";

export interface TranscriptEnv {
  /** The session's working directory, to show paths relative to it. */
  cwd: string;
  homeDir: string;
  setItemOpen(itemId: string, open: boolean): void;
  showCardAgain(requestId: string, shown: boolean): void;
  respondPermission(requestId: string, response: PermissionResponse): void;
  respondQuestion(requestId: string, response: QuestionResponse): void;
  respondPlan(requestId: string, response: PlanResponse): void;
  openLink(url: string): void;
  /** Absent until the Changes pane exists; the "Open in Changes" link is hidden then. */
  openInChanges: ((filePath: string) => void) | null;
  /**
   * Opens the review of a project's code (the trust dialog), for the line about hooks that wait
   * for approval. Null when the shell offers none; the Review button is hidden then.
   */
  reviewProjectCode: ((projectDir: string) => void) | null;
  /**
   * Shows a subagent's own transcript, from its card ("Open transcript"). Null where there is
   * nowhere to show it (inside an agent's transcript); the button is hidden then.
   */
  openSubagent: ((agentId: string) => void) | null;
}
