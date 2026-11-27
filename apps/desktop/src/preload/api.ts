/**
 * The object the preload exposes as `window.dawgPreload`. Built from an injected `ipcRenderer`
 * so it is unit-tested without Electron.
 *
 * Every input is validated here before it goes over IPC (main validates again): a call with bad
 * input rejects with an Error and never reaches main.
 */
import type { z } from "zod";
import {
  type AddedModelFile,
  BadgeCountSchema,
  BRIDGE_VERSION,
  type BranchList,
  type ChangeSet,
  ChooseFolderOptionsSchema,
  ConnectServerInputSchema,
  CreateWorktreeInputSchema,
  type DesktopSettings,
  DesktopSettingsPatchSchema,
  type DirEntry,
  type EngineRestartInfo,
  ExternalUrlSchema,
  type FileContent,
  type FileDiff,
  FileRefSchema,
  FindFilesInputSchema,
  type FindFilesResult,
  IdleUnloadSchema,
  IPC,
  MenuModelSchema,
  ModelIdSchema,
  type ModelOption,
  type ModelStatus,
  type ModelsState,
  NotifyInputSchema,
  OpenTerminalInputSchema,
  PermissionRuleTextSchema,
  type PermissionSettingsState,
  PermissionsProjectSchema,
  PermissionsWriteInputSchema,
  type PlatformInfo,
  type PreloadApi,
  ProjectRefSchema,
  RevertInputSchema,
  type ServerInfo,
  SessionRefSchema,
  type TerminalDataEvent,
  type TerminalExitEvent,
  TerminalIdSchema,
  type TerminalInfo,
  TerminalInputSchema,
  type TerminalReattach,
  TerminalSizeSchema,
  TrackSessionInputSchema,
  type Unsubscribe,
  type WindowState,
  WindowStateSchema,
  type WorkspaceChangedEvent,
  type WorkspaceInfo,
  type WorktreeCleanup,
  type WorktreeInfo,
  WriteFileInputSchema,
} from "../shared/bridge.ts";

/** An absolute path (the contract's schema for one, taken from a schema that has it). */
const AbsolutePathSchema = FileRefSchema.shape.path;

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The slice of Electron's `ipcRenderer` the API uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

export function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
  throw new Error(`Invalid ${what}: ${issues}`);
}

export function createPreloadApi(ipc: IpcRendererLike, platform: PlatformInfo): PreloadApi {
  function subscribe<T>(channel: string, listener: (value: T) => void): Unsubscribe {
    const wrapped: IpcListener = (_event, value) => listener(value as T);
    ipc.on(channel, wrapped);
    return () => {
      ipc.removeListener(channel, wrapped);
    };
  }

  /** A call that takes one model id: validated here, then sent. */
  function withModelId(channel: string, what = "model id") {
    return async (id: string): Promise<void> => {
      const valid = validate(ModelIdSchema, id, what);
      await ipc.invoke(channel, valid);
    };
  }

  /** A call that takes one value: validated against `schema`, then sent. */
  function invokeWith<S extends z.ZodType, R>(channel: string, schema: S, what: string) {
    return async (value: z.input<S>): Promise<R> => {
      const valid = validate(schema, value, what);
      return (await ipc.invoke(channel, valid)) as R;
    };
  }

  return {
    bridgeVersion: BRIDGE_VERSION,
    platform,
    settings: {
      get: async () => (await ipc.invoke(IPC.settingsGet)) as DesktopSettings,
      update: async (patch) => {
        const valid = validate(DesktopSettingsPatchSchema, patch, "settings");
        return (await ipc.invoke(IPC.settingsUpdate, valid)) as DesktopSettings;
      },
      onChange: (listener) => subscribe<DesktopSettings>(IPC.settingsChanged, listener),
    },
    windowState: {
      load: async () => (await ipc.invoke(IPC.windowStateLoad)) as WindowState,
      save: async (state) => {
        const valid = validate(WindowStateSchema, state, "window state");
        await ipc.invoke(IPC.windowStateSave, valid);
      },
    },
    engine: {
      connect: () => ipc.send(IPC.engineConnect),
      onRestart: (listener) => subscribe<EngineRestartInfo>(IPC.engineRestart, listener),
    },
    models: {
      list: async () => (await ipc.invoke(IPC.modelsList)) as ModelOption[],
      status: async () => (await ipc.invoke(IPC.modelsStatus)) as ModelStatus,
      onStatus: (listener) => subscribe<ModelStatus>(IPC.modelsStatusChanged, listener),
      state: async () => (await ipc.invoke(IPC.modelsState)) as ModelsState,
      onState: (listener) => subscribe<ModelsState>(IPC.modelsStateChanged, listener),
      download: withModelId(IPC.modelsDownload),
      pauseDownload: withModelId(IPC.modelsPauseDownload),
      cancelDownload: withModelId(IPC.modelsCancelDownload),
      dismissDownload: withModelId(IPC.modelsDismissDownload),
      useExisting: withModelId(IPC.modelsUseExisting),
      remove: withModelId(IPC.modelsRemove),
      start: withModelId(IPC.modelsStart),
      stop: async () => {
        await ipc.invoke(IPC.modelsStop);
      },
      setDefault: withModelId(IPC.modelsSetDefault),
      setIdleUnload: async (minutes) => {
        const valid = validate(IdleUnloadSchema, minutes, "idle unload time");
        await ipc.invoke(IPC.modelsSetIdleUnload, valid);
      },
      addModelFile: async () => (await ipc.invoke(IPC.modelsAddFile)) as AddedModelFile | null,
      connectServer: async (input) => {
        const valid = validate(ConnectServerInputSchema, input, "server");
        return (await ipc.invoke(IPC.modelsConnectServer, valid)) as ServerInfo;
      },
      removeServer: withModelId(IPC.modelsRemoveServer, "server id"),
      refreshServers: async () => {
        await ipc.invoke(IPC.modelsRefreshServers);
      },
    },
    workspace: {
      track: invokeWith<typeof TrackSessionInputSchema, WorkspaceInfo>(
        IPC.workspaceTrack,
        TrackSessionInputSchema,
        "session",
      ),
      untrack: invokeWith<typeof SessionRefSchema, void>(
        IPC.workspaceUntrack,
        SessionRefSchema,
        "session id",
      ),
      changes: invokeWith<typeof SessionRefSchema, ChangeSet>(
        IPC.workspaceChanges,
        SessionRefSchema,
        "session id",
      ),
      fileDiff: invokeWith<typeof FileRefSchema, FileDiff>(
        IPC.workspaceFileDiff,
        FileRefSchema,
        "file",
      ),
      revert: invokeWith<typeof RevertInputSchema, void>(
        IPC.workspaceRevert,
        RevertInputSchema,
        "revert",
      ),
      listDirectory: invokeWith<typeof FileRefSchema, DirEntry[]>(
        IPC.workspaceListDirectory,
        FileRefSchema,
        "file",
      ),
      readFile: invokeWith<typeof FileRefSchema, FileContent>(
        IPC.workspaceReadFile,
        FileRefSchema,
        "file",
      ),
      writeFile: invokeWith<typeof WriteFileInputSchema, { mtimeMs: number }>(
        IPC.workspaceWriteFile,
        WriteFileInputSchema,
        "file",
      ),
      findFiles: invokeWith<typeof FindFilesInputSchema, FindFilesResult>(
        IPC.workspaceFindFiles,
        FindFilesInputSchema,
        "file search",
      ),
      onChanged: (listener) => subscribe<WorkspaceChangedEvent>(IPC.workspaceChanged, listener),
    },
    worktrees: {
      branches: async (projectDir) => {
        const valid = validate(ProjectRefSchema, { projectDir }, "project");
        return (await ipc.invoke(IPC.worktreesBranches, valid)) as BranchList;
      },
      create: invokeWith<typeof CreateWorktreeInputSchema, WorktreeInfo>(
        IPC.worktreesCreate,
        CreateWorktreeInputSchema,
        "worktree",
      ),
      cleanup: invokeWith<typeof AbsolutePathSchema, WorktreeCleanup>(
        IPC.worktreesCleanup,
        AbsolutePathSchema,
        "worktree path",
      ),
    },
    terminal: {
      open: invokeWith<typeof OpenTerminalInputSchema, TerminalInfo>(
        IPC.terminalOpen,
        OpenTerminalInputSchema,
        "terminal",
      ),
      // One-way, like keystrokes: invalid input throws here and is never sent.
      write: (terminalId, data) => {
        ipc.send(
          IPC.terminalWrite,
          validate(TerminalIdSchema, terminalId, "terminal id"),
          validate(TerminalInputSchema, data, "terminal input"),
        );
      },
      resize: (terminalId, cols, rows) => {
        const id = validate(TerminalIdSchema, terminalId, "terminal id");
        const size = validate(TerminalSizeSchema, { cols, rows }, "terminal size");
        ipc.send(IPC.terminalResize, id, size.cols, size.rows);
      },
      close: invokeWith<typeof TerminalIdSchema, void>(
        IPC.terminalClose,
        TerminalIdSchema,
        "terminal id",
      ),
      list: invokeWith<typeof SessionRefSchema, TerminalReattach[]>(
        IPC.terminalList,
        SessionRefSchema,
        "session id",
      ),
      onData: (listener) => subscribe<TerminalDataEvent>(IPC.terminalData, listener),
      onExit: (listener) => subscribe<TerminalExitEvent>(IPC.terminalExit, listener),
    },
    notifications: {
      show: invokeWith<typeof NotifyInputSchema, boolean>(
        IPC.notificationsShow,
        NotifyInputSchema,
        "notification",
      ),
      setBadge: invokeWith<typeof BadgeCountSchema, void>(
        IPC.notificationsSetBadge,
        BadgeCountSchema,
        "badge count",
      ),
      onOpenSession: (listener) => subscribe<string>(IPC.notificationsOpenSession, listener),
    },
    permissions: {
      read: invokeWith<typeof PermissionsProjectSchema, PermissionSettingsState>(
        IPC.permissionsRead,
        PermissionsProjectSchema,
        "project",
      ),
      write: invokeWith<typeof PermissionsWriteInputSchema, PermissionSettingsState>(
        IPC.permissionsWrite,
        PermissionsWriteInputSchema,
        "permission settings",
      ),
      checkRule: invokeWith<typeof PermissionRuleTextSchema, string | null>(
        IPC.permissionsCheckRule,
        PermissionRuleTextSchema,
        "rule",
      ),
    },
    dialogs: {
      chooseFolder: async (options) => {
        const valid = validate(ChooseFolderOptionsSchema, options, "folder options");
        return (await ipc.invoke(IPC.chooseFolder, valid)) as string | null;
      },
    },
    shell: {
      openExternal: async (url) => {
        const valid = validate(ExternalUrlSchema, url, "link");
        await ipc.invoke(IPC.openExternal, valid);
      },
    },
    menu: {
      // One-way: invalid input throws here and is never sent.
      update: (model) => {
        ipc.send(IPC.menuUpdate, validate(MenuModelSchema, model, "menu"));
      },
      onAction: (listener) => subscribe<string>(IPC.menuAction, listener),
    },
  };
}
