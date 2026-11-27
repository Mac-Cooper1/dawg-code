/**
 * The Files pane: the session's folders as a tree, the files dawg touched marked, open files in
 * tabs, and an editor that saves with ⌘S. When a save finds the file changed on disk, it offers
 * Reload or Overwrite.
 */
import type { SessionId } from "@dawg/protocol";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { run } from "../../app/run.ts";
import { documentKey, getDocument, type TextDocument } from "../../code/documents.ts";
import { CodeEditor } from "../../code/editors.tsx";
import {
  touchedFiles,
  useSessionActivity,
  useSessionFolders,
  useWorkspace,
  useWorkspaceChanged,
} from "../../code/session.ts";
import { basename, displayPath, formatBytes } from "../../lib/format.ts";
import { onPaneFileRequest, takePaneFile } from "../../state/pane-requests.ts";
import { useAppStore } from "../../state/store.ts";
import { Button, ConfirmDialog, IconButton } from "../../ui/index.ts";
import { PaneEmpty } from "../PaneEmpty.tsx";
import type { PaneProps } from "../types.ts";
import styles from "./FilesPane.module.css";
import { FileTree } from "./FileTree.tsx";
import {
  activateFile,
  closeFile,
  type FileTab,
  filesStore,
  followDisk,
  loadDir,
  openFile,
  reloadFile,
  requestOpenFile,
  retryFile,
  revealInTree,
  saveFile,
  sessionOf,
  startSession,
  takePendingOpen,
  useFiles,
} from "./store.ts";

const NEVER_DIRTY = () => false;
const NO_NAMES: Readonly<Record<string, string>> = Object.freeze({});
const NO_SUBSCRIPTION = () => () => {};

/** Whether a document has unsaved edits, kept current as it is edited. */
function useDirty(document: TextDocument | null): boolean {
  return useSyncExternalStore(
    document ? (listener) => document.subscribe(listener) : NO_SUBSCRIPTION,
    document ? () => document.dirty : NEVER_DIRTY,
  );
}

function documentOf(sessionId: SessionId, tab: FileTab): TextDocument | null {
  return tab.status === "ready" ? getDocument(documentKey(sessionId, tab.path)) : null;
}

/** A fresh pane per session; what a session had open is kept in the files store. */
export function FilesPane({ sessionId }: PaneProps) {
  return <SessionFiles key={sessionId} sessionId={sessionId} />;
}

function SessionFiles({ sessionId }: PaneProps) {
  const folders = useSessionFolders(sessionId);
  const { state: workspace, retry } = useWorkspace(sessionId, folders);
  const session = useFiles((state) => sessionOf(state, sessionId));
  const activity = useSessionActivity(sessionId);
  const touched = useMemo(() => touchedFiles(activity.edits), [activity.edits]);
  const homeDir = useAppStore((state) => state.homeDir);
  // `/memory` adds the project's memory folder, which main found, as a root of its own.
  const memoryDirectory =
    workspace.status === "ready" ? (workspace.info.memoryDirectory ?? null) : null;
  const roots = useMemo(
    () =>
      folders
        ? [
            folders.cwd,
            ...folders.additionalDirectories,
            ...(memoryDirectory === null ? [] : [memoryDirectory]),
          ]
        : [],
    [folders, memoryDirectory],
  );
  const rootNames = useMemo(
    () => (memoryDirectory === null ? NO_NAMES : { [memoryDirectory]: "Project memory" }),
    [memoryDirectory],
  );
  const ready = workspace.status === "ready";

  // Once tracked: open the working directory the first time, and catch up with anything that
  // changed while the pane was hidden.
  useEffect(() => {
    if (!ready || roots.length === 0) return;
    startSession(sessionId, roots[0] as string);
    const state = sessionOf(filesStore.getState(), sessionId);
    for (const root of roots) {
      if (state.expanded[root] && !state.dirs[root]) run(loadDir(sessionId, root));
    }
    run(followDisk(sessionId, []));
  }, [ready, sessionId, roots]);

  useWorkspaceChanged(sessionId, (event) => {
    run(followDisk(sessionId, event.paths));
  });

  // A file the store asked for (`/memory` opens MEMORY.md): it waits until its root is shown.
  useEffect(() => {
    const take = () => {
      const path = takePaneFile(sessionId);
      if (path !== null) requestOpenFile(sessionId, path);
    };
    take();
    return onPaneFileRequest(take);
  }, [sessionId]);

  // "Open in Files" from the Changes pane.
  const pendingOpen = session.pendingOpen;
  useEffect(() => {
    if (!ready || pendingOpen === null) return;
    if (!roots.some((root) => pendingOpen === root || pendingOpen.startsWith(`${root}/`))) return;
    const path = takePendingOpen(sessionId);
    if (path === null) return;
    run(openFile(sessionId, path));
    run(revealInTree(sessionId, path, roots));
  }, [ready, pendingOpen, sessionId, roots]);

  if (!folders) return <PaneEmpty pane="files" />;
  if (workspace.status === "failed") {
    return (
      <div className={styles.message} role="alert">
        <p className={styles.messageTitle}>The files could not be read</p>
        <p className={styles.error}>{workspace.message}</p>
        <Button onClick={retry}>Try again</Button>
      </div>
    );
  }
  if (workspace.status === "loading") {
    return (
      <p className={styles.status} role="status">
        Opening the session’s folders…
      </p>
    );
  }

  const active = session.tabs.find((tab) => tab.path === session.active) ?? null;
  return (
    <div className={styles.pane}>
      <div className={styles.split}>
        <FileTree
          sessionId={sessionId}
          roots={roots}
          rootNames={rootNames}
          session={session}
          touched={touched}
        />
        <div className={styles.main}>
          {session.tabs.length === 0 ? (
            <PaneEmpty pane="files" title="No file open">
              Choose a file in the tree to open it.{" "}
              {touched.size > 0 ? "Files dawg created or edited are marked A or M." : ""}
            </PaneEmpty>
          ) : (
            <>
              <OpenFiles sessionId={sessionId} tabs={session.tabs} active={session.active} />
              {active && (
                <ActiveFile
                  key={active.path}
                  sessionId={sessionId}
                  tab={active}
                  relative={displayPath(active.path, folders.cwd, homeDir)}
                  touched={touched.get(active.path) ?? null}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Open files
// ---------------------------------------------------------------------------------------------

function OpenFiles(props: {
  sessionId: SessionId;
  tabs: readonly FileTab[];
  active: string | null;
}) {
  const [closing, setClosing] = useState<string | null>(null);
  return (
    <>
      <ul className={styles.tabs} aria-label="Open files">
        {props.tabs.map((tab) => (
          <OpenFileTab
            key={tab.path}
            sessionId={props.sessionId}
            tab={tab}
            active={tab.path === props.active}
            onClose={(dirty) => {
              if (dirty) setClosing(tab.path);
              else closeFile(props.sessionId, tab.path);
            }}
          />
        ))}
      </ul>
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
        title={`Close ${closing ? basename(closing) : "the file"} without saving?`}
        confirmLabel="Close without saving"
        destructive
        onConfirm={() => {
          if (closing) closeFile(props.sessionId, closing);
          setClosing(null);
        }}
      >
        Your unsaved changes to it are lost.
      </ConfirmDialog>
    </>
  );
}

function OpenFileTab(props: {
  sessionId: SessionId;
  tab: FileTab;
  active: boolean;
  onClose(dirty: boolean): void;
}) {
  const { tab } = props;
  const dirty = useDirty(documentOf(props.sessionId, tab));
  const name = basename(tab.path);
  return (
    <li className={styles.tab} data-active={props.active ? "true" : undefined}>
      <button
        type="button"
        className={styles.tabButton}
        aria-current={props.active ? "true" : undefined}
        aria-label={dirty ? `${name}, unsaved changes` : name}
        title={tab.path}
        onClick={() => activateFile(props.sessionId, tab.path)}
      >
        {name}
        {dirty && (
          <span className={styles.dirty} aria-hidden="true">
            ●
          </span>
        )}
      </button>
      <IconButton
        icon="close"
        size="sm"
        label={`Close ${name}`}
        className={styles.tabClose}
        onClick={() => props.onClose(dirty)}
      />
    </li>
  );
}

function ActiveFile(props: {
  sessionId: SessionId;
  tab: FileTab;
  relative: string;
  touched: "created" | "edited" | null;
}) {
  const { sessionId, tab, relative } = props;
  const document = documentOf(sessionId, tab);
  const dirty = useDirty(document);
  const name = basename(tab.path);
  const save = () => run(saveFile(sessionId, tab.path));

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // ⌘S outside the editor (the editor handles its own).
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  }

  let body: ReactNode;
  if (tab.status === "loading") {
    body = (
      <p className={styles.status} role="status">
        Opening {name}…
      </p>
    );
  } else if (tab.status === "failed") {
    body = (
      <div className={styles.message} role="alert">
        <p className={styles.messageTitle}>{name} could not be opened</p>
        <p className={styles.error}>{tab.message}</p>
        <Button onClick={() => run(retryFile(sessionId, tab.path))}>Try again</Button>
      </div>
    );
  } else if (tab.status === "binary") {
    body = (
      <div className={styles.message}>
        <p className={styles.messageTitle}>{name} is a binary file</p>
        <p>It can’t be shown or edited here ({formatBytes(tab.size)}).</p>
      </div>
    );
  } else if (tab.status === "too-large") {
    body = (
      <div className={styles.message}>
        <p className={styles.messageTitle}>{name} is too large to open here</p>
        <p>
          It is {formatBytes(tab.size)}. The editor opens files up to {formatBytes(5 * 1024 * 1024)}
          .
        </p>
      </div>
    );
  } else if (document) {
    body = <CodeEditor document={document} label={`Edit ${relative}`} onSave={save} />;
  } else {
    body = null;
  }

  return (
    <section className={styles.file} aria-label={relative} onKeyDown={onKeyDown}>
      <div className={styles.bar}>
        <span className={styles.path} title={tab.path}>
          {relative}
        </span>
        {props.touched && (
          <span className={styles.muted}>
            {props.touched === "created" ? "Created by dawg" : "Edited by dawg"}
          </span>
        )}
        <span className={styles.muted} aria-live="polite">
          {tab.saving ? "Saving…" : dirty ? "Unsaved changes" : ""}
        </span>
        {tab.status === "ready" && (
          <Button size="sm" kbd="⌘S" disabled={!dirty || tab.saving} onClick={save}>
            Save
          </Button>
        )}
      </div>
      {tab.conflict && (
        <div className={styles.conflict} role="alert">
          <span className={styles.grow}>
            {tab.conflict === "changed"
              ? `${name} changed on disk since you opened it.`
              : `${name} was deleted on disk.`}
          </span>
          {tab.conflict === "changed" ? (
            <Button size="sm" onClick={() => run(reloadFile(sessionId, tab.path))}>
              Reload
            </Button>
          ) : (
            <Button size="sm" onClick={() => closeFile(sessionId, tab.path)}>
              Close
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={() => run(saveFile(sessionId, tab.path, { overwrite: true }))}
          >
            {tab.conflict === "changed" ? "Overwrite" : "Save it again"}
          </Button>
        </div>
      )}
      {tab.saveError && (
        <p className={styles.alert} role="alert">
          Could not save {name}: {tab.saveError}
        </p>
      )}
      {body}
    </section>
  );
}
