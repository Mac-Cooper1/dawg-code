/**
 * The `@` menu's search: asks main for files matching the query, debounced while typing, and
 * keeps the last answer on screen until the next one arrives so the list does not flicker.
 */
import { useEffect, useRef, useState } from "react";
import type { FileMatch, FindFilesResult } from "../../shared/bridge.ts";

/** Quiet time before a search while the query keeps changing. */
export const SEARCH_DEBOUNCE_MS = 60;

export interface FileSearch {
  matches: readonly FileMatch[];
  /** The query `matches` answer; null before the first answer. */
  answered: string | null;
  /** A search for the current query is on its way. */
  loading: boolean;
  /** The working directory holds more files than are searched. */
  truncated: boolean;
  /** Why the last search failed, as a sentence. */
  error: string | null;
}

const IDLE: FileSearch = {
  matches: [],
  answered: null,
  loading: false,
  truncated: false,
  error: null,
};

function sentence(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "")
    .trim();
  if (text === "") return "Something went wrong.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Searches for `query` (null while the menu is closed). `find` should be stable for a session;
 * `scope` (the session) resets the answer when it changes.
 */
export function useFileSearch(
  query: string | null,
  find: (query: string) => Promise<FindFilesResult>,
  scope: string,
): FileSearch {
  const [state, setState] = useState<FileSearch & { scope: string }>({ ...IDLE, scope });
  const findRef = useRef(find);
  findRef.current = find;
  const latest = useRef(0);
  /** Whether an answer is on screen: the first search goes at once, later ones after a pause. */
  const answered = useRef(false);
  answered.current = state.answered !== null;

  // Another session's answers are not this one's.
  if (state.scope !== scope) setState({ ...IDLE, scope });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` restarts the search for another session
  useEffect(() => {
    if (query === null) {
      // Closed: the next `@` starts afresh instead of showing this one's answer.
      latest.current++;
      setState((current) =>
        current.answered === null && !current.loading ? current : { ...IDLE, scope: current.scope },
      );
      return;
    }
    const ticket = ++latest.current;
    setState((current) => (current.loading ? current : { ...current, loading: true }));
    // The first search (the menu just opened) goes at once; later ones wait for a pause.
    const delay = answered.current ? SEARCH_DEBOUNCE_MS : 0;
    const timer = setTimeout(() => {
      findRef.current(query).then(
        (result) => {
          if (latest.current !== ticket) return;
          setState((current) => ({
            ...current,
            matches: result.matches,
            answered: query,
            loading: false,
            truncated: result.truncated,
            error: null,
          }));
        },
        (error: unknown) => {
          if (latest.current !== ticket) return;
          setState((current) => ({
            ...current,
            matches: [],
            answered: query,
            loading: false,
            truncated: false,
            error: sentence(error),
          }));
        },
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [query, scope]);

  return query === null ? IDLE : state;
}
