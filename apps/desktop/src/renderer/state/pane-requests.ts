/**
 * Files the store asks the Files pane to open, for a session whose pane may not be on screen yet:
 * `/memory` opens the memory folder's MEMORY.md. The pane takes the request when it shows that
 * session, or at once when it already does.
 */
import type { SessionId } from "@dawg/protocol";

const waiting = new Map<SessionId, string>();
const listeners = new Set<() => void>();

/** Asks the session's Files pane to open `path` (absolute). A later request replaces it. */
export function requestPaneFile(sessionId: SessionId, path: string): void {
  waiting.set(sessionId, path);
  for (const listener of [...listeners]) listener();
}

/** Takes the request for `sessionId`, if there is one. */
export function takePaneFile(sessionId: SessionId): string | null {
  const path = waiting.get(sessionId) ?? null;
  waiting.delete(sessionId);
  return path;
}

/** Called whenever a request is made; returns a function that stops it. */
export function onPaneFileRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
