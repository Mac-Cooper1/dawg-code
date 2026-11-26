/**
 * Requests from the action registry to a pane that may not be on screen yet. "New terminal" opens
 * the Terminal pane and asks it for a shell; the pane takes the request when it mounts, or at once
 * when it already shows that session.
 */
import type { SessionId } from "@dawg/protocol";
import { useEffect, useRef } from "react";

const waiting = new Set<SessionId>();
const listeners = new Set<() => void>();

/** Asks the session's Terminal pane for a new shell. */
export function requestNewTerminal(sessionId: SessionId): void {
  waiting.add(sessionId);
  for (const listener of [...listeners]) listener();
}

/** Takes the request for `sessionId`, if there is one. */
export function takeNewTerminalRequest(sessionId: SessionId): boolean {
  return waiting.delete(sessionId);
}

/** For the Terminal pane: calls `open` for each "New terminal" asked of this session. */
export function useNewTerminalRequests(sessionId: SessionId, open: () => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const take = () => {
      if (takeNewTerminalRequest(sessionId)) latest.current();
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [sessionId]);
}
