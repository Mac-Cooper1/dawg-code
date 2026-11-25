/**
 * The Changes pane: every file that differs from the session's base (or, outside git, every file
 * dawg edited), the selected file's diff, comments on lines that go to dawg as one message, and
 * reverting a file or one change after a confirmation.
 */
import type { SessionId } from "@dawg/protocol";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangedFile, Hunk } from "../../../shared/bridge.ts";
import { run } from "../../app/run.ts";
import { splitLines } from "../../code/diff.ts";
import { DiffEditor } from "../../code/editors.tsx";
import {
  errorMessage,
  useSessionActivity,
  useSessionFolders,
  useWorkspace,
  workspaceApi,
} from "../../code/session.ts";
import type { LineMark, LineRange, RevealRequest } from "../../code/types.ts";
import { basename, displayPath, formatBytes } from "../../lib/format.ts";
import { useActions, useAppStore } from "../../state/store.ts";
import { DiffView } from "../../transcript/DiffView.tsx";
import { Button, ConfirmDialog, IconButton } from "../../ui/index.ts";
import { requestOpenFile } from "../files/store.ts";
import { PaneEmpty } from "../PaneEmpty.tsx";
import type { PaneProps } from "../types.ts";
import styles from "./ChangesPane.module.css";
import {
  addComment,
  clearComments,
  type DiffLayout,
  lineLabel,
  type ReviewComment,
  removeComment,
  revealLine,
  reviewMessage,
  selectFile,
  setDiffLayout,
  useReview,
} from "./review.ts";
import { type FileView, useChanges, useComments } from "./useChanges.ts";

/** Narrower than this, the diff shows inline whatever was chosen. */
const SIDE_BY_SIDE_MIN_WIDTH = 640;

const STATUS: Record<ChangedFile["status"], { letter: string; label: string; tone: string }> = {
  modified: { letter: "M", label: "modified", tone: styles.amber ?? "" },
  added: { letter: "A", label: "added", tone: styles.green ?? "" },
  untracked: { letter: "U", label: "new, not yet in git", tone: styles.green ?? "" },
  deleted: { letter: "D", label: "deleted", tone: styles.red ?? "" },
  renamed: { letter: "R", label: "renamed", tone: styles.blue ?? "" },
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count.toLocaleString("en-US")} ${many}`;
}

function linesWord(range: { startLine: number; endLine: number }): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}–${range.endLine}`;
}

/** The pane's width, kept current (0 until measured). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(Math.round(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Where a change starts: its first added or removed line, on the side that shows it. */
export function hunkTarget(hunk: Hunk, inline: boolean): Omit<RevealRequest, "nonce"> {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) return { side: "modified", line: Math.max(1, newLine) };
    if (line.startsWith("-")) {
      return inline
        ? { side: "modified", line: Math.max(1, newLine) }
        : { side: "original", line: Math.max(1, oldLine) };
    }
    oldLine++;
    newLine++;
  }
  return { side: "modified", line: Math.max(1, hunk.newStart) };
}

/** The change holding a line, if one does. */
export function hunkAt(hunks: readonly Hunk[], range: LineRange): number {
  return hunks.findIndex((hunk) => {
    const start = range.side === "original" ? hunk.oldStart : hunk.newStart;
    const count = range.side === "original" ? hunk.oldLines : hunk.newLines;
    const last = Math.max(start, start + count - 1);
    return range.startLine <= last && range.endLine >= start;
  });
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" focusable="false">
      <path
        d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" focusable="false">
      <path
        d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A fresh pane per session, so nothing of one session's view shows in another's. */
export function ChangesPane({ sessionId }: PaneProps) {
  return <SessionChanges key={sessionId} sessionId={sessionId} />;
}

function SessionChanges({ sessionId }: PaneProps) {
  const folders = useSessionFolders(sessionId);
  const { state: workspace, retry } = useWorkspace(sessionId, folders);
  const activity = useSessionActivity(sessionId);
  const changes = useChanges(sessionId, workspace, activity);
  const homeDir = useAppStore((state) => state.homeDir);
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const chosenLayout = useReview((state) => state.layout);
  const narrow = width > 0 && width < SIDE_BY_SIDE_MIN_WIDTH;
  const inline = narrow || chosenLayout === "inline";

  if (!folders) return <PaneEmpty pane="changes" />;
  const cwd = folders.cwd;
  const { list } = changes;
  const git = workspace.status === "ready" ? workspace.info.git : null;

  let body: ReactNode;
  if (list.status === "loading") {
    body = (
      <p className={styles.status} role="status">
        Looking for changes…
      </p>
    );
  } else if (list.status === "failed") {
    body = (
      <div className={styles.message} role="alert">
        <p className={styles.messageTitle}>The changes could not be read</p>
        <p className={styles.error}>{list.message}</p>
        <Button onClick={workspace.status === "failed" ? retry : changes.refresh}>Try again</Button>
      </div>
    );
  } else if (list.files.length === 0) {
    body =
      list.mode === "git" ? (
        <PaneEmpty pane="changes" title="No changes yet">
          Files changed in {displayPath(cwd, cwd, homeDir) || basename(cwd)} show here, compared
          with {git?.baseLabel ?? "the base"}.
        </PaneEmpty>
      ) : (
        <PaneEmpty pane="changes" title="No edits yet">
          This folder is not a git repository, so the pane shows the edits dawg makes in this
          session.
        </PaneEmpty>
      );
  } else {
    body = (
      <>
        <FileList
          files={list.files}
          selectedPath={changes.selectedPath}
          cwd={cwd}
          homeDir={homeDir}
          onSelect={(path) => selectFile(sessionId, path)}
        />
        {list.mode === "git" && list.truncated && (
          <p className={styles.note} style={{ padding: "4px 12px" }}>
            Showing the first {list.files.length.toLocaleString("en-US")} changed files.
          </p>
        )}
        <FilePanel
          sessionId={sessionId}
          view={changes.view}
          file={list.files.find((file) => file.path === changes.selectedPath) ?? null}
          canRevert={list.mode === "git"}
          baseLabel={git?.baseLabel ?? null}
          inline={inline}
          cwd={cwd}
          homeDir={homeDir}
          onChanged={changes.refresh}
        />
      </>
    );
  }

  const baseText =
    list.status !== "ready"
      ? ""
      : list.mode === "git"
        ? `compared with ${git?.baseLabel ?? "the base"}`
        : "dawg’s edits in this session";
  const totals =
    list.status === "ready"
      ? list.files.reduce(
          (sum, file) => ({
            additions: sum.additions + file.additions,
            deletions: sum.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        )
      : null;

  return (
    <div className={styles.pane} ref={root}>
      <div className={styles.bar}>
        {list.status === "ready" && totals && (
          <>
            <span className={styles.strong}>{plural(list.files.length, "file", "files")}</span>
            <span className={styles.add}>
              +{totals.additions.toLocaleString("en-US")}
              <span className="vh"> lines added</span>
            </span>
            <span className={styles.del}>
              −{totals.deletions.toLocaleString("en-US")}
              <span className="vh"> lines removed</span>
            </span>
          </>
        )}
        <span className={`${styles.muted} ${styles.grow} ${styles.ellipsis}`} title={baseText}>
          {baseText}
        </span>
        <LayoutSwitch layout={inline ? "inline" : "side-by-side"} narrow={narrow} />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Refresh the changes"
          title="Refresh the changes"
          onClick={changes.refresh}
        >
          <RefreshIcon />
        </button>
      </div>
      {body}
      <CommentTray sessionId={sessionId} cwd={cwd} homeDir={homeDir} />
    </div>
  );
}

function LayoutSwitch(props: { layout: DiffLayout; narrow: boolean }) {
  const option = (value: DiffLayout, label: string) => (
    <button
      type="button"
      className={styles.segment}
      aria-pressed={props.layout === value}
      disabled={props.narrow && value === "side-by-side"}
      title={
        props.narrow && value === "side-by-side" ? "Widen the pane to see both sides" : undefined
      }
      onClick={() => setDiffLayout(value)}
    >
      {label}
    </button>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a form field set
    <span className={styles.segmented} role="group" aria-label="Diff layout">
      {option("side-by-side", "Side by side")}
      {option("inline", "Inline")}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The changed files
// ---------------------------------------------------------------------------------------------

function FileList(props: {
  files: readonly ChangedFile[];
  selectedPath: string | null;
  cwd: string;
  homeDir: string;
  onSelect(path: string): void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const buttons = [...(listRef.current?.querySelectorAll("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(buttons.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    const target = buttons[next];
    const path = props.files[next]?.path;
    if (target && path) {
      target.focus();
      props.onSelect(path);
    }
  }

  return (
    <ul className={styles.files} aria-label="Changed files" ref={listRef} onKeyDown={onKeyDown}>
      {props.files.map((file) => {
        const status = STATUS[file.status];
        const relative = displayPath(file.path, props.cwd, props.homeDir);
        const slash = relative.lastIndexOf("/");
        const counts = file.binary
          ? "binary"
          : `${plural(file.additions, "line", "lines")} added, ${file.deletions} removed`;
        const selected = file.path === props.selectedPath;
        return (
          <li key={file.path}>
            <button
              type="button"
              className={styles.file}
              aria-current={selected ? "true" : undefined}
              tabIndex={
                selected || (props.selectedPath === null && file === props.files[0]) ? 0 : -1
              }
              aria-label={`${relative}, ${status.label}, ${counts}`}
              title={
                file.oldPath
                  ? `Renamed from ${displayPath(file.oldPath, props.cwd, props.homeDir)}`
                  : relative
              }
              onClick={() => props.onSelect(file.path)}
            >
              <span className={`${styles.badge} ${status.tone}`} aria-hidden="true">
                {status.letter}
              </span>
              <span className={styles.path}>
                <span className={styles.pathText}>
                  {slash > -1 && <span className={styles.dir}>{relative.slice(0, slash + 1)}</span>}
                  {relative.slice(slash + 1)}
                </span>
              </span>
              <span className={styles.counts} aria-hidden="true">
                {file.binary ? (
                  <span className={styles.muted}>binary</span>
                ) : (
                  <>
                    <span className={styles.add}>+{file.additions}</span>
                    <span className={styles.del}>−{file.deletions}</span>
                  </>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// The shown file: its diff, moving between changes, comments and reverting
// ---------------------------------------------------------------------------------------------

type Confirming = { kind: "file" } | { kind: "hunk"; index: number } | null;

function FilePanel(props: {
  sessionId: SessionId;
  view: FileView;
  file: ChangedFile | null;
  canRevert: boolean;
  baseLabel: string | null;
  inline: boolean;
  cwd: string;
  homeDir: string;
  onChanged(): void;
}) {
  const { sessionId, view, file, cwd, homeDir } = props;
  const actions = useActions();
  const path = file?.path ?? null;
  const relative = path ? displayPath(path, cwd, homeDir) : "";
  const textView = view.status === "text" && view.path === path ? view : null;
  const hunks = textView?.hunks ?? [];

  const [current, setCurrent] = useState(0);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [selection, setSelection] = useState<LineRange | null>(null);
  const [composing, setComposing] = useState<LineRange | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const nonce = useRef(0);

  // A different file starts at its first change, with nothing selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the file changes
  useEffect(() => {
    setCurrent(0);
    setSelection(null);
    setComposing(null);
    setFailure(null);
    setReveal(null);
  }, [path]);

  // A comment in the list was chosen: show its lines.
  const wanted = useReview((state) => state.reveal[sessionId] ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request moves the view
  useEffect(() => {
    if (!wanted || wanted.path !== path) return;
    const side = props.inline ? "modified" : wanted.side;
    setReveal({ side, line: wanted.line, nonce: ++nonce.current });
  }, [wanted, path]);

  const index = Math.min(current, Math.max(0, hunks.length - 1));
  const allComments = useComments(sessionId);
  const marks = useMemo<LineMark[]>(
    () =>
      allComments
        .filter((comment) => comment.path === path)
        .map((comment) => ({
          id: comment.id,
          side: comment.side,
          startLine: comment.startLine,
          endLine: comment.endLine,
          text: comment.text,
        })),
    [allComments, path],
  );

  function goTo(next: number) {
    const hunk = hunks[next];
    if (!hunk) return;
    setCurrent(next);
    setReveal({ ...hunkTarget(hunk, props.inline), nonce: ++nonce.current });
  }

  function onSelectLines(range: LineRange) {
    setSelection(range);
    const found = hunkAt(hunks, range);
    if (found !== -1) setCurrent(found);
  }

  async function revert(target: Confirming) {
    if (!path || !target) return;
    setFailure(null);
    try {
      const hunk = target.kind === "hunk" ? hunks[target.index] : undefined;
      await workspaceApi().revert({ sessionId, path, ...(hunk ? { hunk } : {}) });
    } catch (error) {
      setFailure(errorMessage(error));
    }
    props.onChanged();
  }

  if (!file || !path) return null;
  const fileName = basename(path);
  const base = props.baseLabel ?? "the base";
  const commentRange = selection;

  let content: ReactNode;
  if (
    view.status === "none" ||
    ("path" in view && view.path !== path) ||
    view.status === "loading"
  ) {
    content = (
      <p className={styles.status} role="status">
        Loading the diff…
      </p>
    );
  } else if (view.status === "failed") {
    content = (
      <div className={styles.message} role="alert">
        <p className={styles.messageTitle}>The diff could not be read</p>
        <p className={styles.error}>{view.message}</p>
        <Button onClick={props.onChanged}>Try again</Button>
      </div>
    );
  } else if (view.status === "binary") {
    content = (
      <div className={styles.message}>
        <p className={styles.messageTitle}>{fileName} is a binary file</p>
        <p>There is no text diff to show.</p>
      </div>
    );
  } else if (view.status === "too-large") {
    content = (
      <div className={styles.message}>
        <p className={styles.messageTitle}>{fileName} is too large to compare here</p>
        <p>Files over {formatBytes(5 * 1024 * 1024)} are not shown as a diff.</p>
      </div>
    );
  } else if (view.status === "edits") {
    content = (
      <div className={styles.editsView}>
        <p className={styles.note}>
          {fileName} has changed since dawg edited it, so these are dawg’s edits as it made them.
        </p>
        {view.edits.map((edit) => (
          <DiffView key={edit.toolCallId} hunks={edit.hunks} />
        ))}
      </div>
    );
  } else {
    content = (
      <DiffEditor
        path={path}
        original={view.original}
        modified={view.modified}
        inline={props.inline}
        label={`Changes to ${relative}`}
        marks={marks}
        reveal={reveal}
        onSelectLines={onSelectLines}
        onCommentRequest={(range) => {
          setSelection(range);
          setComposing(range);
        }}
      />
    );
  }

  return (
    <section className={styles.panel} aria-label={`Diff of ${relative}`}>
      <div className={styles.toolbar}>
        <span className={styles.toolbarPath} title={relative}>
          {relative}
        </span>
        {textView && hunks.length > 0 && (
          <span className={styles.hunkNav}>
            <span>
              Change {index + 1} of {hunks.length}
            </span>
            <button
              type="button"
              className={styles.segment}
              aria-label="Previous change"
              title="Previous change"
              disabled={index === 0}
              onClick={() => goTo(index - 1)}
            >
              <Chevron up />
            </button>
            <button
              type="button"
              className={styles.segment}
              aria-label="Next change"
              title="Next change"
              disabled={index >= hunks.length - 1}
              onClick={() => goTo(index + 1)}
            >
              <Chevron up={false} />
            </button>
          </span>
        )}
        {textView && (
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            disabled={commentRange === null}
            title={
              commentRange ? undefined : "Select lines in the diff first, or press + beside a line"
            }
            onClick={() => commentRange && setComposing(commentRange)}
          >
            {commentRange ? `Comment on ${linesWord(commentRange)}` : "Comment"}
          </Button>
        )}
        {props.canRevert && textView && hunks.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setConfirming({ kind: "hunk", index })}>
            Revert change
          </Button>
        )}
        {props.canRevert && view.status !== "loading" && (
          <Button size="sm" variant="ghost" onClick={() => setConfirming({ kind: "file" })}>
            Revert file
          </Button>
        )}
        {file.status !== "deleted" && (
          <Button
            size="sm"
            variant="ghost"
            icon="file"
            onClick={() => {
              requestOpenFile(sessionId, path);
              actions.openPane("files");
            }}
          >
            Open in Files
          </Button>
        )}
      </div>
      {failure && (
        <p className={styles.alert} role="alert">
          {failure}
        </p>
      )}
      {content}
      {composing && textView && (
        <CommentForm
          key={`${composing.side}:${composing.startLine}:${composing.endLine}`}
          title={`Comment on ${fileName}, ${linesWord(composing)}${composing.side === "original" ? " (before the change)" : ""}`}
          onCancel={() => setComposing(null)}
          onAdd={(text) => {
            const source = composing.side === "original" ? textView.original : textView.modified;
            const quote = splitLines(source).lines.slice(
              composing.startLine - 1,
              composing.endLine,
            );
            addComment(sessionId, { path, ...composing, text, quote });
            setComposing(null);
          }}
        />
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={confirming?.kind === "hunk" ? "Revert this change?" : `Revert ${fileName}?`}
        confirmLabel={confirming?.kind === "hunk" ? "Revert change" : "Revert file"}
        destructive
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          run(revert(target));
        }}
      >
        {confirming?.kind === "hunk"
          ? `Change ${confirming.index + 1} of ${fileName} goes back to how it was in ${base}.`
          : file.status === "added" || file.status === "untracked"
            ? `${fileName} is new, so reverting it deletes the file.`
            : file.status === "deleted"
              ? `${fileName} comes back as it was in ${base}.`
              : `Every change to ${fileName} since ${base} is undone.`}{" "}
        You can’t undo this here.
      </ConfirmDialog>
    </section>
  );
}

function CommentForm(props: { title: string; onAdd(text: string): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const add = () => {
    if (text.trim() !== "") props.onAdd(text.trim());
  };
  return (
    <form
      className={styles.form}
      aria-label={props.title}
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <p className={styles.formTitle}>{props.title}</p>
      <textarea
        ref={field}
        className={styles.textarea}
        aria-label="Comment for dawg"
        placeholder="What should dawg change here?"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Closes the form only; Esc elsewhere stops dawg.
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            add();
          }
        }}
      />
      <div className={styles.actions}>
        <Button type="submit" size="sm" variant="primary" kbd="⌘⏎" disabled={text.trim() === ""}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Comments waiting to be sent
// ---------------------------------------------------------------------------------------------

function CommentTray(props: { sessionId: SessionId; cwd: string; homeDir: string }) {
  const { sessionId, cwd, homeDir } = props;
  const actions = useActions();
  const comments = useComments(sessionId);
  const waiting = useAppStore((state) => (state.pending[sessionId]?.length ?? 0) > 0);
  const draft = useAppStore((state) => state.ui.drafts[sessionId] ?? "");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (comments.length > 0) setNote(null);
  }, [comments.length]);

  function send() {
    if (comments.length === 0) return;
    const message = reviewMessage(comments, cwd, homeDir);
    if (waiting) {
      // Sent now, it would answer the waiting decision card instead.
      actions.setDraft(sessionId, draft.trim() === "" ? message : `${draft}\n\n${message}`);
      setNote("A decision is waiting, so the comments are in the message box, not sent yet.");
    } else {
      run(actions.submit(sessionId, message));
      setNote(
        comments.length === 1 ? "Comment sent to dawg." : "Comments sent to dawg as one message.",
      );
    }
    clearComments(sessionId);
  }

  function goTo(comment: ReviewComment) {
    revealLine(sessionId, comment.path, comment.side, comment.startLine);
  }

  return (
    <>
      {comments.length > 0 && (
        <ul className={styles.comments} aria-label="Comments to send">
          {comments.map((comment) => {
            const where = `${displayPath(comment.path, cwd, homeDir)}:${lineLabel(comment)}`;
            return (
              <li key={comment.id} className={styles.comment}>
                <div className={styles.commentBody}>
                  <button
                    type="button"
                    className={styles.commentWhere}
                    aria-label={`Show ${where}`}
                    onClick={() => goTo(comment)}
                  >
                    {where}
                    {comment.side === "original" ? " (before)" : ""}
                  </button>
                  <p className={styles.commentText}>{comment.text}</p>
                </div>
                <IconButton
                  icon="close"
                  size="sm"
                  label={`Remove the comment on ${where}`}
                  onClick={() => removeComment(sessionId, comment.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className={`${styles.bar} ${styles.footer}`}>
        <span className={`${styles.grow} ${styles.muted}`} aria-live="polite">
          {comments.length > 0
            ? `${plural(comments.length, "comment", "comments")} waiting · sent as one message, with file and line references`
            : (note ?? "Select lines and press Comment, or the + beside a line.")}
        </span>
        {comments.length > 0 && (
          <Button variant="primary" size="sm" icon="send" onClick={send}>
            Send to dawg
          </Button>
        )}
      </div>
    </>
  );
}
