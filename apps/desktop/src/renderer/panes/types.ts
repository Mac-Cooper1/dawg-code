/** What every side pane is given. The dock shows panes only while a session is selected. */
import type { SessionId } from "@dawg/protocol";

export interface PaneProps {
  /** The selected session. A pane reads the rest from the store (`useAppStore`). */
  sessionId: SessionId;
}
