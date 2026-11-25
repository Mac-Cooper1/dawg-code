import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, ExternalUrlSchema, IPC } from "../shared/bridge.ts";
import { MOCK_MODELS } from "../shared/mock-models.ts";
import {
  appLocation,
  appUrl,
  describeRefusedSender,
  isAppUrl,
  isTrustedSender,
} from "./app-url.ts";
import { createInvokeHandlers, createSendHandlers, type MainServices } from "./ipc-handlers.ts";
import { createMockModelService } from "./models/mock.ts";
import type { ModelService } from "./models/service.ts";
import type { SettingsStore, WindowStateStore } from "./stores.ts";
import type { TerminalService } from "./terminal/service.ts";
import { initialBounds } from "./window-geometry.ts";
import type { WorkspaceService } from "./workspace/service.ts";
import type { WorktreeService } from "./workspace/worktrees.ts";

/** The mock service, recording every call that changes something. */
function recordingModels(): ModelService & { calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const base = createMockModelService();
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  return {
    ...base,
    calls,
    download: record("download"),
    pauseDownload: record("pauseDownload"),
    cancelDownload: record("cancelDownload"),
    dismissDownload: record("dismissDownload"),
    useExisting: record("useExisting"),
    remove: record("remove"),
    start: record("start"),
    stop: record("stop"),
    setDefault: record("setDefault"),
    setIdleUnload: record("setIdleUnload"),
    removeServer: record("removeServer"),
    refreshServers: record("refreshServers"),
    addModelFile: async (choose) => {
      calls.push(["addModelFile", await choose()]);
      return null;
    },
    connectServer: async (input) => {
      calls.push(["connectServer", input]);
      return base.connectServer(input);
    },
  };
}

/** Workspace, worktree and terminal services that record what reaches them. */
function recordingPanes() {
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): never => {
      calls.push([name, ...args]);
      return Promise.resolve(null) as never;
    };
  const workspace: WorkspaceService = {
    track: record("track"),
    untrack: record("untrack"),
    releaseOwner: record("releaseOwner"),
    changes: record("changes"),
    fileDiff: record("fileDiff"),
    revert: record("revert"),
    listDirectory: record("listDirectory"),
    readFile: record("readFile"),
    writeFile: record("writeFile"),
    onChanged: () => () => {},
    resolveDirectory: record("resolveDirectory"),
    dispose: () => {},
  };
  const worktrees: WorktreeService = {
    branches: record("branches"),
    create: record("create"),
    cleanup: record("cleanup"),
  };
  const terminals: TerminalService = {
    open: record("open"),
    write: (...args) => {
      calls.push(["write", ...args]);
    },
    resize: (...args) => {
      calls.push(["resize", ...args]);
    },
    close: record("close"),
    list: record("list"),
    onData: () => () => {},
    onExit: () => () => {},
    disposeAll: () => {},
  };
  return { calls, workspace, worktrees, terminals };
}

function services(): MainServices<string> & {
  opened: string[];
  changed: unknown[];
  models: ReturnType<typeof recordingModels>;
  pickedFor: string[];
  panes: ReturnType<typeof recordingPanes>;
} {
  const opened: string[] = [];
  const changed: unknown[] = [];
  const pickedFor: string[] = [];
  const settings: SettingsStore = {
    get: async () => DEFAULT_SETTINGS,
    update: async (patch) => ({ ...DEFAULT_SETTINGS, ...(patch as object) }),
  };
  const windowState: WindowStateStore = { load: vi.fn(), save: vi.fn() };
  const panes = recordingPanes();
  return {
    opened,
    changed,
    pickedFor,
    settings,
    windowState,
    panes,
    workspace: panes.workspace,
    worktrees: panes.worktrees,
    terminals: panes.terminals,
    ownerOf: (sender) => `owner:${sender}`,
    models: recordingModels(),
    chooseModelFile: async (sender) => {
      pickedFor.push(sender);
      return "/models/picked.gguf";
    },
    windowIdFor: () => "main",
    settingsChanged: (value) => changed.push(value),
    chooseFolder: async (_sender, options) => options?.defaultPath ?? "/picked",
    openExternal: async (url) => {
      opened.push(url);
    },
  };
}

function handler(name: string, target = services()) {
  const found = createInvokeHandlers(target)[name];
  if (!found) throw new Error(`no handler for ${name}`);
  return found;
}

describe("IPC handlers", () => {
  it("opens only http and https links", async () => {
    const target = services();
    const open = handler(IPC.openExternal, target);
    await open("sender", ["https://example.com/a?b=1"]);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "not a url", 42, undefined]) {
      await expect(open("sender", [bad])).rejects.toThrow(/Invalid link/);
    }
    expect(target.opened).toEqual(["https://example.com/a?b=1"]);
  });

  it("validates folder dialog options", async () => {
    const choose = handler(IPC.chooseFolder);
    expect(await choose("sender", [undefined])).toBe("/picked");
    expect(await choose("sender", [{ title: "Pick", defaultPath: "/x" }])).toBe("/x");
    await expect(choose("sender", [{ title: "Pick", evil: true }])).rejects.toThrow(
      /Invalid folder options/,
    );
    await expect(choose("sender", [{ title: "x".repeat(201) }])).rejects.toThrow();
  });

  it("announces settings changes after a successful update", async () => {
    const target = services();
    const result = await handler(IPC.settingsUpdate, target)("sender", [{ appearance: "light" }]);
    expect(result).toMatchObject({ appearance: "light" });
    expect(target.changed).toEqual([result]);
  });

  it("passes window state to the store for the sender's window", async () => {
    const target = services();
    await handler(IPC.windowStateSave, target)("sender", [{ sidebarOpen: false }]);
    expect(target.windowState.save).toHaveBeenCalledWith("main", { sidebarOpen: false });
  });

  it("serves the models the service has", async () => {
    expect(await handler(IPC.modelsList)("sender", [])).toEqual(MOCK_MODELS.map((m) => m.option));
    expect(await handler(IPC.modelsStatus)("sender", [])).toMatchObject({ state: "ready" });
    expect(await handler(IPC.modelsState)("sender", [])).toMatchObject({
      defaultModelId: "qwen3.8-27b-q8",
      downloads: [],
    });
  });

  it("validates model ids before they reach the model service", async () => {
    const target = services();
    const channels = [
      IPC.modelsDownload,
      IPC.modelsPauseDownload,
      IPC.modelsCancelDownload,
      IPC.modelsDismissDownload,
      IPC.modelsUseExisting,
      IPC.modelsRemove,
      IPC.modelsStart,
      IPC.modelsSetDefault,
    ];
    for (const channel of channels) {
      for (const bad of ["", 42, undefined, "x".repeat(513), { id: "a" }]) {
        await expect(handler(channel, target)("sender", [bad])).rejects.toThrow(/Invalid model id/);
      }
      await handler(channel, target)("sender", ["qwen3.8-27b-q8"]);
    }
    await expect(handler(IPC.modelsRemoveServer, target)("sender", [""])).rejects.toThrow(
      /Invalid server id/,
    );
    await handler(IPC.modelsRemoveServer, target)("sender", ["remote:1f3a9c"]);
    expect(target.models.calls).toEqual([
      ["download", "qwen3.8-27b-q8"],
      ["pauseDownload", "qwen3.8-27b-q8"],
      ["cancelDownload", "qwen3.8-27b-q8"],
      ["dismissDownload", "qwen3.8-27b-q8"],
      ["useExisting", "qwen3.8-27b-q8"],
      ["remove", "qwen3.8-27b-q8"],
      ["start", "qwen3.8-27b-q8"],
      ["setDefault", "qwen3.8-27b-q8"],
      ["removeServer", "remote:1f3a9c"],
    ]);
  });

  it("validates the idle unload time", async () => {
    const target = services();
    const set = handler(IPC.modelsSetIdleUnload, target);
    for (const bad of [0, -5, 1.5, 24 * 60 + 1, "10", undefined]) {
      await expect(set("sender", [bad])).rejects.toThrow(/Invalid idle unload time/);
    }
    await set("sender", [null]);
    await set("sender", [30]);
    expect(target.models.calls).toEqual([
      ["setIdleUnload", null],
      ["setIdleUnload", 30],
    ]);
  });

  it("validates a server before connecting to it", async () => {
    const target = services();
    const connect = handler(IPC.modelsConnectServer, target);
    for (const bad of [
      { url: "ftp://example.com" },
      { url: "not a url" },
      { url: "https://example.com", apiKey: "" },
      { url: "https://example.com", extra: true },
      "https://example.com",
    ]) {
      await expect(connect("sender", [bad])).rejects.toThrow(/Invalid server/);
    }
    await connect("sender", [{ url: "https://example.com/v1", apiKey: "sk-1" }]);
    expect(target.models.calls).toEqual([
      ["connectServer", { url: "https://example.com/v1", apiKey: "sk-1" }],
    ]);
  });

  it("asks for a model file with the native picker of the calling window", async () => {
    const target = services();
    expect(await handler(IPC.modelsAddFile, target)("window-1", [])).toBeNull();
    expect(target.pickedFor).toEqual(["window-1"]);
    expect(target.models.calls).toEqual([["addModelFile", "/models/picked.gguf"]]);
  });

  it("has a handler for every invoke channel of the models bridge", () => {
    const handlers = createInvokeHandlers(services());
    const invokeChannels = Object.entries(IPC)
      .filter(([name]) => name.startsWith("models") && !name.endsWith("Changed"))
      .map(([, channel]) => channel);
    for (const channel of invokeChannels) expect(handlers[channel]).toBeTypeOf("function");
  });
});

describe("workspace, worktree and terminal IPC", () => {
  const session = { sessionId: "s1", cwd: "/Users/me/tally", projectDir: "/Users/me/tally" };
  const file = { sessionId: "s1", path: "/Users/me/tally/src/a.ts" };
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] };

  it("validates every call before it reaches the services", async () => {
    const target = services();
    const bad: [string, unknown[], RegExp][] = [
      [IPC.workspaceTrack, [{ ...session, cwd: "relative/path" }], /Invalid session/],
      [IPC.workspaceTrack, [{ ...session, evil: true }], /Invalid session/],
      [IPC.workspaceTrack, [{ ...session, additionalDirectories: ["x"] }], /Invalid session/],
      [IPC.workspaceUntrack, [""], /Invalid session id/],
      [IPC.workspaceChanges, [42], /Invalid session id/],
      [IPC.workspaceFileDiff, [{ ...file, path: "src/a.ts" }], /Invalid file/],
      [IPC.workspaceListDirectory, [{ sessionId: "s1" }], /Invalid file/],
      [IPC.workspaceReadFile, ["/Users/me/tally/a.ts"], /Invalid file/],
      [IPC.workspaceRevert, [{ ...file, hunk: { ...hunk, lines: "x" } }], /Invalid revert/],
      [IPC.workspaceWriteFile, [{ ...file, content: 7 }], /Invalid file/],
      [IPC.workspaceWriteFile, [{ ...file, content: "x", expectedMtimeMs: -1 }], /Invalid file/],
      [
        IPC.workspaceWriteFile,
        [{ ...file, content: "x".repeat(5 * 1024 * 1024 + 1) }],
        /Invalid file/,
      ],
      [IPC.worktreesBranches, ["/Users/me/tally"], /Invalid project/],
      [
        IPC.worktreesCreate,
        [{ projectDir: "/p", name: "Bad Name", base: "main" }],
        /Invalid worktree/,
      ],
      [IPC.worktreesCreate, [{ projectDir: "/p", name: "../x", base: "main" }], /Invalid worktree/],
      [IPC.worktreesCreate, [{ projectDir: "/p", name: "ok", base: "" }], /Invalid worktree/],
      [IPC.worktreesCleanup, ["relative"], /Invalid worktree path/],
      [IPC.terminalOpen, [{ sessionId: "s1", cwd: "/p", cols: 1, rows: 24 }], /Invalid terminal/],
      [IPC.terminalOpen, [{ sessionId: "s1", cwd: "/p", cols: 80, rows: 501 }], /Invalid terminal/],
      [IPC.terminalClose, [""], /Invalid terminal id/],
      [IPC.terminalList, [undefined], /Invalid session id/],
    ];
    for (const [channel, args, message] of bad) {
      await expect(handler(channel, target)("window-1", args)).rejects.toThrow(message);
    }
    expect(target.panes.calls).toEqual([]);
  });

  it("passes valid calls on, with the calling window as the owner of a tracked session", async () => {
    const target = services();
    const call = (channel: string, ...args: unknown[]) =>
      handler(channel, target)("window-1", args);
    await call(IPC.workspaceTrack, session);
    await call(IPC.workspaceUntrack, "s1");
    await call(IPC.workspaceChanges, "s1");
    await call(IPC.workspaceFileDiff, file);
    await call(IPC.workspaceRevert, { ...file, hunk });
    await call(IPC.workspaceListDirectory, file);
    await call(IPC.workspaceReadFile, file);
    await call(IPC.workspaceWriteFile, { ...file, content: "x", expectedMtimeMs: 12.5 });
    await call(IPC.worktreesBranches, { projectDir: "/Users/me/tally" });
    await call(IPC.worktreesCreate, { projectDir: "/p", name: "fix-1", base: "main" });
    await call(IPC.worktreesCleanup, "/p/.dawg/worktrees/fix-1");
    await call(IPC.terminalOpen, { sessionId: "s1", cwd: "/p", cols: 80, rows: 24 });
    await call(IPC.terminalClose, "t1");
    await call(IPC.terminalList, "s1");
    expect(target.panes.calls).toEqual([
      ["track", { ...session, additionalDirectories: [] }, "owner:window-1"],
      ["untrack", "s1", "owner:window-1"],
      ["changes", "s1"],
      ["fileDiff", file],
      ["revert", { ...file, hunk }],
      ["listDirectory", file],
      ["readFile", file],
      ["writeFile", { ...file, content: "x", expectedMtimeMs: 12.5 }],
      ["branches", "/Users/me/tally"],
      ["create", { projectDir: "/p", name: "fix-1", base: "main" }],
      ["cleanup", "/p/.dawg/worktrees/fix-1"],
      ["open", { sessionId: "s1", cwd: "/p", cols: 80, rows: 24 }],
      ["close", "t1"],
      ["list", "s1"],
    ]);
  });

  it("drops invalid keystrokes and resizes, and passes valid ones on", () => {
    const target = services();
    const logs: string[] = [];
    const send = createSendHandlers(target, (m) => logs.push(m));
    const write = send[IPC.terminalWrite];
    const resize = send[IPC.terminalResize];
    if (!write || !resize) throw new Error("missing send handlers");
    write("window-1", ["t1", "ls\r"]);
    write("window-1", ["t1", 42]);
    write("window-1", ["", "x"]);
    write("window-1", ["t1", "x".repeat(1024 * 1024 + 1)]);
    resize("window-1", ["t1", 120, 40]);
    resize("window-1", ["t1", 1, 40]);
    resize("window-1", ["t1", 80, 1.5]);
    expect(target.panes.calls).toEqual([
      ["write", "t1", "ls\r"],
      ["resize", "t1", 120, 40],
    ]);
    expect(logs).toHaveLength(5);
    expect(logs[0]).toMatch(/Dropped "dawg:terminal:write": Invalid terminal input/);
  });

  it("has a handler for every channel of the new bridge sections", () => {
    const target = services();
    const invoke = createInvokeHandlers(target);
    const send = createSendHandlers(target, () => {});
    const events = [IPC.workspaceChanged, IPC.terminalData, IPC.terminalExit];
    const channels = Object.entries(IPC)
      .filter(([name]) => /^(workspace|worktrees|terminal)/.test(name))
      .map(([, channel]) => channel)
      .filter((channel) => !(events as string[]).includes(channel));
    for (const channel of channels) {
      expect(invoke[channel] ?? send[channel]).toBeTypeOf("function");
    }
  });
});

describe("URL validation", () => {
  it("accepts only http(s)", () => {
    expect(ExternalUrlSchema.safeParse("http://localhost:3000").success).toBe(true);
    expect(ExternalUrlSchema.safeParse("mailto:a@b.c").success).toBe(false);
    expect(ExternalUrlSchema.safeParse("dawg://x").success).toBe(false);
  });

  it("recognises the app's own page in dev and in the built app", () => {
    const dev = appLocation("http://localhost:5173", "/app/out/renderer/index.html");
    expect(isAppUrl("http://localhost:5173/", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5173/src/x.ts?t=1", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isAppUrl("https://evil.example/", dev)).toBe(false);

    const built = appLocation(undefined, "/app/out/renderer/index.html");
    expect(appUrl(built)).toBe("file:///app/out/renderer/index.html");
    expect(isAppUrl("file:///app/out/renderer/index.html#/settings", built)).toBe(true);
    expect(isAppUrl("file:///app/out/renderer/other.html", built)).toBe(false);
    expect(isAppUrl("file:///etc/passwd", built)).toBe(false);
    expect(isAppUrl("http://localhost:5173/", built)).toBe(false);
    expect(isAppUrl("garbage", built)).toBe(false);
  });

  it("trusts only the top frame of the app's own windows", () => {
    const location = appLocation(undefined, "/app/out/renderer/index.html");
    const mainFrame = { url: "file:///app/out/renderer/index.html" };
    const own = (id: number) => id === 1;
    expect(
      isTrustedSender({ sender: { id: 1, mainFrame }, senderFrame: mainFrame }, location, own),
    ).toBe(true);
    const sub = { url: mainFrame.url };
    expect(isTrustedSender({ sender: { id: 1, mainFrame }, senderFrame: sub }, location, own)).toBe(
      false,
    );
    expect(
      isTrustedSender({ sender: { id: 2, mainFrame }, senderFrame: mainFrame }, location, own),
    ).toBe(false);
    expect(
      isTrustedSender({ sender: { id: 1, mainFrame }, senderFrame: null }, location, own),
    ).toBe(false);
    const away = { url: "https://evil.example/" };
    expect(
      isTrustedSender({ sender: { id: 1, mainFrame: away }, senderFrame: away }, location, own),
    ).toBe(false);
  });
});

describe("refused senders", () => {
  const location = appLocation(undefined, "/app/out/renderer/index.html");
  const own = (id: number) => id === 1;

  it("refuses our own window's initial blank document and says so", () => {
    // What Electron reports for the preload's sendSync when it runs in the about:blank document
    // that precedes the app page (seen under Playwright): our window, its main frame, no URL yet.
    const blank = { url: "" };
    const event = { sender: { id: 1, mainFrame: blank }, senderFrame: blank };
    expect(isTrustedSender(event, location, own)).toBe(false);
    expect(describeRefusedSender(event, "dawg:platform", own)).toBe(
      'Refused "dawg:platform" from window 1\'s initial blank document, before the app page loaded (harmless).',
    );
  });

  it("names the other reasons", () => {
    const page = { url: "file:///app/out/renderer/index.html" };
    const away = { url: "https://evil.example/" };
    const sub = { url: "" };
    expect(
      describeRefusedSender({ sender: { id: 1, mainFrame: page }, senderFrame: null }, "c", own),
    ).toMatch(/frame is gone/);
    expect(
      describeRefusedSender({ sender: { id: 2, mainFrame: page }, senderFrame: page }, "c", own),
    ).toMatch(/not an app window/);
    expect(
      describeRefusedSender({ sender: { id: 1, mainFrame: page }, senderFrame: sub }, "c", own),
    ).toMatch(/subframe/);
    expect(
      describeRefusedSender({ sender: { id: 1, mainFrame: away }, senderFrame: away }, "c", own),
    ).toMatch(/not the app page/);
  });
});

describe("window geometry", () => {
  it("uses 1440×900 when it fits and shrinks to the work area otherwise, centred", () => {
    expect(initialBounds({ x: 0, y: 25, width: 2560, height: 1415 })).toEqual({
      x: 560,
      y: 283,
      width: 1440,
      height: 900,
    });
    expect(initialBounds({ x: 0, y: 25, width: 1280, height: 775 })).toEqual({
      x: 0,
      y: 25,
      width: 1280,
      height: 775,
    });
  });
});
