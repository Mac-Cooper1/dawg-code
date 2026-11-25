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
import { createInvokeHandlers, type MainServices } from "./ipc-handlers.ts";
import { createMockModelService } from "./models/mock.ts";
import type { ModelService } from "./models/service.ts";
import type { SettingsStore, WindowStateStore } from "./stores.ts";
import { initialBounds } from "./window-geometry.ts";

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

function services(): MainServices<string> & {
  opened: string[];
  changed: unknown[];
  models: ReturnType<typeof recordingModels>;
  pickedFor: string[];
} {
  const opened: string[] = [];
  const changed: unknown[] = [];
  const pickedFor: string[] = [];
  const settings: SettingsStore = {
    get: async () => DEFAULT_SETTINGS,
    update: async (patch) => ({ ...DEFAULT_SETTINGS, ...(patch as object) }),
  };
  const windowState: WindowStateStore = { load: vi.fn(), save: vi.fn() };
  return {
    opened,
    changed,
    pickedFor,
    settings,
    windowState,
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
