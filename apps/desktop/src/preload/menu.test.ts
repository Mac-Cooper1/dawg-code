import { describe, expect, it } from "vitest";
import { IPC, type MenuModel, type PlatformInfo } from "../shared/bridge.ts";
import { createPreloadApi, type IpcRendererLike } from "./api.ts";

const platform: PlatformInfo = {
  os: "darwin",
  arch: "arm64",
  homeDir: "/Users/me",
  appVersion: "0.0.0",
  isDev: false,
  engine: "mock",
};

type Listener = (event: unknown, ...args: unknown[]) => void;

function fakeIpc() {
  const sent: [string, unknown[]][] = [];
  const listeners = new Map<string, Set<Listener>>();
  const ipc: IpcRendererLike = {
    invoke: async () => null,
    send: (channel, ...args) => sent.push([channel, args]),
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
  return { ipc, sent, emit };
}

const EMPTY: MenuModel = {
  app: [],
  file: [],
  edit: [],
  view: [],
  session: [],
  help: [],
  dock: [],
};

describe("the preload's menu section", () => {
  it("sends a valid model, and throws on an invalid one without sending it", () => {
    const { ipc, sent } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    const model: MenuModel = {
      ...EMPTY,
      file: [
        {
          type: "item",
          id: "session.new",
          label: "New session…",
          accelerator: "CmdOrCtrl+N",
          enabled: true,
        },
      ],
    };
    api.menu.update(model);
    expect(sent).toEqual([[IPC.menuUpdate, [model]]]);

    const bad = [
      { ...EMPTY, file: [{ type: "item", id: "x", label: "X", enabled: true, run: "code" }] },
      { ...EMPTY, file: [{ type: "item", id: "x", label: "X", enabled: true, accelerator: "K+" }] },
      { ...EMPTY, help: undefined },
    ];
    for (const value of bad) {
      expect(() => api.menu.update(value as unknown as MenuModel)).toThrow(/^Invalid menu/);
    }
    expect(sent).toHaveLength(1);
  });

  it("hears the actions main sends, until unsubscribed", () => {
    const { ipc, emit } = fakeIpc();
    const api = createPreloadApi(ipc, platform);
    const heard: string[] = [];
    const stop = api.menu.onAction((actionId) => heard.push(actionId));
    emit(IPC.menuAction, "session.fork");
    stop();
    emit(IPC.menuAction, "session.archive");
    expect(heard).toEqual(["session.fork"]);
  });
});
