/**
 * The Files pane's state, per session, and what it does through the bridge: the folder tree
 * (loaded a folder at a time), the open files, saving, and following changes on disk.
 *
 * It lives outside the pane because the dock unmounts hidden panes: open files, unsaved edits
 * (in `code/documents.ts`) and expanded folders survive switching panes or sessions.
 */
import type { SessionId } from "@dawg/protocol";
import { createStore, useStore } from "zustand";
import type { DirEntry, FileContent } from "../../../shared/bridge.ts";
import { closeDocument, documentKey, getDocument, openDocument } from "../../code/documents.ts";
import { errorMessage, workspaceApi } from "../../code/session.ts";

export interface DirListing {
  status: "loading" | "ready" | "failed";
  /** Directories first, then files; git-ignored ones last in each. */
  entries: DirEntry[];
  message: string | null;
}

export interface FileTab {
  /** Absolute. */
  path: string;
  status: "loading" | "ready" | "binary" | "too-large" | "failed";
  /** Why it could not be opened, for "failed". */
  message: string | null;
  size: number;
  /** The modification time of the version on disk the editor holds. */
  mtimeMs: number;
  /** The file changed (or was deleted) on disk while it had unsaved edits, or during a save. */
  conflict: "changed" | "deleted" | null;
  saving: boolean;
  /** A save that failed for another reason. */
  saveError: string | null;
}

export interface FilesSession {
  /** Set once the pane has shown the session (its working directory then starts open). */
  started: boolean;
  /** Folders shown open. */
  expanded: Record<string, true>;
  dirs: Record<string, DirListing>;
  tabs: FileTab[];
  active: string | null;
  /** A file another pane asked to show ("Open in Files"). */
  pendingOpen: string | null;
}

interface FilesState {
  sessions: Record<SessionId, FilesSession>;
}

const EMPTY_SESSION: FilesSession = {
  started: false,
  expanded: {},
  dirs: {},
  tabs: [],
  active: null,
  pendingOpen: null,
};

export const filesStore = createStore<FilesState>(() => ({ sessions: {} }));

export function useFiles<T>(selector: (state: FilesState) => T): T {
  return useStore(filesStore, selector);
}

export function sessionOf(state: FilesState, sessionId: SessionId): FilesSession {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}

function current(sessionId: SessionId): FilesSession {
  return sessionOf(filesStore.getState(), sessionId);
}

function update(sessionId: SessionId, change: (session: FilesSession) => FilesSession): void {
  filesStore.setState((state) => ({
    sessions: { ...state.sessions, [sessionId]: change(sessionOf(state, sessionId)) },
  }));
}

function patchTab(sessionId: SessionId, path: string, patch: Partial<FileTab>): void {
  update(sessionId, (session) => ({
    ...session,
    tabs: session.tabs.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)),
  }));
}

function tabOf(sessionId: SessionId, path: string): FileTab | undefined {
  return current(sessionId).tabs.find((tab) => tab.path === path);
}

/** Tests: forgets every session's files. */
export function resetFiles(): void {
  filesStore.setState({ sessions: {} }, true);
}

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

/** Directories before files, and git-ignored entries after the rest of their kind. */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  const rank = (entry: DirEntry) => (entry.kind === "directory" ? 0 : 2) + (entry.ignored ? 1 : 0);
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

/** The first time a session shows: its working directory starts open. */
export function startSession(sessionId: SessionId, cwd: string): void {
  if (current(sessionId).started) return;
  update(sessionId, (session) => ({
    ...session,
    started: true,
    expanded: { [cwd]: true, ...session.expanded },
  }));
}

export async function loadDir(sessionId: SessionId, path: string): Promise<void> {
  update(sessionId, (session) => {
    const listing = session.dirs[path];
    return {
      ...session,
      dirs: {
        ...session.dirs,
        // A folder shown already keeps its entries while it reloads.
        [path]:
          listing?.status === "ready" ? listing : { status: "loading", entries: [], message: null },
      },
    };
  });
  let next: DirListing;
  try {
    const entries = await workspaceApi().listDirectory({ sessionId, path });
    next = { status: "ready", entries: sortEntries(entries), message: null };
  } catch (error) {
    next = { status: "failed", entries: [], message: errorMessage(error) };
  }
  update(sessionId, (session) => ({ ...session, dirs: { ...session.dirs, [path]: next } }));
}

export function setExpanded(sessionId: SessionId, path: string, open: boolean): void {
  update(sessionId, (session) => {
    const { [path]: _was, ...rest } = session.expanded;
    return { ...session, expanded: open ? { ...rest, [path]: true } : rest };
  });
  if (open && !current(sessionId).dirs[path]) void loadDir(sessionId, path);
}

/** Opens the folders between a root and `path`, so it shows in the tree. */
export async function revealInTree(
  sessionId: SessionId,
  path: string,
  roots: readonly string[],
): Promise<void> {
  const root = roots.find((dir) => path.startsWith(`${dir}/`));
  if (!root) return;
  const parts = path
    .slice(root.length + 1)
    .split("/")
    .slice(0, -1);
  const folders = [root];
  for (const part of parts) folders.push(`${folders.at(-1)}/${part}`);
  update(sessionId, (session) => ({
    ...session,
    expanded: { ...session.expanded, ...Object.fromEntries(folders.map((dir) => [dir, true])) },
  }));
  await Promise.all(
    folders.filter((dir) => !current(sessionId).dirs[dir]).map((dir) => loadDir(sessionId, dir)),
  );
}

// ---------------------------------------------------------------------------------------------
// Open files
// ---------------------------------------------------------------------------------------------

function tabFrom(path: string, file: FileContent): FileTab {
  return {
    path,
    status: file.binary ? "binary" : file.tooLarge || file.content === null ? "too-large" : "ready",
    message: null,
    size: file.size,
    mtimeMs: file.mtimeMs,
    conflict: null,
    saving: false,
    saveError: null,
  };
}

/** Shows a file, opening it first when it is not open yet. */
export async function openFile(sessionId: SessionId, path: string): Promise<void> {
  if (tabOf(sessionId, path)) {
    update(sessionId, (session) => ({ ...session, active: path }));
    return;
  }
  const loading: FileTab = {
    path,
    status: "loading",
    message: null,
    size: 0,
    mtimeMs: 0,
    conflict: null,
    saving: false,
    saveError: null,
  };
  update(sessionId, (session) => ({ ...session, tabs: [...session.tabs, loading], active: path }));
  await readInto(sessionId, path);
}

/** Reads a file into its tab (and document); a failure shows in the tab. */
async function readInto(sessionId: SessionId, path: string): Promise<void> {
  try {
    const file = await workspaceApi().readFile({ sessionId, path });
    if (!tabOf(sessionId, path)) return; // Closed meanwhile.
    if (file.content !== null && !file.binary && !file.tooLarge) {
      openDocument(documentKey(sessionId, path), path, file.content).reset(file.content);
    }
    patchTab(sessionId, path, tabFrom(path, file));
  } catch (error) {
    patchTab(sessionId, path, { status: "failed", message: errorMessage(error) });
  }
}

/** Tries a file that could not be opened again. */
export function retryFile(sessionId: SessionId, path: string): Promise<void> {
  patchTab(sessionId, path, { status: "loading", message: null });
  return readInto(sessionId, path);
}

export function activateFile(sessionId: SessionId, path: string): void {
  update(sessionId, (session) => ({ ...session, active: path }));
}

/** Closes a file, dropping unsaved edits (the pane asks first). */
export function closeFile(sessionId: SessionId, path: string): void {
  closeDocument(documentKey(sessionId, path));
  update(sessionId, (session) => {
    const index = session.tabs.findIndex((tab) => tab.path === path);
    const tabs = session.tabs.filter((tab) => tab.path !== path);
    const active =
      session.active !== path
        ? session.active
        : (tabs[Math.min(index, tabs.length - 1)]?.path ?? null);
    return { ...session, tabs, active };
  });
}

/**
 * Saves a file. Unless `overwrite`, main refuses when the file changed on disk since it was read;
 * the tab then shows the conflict, so the person can reload or overwrite.
 */
export async function saveFile(
  sessionId: SessionId,
  path: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const tab = tabOf(sessionId, path);
  const document = getDocument(documentKey(sessionId, path));
  if (!tab || !document || tab.saving || tab.status !== "ready") return;
  const content = document.getText();
  const expected =
    options.overwrite || tab.conflict !== null ? {} : { expectedMtimeMs: tab.mtimeMs };
  patchTab(sessionId, path, { saving: true, saveError: null });
  const api = workspaceApi();
  try {
    const { mtimeMs } = await api.writeFile({ sessionId, path, content, ...expected });
    document.markSaved(content);
    patchTab(sessionId, path, { saving: false, mtimeMs, conflict: null, saveError: null });
  } catch (error) {
    // Main names the reason in words; what is on disk now says whether it was a conflict.
    let conflict: FileTab["conflict"] = null;
    try {
      const now = await api.readFile({ sessionId, path });
      if (now.mtimeMs !== tab.mtimeMs) conflict = "changed";
    } catch {
      conflict = "deleted";
    }
    patchTab(sessionId, path, {
      saving: false,
      conflict,
      saveError: conflict ? null : errorMessage(error),
    });
  }
}

/** Replaces the editor's text with what is on disk, dropping unsaved edits. */
export async function reloadFile(sessionId: SessionId, path: string): Promise<void> {
  const document = getDocument(documentKey(sessionId, path));
  try {
    const file = await workspaceApi().readFile({ sessionId, path });
    if (file.content !== null) document?.reset(file.content);
    patchTab(sessionId, path, tabFrom(path, file));
  } catch (error) {
    patchTab(sessionId, path, { conflict: "deleted", saveError: null });
    console.warn("dawg-code: could not reload", path, error);
  }
}

/**
 * Files changed on disk (`paths` empty: anything may have). Shown folders are listed again; an
 * open file without unsaved edits is reloaded, and one with unsaved edits shows the conflict.
 */
export async function followDisk(sessionId: SessionId, paths: readonly string[]): Promise<void> {
  const session = current(sessionId);
  const all = paths.length === 0;
  const parents = new Set(paths.map((path) => path.slice(0, Math.max(1, path.lastIndexOf("/")))));
  const dirs = Object.keys(session.dirs).filter(
    (dir) => all || parents.has(dir) || paths.includes(dir),
  );
  const tabs = session.tabs.filter(
    (tab) => (all || paths.includes(tab.path)) && !tab.saving && tab.status !== "loading",
  );
  await Promise.all([
    ...dirs.map((dir) => loadDir(sessionId, dir)),
    ...tabs.map((tab) => recheck(sessionId, tab)),
  ]);
}

async function recheck(sessionId: SessionId, tab: FileTab): Promise<void> {
  const document = getDocument(documentKey(sessionId, tab.path));
  let file: FileContent;
  try {
    file = await workspaceApi().readFile({ sessionId, path: tab.path });
  } catch {
    if (tabOf(sessionId, tab.path)) patchTab(sessionId, tab.path, { conflict: "deleted" });
    return;
  }
  const now = tabOf(sessionId, tab.path);
  if (!now || now.saving) return;
  if (file.mtimeMs === now.mtimeMs && now.conflict !== "deleted") return;
  if (document?.dirty) {
    patchTab(sessionId, tab.path, { conflict: "changed" });
    return;
  }
  if (file.content !== null && !file.binary && !file.tooLarge) {
    openDocument(documentKey(sessionId, tab.path), tab.path, file.content).reset(file.content);
  }
  patchTab(sessionId, tab.path, tabFrom(tab.path, file));
}

/** "Open in Files" from another pane: the Files pane opens it when it shows. */
export function requestOpenFile(sessionId: SessionId, path: string): void {
  update(sessionId, (session) => ({ ...session, pendingOpen: path }));
}

export function takePendingOpen(sessionId: SessionId): string | null {
  const path = current(sessionId).pendingOpen;
  if (path !== null) update(sessionId, (session) => ({ ...session, pendingOpen: null }));
  return path;
}
