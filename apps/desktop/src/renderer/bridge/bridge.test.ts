import {
  createClient,
  createMessagePortTransport,
  createServer,
  PROTOCOL_VERSION,
  type Transport,
} from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW_STATE,
  ENGINE_PORT_MESSAGE,
  type PreloadApi,
} from "../../shared/bridge.ts";
import { createElectronBridge, type PortWindow } from "./electron.ts";
import {
  BROWSER_CHOSEN_FOLDER,
  createMemoryBridge,
  type EngineLike,
  getBridge,
  type StorageLike,
  setBridgeForTests,
} from "./index.ts";
import { STORAGE_KEYS } from "./memory.ts";

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  setBridgeForTests(null);
});

/** An engine that answers `initialize`, and counts its connections. */
function fakeEngine(): EngineLike & { transports: Transport[] } {
  const transports: Transport[] = [];
  return {
    transports,
    connect(transport) {
      transports.push(transport);
      createServer(transport, {
        initialize: () => ({
          protocolVersion: PROTOCOL_VERSION,
          engine: { name: "fake engine", version: "1.0.0" },
          capabilities: { methods: ["initialize"], events: [], maxMessageLength: null },
        }),
      });
    },
  };
}

function nextPort(bridge: { engine: { onPort(l: (p: MessagePort) => void): () => void } }) {
  return new Promise<MessagePort>((resolve) => {
    const stop = bridge.engine.onPort((port) => {
      stop();
      ports.push(port);
      resolve(port);
    });
  });
}

async function initializeOver(port: MessagePort) {
  const client = createClient(createMessagePortTransport(port));
  return client.initialize({ client: { name: "test", version: "0" }, capabilities: {} });
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("memory bridge", () => {
  it("delivers a port that reaches the engine", async () => {
    const engine = fakeEngine();
    const bridge = createMemoryBridge({ engine, storage: null });
    const port = nextPort(bridge);
    bridge.engine.connect();
    const result = await initializeOver(await port);
    expect(result.engine.name).toBe("fake engine");
    expect(engine.transports).toHaveLength(1);
  });

  it("holds a port that arrives before anyone listens", async () => {
    const bridge = createMemoryBridge({ engine: fakeEngine(), storage: null });
    bridge.engine.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await initializeOver(await nextPort(bridge));
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("simulates a restart: onRestart, the old connection closed, then a fresh port", async () => {
    const engine = fakeEngine();
    const bridge = createMemoryBridge({ engine, storage: null });
    const first = nextPort(bridge);
    bridge.engine.connect();
    await initializeOver(await first);

    const reasons: string[] = [];
    bridge.engine.onRestart((info) => reasons.push(info.reason));
    const second = nextPort(bridge);
    bridge.simulateEngineRestart("boom");
    expect(reasons).toEqual(["boom"]);
    expect(engine.transports[0]?.closed).toBe(true);
    await initializeOver(await second);
    expect(engine.transports).toHaveLength(2);
  });

  it("serves a readable error when the engine cannot start", async () => {
    const bridge = createMemoryBridge({
      storage: null,
      engine: {
        connect: () => {
          throw new Error("no engine here");
        },
      },
    });
    const port = nextPort(bridge);
    bridge.engine.connect();
    await expect(initializeOver(await port)).rejects.toThrow(/no engine here/);
  });

  it("persists settings and window state, and notifies settings listeners", async () => {
    const storage = memoryStorage();
    const bridge = createMemoryBridge({ storage });
    expect(await bridge.settings.get()).toEqual(DEFAULT_SETTINGS);
    const seen: string[] = [];
    bridge.settings.onChange((value) => seen.push(value.appearance));
    await bridge.settings.update({ appearance: "light" });
    await bridge.windowState.save({ ...DEFAULT_WINDOW_STATE, sidebarWidth: 300 });
    expect(seen).toEqual(["light"]);

    const reopened = createMemoryBridge({ storage });
    expect((await reopened.settings.get()).appearance).toBe("light");
    expect((await reopened.windowState.load()).sidebarWidth).toBe(300);
    // Explicit options win over saved values.
    const explicit = createMemoryBridge({ storage, settings: { appearance: "dark" } });
    expect((await explicit.settings.get()).appearance).toBe("dark");
  });

  it("ignores corrupt or throwing storage", async () => {
    const storage = memoryStorage();
    storage.data.set(STORAGE_KEYS.settings, "{nope");
    expect(await createMemoryBridge({ storage }).settings.get()).toEqual(DEFAULT_SETTINGS);
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const bridge = createMemoryBridge({ storage: throwing });
    expect(await bridge.settings.update({ toolCalls: "open" })).toMatchObject({
      toolCalls: "open",
    });
  });

  it("validates input like the real bridge", async () => {
    const bridge = createMemoryBridge({ storage: null });
    // @ts-expect-error: not an appearance
    await expect(bridge.settings.update({ appearance: "purple" })).rejects.toThrow(/Invalid/);
    await expect(
      bridge.windowState.save({ ...DEFAULT_WINDOW_STATE, sidebarWidth: 1 }),
    ).rejects.toThrow();
    await expect(bridge.shell.openExternal("file:///etc/passwd")).rejects.toThrow(/Invalid link/);
    expect(await bridge.dialogs.chooseFolder()).toBe(BROWSER_CHOSEN_FOLDER);
  });

  it("reports browser platform info and the mock models", async () => {
    const bridge = createMemoryBridge({ storage: null, platform: { homeDir: "/home/x" } });
    expect(bridge.platform).toMatchObject({ os: "browser", homeDir: "/home/x", engine: "mock" });
    expect((await bridge.models.list()).length).toBeGreaterThan(0);
    expect((await bridge.models.status()).state).toBe("ready");
  });
});

describe("electron bridge", () => {
  function fakeWindow() {
    let listener: ((event: MessageEvent) => void) | null = null;
    const target: PortWindow & { dispatch(event: Partial<MessageEvent>): void } = {
      addEventListener: (_type, next) => {
        listener = next;
      },
      dispatch: (event) => listener?.(event as MessageEvent),
    };
    return target;
  }

  const preload = createMemoryBridge({ storage: null }) as unknown as PreloadApi;

  it("takes ports only from this window's own engine-port messages", () => {
    const target = fakeWindow();
    const bridge = createElectronBridge(preload, target);
    const received: MessagePort[] = [];
    bridge.engine.onPort((port) => received.push(port));
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);

    target.dispatch({ source: null, data: ENGINE_PORT_MESSAGE, ports: [port1] });
    target.dispatch({ source: target as never, data: "something else", ports: [port1] });
    target.dispatch({ source: target as never, data: ENGINE_PORT_MESSAGE, ports: [] });
    expect(received).toEqual([]);
    target.dispatch({ source: target as never, data: ENGINE_PORT_MESSAGE, ports: [port1] });
    expect(received).toEqual([port1]);
  });

  it("passes the rest straight to the preload", () => {
    const bridge = createElectronBridge(preload, fakeWindow());
    expect(bridge.platform).toBe(preload.platform);
    expect(bridge.settings).toBe(preload.settings);
  });
});

describe("getBridge", () => {
  it("falls back to a memoised memory bridge outside Electron, and can be overridden", () => {
    const first = getBridge();
    expect(first.platform.os).toBe("browser");
    expect(getBridge()).toBe(first);
    const replacement = createMemoryBridge({ storage: null });
    setBridgeForTests(replacement);
    expect(getBridge()).toBe(replacement);
    setBridgeForTests(null);
    expect(getBridge()).toBe(first);
  });
});
