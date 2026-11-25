/**
 * The Changes pane's data: the changed files (from git, or outside git from dawg's own edits) and
 * the selected file's two versions, reloaded when files change on disk or a tool call finishes.
 */
import type { SessionId } from "@dawg/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, Hunk } from "../../../shared/bridge.ts";
import { makeHunks } from "../../code/diff.ts";
import {
  type AgentEdit,
  errorMessage,
  type SessionActivity,
  useWorkspaceChanged,
  type WorkspaceState,
  workspaceApi,
} from "../../code/session.ts";
import { commentsOf, useReview } from "./review.ts";
import { editedFiles, editsOf, textBeforeEdits } from "./sessionEdits.ts";

export type ChangeList =
  | { status: "loading" }
  | { status: "failed"; message: string }
  /** In git: everything that differs from the base. */
  | { status: "ready"; mode: "git"; files: ChangedFile[]; truncated: boolean }
  /** Outside git: the files dawg edited in this session. */
  | { status: "ready"; mode: "edits"; files: ChangedFile[] };

export type FileView =
  | { status: "none" }
  | { status: "loading"; path: string }
  | { status: "failed"; path: string; message: string }
  | { status: "binary"; path: string }
  | { status: "too-large"; path: string }
  | {
      status: "text";
      path: string;
      original: string;
      modified: string;
      /** The file is new: there is no base version. */
      added: boolean;
      /** The file was deleted. */
      deleted: boolean;
      hunks: Hunk[];
    }
  /** Outside git, when the file changed since dawg's edits: the edits as dawg made them. */
  | { status: "edits"; path: string; edits: AgentEdit[] };

export interface Changes {
  list: ChangeList;
  /** The file shown: the one picked, or the first. */
  selectedPath: string | null;
  view: FileView;
  /** Reloads the list and the shown file. */
  refresh(): void;
}

function sameView(a: FileView, b: FileView): boolean {
  if (a.status !== "text" || b.status !== "text") return false;
  return (
    a.path === b.path &&
    a.original === b.original &&
    a.modified === b.modified &&
    a.hunks.length === b.hunks.length
  );
}

export function useChanges(
  sessionId: SessionId,
  workspace: WorkspaceState,
  activity: SessionActivity,
): Changes {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useWorkspaceChanged(sessionId, refresh);

  // A finished tool call may have changed files the watcher has not reported yet.
  const finished = activity.finishedTools;
  const firstFinished = useRef(finished);
  useEffect(() => {
    if (finished !== firstFinished.current) refresh();
  }, [finished, refresh]);

  const git = workspace.status === "ready" ? workspace.info.git !== null : null;
  const [gitList, setGitList] = useState<ChangeList>({ status: "loading" });
  const [gitIsMissing, setGitIsMissing] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` asks again
  useEffect(() => {
    if (git !== true) return;
    let live = true;
    workspaceApi()
      .changes(sessionId)
      .then(
        (set) => {
          if (!live) return;
          if (set.baseCommit === null) {
            setGitIsMissing(true);
            return;
          }
          setGitIsMissing(false);
          setGitList({ status: "ready", mode: "git", files: set.files, truncated: set.truncated });
        },
        (error: unknown) => {
          if (live) setGitList({ status: "failed", message: errorMessage(error) });
        },
      );
    return () => {
      live = false;
    };
  }, [sessionId, git, revision]);

  const editsList = useMemo<ChangeList>(
    () => ({ status: "ready", mode: "edits", files: editedFiles(activity.edits) }),
    [activity.edits],
  );

  let list: ChangeList;
  if (workspace.status === "loading") list = { status: "loading" };
  else if (workspace.status === "failed") list = { status: "failed", message: workspace.message };
  else if (git === false || gitIsMissing) list = editsList;
  else list = gitList;

  const picked = useReview((state) => state.selected[sessionId] ?? null);
  const files = list.status === "ready" ? list.files : null;
  const selectedPath =
    files === null
      ? null
      : files.some((file) => file.path === picked)
        ? picked
        : (files[0]?.path ?? null);
  const mode = list.status === "ready" ? list.mode : null;
  const editsOfFile = useMemo(
    () => (selectedPath && mode === "edits" ? editsOf(activity.edits, selectedPath) : []),
    [selectedPath, mode, activity.edits],
  );

  const [view, setView] = useState<FileView>({ status: "none" });
  const request = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` asks again
  useEffect(() => {
    const ticket = ++request.current;
    const show = (next: FileView) => {
      if (ticket !== request.current) return;
      setView((previous) => (sameView(previous, next) ? previous : next));
    };
    if (!selectedPath || !mode) {
      show({ status: "none" });
      return;
    }
    setView((previous) =>
      "path" in previous && previous.path === selectedPath
        ? previous
        : { status: "loading", path: selectedPath },
    );
    const path = selectedPath;
    const api = workspaceApi();
    if (mode === "git") {
      api.fileDiff({ sessionId, path }).then(
        (diff) => {
          if (diff.binary) show({ status: "binary", path });
          else if (diff.tooLarge) show({ status: "too-large", path });
          else {
            show({
              status: "text",
              path,
              original: diff.original ?? "",
              modified: diff.modified ?? "",
              added: diff.original === null,
              deleted: diff.modified === null,
              hunks: diff.hunks,
            });
          }
        },
        (error: unknown) => show({ status: "failed", path, message: errorMessage(error) }),
      );
      return;
    }
    api.readFile({ sessionId, path }).then(
      (file) => {
        if (file.binary) return show({ status: "binary", path });
        if (file.tooLarge || file.content === null) return show({ status: "too-large", path });
        const before = textBeforeEdits(file.content, editsOfFile);
        if (before === null) return show({ status: "edits", path, edits: editsOfFile });
        show({
          status: "text",
          path,
          original: before,
          modified: file.content,
          added: editsOfFile[0]?.created ?? false,
          deleted: false,
          hunks: makeHunks(before, file.content),
        });
      },
      // Gone, or out of reach: show the edits as dawg made them.
      () => show({ status: "edits", path, edits: editsOfFile }),
    );
  }, [sessionId, selectedPath, mode, editsOfFile, revision]);

  return { list, selectedPath, view, refresh };
}

/** The comments waiting in this session. */
export function useComments(sessionId: SessionId) {
  return useReview((state) => commentsOf(state, sessionId));
}
