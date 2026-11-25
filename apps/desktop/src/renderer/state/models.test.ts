import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsState } from "../../shared/bridge.ts";
import { MOCK_MODELS, mockModelsState } from "../../shared/mock-models.ts";
import {
  createFakeBridge,
  type FakeBridge,
  type FakeBridgeOptions,
} from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { PROJECT } from "./__fixtures__/streams.ts";
import { MODEL_LOADING_NOTICE_ID } from "./actions.ts";
import { MODEL_BOUND_TIMEOUT_MS } from "./connection.ts";
import { firstRunStep, leadModel, needsSetup } from "./models.ts";
import { selectModelFooter } from "./selectors.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

async function start(options: Omit<FakeBridgeOptions, "engine"> = {}): Promise<Harness> {
  const engine = new FakeEngine();
  const bridge = createFakeBridge({ engine, ...options });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  await store.getState().actions.start();
  return harness;
}

const Q8 = "qwen3.8-27b-q8";
const GPT_OSS = "gpt-oss-20b-q4";

function s(harness: Harness) {
  return harness.store.getState();
}

function emptyMac(patch: Partial<ModelsState> = {}): ModelsState {
  return { ...mockModelsState("empty"), ...patch };
}

describe("models state in the store", () => {
  it("loads the models state and keeps the picker's list and the status from it", async () => {
    const harness = await start();
    expect(s(harness).modelsState?.defaultModelId).toBe(Q8);
    expect(s(harness).models.map((model) => model.id)).toEqual(
      MOCK_MODELS.map((model) => model.option.id),
    );
    expect(s(harness).modelStatus?.state).toBe("ready");
    expect(s(harness).onboarding).toBeNull();

    // Progress arrives as whole states; an unchanged list keeps its identity.
    const models = s(harness).models;
    await harness.bridge.models.setIdleUnload(30);
    expect(s(harness).modelsState?.idleUnloadMinutes).toBe(30);
    expect(s(harness).models).toBe(models);

    await s(harness).actions.stopModel();
    expect(s(harness).modelStatus?.state).toBe("stopped");
    expect(s(harness).models).toBe(models);
  });

  it("falls back to the list and the status when main has no models state", async () => {
    const harness = await start({ modelsStateFails: true });
    expect(s(harness).modelsState).toBeNull();
    expect(s(harness).models.length).toBe(MOCK_MODELS.length);
    expect(s(harness).modelStatus?.state).toBe("ready");
    expect(s(harness).onboarding).toBeNull();
  });

  it("turns failed model actions into notices and reports server errors as sentences", async () => {
    const harness = await start();
    await s(harness).actions.removeModel(GPT_OSS);
    expect(s(harness).notices.at(-1)?.text).toBe(
      "Could not delete gpt-oss 20B (4-bit): dawg did not download gpt-oss 20B (4-bit), so it leaves it.",
    );
    const failed = await s(harness).actions.connectServer({ url: "http://unreachable.local:8080" });
    expect(failed).toEqual({
      error: "Could not reach http://unreachable.local:8080: it did not answer within 5 seconds.",
    });
    const added = await s(harness).actions.connectServer({
      url: "http://studio.local:8080/v1",
      apiKey: "sk-test",
    });
    expect(added).toMatchObject({ server: { kind: "remote", hasKey: true, reachable: true } });
    expect(s(harness).models.some((model) => model.origin === "remote")).toBe(true);
  });

  it("downloads, pauses, cancels and dismisses through the bridge", async () => {
    const harness = await start({ modelsState: emptyMac() });
    const { actions } = s(harness);
    await actions.downloadModel("qwen3.8-27b-q6");
    harness.bridge.modelManager.advanceDownload("qwen3.8-27b-q6", 1_000_000_000);
    expect(s(harness).modelsState?.downloads[0]).toMatchObject({
      modelId: "qwen3.8-27b-q6",
      phase: "downloading",
      bytesDone: 1_000_000_000,
    });
    await actions.pauseDownload("qwen3.8-27b-q6");
    expect(s(harness).modelsState?.downloads[0]?.phase).toBe("paused");
    await actions.cancelDownload("qwen3.8-27b-q6");
    // Cancelled downloads leave the list at once.
    expect(s(harness).modelsState?.downloads).toEqual([]);
  });

  it("names the server's model in the footer when it is the default and nothing is loaded", async () => {
    const harness = await start();
    await s(harness).actions.setDefaultModel("ollama/qwen3.6:35b-a3b");
    await s(harness).actions.stopModel();
    expect(selectModelFooter(s(harness))).toEqual({
      label: "qwen3.6 35B-A3B · Ollama",
      state: "ready",
      detail: "Ready",
    });
  });
});

describe("first run", () => {
  it("knows where to start and which model to lead with", () => {
    const empty = emptyMac();
    expect(needsSetup(empty)).toBe(true);
    expect(needsSetup(mockModelsState())).toBe(false);
    expect(needsSetup({ ...mockModelsState(), defaultModelId: null })).toBe(true);
    expect(firstRunStep(empty)).toEqual({ step: "welcome" });
    expect(
      firstRunStep(
        emptyMac({
          downloads: [
            {
              modelId: Q8,
              phase: "paused",
              bytesDone: 5,
              bytesTotal: 10,
              bytesPerSecond: 0,
              secondsLeft: null,
              error: null,
            },
          ],
        }),
      ),
    ).toEqual({ step: "download", modelId: Q8, error: null });
    expect(leadModel(empty)?.id).toBe(Q8);
    expect(leadModel(mockModelsState("small"))).toBeNull();
  });

  it("downloads the chosen model, starts it, makes it the default, then gives way", async () => {
    const harness = await start({ modelsState: emptyMac() });
    const manager = harness.bridge.modelManager;
    expect(s(harness).onboarding).toEqual({ step: "welcome" });

    await s(harness).actions.setUpModel(Q8);
    expect(s(harness).onboarding).toEqual({ step: "download", modelId: Q8, error: null });
    manager.advanceDownload(Q8, 12_000_000_000);
    expect(s(harness).modelsState?.downloads[0]?.bytesDone).toBe(12_000_000_000);

    manager.advanceDownload(Q8);
    expect(s(harness).onboarding).toEqual({ step: "start", modelId: Q8, error: null });
    await vi.waitFor(() => expect(s(harness).modelStatus?.state).toBe("loading"));
    // Still loading: first run waits.
    expect(s(harness).onboarding?.step).toBe("start");

    manager.finishLoad();
    await vi.waitFor(() => expect(s(harness).onboarding).toBeNull());
    expect(s(harness).modelsState?.defaultModelId).toBe(Q8);
    expect(s(harness).modelStatus).toMatchObject({ state: "ready", modelId: Q8 });
    // The finished download was cleared from the list.
    expect(s(harness).modelsState?.downloads).toEqual([]);
  });

  it("carries on with a download left unfinished at the last launch", async () => {
    const harness = await start({
      modelsState: emptyMac({
        downloads: [
          {
            modelId: Q8,
            phase: "paused",
            bytesDone: 9_000_000_000,
            bytesTotal: 30_000_000_000,
            bytesPerSecond: 0,
            secondsLeft: null,
            error: null,
          },
        ],
      }),
    });
    expect(s(harness).onboarding).toEqual({ step: "download", modelId: Q8, error: null });
    await s(harness).actions.setUpModel(Q8);
    expect(s(harness).modelsState?.downloads[0]).toMatchObject({
      phase: "checking",
      bytesDone: 9_000_000_000,
    });
  });

  it("shows a failed download's sentence, and Retry resumes it", async () => {
    const harness = await start({ modelsState: emptyMac() });
    await s(harness).actions.setUpModel(Q8);
    harness.bridge.modelManager.advanceDownload(Q8, 4_000_000_000);
    harness.bridge.modelManager.failDownload(Q8, "The connection dropped 5 times in a row.");
    expect(s(harness).onboarding).toEqual({
      step: "download",
      modelId: Q8,
      error: "The connection dropped 5 times in a row.",
    });
    await s(harness).actions.setUpModel(Q8);
    expect(s(harness).onboarding).toEqual({ step: "download", modelId: Q8, error: null });
    expect(s(harness).modelsState?.downloads[0]).toMatchObject({
      phase: "checking",
      bytesDone: 4_000_000_000,
    });
  });

  it("says why a download could not start", async () => {
    const harness = await start({ modelsState: mockModelsState("small") });
    await s(harness).actions.setUpModel(Q8);
    expect(s(harness).onboarding).toEqual({
      step: "download",
      modelId: Q8,
      error: "Needs 43 GB of memory; this Mac has 16 GB.",
    });
  });

  it("goes back to the welcome screen when the download is cancelled", async () => {
    const harness = await start({ modelsState: emptyMac() });
    await s(harness).actions.setUpModel(Q8);
    await s(harness).actions.cancelDownload(Q8);
    expect(s(harness).onboarding).toEqual({ step: "welcome" });
    expect(s(harness).modelsState?.downloads).toEqual([]);
  });

  it("says why a model could not start, and starts it on Try again", async () => {
    const harness = await start({ modelsState: emptyMac() });
    await s(harness).actions.setUpModel(Q8);
    harness.bridge.modelManager.advanceDownload(Q8);
    await vi.waitFor(() => expect(s(harness).modelStatus?.state).toBe("loading"));
    harness.bridge.modelManager.finishLoad("Not enough free memory: quit some apps and try again");
    await vi.waitFor(() =>
      expect(s(harness).onboarding).toEqual({
        step: "start",
        modelId: Q8,
        error: "Not enough free memory: quit some apps and try again.",
      }),
    );
    const retry = s(harness).actions.setUpModel(Q8);
    await vi.waitFor(() => expect(s(harness).modelStatus?.state).toBe("loading"));
    harness.bridge.modelManager.finishLoad();
    await retry;
    expect(s(harness).onboarding).toBeNull();
  });

  it("uses the copy another app has, without a download", async () => {
    const harness = await start({ modelsState: emptyMac() });
    const setUp = s(harness).actions.setUpModel(GPT_OSS, { useExisting: true });
    await vi.waitFor(() => expect(s(harness).modelStatus?.state).toBe("loading"));
    expect(s(harness).onboarding).toEqual({ step: "start", modelId: GPT_OSS, error: null });
    expect(s(harness).modelsState?.downloads).toEqual([]);
    harness.bridge.modelManager.finishLoad();
    await setUp;
    expect(s(harness).onboarding).toBeNull();
    expect(s(harness).models.find((model) => model.id === GPT_OSS)?.origin).toBe("lmstudio");
  });

  it("offers a server's models when they are all there is and none is the default", async () => {
    const installed = mockModelsState();
    const ollama = installed.installed.filter((option) => option.source === "server");
    const harness = await start({
      modelsState: emptyMac({
        installed: ollama,
        servers: installed.servers,
      }),
    });
    expect(s(harness).onboarding).toEqual({ step: "welcome" });
    await s(harness).actions.setUpModel("ollama/qwen3.6:35b-a3b");
    expect(s(harness).onboarding).toBeNull();
    expect(s(harness).modelsState?.defaultModelId).toBe("ollama/qwen3.6:35b-a3b");
  });

  it("does not come back while some model can still run", async () => {
    const harness = await start();
    for (const option of s(harness).models.filter((model) => model.removable)) {
      await s(harness).actions.removeModel(option.id);
    }
    expect(s(harness).models.length).toBeGreaterThan(0);
    expect(s(harness).onboarding).toBeNull();
  });

  it("shows the welcome screen again when the last model is deleted", async () => {
    const state = mockModelsState();
    const harness = await start({
      modelsState: {
        ...state,
        installed: state.installed.filter((option) => option.id === Q8),
        servers: [],
      },
    });
    expect(s(harness).onboarding).toBeNull();
    await s(harness).actions.removeModel(Q8);
    expect(s(harness).onboarding).toEqual({ step: "welcome" });
  });
});

describe("requests that wait for a model to load", () => {
  it("wait as long as the engine host does, and say the model is loading meanwhile", async () => {
    const harness = await start();
    harness.engine.addSession("s1");
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.engine.overrides["session.setModel"] = async (params) => {
      await loaded;
      return { model: params.model, modelInfo: null, effort: null };
    };
    vi.useFakeTimers();
    const switching = s(harness).actions.setModel("s1", "qwen3.8-27b-q6");
    // Main starts loading the model the session needs.
    harness.bridge.modelManager.setStatus({
      state: "loading",
      modelId: "qwen3.8-27b-q6",
      label: "Qwen3.8 27B · 6-bit",
      message: "Loading into memory",
      memoryBytes: null,
    });
    await vi.waitFor(() =>
      expect(s(harness).notices.find((notice) => notice.id === MODEL_LOADING_NOTICE_ID)).toEqual({
        id: MODEL_LOADING_NOTICE_ID,
        text: "Loading Qwen3.8 27B · 6-bit into memory. This can take a few minutes.",
        tone: "neutral",
      }),
    );
    // Well past the client's usual 30 seconds: still waiting, no error.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s(harness).notices.filter((notice) => notice.tone === "error")).toEqual([]);

    release();
    await switching;
    expect(harness.engine.callsOf("session.setModel")).toEqual([
      { sessionId: "s1", model: "qwen3.8-27b-q6" },
    ]);
    expect(s(harness).notices).toEqual([]);
  });

  it("give up only after the engine host would have", async () => {
    const harness = await start();
    harness.engine.addSession("s1");
    harness.engine.overrides["session.setModel"] = () => new Promise<never>(() => {});
    vi.useFakeTimers();
    const switching = s(harness).actions.setModel("s1", "qwen3.8-27b-q6");
    await vi.advanceTimersByTimeAsync(MODEL_BOUND_TIMEOUT_MS - 1000);
    expect(s(harness).notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await switching;
    expect(s(harness).notices.at(-1)?.text).toMatch(/^Could not change the model: .*timed out/);
  });

  it("send the default model with a new session", async () => {
    const harness = await start({ folder: PROJECT });
    await s(harness).actions.setDefaultModel(GPT_OSS);
    await s(harness).actions.newSession();
    expect(harness.engine.callsOf("session.create")).toEqual([{ cwd: PROJECT, model: GPT_OSS }]);
  });
});
