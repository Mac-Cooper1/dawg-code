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
});
