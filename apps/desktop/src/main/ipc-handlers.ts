/**
 * What main answers on each IPC channel, with every input validated. Kept free of Electron (the
 * sender is a type parameter) so the validation is unit-tested; `index.ts` registers these with
 * `ipcMain` behind the sender check.
 */
import type { z } from "zod";
import {
  type AddedModelFile,
  BadgeCountSchema,
  type BranchList,
  type ChangeSet,
  type ChooseFolderOptions,
  ChooseFolderOptionsSchema,
  ConnectServerInputSchema,
  CreateWorktreeInputSchema,
  type DesktopSettings,
  type DirEntry,
  ExternalUrlSchema,
  type FileContent,
  type FileDiff,
  FileRefSchema,
  FindFilesInputSchema,
  type FindFilesResult,
  HelperEnabledSchema,
  IdleUnloadSchema,
  IPC,
  type MenuModel,
  MenuModelSchema,
  ModelIdSchema,
  type ModelOption,
  type ModelStatus,
  type ModelsState,
  type NotifyInput,
  NotifyInputSchema,
  OpenTerminalInputSchema,
  PermissionRuleTextSchema,
  type PermissionSettingsState,
  PermissionsProjectSchema,
  PermissionsWriteInputSchema,
  ProjectRefSchema,
  RevertInputSchema,
  type ServerInfo,
  SessionRefSchema,
  TerminalIdSchema,
  type TerminalInfo,
  TerminalInputSchema,
  type TerminalReattach,
  TerminalSizeSchema,
  TrackSessionInputSchema,
  type WindowState,
  type WorkspaceInfo,
  type WorktreeCleanup,
  type WorktreeInfo,
  WriteFileInputSchema,
} from "../shared/bridge.ts";
import type { ModelService } from "./models/service.ts";
import type { SettingsStore, WindowStateStore } from "./stores.ts";
import type { TerminalService } from "./terminal/service.ts";
import { validateInput } from "./validate.ts";
import type { WorkspaceService } from "./workspace/service.ts";
import type { WorktreeService } from "./workspace/worktrees.ts";

/** An absolute path (the contract's schema for one, taken from a schema that has it). */
const AbsolutePathSchema = FileRefSchema.shape.path;

/** Notifications and the Dock badge, for the window that asks. */
export interface NotificationServiceFor<Sender> {
  /** Shows a notification unless a dawg window is focused or notifications are off. */
  show(sender: Sender, input: NotifyInput): Promise<boolean>;
  setBadge(sender: Sender, count: number): Promise<void>;
}

/** Settings → Permissions: reads and edits the settings files' default mode and rules. */
export interface PermissionSettingsService {
  read(projectDir: string | null): Promise<PermissionSettingsState>;
  write(input: z.output<typeof PermissionsWriteInputSchema>): Promise<PermissionSettingsState>;
  checkRule(rule: string): Promise<string | null>;
}

export interface MainServices<Sender> {
  settings: SettingsStore;
  windowState: WindowStateStore;
  models: ModelService;
  workspace: WorkspaceService;
  worktrees: WorktreeService;
  terminals: TerminalService;
  notifications: NotificationServiceFor<Sender>;
  permissions: PermissionSettingsService;
  /** A stable name for the sender's window: the sessions it tracks are released when it closes. */
  ownerOf(sender: Sender): string;
  /** Which saved layout a sender uses. One window, "main", in this wave. */
  windowIdFor(sender: Sender): string;
  /** Called after every successful settings change, to apply the theme and tell every window. */
  settingsChanged(settings: DesktopSettings): void;
  chooseFolder(sender: Sender, options: ChooseFolderOptions): Promise<string | null>;
  /** The native picker for one `.gguf` file; null when cancelled. */
  chooseModelFile(sender: Sender): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}

export type InvokeHandler<Sender> = (sender: Sender, args: readonly unknown[]) => Promise<unknown>;

/** A one-way message (`ipcRenderer.send`): nothing to answer, so bad input is only logged. */
export type SendHandler<Sender> = (sender: Sender, args: readonly unknown[]) => void;

export function createInvokeHandlers<Sender>(
  services: MainServices<Sender>,
): Record<string, InvokeHandler<Sender>> {
  const { models, workspace, worktrees, terminals, notifications, permissions } = services;
  const modelId = (value: unknown) => validateInput(ModelIdSchema, value, "model id");
  const sessionId = (value: unknown) => validateInput(SessionRefSchema, value, "session id");
  const fileRef = (value: unknown) => validateInput(FileRefSchema, value, "file");

  return {
    [IPC.settingsGet]: async (): Promise<DesktopSettings> => services.settings.get(),
    [IPC.settingsUpdate]: async (_sender, [patch]): Promise<DesktopSettings> => {
      const settings = await services.settings.update(patch);
      services.settingsChanged(settings);
      return settings;
    },
    [IPC.windowStateLoad]: async (sender): Promise<WindowState> =>
      services.windowState.load(services.windowIdFor(sender)),
    [IPC.windowStateSave]: async (sender, [state]): Promise<void> => {
      await services.windowState.save(services.windowIdFor(sender), state);
    },
    [IPC.modelsList]: async (): Promise<ModelOption[]> => models.list(),
    [IPC.modelsStatus]: async (): Promise<ModelStatus> => models.status(),
    [IPC.modelsState]: async (): Promise<ModelsState> => models.state(),
    [IPC.modelsDownload]: async (_sender, [id]): Promise<void> => models.download(modelId(id)),
    [IPC.modelsPauseDownload]: async (_sender, [id]): Promise<void> =>
      models.pauseDownload(modelId(id)),
    [IPC.modelsCancelDownload]: async (_sender, [id]): Promise<void> =>
      models.cancelDownload(modelId(id)),
    [IPC.modelsDismissDownload]: async (_sender, [id]): Promise<void> =>
      models.dismissDownload(modelId(id)),
    [IPC.modelsUseExisting]: async (_sender, [id]): Promise<void> =>
      models.useExisting(modelId(id)),
    [IPC.modelsRemove]: async (_sender, [id]): Promise<void> => models.remove(modelId(id)),
    [IPC.modelsStart]: async (_sender, [id]): Promise<void> => models.start(modelId(id)),
    [IPC.modelsStop]: async (): Promise<void> => models.stop(),
    [IPC.modelsSetDefault]: async (_sender, [id]): Promise<void> => models.setDefault(modelId(id)),
    [IPC.modelsSetIdleUnload]: async (_sender, [minutes]): Promise<void> =>
      models.setIdleUnload(validateInput(IdleUnloadSchema, minutes, "idle unload time")),
    [IPC.modelsSetHelperEnabled]: async (_sender, [enabled]): Promise<void> =>
      models.setHelperEnabled(validateInput(HelperEnabledSchema, enabled, "helper setting")),
    [IPC.modelsAddFile]: async (sender): Promise<AddedModelFile | null> =>
      models.addModelFile(() => services.chooseModelFile(sender)),
    [IPC.modelsConnectServer]: async (_sender, [input]): Promise<ServerInfo> =>
      models.connectServer(validateInput(ConnectServerInputSchema, input, "server")),
    [IPC.modelsRemoveServer]: async (_sender, [id]): Promise<void> =>
      models.removeServer(validateInput(ModelIdSchema, id, "server id")),
    [IPC.modelsRefreshServers]: async (): Promise<void> => models.refreshServers(),
    [IPC.workspaceTrack]: async (sender, [input]): Promise<WorkspaceInfo> =>
      workspace.track(
        validateInput(TrackSessionInputSchema, input, "session"),
        services.ownerOf(sender),
      ),
    [IPC.workspaceUntrack]: async (sender, [id]): Promise<void> =>
      workspace.untrack(sessionId(id), services.ownerOf(sender)),
    [IPC.workspaceChanges]: async (_sender, [id]): Promise<ChangeSet> =>
      workspace.changes(sessionId(id)),
    [IPC.workspaceFileDiff]: async (_sender, [ref]): Promise<FileDiff> =>
      workspace.fileDiff(fileRef(ref)),
    [IPC.workspaceRevert]: async (_sender, [input]): Promise<void> =>
      workspace.revert(validateInput(RevertInputSchema, input, "revert")),
    [IPC.workspaceListDirectory]: async (_sender, [ref]): Promise<DirEntry[]> =>
      workspace.listDirectory(fileRef(ref)),
    [IPC.workspaceReadFile]: async (_sender, [ref]): Promise<FileContent> =>
      workspace.readFile(fileRef(ref)),
    [IPC.workspaceWriteFile]: async (_sender, [input]): Promise<{ mtimeMs: number }> =>
      workspace.writeFile(validateInput(WriteFileInputSchema, input, "file")),
    [IPC.workspaceFindFiles]: async (_sender, [input]): Promise<FindFilesResult> =>
      workspace.findFiles(validateInput(FindFilesInputSchema, input, "file search")),
    [IPC.worktreesBranches]: async (_sender, [ref]): Promise<BranchList> =>
      worktrees.branches(validateInput(ProjectRefSchema, ref, "project").projectDir),
    [IPC.worktreesCreate]: async (_sender, [input]): Promise<WorktreeInfo> =>
      worktrees.create(validateInput(CreateWorktreeInputSchema, input, "worktree")),
    [IPC.worktreesCleanup]: async (_sender, [worktreePath]): Promise<WorktreeCleanup> =>
      worktrees.cleanup(validateInput(AbsolutePathSchema, worktreePath, "worktree path")),
    [IPC.terminalOpen]: async (_sender, [input]): Promise<TerminalInfo> =>
      terminals.open(validateInput(OpenTerminalInputSchema, input, "terminal")),
    [IPC.terminalClose]: async (_sender, [id]): Promise<void> =>
      terminals.close(validateInput(TerminalIdSchema, id, "terminal id")),
    [IPC.terminalList]: async (_sender, [id]): Promise<TerminalReattach[]> =>
      terminals.list(sessionId(id)),
    [IPC.notificationsShow]: async (sender, [input]): Promise<boolean> =>
      notifications.show(sender, validateInput(NotifyInputSchema, input, "notification")),
    [IPC.notificationsSetBadge]: async (sender, [count]): Promise<void> =>
      notifications.setBadge(sender, validateInput(BadgeCountSchema, count, "badge count")),
    [IPC.permissionsRead]: async (_sender, [projectDir]): Promise<PermissionSettingsState> =>
      permissions.read(validateInput(PermissionsProjectSchema, projectDir, "project")),
    [IPC.permissionsWrite]: async (_sender, [input]): Promise<PermissionSettingsState> =>
      permissions.write(validateInput(PermissionsWriteInputSchema, input, "permission settings")),
    [IPC.permissionsCheckRule]: async (_sender, [rule]): Promise<string | null> =>
      permissions.checkRule(validateInput(PermissionRuleTextSchema, rule, "rule")),
    [IPC.chooseFolder]: async (sender, [options]): Promise<string | null> =>
      services.chooseFolder(
        sender,
        validateInput(ChooseFolderOptionsSchema, options, "folder options"),
      ),
    [IPC.openExternal]: async (_sender, [url]): Promise<void> =>
      services.openExternal(validateInput(ExternalUrlSchema, url, "link")),
  };
}

/**
 * One-way messages: keystrokes and resizes, too frequent to answer. Input is validated all the
 * same; anything invalid is dropped and logged.
 */
export function createSendHandlers<Sender>(
  services: Pick<MainServices<Sender>, "terminals">,
  log: (message: string) => void,
): Record<string, SendHandler<Sender>> {
  const { terminals } = services;
  const guarded =
    (channel: string, handle: (args: readonly unknown[]) => void): SendHandler<Sender> =>
    (_sender, args) => {
      try {
        handle(args);
      } catch (error) {
        log(`Dropped "${channel}": ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  return {
    [IPC.terminalWrite]: guarded(IPC.terminalWrite, ([id, data]) => {
      terminals.write(
        validateInput(TerminalIdSchema, id, "terminal id"),
        validateInput(TerminalInputSchema, data, "terminal input"),
      );
    }),
    [IPC.terminalResize]: guarded(IPC.terminalResize, ([id, cols, rows]) => {
      const size = validateInput(TerminalSizeSchema, { cols, rows }, "terminal size");
      terminals.resize(validateInput(TerminalIdSchema, id, "terminal id"), size.cols, size.rows);
    }),
  };
}

/** Where a window's menu model goes: main/menu-bar.ts. */
export interface MenuModelsFor<Sender> {
  update(sender: Sender, model: MenuModel): void;
}

/**
 * The window's menu model (`menu.update`), sent whenever it changes. One-way like keystrokes:
 * a model that fails validation is dropped and logged, and the menus stay as they were.
 */
export function createMenuSendHandlers<Sender>(
  menu: MenuModelsFor<Sender>,
  log: (message: string) => void,
): Record<string, SendHandler<Sender>> {
  return {
    [IPC.menuUpdate]: (sender, [model]) => {
      let valid: MenuModel;
      try {
        valid = validateInput(MenuModelSchema, model, "menu");
      } catch (error) {
        log(
          `Dropped "${IPC.menuUpdate}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      menu.update(sender, valid);
    },
  };
}
