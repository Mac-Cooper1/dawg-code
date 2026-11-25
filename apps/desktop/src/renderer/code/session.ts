/**
 * What the Changes and Files panes read about a session: its folders (from the store), its
 * workspace (registered with main through `workspace.track`), and the edits dawg made (from the
 * transcript's diffs).
 */
import type { DiffHunk, SessionId } from "@dawg/protocol";
import { useEffect, useRef, useState } from "react";
import type { DawgBridge, WorkspaceChangedEvent, WorkspaceInfo } from "../../shared/bridge.ts";
import { getBridge } from "../bridge/index.ts";
import { useAppStore } from "../state/store.ts";
import type { AppStore, TranscriptItem } from "../state/types.ts";

export function workspaceApi(): DawgBridge["workspace"] {
  return getBridge().workspace;
}

/** A failure as one sentence for the pane, without Electron's "Error invoking remote method…". */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const cleaned = text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
  return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
}

export interface SessionFolders {
  cwd: string;
  projectDir: string;
  additionalDirectories: string[];
}

const NO_DIRECTORIES: string[] = [];

/** The session's working directory, project and additional directories; null if it is gone. */
export function useSessionFolders(sessionId: SessionId): SessionFolders | null {
  const cwd = useAppStore((state) => state.sessions[sessionId]?.summary.cwd ?? null);
  const projectDir = useAppStore((state) => state.sessions[sessionId]?.summary.projectDir ?? null);
  const additionalDirectories = useAppStore(
    (state) => state.sessions[sessionId]?.additionalDirectories ?? NO_DIRECTORIES,
  );
  const memo = useRef<SessionFolders | null>(null);
  if (cwd === null || projectDir === null) return null;
  const previous = memo.current;
  if (
    previous &&
    previous.cwd === cwd &&
    previous.projectDir === projectDir &&
    previous.additionalDirectories === additionalDirectories
  ) {
    return previous;
  }
  memo.current = { cwd, projectDir, additionalDirectories };
  return memo.current;
}

export type WorkspaceState =
  | { status: "loading" }
  | { status: "ready"; info: WorkspaceInfo }
  | { status: "failed"; message: string };

/**
 * Registers the session's folders with main (calling again is harmless) and returns what main
 * knows: the repository, its branch and the base the Changes pane compares with. `retry` asks
 * again after a failure.
 */
export function useWorkspace(
  sessionId: SessionId,
  folders: SessionFolders | null,
): { state: WorkspaceState; retry(): void } {
  const [state, setState] = useState<WorkspaceState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again
  useEffect(() => {
    if (!folders) return;
    let live = true;
    setState((previous) =>
      previous.status === "ready" && previous.info.sessionId === sessionId
        ? previous
        : { status: "loading" },
    );
    workspaceApi()
      .track({
        sessionId,
        cwd: folders.cwd,
        projectDir: folders.projectDir,
        additionalDirectories: folders.additionalDirectories,
      })
      .then(
        (info) => {
          if (live) setState({ status: "ready", info });
        },
        (error: unknown) => {
          if (live) setState({ status: "failed", message: errorMessage(error) });
        },
      );
    return () => {
      live = false;
    };
  }, [sessionId, folders, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

/** Calls `listener` for files changed on disk under this session's folders. */
export function useWorkspaceChanged(
  sessionId: SessionId,
  listener: (event: WorkspaceChangedEvent) => void,
): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(
    () =>
      workspaceApi().onChanged((event) => {
        if (event.sessionId === sessionId) latest.current(event);
      }),
    [sessionId],
  );
}

// ---------------------------------------------------------------------------------------------
// dawg's edits, from the transcript
// ---------------------------------------------------------------------------------------------

/** One edit dawg made: a finished Edit, MultiEdit or Write call that shows a diff. */
export interface AgentEdit {
  toolCallId: string;
  /** Absolute. */
  path: string;
  /** The file did not exist before. */
  created: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface SessionActivity {
  /** In the order dawg made them. */
  edits: readonly AgentEdit[];
  /** Tool calls finished so far: when it grows, files may have changed. */
  finishedTools: number;
}

const EMPTY_ACTIVITY: SessionActivity = { edits: [], finishedTools: 0 };
const activityByItems = new WeakMap<readonly TranscriptItem[], SessionActivity>();
const lastActivity = new Map<SessionId, SessionActivity>();

function sameEdits(a: readonly AgentEdit[], b: readonly AgentEdit[]): boolean {
  return (
    a.length === b.length && a.every((edit, index) => edit.toolCallId === b[index]?.toolCallId)
  );
}

/** Exported for tests. Stable for unchanged edits and counts, so components can subscribe. */
export function selectSessionActivity(state: AppStore, sessionId: SessionId): SessionActivity {
  const items = state.transcripts[sessionId];
  if (!items) return EMPTY_ACTIVITY;
  const cached = activityByItems.get(items);
  if (cached) return cached;
  const edits: AgentEdit[] = [];
  let finishedTools = 0;
  for (const item of items) {
    if (item.kind !== "tool" || item.state === "running") continue;
    finishedTools++;
    const display = item.display;
    if (item.state !== "success" || display?.kind !== "diff") continue;
    edits.push({
      toolCallId: item.toolCallId,
      path: display.filePath,
      created: display.created,
      hunks: display.hunks,
      additions: display.additions,
      deletions: display.deletions,
    });
  }
  const previous = lastActivity.get(sessionId);
  const result =
    previous && previous.finishedTools === finishedTools && sameEdits(previous.edits, edits)
      ? previous
      : { edits, finishedTools };
  lastActivity.set(sessionId, result);
  activityByItems.set(items, result);
  return result;
}

export function useSessionActivity(sessionId: SessionId): SessionActivity {
  return useAppStore((state) => selectSessionActivity(state, sessionId));
}

/** What dawg did to each file it touched: created it, or edited it. */
export function touchedFiles(edits: readonly AgentEdit[]): Map<string, "created" | "edited"> {
  const touched = new Map<string, "created" | "edited">();
  for (const edit of edits) {
    if (!touched.has(edit.path)) touched.set(edit.path, edit.created ? "created" : "edited");
  }
  return touched;
}
