/**
 * The main process: one window, the menu, settings and window state, and the engine host.
 * See README.md ("Processes") for how the pieces talk.
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
  nativeTheme,
  type OpenDialogOptions,
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
} from "../shared/bridge.ts";
import { appLocation, appUrl, describeRefusedSender, isTrustedSender } from "./app-url.ts";
import { spawnEngineHost } from "./engine-host-process.ts";
import { createEngineSupervisor, type EngineSupervisor } from "./engine-supervisor.ts";
import { createInvokeHandlers } from "./ipc-handlers.ts";
import { menuTemplate } from "./menu.ts";
import { homeDirFrom, resolveDataRoot, settingsFile, stateFile } from "./paths.ts";
import { installSecurity } from "./security.ts";
import { createSettingsStore, createWindowStateStore } from "./stores.ts";
import {
  initialBounds,
  MIN_WINDOW_SIZE,
  TRAFFIC_LIGHT_POSITION,
  WINDOW_BACKGROUND,
} from "./window-geometry.ts";

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
  engine: "mock",
});

async function start(): Promise<void> {
  installSecurity(location, log);
  applyAppearance(await settings.get());
  nativeTheme.on("updated", () => updateWindowBackgrounds());

  supervisor = createEngineSupervisor<MessagePortMain>({
    spawn: () =>
      spawnEngineHost({ modulePath: engineHostPath, env: engineHostEnv(), log: console.log }),
    createChannel: () => {
      const { port1, port2 } = new MessageChannelMain();
      return { engineEnd: port1, clientEnd: port2 };
    },
    log: (message) => log(`[supervisor] ${message}`),
    onGaveUp: (reason) => void showEngineFailure(reason),
  });
  supervisor.start();

  registerIpc();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        appName: APP_NAME,
        isDev,
        onRestartEngineHost: () => supervisor?.restart(),
      }),
    ),
  );

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
  if (process.env.DAWG_MOCK_SPEED !== undefined) env.DAWG_MOCK_SPEED = process.env.DAWG_MOCK_SPEED;
  return env;
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
    log(`Window visible ${Date.now() - launchedAt} ms after launch (${why}).`);
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
  window.webContents.once("destroyed", () => {
    ownWebContents.delete(contentsId);
    supervisor?.removeClient(String(contentsId));
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  void window.loadURL(appUrl(location)).catch((error: unknown) => {
    log(`Could not load the app page: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
    windowIdFor: () => "main",
    settingsChanged: (value) => {
      applyAppearance(value);
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
    openExternal: (url) => shell.openExternal(url),
  });

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event, channel))
        throw new Error("This call is only allowed from the app's own page");
      return handler(event.sender, args);
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

app.on("will-quit", () => {
  supervisor?.stop();
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
