/**
 * The main process: one window, the menu, settings and window state, the model manager and the
 * engine host. See README.md ("Processes") for how the pieces talk.
 */
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  MessageChannelMain,
  type MessagePortMain,
  Notification,
  nativeImage,
  nativeTheme,
  type OpenDialogOptions,
  safeStorage,
  screen,
  shell,
  type WebContents,
} from "electron";
import {
  type DesktopSettings,
  type EngineRestartInfo,
  IPC,
  type PlatformInfo,
  PlatformInfoSchema,
  PROJECT_URL,
} from "../shared/bridge.ts";
import type { MainToHost } from "../shared/engine-host-messages.ts";
import { appLocation, appUrl, describeRefusedSender, isTrustedSender } from "./app-url.ts";
import { checkConfigFile } from "./config-files.ts";
import { spawnEngineHost } from "./engine-host-process.ts";
import { createEngineSupervisor, type EngineSupervisor } from "./engine-supervisor.ts";
import {
  createInvokeHandlers,
  createMenuSendHandlers,
  createSendHandlers,
} from "./ipc-handlers.ts";
import { createMenuBar } from "./menu-bar.ts";
import { createModelService, engineMode, resolveResourcesDir } from "./models/index.ts";
import { answerHostMessage } from "./models/service.ts";
import { createNotificationService } from "./notifications.ts";
import { homeDirFrom, resolveDataRoot, settingsFile, stateFile, workspaceFile } from "./paths.ts";
import { createPermissionSettingsService } from "./permissions.ts";
import { installSecurity } from "./security.ts";
import { createSettingsStore, createWindowStateStore } from "./stores.ts";
import { createNodePtySpawner } from "./terminal/node-pty.ts";
import { createTerminalService } from "./terminal/service.ts";
import { createWebInvokeHandlers } from "./web/ipc.ts";
import { createWebSettingsService } from "./web/service.ts";
import {
  initialBounds,
  MIN_WINDOW_SIZE,
  TRAFFIC_LIGHT_POSITION,
  WINDOW_BACKGROUND,
} from "./window-geometry.ts";
import { createWorkspaceService } from "./workspace/service.ts";
import { createWorkspaceStore } from "./workspace/store.ts";
import { createWorktreeService } from "./workspace/worktrees.ts";

const APP_NAME = "dawg-code";
const launchedAt = Date.now();

function log(message: string): void {
  console.log(`[main] ${message}`);
}

const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = devServerUrl !== undefined && devServerUrl !== "";
const here = import.meta.dirname;
const location = appLocation(devServerUrl, path.join(here, "../renderer/index.html"));
const preloadPath = path.join(here, "../preload/index.cjs");
const engineHostPath = path.join(here, "engine-host.js");

const homeDir = homeDirFrom();
const dataRoot = resolveDataRoot(process.env, homeDir);
const settings = createSettingsStore(settingsFile(dataRoot), log);
const windowState = createWindowStateStore(stateFile(dataRoot), log);
const mode = engineMode(process.env);
const resourcesDir = resolveResourcesDir(app.isPackaged, here);
const models = createModelService({
  env: process.env,
  dataRoot,
  homeDir,
  resourcesDir,
  isPackaged: app.isPackaged,
  mainDir: here,
  log: (message) => log(`[models] ${message}`),
});
// Settings → Web: the search service WebSearch uses, its key in the Keychain (web/service.ts).
const web = createWebSettingsService({
  dataRoot,
  encryption: safeStorage,
  log: (message) => log(`[web] ${message}`),
});
// The panes' files, git and shells (Changes, Files, Terminal), each limited to a session's folders.
const workspaceStore = createWorkspaceStore(workspaceFile(dataRoot), (message) =>
  log(`[workspace] ${message}`),
);
const workspace = createWorkspaceService({
  store: workspaceStore,
  log: (message) => log(`[workspace] ${message}`),
  // Lists files for `@` mentions outside git (fetched by `pnpm fetch-ripgrep` in a checkout).
  ripgrepPath: path.join(resourcesDir, "bin", `${process.platform}-${process.arch}`, "rg"),
  // `/memory` shows the project's memory folder in the Files pane; main works out where it is.
  memoryDirectory: async (projectDir) =>
    (await import("@dawg/engine")).memoryDirectory(dataRoot, projectDir),
});
const worktrees = createWorktreeService({
  store: workspaceStore,
  log: (message) => log(`[worktrees] ${message}`),
});
const terminals = createTerminalService({
  spawn: createNodePtySpawner((message) => log(`[terminal] ${message}`)),
  resolveDirectory: (sessionId, dir) => workspace.resolveDirectory(sessionId, dir),
  log: (message) => log(`[terminal] ${message}`),
});
// macOS notifications and the Dock badge. Windows decide when to ask; see notifications.ts.
const notifications = createNotificationService<WebContents>({
  getSettings: () => settings.get(),
  isAnyWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
  isSupported: () => Notification.isSupported(),
  createNotification: (options) => {
    const notification = new Notification(options);
    return {
      show: () => notification.show(),
      close: () => notification.close(),
      onClick: (listener) => notification.on("click", listener),
      onClose: (listener) => notification.on("close", listener),
    };
  },
  setDockBadge: (text) => app.dock?.setBadge(text),
  windowKeyOf: (sender) => String(sender.id),
  openInWindow: (sender, sessionId) => {
    if (sender.isDestroyed()) return false;
    const window = BrowserWindow.fromWebContents(sender);
    if (!window || window.isDestroyed()) return false;
    bringForward(window);
    sendWhenLoaded(sender, IPC.notificationsOpenSession, sessionId);
    return true;
  },
  openInMainWindow: (sessionId) => void openSessionInMainWindow(sessionId),
  log: (message) => log(`[notifications] ${message}`),
});

app.setName(APP_NAME);
// Chromium's profile: separate for dev so a dev build and the built app can run side by side,
// and under $DAWG_HOME when it is set so tests and experiments leave the real profile alone.
if (process.env.DAWG_HOME) app.setPath("userData", path.join(dataRoot, "electron"));
else
  app.setPath("userData", path.join(app.getPath("appData"), isDev ? `${APP_NAME}-dev` : APP_NAME));

let mainWindow: BrowserWindow | null = null;
let supervisor: EngineSupervisor<MessagePortMain> | null = null;
const ownWebContents = new Set<number>();

const platform: PlatformInfo = PlatformInfoSchema.parse({
  os: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
  arch: process.arch,
  homeDir,
  appVersion: app.getVersion(),
  isDev,
  engine: mode,
});

// The menu bar and the Dock menu, from each window's action registry (see menu-bar.ts).
const menuBar = createMenuBar({
  template: {
    appName: APP_NAME,
    isDev,
    platform: process.platform,
    onRestartEngineHost: () => supervisor?.restart(),
  },
  show: (bar, dock) => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(bar));
    app.dock?.setMenu(Menu.buildFromTemplate(dock));
  },
  focusedWindow: () => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return null;
    return ownWebContents.has(window.webContents.id) ? window.webContents.id : null;
  },
  openWindows: () => ownWindows().map((window) => window.webContents.id),
  bringForward: (id) => {
    const window = ownWindows().find((candidate) => candidate.webContents.id === id);
    if (window) bringForward(window);
  },
  openMainWindow: () => {
    if (mainWindow && !mainWindow.isDestroyed()) bringForward(mainWindow);
    else createMainWindow();
    // createMainWindow sets it.
    return (mainWindow as BrowserWindow | null)?.webContents.id ?? -1;
  },
  sendAction: (id, actionId) => {
    const window = ownWindows().find((candidate) => candidate.webContents.id === id);
    if (window && !window.webContents.isDestroyed()) {
      window.webContents.send(IPC.menuAction, actionId);
    }
  },
  openSession: (sessionId) => void openSessionInMainWindow(sessionId),
  openProjectPage: () => {
    shell.openExternal(PROJECT_URL).catch((error: unknown) => {
      log(
        `Could not open ${PROJECT_URL}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  },
});

/** dawg's open windows (not DevTools and the like). */
function ownWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && ownWebContents.has(window.webContents.id),
  );
}

async function start(): Promise<void> {
  installSecurity(location, log);
  applyAppearance(await settings.get());
  nativeTheme.on("updated", () => updateWindowBackgrounds());
  if (!app.isPackaged) showDockIcon();

  models.onState((state) => broadcast(IPC.modelsStateChanged, state));
  models.onStatus((status) => broadcast(IPC.modelsStatusChanged, status));
  workspace.onChanged((event) => broadcast(IPC.workspaceChanged, event));
  terminals.onData((event) => broadcast(IPC.terminalData, event));
  terminals.onExit((event) => broadcast(IPC.terminalExit, event));
  models.onModelsChanged(() => {
    const message: MainToHost = { type: "models-changed" };
    supervisor?.post(message);
  });
  void models.init().catch((error: unknown) => {
    log(
      `The model manager did not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  // The engine host gets the search service first thing, and again whenever it changes.
  await web.load().catch((error: unknown) => {
    log(`Web settings did not load: ${error instanceof Error ? error.message : String(error)}`);
  });
  web.onChange((search) => {
    const message: MainToHost = { type: "web-config", search };
    supervisor?.post(message);
  });

  supervisor = createEngineSupervisor<MessagePortMain>({
    spawn: () => {
      const child = spawnEngineHost({
        modulePath: engineHostPath,
        env: engineHostEnv(),
        log: console.log,
      });
      // Before any window's connection, so every session sees it (messages keep their order).
      const message: MainToHost = { type: "web-config", search: web.hostConfig() };
      child.postMessage(message, []);
      return child;
    },
    createChannel: () => {
      const { port1, port2 } = new MessageChannelMain();
      return { engineEnd: port1, clientEnd: port2 };
    },
    log: (message) => log(`[supervisor] ${message}`),
    onGaveUp: (reason) => void showEngineFailure(reason),
    onMessage: (message, reply) => {
      void answerHostMessage(models, message, (line) => log(`[models] ${line}`)).then((answer) => {
        if (answer) reply(answer);
      });
    },
  });
  supervisor.start();

  registerIpc();
  menuBar.render();
  // The menus follow the window with focus.
  app.on("browser-window-focus", () => menuBar.render());

  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

function engineHostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = homeDir;
  env.DAWG_HOME = dataRoot;
  env.DAWG_ENGINE = mode;
  env.DAWG_RESOURCES_DIR = resourcesDir;
  if (process.env.DAWG_MOCK_SPEED !== undefined) env.DAWG_MOCK_SPEED = process.env.DAWG_MOCK_SPEED;
  return env;
}

/** A packaged build takes its icon from the bundle; unpackaged, Electron's own would show. */
function showDockIcon(): void {
  const icon = path.join(resourcesDir, "icon.png");
  try {
    // At 256 px, the Dock's largest regular tile: handing it the 1024 px artwork kept the window
    // from showing for 0.35 to 0.6 s on an Intel Mac (README, "Performance").
    app.dock?.setIcon(nativeImage.createFromPath(icon).resize({ width: 256, quality: "best" }));
  } catch (error) {
    log(
      `Could not show the Dock icon from ${icon}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Sends to every window's page. */
function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, value);
  }
}

function createMainWindow(): void {
  const bounds = initialBounds(screen.getPrimaryDisplay().workArea);
  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    backgroundColor: currentBackground(),
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = window;
  const contentsId = window.webContents.id;
  ownWebContents.add(contentsId);

  let shown = false;
  const show = (why: string) => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    window.show();
    // From the process's creation, which includes Electron's own start (the spec's budget is
    // 2 s from launch), and from when this file began to run.
    const created = process.getCreationTime();
    const sinceStart =
      created === null ? "" : `${Math.round(Date.now() - created)} ms after the app started, `;
    log(`Window visible ${sinceStart}${Date.now() - launchedAt} ms after main loaded (${why}).`);
  };
  window.once("ready-to-show", () => show("ready to show"));
  // A page that never paints (a crash, a broken build) must still give the person a window.
  setTimeout(() => show("timeout"), 3000);

  window.webContents.on("render-process-gone", (_event, details) => {
    log(`The renderer exited (${details.reason}, code ${details.exitCode}).`);
  });
  if (isDev) {
    // In dev, page errors (CSP violations, failed imports) show up in the terminal too.
    window.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") {
        log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
      }
    });
  }
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) menuBar.pageLoading(contentsId);
  });
  window.webContents.once("destroyed", () => {
    ownWebContents.delete(contentsId);
    menuBar.windowClosed(contentsId);
    supervisor?.removeClient(String(contentsId));
    workspace.releaseOwner(String(contentsId));
    notifications.windowClosed(String(contentsId));
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  void window.loadURL(appUrl(location)).catch((error: unknown) => {
    log(`Could not load the app page: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function focusMainWindow(): void {
  if (mainWindow) bringForward(mainWindow);
}

function bringForward(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Sends to a page, after it has loaded when it is still loading (a window just made). */
function sendWhenLoaded(contents: WebContents, channel: string, value: unknown): void {
  if (contents.isDestroyed()) return;
  if (!contents.isLoading()) {
    contents.send(channel, value);
    return;
  }
  contents.once("did-finish-load", () => {
    if (!contents.isDestroyed()) contents.send(channel, value);
  });
}

/**
 * A notification was clicked after the window that asked closed. With no window open, the new one
 * starts on the session: it is saved as the window's selection before the page loads, so the
 * page cannot miss it.
 */
async function openSessionInMainWindow(sessionId: string): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    bringForward(mainWindow);
    sendWhenLoaded(mainWindow.webContents, IPC.notificationsOpenSession, sessionId);
    return;
  }
  try {
    const saved = await windowState.load("main");
    await windowState.save("main", { ...saved, selectedSessionId: sessionId });
  } catch (error) {
    log(
      `Could not select the session for the new window: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!mainWindow) createMainWindow();
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

function currentBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

function applyAppearance(value: DesktopSettings): void {
  nativeTheme.themeSource = value.appearance;
  updateWindowBackgrounds();
}

function updateWindowBackgrounds(): void {
  const color = currentBackground();
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(color);
}

// ---------------------------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------------------------

function trusted(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
  const isOwn = (id: number) => ownWebContents.has(id);
  const ok = isTrustedSender(event, location, isOwn);
  if (!ok) log(describeRefusedSender(event, channel, isOwn));
  return ok;
}

function registerIpc(): void {
  const handlers = createInvokeHandlers<WebContents>({
    settings,
    windowState,
    models,
    workspace,
    worktrees,
    terminals,
    notifications,
    // The same home the engine host is given as HOME, so the page edits the files sessions read.
    permissions: createPermissionSettingsService({ homeDir }),
    ownerOf: (sender) => String(sender.id),
    windowIdFor: () => "main",
    settingsChanged: (value) => {
      applyAppearance(value);
      notifications.settingsChanged(value);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC.settingsChanged, value);
      }
    },
    chooseFolder: async (sender, options) => {
      const owner = BrowserWindow.fromWebContents(sender);
      const dialogOptions: OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
        ...(options?.title === undefined ? {} : { title: options.title }),
        ...(options?.defaultPath === undefined ? {} : { defaultPath: options.defaultPath }),
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    chooseModelFile: async (sender) => {
      const owner = BrowserWindow.fromWebContents(sender);
      const dialogOptions: OpenDialogOptions = {
        title: "Add a model file",
        buttonLabel: "Add",
        properties: ["openFile"],
        filters: [{ name: "GGUF model", extensions: ["gguf"] }],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    openExternal: (url) => shell.openExternal(url),
    openConfigFile: async (file) => {
      const failure = await shell.openPath(await checkConfigFile(file));
      if (failure !== "") throw new Error(failure);
    },
  });

  for (const [channel, handler] of Object.entries({
    ...handlers,
    ...createWebInvokeHandlers<WebContents>(web),
  })) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event, channel))
        throw new Error("This call is only allowed from the app's own page");
      return handler(event.sender, args);
    });
  }

  const sendHandlers = {
    ...createSendHandlers<WebContents>({ terminals }, (message) => log(`[ipc] ${message}`)),
    ...createMenuSendHandlers<WebContents>(
      { update: (sender, model) => menuBar.update(sender.id, model) },
      (message) => log(`[ipc] ${message}`),
    ),
  };
  for (const [channel, handler] of Object.entries(sendHandlers)) {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (trusted(event, channel)) handler(event.sender, args);
    });
  }

  ipcMain.on(IPC.platform, (event) => {
    event.returnValue = trusted(event, IPC.platform) ? platform : null;
  });

  ipcMain.on(IPC.engineConnect, (event) => {
    if (!trusted(event, IPC.engineConnect)) return;
    connectEngine(event.sender);
  });
}

function connectEngine(contents: WebContents): void {
  supervisor?.connect(String(contents.id), {
    deliverPort: (port) => {
      if (contents.isDestroyed()) {
        port.close();
        return;
      }
      contents.postMessage(IPC.enginePort, null, [port]);
    },
    notifyRestart: (reason) => {
      if (contents.isDestroyed()) return;
      const info: EngineRestartInfo = { reason };
      contents.send(IPC.engineRestart, info);
    },
  });
}

async function showEngineFailure(reason: string): Promise<void> {
  const options = {
    type: "error" as const,
    message: "The engine stopped and could not be restarted",
    detail: reason,
    buttons: ["Try again", "Close"],
    defaultId: 0,
    cancelId: 1,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response === 0) supervisor?.restart();
}

// ---------------------------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------------------------

// The runtime stops before the app goes: no llama-server outlives it. Quitting waits for that,
// at most `QUIT_GRACE_MS` (llama-server gets SIGTERM, then SIGKILL after 10 s).
const QUIT_GRACE_MS = 12_000;
let modelsStopped = false;
app.on("before-quit", (event) => {
  if (modelsStopped) return;
  event.preventDefault();
  modelsStopped = true;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_GRACE_MS).unref());
  void Promise.race([models.dispose(), timeout])
    .catch((error: unknown) => {
      log(`Stopping the models failed: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => app.quit());
});

app.on("will-quit", () => {
  supervisor?.stop();
  // No shell outlives the app.
  terminals.disposeAll();
  workspace.dispose();
  // A notification clicked after quitting would reach nothing.
  notifications.closeAll();
});

// On macOS the app stays open with no windows; the Dock icon brings one back ("activate").
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------

app.enableSandbox();

if (!app.requestSingleInstanceLock()) {
  log("Another dawg-code is already running; focusing it instead.");
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
  void app.whenReady().then(start);
}
