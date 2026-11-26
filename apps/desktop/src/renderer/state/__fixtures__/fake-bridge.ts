/**
 * A bridge for the store and pane tests. Engine ports are real `MessageChannel` ports served by
 * any engine-like object (the fake engine or the mock engine); models come from the fake model
 * manager, driven by hand (`modelManager`); everything else is in memory and recorded.
 *
 * The workspace is an in-memory file tree (`files`) with changes and diffs a test sets; worktrees
 * answer from `repos`; terminals are fake shells a test writes output to (`terminalOutput`) and
 * ends (`endTerminal`).
 */
import {
  type BranchList,
  type ChangeSet,
  type CreateWorktreeInput,
  type DawgBridge,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_STATE,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type DirEntry,
  type EngineRestartInfo,
  type FileContent,
  type FileDiff,
  type FindFilesInput,
  type ModelOption,
  type ModelStatus,
  type ModelsState,
  type NotifyInput,
  NotifyInputSchema,
  type OpenTerminalInput,
  type RevertInput,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalReattach,
  type TrackSessionInput,
  TrackSessionInputSchema,
  type WindowState,
  WindowStateSchema,
  type WorkspaceChangedEvent,
  type WorkspaceInfo,
  type WorktreeCleanup,
  type WorktreeInfo,
  type WriteFileInput,
} from "../../../shared/bridge.ts";
import { mockModelsState } from "../../../shared/mock-models.ts";
import {
  createFakeModelManager,
  type FakeModelManager,
  type FakeModelManagerOptions,
} from "../../bridge/fake-models.ts";
import { findInFiles } from "../../bridge/fake-workspace.ts";
import {
  createFakePermissions,
  type FakePermissions,
  type FakeSettingsFile,
} from "../../bridge/fake-permissions.ts";
import { HOME } from "./streams.ts";

export interface PortServer {
  serve(port: MessagePort): void;
}

export interface FakeBridgeOptions {
  engine: PortServer;
  windowState?: Partial<WindowState>;
  settings?: Partial<DesktopSettings>;
  /** The installed models; the rest of the models state is `modelsState`'s. */
  models?: ModelOption[];
  modelStatus?: ModelStatus;
  /** Where the model manager starts. Default: every mock model installed, the default loaded. */
  modelsState?: ModelsState;
  /** The model manager runs by hand unless `auto` is set here. */
  modelManager?: Omit<FakeModelManagerOptions, "state">;
  /** Makes `models.state()` fail, as an older main would. */
  modelsStateFails?: boolean;
  /** What the folder picker answers. */
  folder?: string | null;
  /**
   * Git repositories by project folder: their branches (the current one first). Folders not
   * listed are not repositories.
   */
  repos?: Record<string, { current: string | null; branches: string[] }>;
  /** What `worktrees.cleanup` answers. Default: removed. */
  cleanup?: WorktreeCleanup;
  /** Files in the workspace, by absolute path. Directories are implied by the paths. */
  files?: Record<string, string>;
  /** What `workspace.changes` lists. */
  changes?: ChangeSet["files"];
  /** What `workspace.fileDiff` answers, by path. */
  diffs?: Record<string, FileDiff>;
  /** Settings files for `permissions`, by absolute path. Default: none exist. */
  permissionFiles?: Record<string, FakeSettingsFile>;
}

/** A fake shell. */
export interface FakeTerminal {
  terminalId: string;
  sessionId: string;
  cwd: string;
  title: string;
  alive: boolean;
  cols: number;
  rows: number;
  /** Everything written to it so far, as the shell wrote it (the reattach backlog). */
  output: string;
  /** What the window typed or pasted. */
  input: string[];
}

export interface FakeBridge extends DawgBridge {
  readonly saved: WindowState[];
  readonly settingsUpdates: DesktopSettingsPatch[];
  /** Simulates the engine host dying: the restart notice, then a fresh port. */
  restartEngine(reason?: string, beforeNewPort?: () => void): void;
  /** Changes settings as another window would. */
  changeSettings(patch: DesktopSettingsPatch): void;
  setModelStatus(status: ModelStatus): void;
  /** The model manager behind `models`. */
  readonly modelManager: FakeModelManager;
  /** Every `workspace.track` call, in order. */
  readonly tracked: TrackSessionInput[];
  /** Every `workspace.untrack` call, in order. */
  readonly untracked: string[];
  /** Every `workspace.revert` call. */
  readonly reverts: RevertInput[];
  /** Every `workspace.writeFile` call. */
  readonly writes: WriteFileInput[];
  /** Every `workspace.findFiles` call (`@` in the composer). */
  readonly findFilesCalls: FindFilesInput[];
  /** The in-memory files (`writeFile` changes them). */
  readonly files: Map<string, { content: string; mtimeMs: number }>;
  /** Reports files changed on disk to `workspace.onChanged` listeners. */
  workspaceChanged(event: WorkspaceChangedEvent): void;
  /** Every `worktrees.create` call. */
  readonly worktreesCreated: CreateWorktreeInput[];
  /** Every `worktrees.cleanup` call. */
  readonly worktreesCleaned: string[];
  /** Makes the next `worktrees.create` reject with this sentence. */
  failNextWorktree(message: string): void;
  /** Open terminals (and ended ones not yet closed), by id. */
  readonly terminals: Map<string, FakeTerminal>;
  /** Every `terminal.open` call. */
  readonly terminalsOpened: OpenTerminalInput[];
  /** Every `terminal.close` call. */
  readonly terminalsClosed: string[];
  /** The shell writes output. */
  terminalOutput(terminalId: string, data: string): void;
  /** The shell exits. */
  endTerminal(terminalId: string, exitCode?: number | null, signal?: number | null): void;
  /** Every `notifications.show` call that main would show (notifications on), in order. */
  readonly notificationsShown: NotifyInput[];
  /** Every `notifications.setBadge` count, in order. */
  readonly badgeCounts: number[];
  /** The person clicks a session's notification: `notifications.onOpenSession` hears it. */
  openSessionFromNotification(sessionId: string): void;
  /** The settings files behind `permissions`, its writes, and a way to make one fail. */
  readonly fakePermissions: FakePermissions;
  /** Closes every port it handed out. */
  close(): void;
}

/** The commit every fake repository's HEAD is on. */
export const FAKE_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function createFakeBridge(options: FakeBridgeOptions): FakeBridge {
  let settings: DesktopSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  const windowState = WindowStateSchema.parse({ ...DEFAULT_WINDOW_STATE, ...options.windowState });
  const settingsListeners = new Set<(settings: DesktopSettings) => void>();
  const portListeners = new Set<(port: MessagePort) => void>();
  const restartListeners = new Set<(info: EngineRestartInfo) => void>();
  const ports: MessagePort[] = [];
  const saved: WindowState[] = [];
  const settingsUpdates: DesktopSettingsPatch[] = [];
  const initialModels = options.modelsState ?? mockModelsState();
  const fakePermissions = createFakePermissions({
    homeDir: HOME,
    files: options.permissionFiles ?? {},
  });
  const modelManager = createFakeModelManager({
    auto: false,
    ...options.modelManager,
    state: {
      ...initialModels,
      ...(options.models ? { installed: options.models } : {}),
      ...(options.modelStatus ? { status: options.modelStatus } : {}),
    },
  });

  function subscribe<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // --- Workspace ---------------------------------------------------------------------------

  const tracked: TrackSessionInput[] = [];
  const untracked: string[] = [];
  const reverts: RevertInput[] = [];
  const writes: WriteFileInput[] = [];
  const findFilesCalls: FindFilesInput[] = [];
  const workspaceListeners = new Set<(event: WorkspaceChangedEvent) => void>();
  const files = new Map<string, { content: string; mtimeMs: number }>(
    Object.entries(options.files ?? {}).map(([path, content]) => [path, { content, mtimeMs: 1 }]),
  );
  const worktreesCreated: CreateWorktreeInput[] = [];
  const worktreesCleaned: string[] = [];
  const worktrees = new Map<string, WorktreeInfo>();
  const branchesMade = new Set<string>();
  let worktreeFailure: string | null = null;

  function repoOf(dir: string): { root: string; current: string | null } | null {
    for (const [root, repo] of Object.entries(options.repos ?? {})) {
      if (dir === root || dir.startsWith(`${root}/`)) return { root, current: repo.current };
    }
    return null;
  }

  function workspaceInfo(input: TrackSessionInput): WorkspaceInfo {
    const worktree = worktrees.get(input.cwd) ?? null;
    const repo = repoOf(input.projectDir);
    if (!repo && !worktree) return { sessionId: input.sessionId, cwd: input.cwd, git: null };
    return {
      sessionId: input.sessionId,
      cwd: input.cwd,
      git: {
        root: worktree ? worktree.path : (repo?.root ?? input.cwd),
        branch: worktree ? worktree.branch : (repo?.current ?? null),
        baseCommit: worktree ? worktree.baseCommit : FAKE_COMMIT,
        baseLabel: worktree ? worktree.base : `where the session started (${FAKE_COMMIT.slice(0, 7)})`,
        worktree,
      },
    };
  }

  function listDirectory(dir: string): DirEntry[] {
    const entries = new Map<string, DirEntry>();
    for (const [path, file] of files) {
      if (!path.startsWith(`${dir}/`)) continue;
      const rest = path.slice(dir.length + 1);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const full = `${dir}/${name}`;
      if (entries.has(name)) continue;
      entries.set(
        name,
        slash === -1
          ? { name, path: full, kind: "file", ignored: false, size: file.content.length }
          : { name, path: full, kind: "directory", ignored: false, size: null },
      );
    }
    return [...entries.values()].sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
    );
  }

  function fileContent(path: string): FileContent {
    const file = files.get(path);
    if (!file) throw new Error(`No such file: ${nameOf(path)}`);
    return {
      path,
      content: file.content,
      binary: false,
      tooLarge: false,
      size: file.content.length,
      mtimeMs: file.mtimeMs,
    };
  }

  // --- Terminals ---------------------------------------------------------------------------

  const terminals = new Map<string, FakeTerminal>();
  const terminalsOpened: OpenTerminalInput[] = [];
  const terminalsClosed: string[] = [];
  const dataListeners = new Set<(event: TerminalDataEvent) => void>();
  const exitListeners = new Set<(event: TerminalExitEvent) => void>();
  let terminalCount = 0;

  // --- Notifications -----------------------------------------------------------------------

  const notificationsShown: NotifyInput[] = [];
  const badgeCounts: number[] = [];
  const openSessionListeners = new Set<(sessionId: string) => void>();

  function terminalOf(terminalId: string): FakeTerminal {
    const terminal = terminals.get(terminalId);
    if (!terminal) throw new Error(`No terminal ${terminalId}`);
    return terminal;
  }

  function infoOf(terminal: FakeTerminal) {
    const { terminalId, sessionId, cwd, title, alive } = terminal;
    return { terminalId, sessionId, cwd, title, alive };
  }

  function handOutPort(): void {
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    options.engine.serve(channel.port2);
    setTimeout(() => {
      for (const listener of [...portListeners]) listener(channel.port1);
    }, 0);
  }

  return {
    bridgeVersion: 1,
    platform: {
      os: "darwin",
      arch: "arm64",
      homeDir: HOME,
      appVersion: "0.1.0-test",
      isDev: true,
      engine: "mock",
    },
    settings: {
      get: async () => settings,
      update: async (patch) => {
        settingsUpdates.push(patch);
        settings = { ...settings, ...patch };
        for (const listener of [...settingsListeners]) listener(settings);
        return settings;
      },
      onChange: (listener) => subscribe(settingsListeners, listener),
    },
    windowState: {
      load: async () => windowState,
      save: async (state) => {
        saved.push(WindowStateSchema.parse(state));
      },
    },
    engine: {
      connect: () => handOutPort(),
      onPort: (listener) => subscribe(portListeners, listener),
      onRestart: (listener) => subscribe(restartListeners, listener),
    },
    models: {
      ...modelManager.api,
      state: options.modelsStateFails
        ? async () => {
            throw new Error("No such method: models.state");
          }
        : modelManager.api.state,
    },
    workspace: {
      track: async (input) => {
        const parsed = TrackSessionInputSchema.parse(input);
        tracked.push(parsed);
        return workspaceInfo(parsed);
      },
      untrack: async (sessionId) => {
        untracked.push(sessionId);
      },
      changes: async () => ({
        baseCommit: options.repos ? FAKE_COMMIT : null,
        files: options.changes ?? [],
        truncated: false,
      }),
      fileDiff: async (ref) => {
        const diff = options.diffs?.[ref.path];
        if (!diff) throw new Error(`No diff for ${nameOf(ref.path)}`);
        return diff;
      },
      revert: async (input) => {
        reverts.push(input);
      },
      listDirectory: async (ref) => listDirectory(ref.path),
      readFile: async (ref) => fileContent(ref.path),
      writeFile: async (input) => {
        writes.push(input);
        const current = files.get(input.path);
        if (
          current &&
          input.expectedMtimeMs !== undefined &&
          current.mtimeMs !== input.expectedMtimeMs
        ) {
          throw new Error("The file changed on disk since it was opened");
        }
        const mtimeMs = (current?.mtimeMs ?? 0) + 1;
        files.set(input.path, { content: input.content, mtimeMs });
        return { mtimeMs };
      },
      findFiles: async (input) => {
        findFilesCalls.push(input);
        const cwd = tracked.findLast((track) => track.sessionId === input.sessionId)?.cwd;
        if (cwd === undefined) throw new Error(`Session ${input.sessionId} is not tracked.`);
        return findInFiles(cwd, files.keys(), input.query, input.limit ?? 50);
      },
      onChanged: (listener) => subscribe(workspaceListeners, listener),
    },
    worktrees: {
      branches: async (projectDir): Promise<BranchList> => {
        const repo = options.repos?.[projectDir];
        if (!repo) return { isRepo: false, current: null, branches: [] };
        return { isRepo: true, current: repo.current, branches: [...repo.branches] };
      },
      create: async (input) => {
        worktreesCreated.push(input);
        if (worktreeFailure !== null) {
          const message = worktreeFailure;
          worktreeFailure = null;
          throw new Error(message);
        }
        if (!options.repos?.[input.projectDir]) {
          throw new Error("The folder is not in a git repository.");
        }
        const branch = `dawg/${input.name}`;
        if (branchesMade.has(branch) || options.repos[input.projectDir]?.branches.includes(branch)) {
          throw new Error(`A branch named ${branch} already exists.`);
        }
        branchesMade.add(branch);
        const info: WorktreeInfo = {
          path: `${input.projectDir}/.dawg/worktrees/${input.name}`,
          branch,
          base: input.base,
          baseCommit: FAKE_COMMIT,
        };
        worktrees.set(info.path, info);
        return info;
      },
      cleanup: async (worktreePath) => {
        worktreesCleaned.push(worktreePath);
        const result = options.cleanup ?? { removed: true, reason: null };
        if (result.removed) worktrees.delete(worktreePath);
        return result;
      },
    },
    terminal: {
      open: async (input) => {
        terminalsOpened.push(input);
        terminalCount += 1;
        const terminal: FakeTerminal = {
          terminalId: `term-${terminalCount}`,
          sessionId: input.sessionId,
          cwd: input.cwd,
          title: "zsh",
          alive: true,
          cols: input.cols,
          rows: input.rows,
          output: "",
          input: [],
        };
        terminals.set(terminal.terminalId, terminal);
        return infoOf(terminal);
      },
      write: (terminalId, data) => {
        terminalOf(terminalId).input.push(data);
      },
      resize: (terminalId, cols, rows) => {
        const terminal = terminalOf(terminalId);
        terminal.cols = cols;
        terminal.rows = rows;
      },
      close: async (terminalId) => {
        terminalsClosed.push(terminalId);
        terminals.delete(terminalId);
      },
      list: async (sessionId): Promise<TerminalReattach[]> =>
        [...terminals.values()]
          .filter((terminal) => terminal.sessionId === sessionId)
          .map((terminal) => ({ ...infoOf(terminal), backlog: terminal.output })),
      onData: (listener) => subscribe(dataListeners, listener),
      onExit: (listener) => subscribe(exitListeners, listener),
    },
    notifications: {
      show: async (input) => {
        // Validated as main does, so a test fails on a title or body main would refuse.
        const valid = NotifyInputSchema.parse(input);
        if (!settings.notifications) return false;
        notificationsShown.push(valid);
        return true;
      },
      setBadge: async (count) => {
        badgeCounts.push(count);
      },
      onOpenSession: (listener) => subscribe(openSessionListeners, listener),
    },
    permissions: fakePermissions.api,
    dialogs: {
      chooseFolder: async () => (options.folder === undefined ? null : options.folder),
    },
    shell: {
      openExternal: async () => {},
    },
    saved,
    settingsUpdates,
    restartEngine(reason = "The engine host exited (code 1)", beforeNewPort) {
      for (const listener of [...restartListeners]) listener({ reason });
      beforeNewPort?.();
      handOutPort();
    },
    changeSettings(patch) {
      settings = { ...settings, ...patch };
      for (const listener of [...settingsListeners]) listener(settings);
    },
    setModelStatus(status) {
      modelManager.setStatus(status);
    },
    modelManager,
    fakePermissions,
    tracked,
    untracked,
    reverts,
    writes,
    findFilesCalls,
    files,
    workspaceChanged(event) {
      for (const listener of [...workspaceListeners]) listener(event);
    },
    worktreesCreated,
    worktreesCleaned,
    failNextWorktree(message) {
      worktreeFailure = message;
    },
    terminals,
    terminalsOpened,
    terminalsClosed,
    terminalOutput(terminalId, data) {
      const terminal = terminalOf(terminalId);
      terminal.output += data;
      for (const listener of [...dataListeners]) listener({ terminalId, data });
    },
    endTerminal(terminalId, exitCode = 0, signal = null) {
      terminalOf(terminalId).alive = false;
      for (const listener of [...exitListeners]) listener({ terminalId, exitCode, signal });
    },
    notificationsShown,
    badgeCounts,
    openSessionFromNotification(sessionId) {
      for (const listener of [...openSessionListeners]) listener(sessionId);
    },
    close() {
      modelManager.dispose();
      for (const port of ports.splice(0)) port.close();
    },
  };
}
