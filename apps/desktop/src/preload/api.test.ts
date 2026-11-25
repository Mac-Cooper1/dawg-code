import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_STATE, IPC, type PlatformInfo } from "../shared/bridge.ts";
import { createPreloadApi, type IpcRendererLike } from "./api.ts";

const platform: PlatformInfo = {
  os: "darwin",
  arch: "x64",
  homeDir: "/Users/me",
  appVersion: "0.0.0",
  isDev: false,
  engine: "mock",
};

type Listener = (event: unknown, ...args: unknown[]) => void;

function fakeIpc() {
  const invoked: { channel: string; args: unknown[] }[] = [];
  const sent: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const ipc: IpcRendererLike = {
    invoke: async (channel, ...args) => {
      invoked.push({ channel, args });
      return channel === IPC.chooseFolder ? "/picked" : null;
    },
    send: (channel) => sent.push(channel),
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
  };
  const emit = (channel: string, value: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, value);
  };
  return { ipc, invoked, sent, emit, listeners };
}

describe("preload API", () => {
  it("rejects invalid input before it reaches IPC", async () => {
    const { ipc, invoked } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    const bad = [
      // @ts-expect-error: not an appearance
      api.settings.update({ appearance: "purple" }),
      // @ts-expect-error: unknown key
      api.settings.update({ fontSize: 14 }),
      api.windowState.save({ ...DEFAULT_WINDOW_STATE, dockWidth: 10 }),
      // @ts-expect-error: unknown option
      api.dialogs.chooseFolder({ multiple: true }),
      api.shell.openExternal("file:///etc/passwd"),
      api.shell.openExternal("javascript:alert(1)"),
    ];
    for (const call of bad) await expect(call).rejects.toThrow(/^Invalid /);
    expect(invoked).toEqual([]);
  });

  it("sends validated input over the right channels", async () => {
    const { ipc, invoked, sent } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    await api.settings.update({ appearance: "dark" });
    await api.windowState.save({ ...DEFAULT_WINDOW_STATE, sidebarOpen: false });
    expect(await api.dialogs.chooseFolder()).toBe("/picked");
    await api.shell.openExternal("https://example.com");
    api.engine.connect();
    expect(invoked.map((call) => call.channel)).toEqual([
      IPC.settingsUpdate,
      IPC.windowStateSave,
      IPC.chooseFolder,
      IPC.openExternal,
    ]);
    expect(invoked[0]?.args).toEqual([{ appearance: "dark" }]);
    expect(sent).toEqual([IPC.engineConnect]);
    expect(api.platform).toEqual(platform);
  });

  it("subscribes listeners and unsubscribes them", () => {
    const { ipc, emit, listeners } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    const reasons: string[] = [];
    const stop = api.engine.onRestart((info) => reasons.push(info.reason));
    emit(IPC.engineRestart, { reason: "gone" });
    stop();
    emit(IPC.engineRestart, { reason: "again" });
    expect(reasons).toEqual(["gone"]);
    expect(listeners.get(IPC.engineRestart)?.size).toBe(0);
  });

  it("validates every models call before it reaches IPC", async () => {
    const { ipc, invoked } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    const bad = [
      api.models.download(""),
      // @ts-expect-error: not a string
      api.models.pauseDownload(7),
      api.models.cancelDownload("x".repeat(513)),
      api.models.dismissDownload(""),
      api.models.useExisting(""),
      api.models.remove(""),
      api.models.start(""),
      api.models.setDefault(""),
      api.models.setIdleUnload(0),
      api.models.setIdleUnload(2.5),
      api.models.setIdleUnload(24 * 60 + 1),
      api.models.connectServer({ url: "file:///etc/passwd" }),
      api.models.connectServer({ url: "https://example.com", apiKey: "" }),
      // @ts-expect-error: unknown key
      api.models.connectServer({ url: "https://example.com", headers: {} }),
      api.models.removeServer(""),
    ];
    for (const call of bad) await expect(call).rejects.toThrow(/^Invalid /);
    expect(invoked).toEqual([]);
  });

  it("sends models calls over their channels", async () => {
    const { ipc, invoked } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    await api.models.state();
    await api.models.download("qwen3.8-27b-q8");
    await api.models.pauseDownload("qwen3.8-27b-q8");
    await api.models.cancelDownload("qwen3.8-27b-q8");
    await api.models.dismissDownload("qwen3.8-27b-q8");
    await api.models.useExisting("qwen3.8-27b-q8");
    await api.models.remove("qwen3.8-27b-q8");
    await api.models.start("ollama/qwen3:32b");
    await api.models.stop();
    await api.models.setDefault("qwen3.8-27b-q8");
    await api.models.setIdleUnload(null);
    await api.models.setIdleUnload(15);
    await api.models.addModelFile();
    await api.models.connectServer({ url: "https://example.com/v1", apiKey: "sk-1" });
    await api.models.removeServer("remote:1f3a9c");
    await api.models.refreshServers();
    expect(invoked).toEqual([
      { channel: IPC.modelsState, args: [] },
      { channel: IPC.modelsDownload, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsPauseDownload, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsCancelDownload, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsDismissDownload, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsUseExisting, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsRemove, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsStart, args: ["ollama/qwen3:32b"] },
      { channel: IPC.modelsStop, args: [] },
      { channel: IPC.modelsSetDefault, args: ["qwen3.8-27b-q8"] },
      { channel: IPC.modelsSetIdleUnload, args: [null] },
      { channel: IPC.modelsSetIdleUnload, args: [15] },
      { channel: IPC.modelsAddFile, args: [] },
      {
        channel: IPC.modelsConnectServer,
        args: [{ url: "https://example.com/v1", apiKey: "sk-1" }],
      },
      { channel: IPC.modelsRemoveServer, args: ["remote:1f3a9c"] },
      { channel: IPC.modelsRefreshServers, args: [] },
    ]);
  });

  it("delivers models state and status pushed by main", () => {
    const { ipc, emit } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    const states: unknown[] = [];
    const statuses: unknown[] = [];
    const stopState = api.models.onState((state) => states.push(state.defaultModelId));
    api.models.onStatus((status) => statuses.push(status.state));
    emit(IPC.modelsStateChanged, { defaultModelId: "a" });
    emit(IPC.modelsStatusChanged, { state: "loading" });
    stopState();
    emit(IPC.modelsStateChanged, { defaultModelId: "b" });
    expect(states).toEqual(["a"]);
    expect(statuses).toEqual(["loading"]);
  });
});
