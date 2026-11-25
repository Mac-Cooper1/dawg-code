/**
 * Reads a background command's output while its viewer is open, and follows it while the command
 * runs: each read starts where the last one stopped (`nextOffset`), once a second, until the
 * engine says everything was read (`done`).
 *
 * Long output shows its end: when more than `TAIL_BYTES` are waiting at the first read, reading
 * starts that far from the end, and the viewer keeps at most `KEEP_CHARS` characters.
 */
import type { SessionId } from "@dawg/protocol";
import { useEffect, useRef, useState } from "react";
import type { AppActions } from "../../state/types.ts";

export const POLL_MS = 1000;
export const TAIL_BYTES = 256 * 1024;
export const KEEP_CHARS = 512 * 1024;

export interface OutputState {
  text: string;
  /** Earlier output is left out. */
  truncated: boolean;
  /** Nothing has been read yet. */
  loading: boolean;
  /** Everything was read and the command has ended. */
  done: boolean;
  /** Why the last read failed, as a sentence. */
  error: string | null;
}

const INITIAL: OutputState = {
  text: "",
  truncated: false,
  loading: true,
  done: false,
  error: null,
};

export function useBackgroundOutput(
  read: AppActions["readBackgroundOutput"],
  sessionId: SessionId,
  taskId: string,
  options: { open: boolean; running: boolean },
): OutputState {
  const [state, setState] = useState<OutputState>(INITIAL);
  const running = useRef(options.running);
  running.current = options.running;
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!options.open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;
    let text = "";
    let truncated = false;
    setState(INITIAL);

    const next = async (): Promise<void> => {
      const result = await readRef.current(sessionId, taskId, offset);
      if (cancelled) return;
      if ("error" in result) {
        setState((current) => ({ ...current, loading: false, error: result.error }));
        // Try again while it runs: the engine may have been busy or restarting.
        if (running.current) timer = setTimeout(() => void next(), POLL_MS * 3);
        return;
      }
      if (offset === 0 && result.totalBytes - result.nextOffset > TAIL_BYTES) {
        offset = result.totalBytes - TAIL_BYTES;
        truncated = true;
        return next();
      }
      offset = result.nextOffset;
      text += result.text;
      if (text.length > KEEP_CHARS) {
        text = text.slice(-KEEP_CHARS);
        truncated = true;
      }
      setState({ text, truncated, loading: false, done: result.done, error: null });
      if (result.done) return;
      if (result.nextOffset < result.totalBytes) return next();
      // Everything written so far is in; the engine says `done` once the command has ended.
      timer = setTimeout(() => void next(), POLL_MS);
    };

    void next();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [options.open, sessionId, taskId]);

  return state;
}
