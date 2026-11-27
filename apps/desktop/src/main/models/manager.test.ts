import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cachePaths, DownloadError } from "@dawg/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsStateSchema } from "../../shared/bridge.ts";
import { MainToHostSchema } from "../../shared/engine-host-messages.ts";
import { MOCK_DEFAULT_MODEL_ID, MOCK_MODELS } from "../../shared/mock-models.ts";
import { remoteServerId } from "./format.ts";
import { NO_MODEL_MESSAGE } from "./manager.ts";
import { createMockModelService } from "./mock.ts";
import { answerHostMessage } from "./service.ts";
import { GB, harness, M4_MAX, sha, testEntry } from "./test-fakes.ts";

const small = testEntry("small-q4", { rank: 10, minMemoryGb: 24 });
const mid = testEntry("mid-q6", { rank: 40, minMemoryGb: 48, vision: true });
const big = testEntry("big-q8", { rank: 50, minMemoryGb: 96 });
const proOnly = testEntry("moe-q4", { rank: 45, minMemoryGb: 32, chipClasses: ["base", "pro"] });
const CATALOG = [small, mid, big, proOnly];

type Harness = Awaited<ReturnType<typeof harness>>;
let current: Harness[] = [];

async function setup(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness({ catalog: CATALOG, ...options });
  current.push(h);
  await h.manager.init();
  return h;
}

afterEach(async () => {
  for (const h of current) await h.cleanup();
  current = [];
});

async function downloaded(h: Harness, id: string) {
  await h.manager.download(id);
  const call = await vi.waitFor(() => {
    const found = h.downloads.find((d) => d.entry.id === id && !d.signal.aborted);
    if (!found) throw new Error("not started");
    return found;
  });
  await call.finish();
  await vi.waitFor(async () => {
    expect((await h.manager.state()).installed.some((o) => o.id === id)).toBe(true);
  });
}

describe("models state", () => {
  it("describes the machine and the catalog: fit, the recommendation, best first", async () => {
    const h = await setup();
    const state = await h.manager.state();
    expect(() => ModelsStateSchema.parse(state)).not.toThrow();
    expect(state.machine).toEqual({
      chip: "Apple M4 Max",
      arch: "arm64",
      memoryBytes: 64 * GB,
      freeDiskBytes: 500e9,
      macosVersion: "26.1",
    });
    expect(state.catalog.map((m) => m.id)).toEqual(["mid-q6", "small-q4", "big-q8", "moe-q4"]);
    expect(state.catalog.filter((m) => m.recommended).map((m) => m.id)).toEqual(["mid-q6"]);
    const byId = Object.fromEntries(state.catalog.map((m) => [m.id, m]));
    expect(byId["mid-q6"]).toMatchObject({
      shortLabel: "Model mid-q6 · 8-bit",
      sizeBytes: 1200,
      fits: true,
      fitNote: null,
      state: "available",
      foundIn: null,
    });
    expect(byId["big-q8"]?.fitNote).toBe("Needs 96 GB of memory; this Mac has 64 GB.");
    expect(byId["moe-q4"]?.fitNote).toBe(
      "Meant for Macs with a base or Pro chip; this Mac has Apple M4 Max.",
    );
    expect(state.installed).toEqual([]);
    expect(state.defaultModelId).toBeNull();
    expect(state.status).toMatchObject({ state: "stopped", modelId: null });
    expect(state.idleUnloadMinutes).toBeNull();
  });

  it("recommends nothing on a Mac that fits nothing, and says why", async () => {
    const h = await setup({
      hardware: {
        ...M4_MAX,
        arch: "x64",
        chip: "Intel Core i7",
        chipClass: "intel",
        memoryBytes: 16 * GB,
      },
    });
    const state = await h.manager.state();
    expect(state.catalog.some((m) => m.recommended)).toBe(false);
    expect(state.catalog.every((m) => !m.fits)).toBe(true);
    expect(new Set(state.catalog.map((m) => m.fitNote))).toEqual(
      new Set(["Needs a Mac with Apple silicon."]),
    );
  });

  it("keeps working when the catalog cannot be loaded", async () => {
    const h = await harness({});
    current.push(h);
    h.backend.loadCatalog = async () => {
      throw new Error("bundled catalog is invalid");
    };
    const state = await h.manager.state();
    expect(state.catalog).toEqual([]);
    expect(h.logs.some((line) => line.includes("bundled catalog is invalid"))).toBe(true);
  });
});

describe("downloads", () => {
  it("downloads, installs, and makes the first model the default", async () => {
    const h = await setup();
    const states: string[] = [];
    h.manager.onState((state) => states.push(state.downloads[0]?.phase ?? "none"));
    await h.manager.download("small-q4");
    const call = await vi.waitFor(() => h.downloads[0] ?? Promise.reject(new Error("none")));
    await call.progress(400);
    await vi.waitFor(async () => {
      expect((await h.manager.state()).downloads[0]).toMatchObject({
        modelId: "small-q4",
        phase: "downloading",
        bytesDone: 400,
        bytesTotal: 1000,
        bytesPerSecond: 100,
        secondsLeft: 6,
      });
    });
    expect((await h.manager.state()).catalog.find((m) => m.id === "small-q4")?.state).toBe(
      "downloading",
    );
    const result = await call.finish();

    await vi.waitFor(async () => expect((await h.manager.state()).defaultModelId).toBe("small-q4"));
    const state = await h.manager.state();
    expect(state.downloads).toEqual([
      expect.objectContaining({ modelId: "small-q4", phase: "done", bytesDone: 1000 }),
    ]);
    expect(state.installed).toEqual([
      expect.objectContaining({
        id: "small-q4",
        source: "bundled",
        origin: "catalog",
        removable: true,
        contextWindow: 131_072,
        description: "Bundled runtime · 128K context · text only",
      }),
    ]);
    expect(state.catalog.find((m) => m.id === "small-q4")?.state).toBe("installed");
    const saved = await vi.waitFor(async () => {
      const file = JSON.parse(await readFile(path.join(h.dataRoot, "models.json"), "utf8"));
      expect(file.installed).toEqual([
        { id: "small-q4", source: "download", modelPath: result.model.path },
      ]);
      return file;
    });
    expect(saved.defaultModelId).toBe("small-q4");
    expect(saved.downloads).toEqual([]);
    expect(states).toContain("done");
    expect(h.modelsChanged()).toBeGreaterThan(0);

    await h.manager.dismissDownload("small-q4");
    expect((await h.manager.state()).downloads).toEqual([]);
  });

  it("sends progress at most about every interval", async () => {
    const h = await setup();
    let updates = 0;
    h.manager.onState(() => {
      updates += 1;
    });
    await h.manager.download("small-q4");
    const call = await vi.waitFor(() => h.downloads[0] ?? Promise.reject(new Error("none")));
    updates = 0;
    for (let i = 1; i <= 30; i += 1) await call.progress(i * 10);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updates).toBeGreaterThan(0);
    expect(updates).toBeLessThanOrEqual(4);
    expect((await h.manager.state()).downloads[0]?.bytesDone).toBe(300);
  });

  it("pauses keeping the partial file, and resumes", async () => {
    const h = await setup();
    await h.manager.download("small-q4");
    const first = await vi.waitFor(() => h.downloads[0] ?? Promise.reject(new Error("none")));
    await first.progress(300);
    await h.manager.pauseDownload("small-q4");
    const paused = await h.manager.state();
    expect(paused.downloads[0]).toMatchObject({ phase: "paused", bytesDone: 300 });
    expect(paused.catalog.find((m) => m.id === "small-q4")?.state).toBe("paused");
    const partial = cachePaths(
      h.hubDir,
      small.source.repo,
      small.source.revision,
      small.source.file,
      small.source.sha256,
    );
    expect((await stat(partial.incompletePath)).size).toBe(300);
    const saved = JSON.parse(await readFile(path.join(h.dataRoot, "models.json"), "utf8"));
    expect(saved.downloads).toEqual([{ modelId: "small-q4", phase: "paused" }]);

    await h.manager.download("small-q4");
    const second = await vi.waitFor(() => h.downloads[1] ?? Promise.reject(new Error("none")));
    expect((await h.manager.state()).downloads[0]?.bytesDone).toBe(300);
    await second.finish();
    await vi.waitFor(async () =>
      expect((await h.manager.state()).downloads[0]?.phase).toBe("done"),
    );
  });

  it("cancels removing the partial file, and only ended downloads can be dismissed", async () => {
    const h = await setup();
    await h.manager.download("small-q4");
    const call = await vi.waitFor(() => h.downloads[0] ?? Promise.reject(new Error("none")));
    await call.progress(500);
    await expect(h.manager.dismissDownload("small-q4")).rejects.toThrow(/Only a finished/);
    await h.manager.cancelDownload("small-q4");
    const state = await h.manager.state();
    expect(state.downloads[0]).toMatchObject({ phase: "cancelled", bytesDone: 0 });
    expect(state.catalog.find((m) => m.id === "small-q4")?.state).toBe("available");
    const partial = cachePaths(
      h.hubDir,
      small.source.repo,
      small.source.revision,
      small.source.file,
      small.source.sha256,
    );
    await expect(stat(partial.incompletePath)).rejects.toThrow();
    await h.manager.dismissDownload("small-q4");
    expect((await h.manager.state()).downloads).toEqual([]);
  });

  it("reports a failure as a sentence, and can be retried", async () => {
    const h = await setup();
    await h.manager.download("small-q4");
    const first = await vi.waitFor(() => h.downloads[0] ?? Promise.reject(new Error("none")));
    await first.progress(100);
    first.fail(new DownloadError("network", "small-q4.gguf", "gave up: ECONNRESET"));
    await vi.waitFor(async () =>
      expect((await h.manager.state()).downloads[0]?.phase).toBe("failed"),
    );
    const failed = await h.manager.state();
    expect(failed.downloads[0]?.error).toBe(
      "The download kept failing, so it stopped. Check the connection and try again; it picks up where it stopped.",
    );
    expect(failed.catalog.find((m) => m.id === "small-q4")?.state).toBe("failed");

    await h.manager.download("small-q4");
    const retry = await vi.waitFor(() => h.downloads[1] ?? Promise.reject(new Error("none")));
    expect((await h.manager.state()).downloads[0]).toMatchObject({ error: null, bytesDone: 100 });
    await retry.finish();
    await vi.waitFor(async () =>
      expect((await h.manager.state()).downloads[0]?.phase).toBe("done"),
    );
  });

  it("runs downloads one at a time, in order", async () => {
    const h = await setup();
    await h.manager.download("small-q4");
    await h.manager.download("mid-q6");
    await vi.waitFor(() => expect(h.downloads).toHaveLength(1));
    expect((await h.manager.state()).downloads.map((d) => d.phase)).toEqual(["checking", "queued"]);
    await h.downloads[0]?.finish();
    await vi.waitFor(() => expect(h.downloads).toHaveLength(2));
    expect(h.downloads[1]?.entry.id).toBe("mid-q6");
    const result = await h.downloads[1]?.finish();
    expect(result?.projector).toBeDefined();
    await vi.waitFor(async () =>
      expect((await h.manager.state()).installed.map((o) => o.id).sort()).toEqual([
        "mid-q6",
        "small-q4",
      ]),
    );
    // The first model stays the default.
    expect((await h.manager.state()).defaultModelId).toBe("small-q4");
  });

  it("picks an unfinished download up again after a relaunch", async () => {
    const first = await setup();
    await first.manager.download("small-q4");
    const call = await vi.waitFor(() => first.downloads[0] ?? Promise.reject(new Error("none")));
    await call.progress(600);
    await first.manager.dispose();

    const again = await harness({ catalog: CATALOG, dir: first.dir });
    current.unshift(again);
    await again.manager.init();
    await vi.waitFor(() => expect(again.downloads).toHaveLength(1));
    expect((await again.manager.state()).downloads[0]).toMatchObject({
      modelId: "small-q4",
      bytesDone: 600,
    });
    await again.downloads[0]?.finish();
    await vi.waitFor(async () =>
      expect((await again.manager.state()).installed.map((o) => o.id)).toEqual(["small-q4"]),
    );
  });
});

describe("existing copies", () => {
  it("offers a copy another app has and adopts it without downloading", async () => {
    const h = await setup({
      scan: [
        {
          entryId: "small-q4",
          model: {
            source: "lmstudio",
            path: "/Users/me/.lmstudio/models/org/small/small-q4.gguf",
            sha256: sha("small-q4"),
            sizeBytes: 1000,
          },
          ready: true,
        },
      ],
    });
    await vi.waitFor(async () =>
      expect((await h.manager.state()).catalog.find((m) => m.id === "small-q4")?.foundIn).toBe(
        "lmstudio",
      ),
    );
    await expect(h.manager.useExisting("mid-q6")).rejects.toThrow(/No complete copy/);
    await h.manager.useExisting("small-q4");
    const state = await h.manager.state();
    expect(h.downloads).toEqual([]);
    expect(state.installed[0]).toMatchObject({
      id: "small-q4",
      origin: "lmstudio",
      removable: false,
      description: "LM Studio’s copy · 128K context · text only",
    });
    expect(state.catalog.find((m) => m.id === "small-q4")).toMatchObject({
      state: "installed",
      foundIn: null,
    });
    expect(state.defaultModelId).toBe("small-q4");
    expect(h.calls.scan).toBe(1);
    const answer = await h.manager.requestModel(null);
    expect(answer.ok && answer.grant).toMatchObject({
      modelId: "small-q4",
      profile: "qwen3.8",
      slots: { conversation: [0], utility: [1] },
    });
    expect(h.runtimes[0]?.launch.modelPath).toBe(
      "/Users/me/.lmstudio/models/org/small/small-q4.gguf",
    );
  });

  it("forgets models whose files are gone", async () => {
    const first = await setup({
      scan: [
        {
          entryId: "small-q4",
          model: { source: "ollama", path: "/nowhere/blob", sha256: sha("small-q4"), sizeBytes: 1 },
          ready: true,
        },
      ],
    });
    await vi.waitFor(async () =>
      expect((await first.manager.state()).catalog[1]?.foundIn).toBe("ollama"),
    );
    await first.manager.useExisting("small-q4");
    await first.manager.dispose();
    const again = await harness({ catalog: CATALOG, dir: first.dir });
    current.unshift(again);
    expect((await again.manager.state()).installed).toEqual([]);
    expect(again.logs.some((line) => line.includes("/nowhere/blob is gone"))).toBe(true);
  });
});

describe("the engine host's model requests", () => {
  it("refuses while nothing is installed, retryable only while downloading", async () => {
    const h = await setup();
    expect(await h.manager.requestModel(null)).toEqual({
      ok: false,
      message: NO_MODEL_MESSAGE,
      retryable: false,
    });
    await h.manager.download("small-q4");
    expect(await h.manager.requestModel(null)).toMatchObject({ ok: false, retryable: true });
    expect(await h.manager.requestModel("small-q4")).toEqual({
      ok: false,
      message: "Model small-q4 (8-bit) is still downloading.",
      retryable: true,
    });
    expect(await h.manager.requestModel("big-q8")).toMatchObject({
      ok: false,
      message: "Model big-q8 (8-bit) is not downloaded yet. Download it in Settings → Models.",
      retryable: false,
    });
    expect(await h.manager.requestModel("ollama/qwen3:32b")).toMatchObject({
      ok: false,
      message: "Ollama is not running on this Mac.",
      retryable: true,
    });
    expect(await h.manager.requestModel("nope")).toMatchObject({ ok: false, retryable: false });
  });

  it("loads the default model on demand and grants it with the runtime's slots", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    const answer = await h.manager.requestModel(null);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.grant).toMatchObject({
      modelId: "small-q4",
      endpoint: { kind: "bundled", model: "small-q4", contextWindow: 131_072 },
      slots: { conversation: [0], utility: [1] },
      generation: 1,
      profile: "qwen3.8",
    });
    expect(h.runtimes).toHaveLength(1);
    expect(h.runtimes[0]?.launch).toMatchObject({
      modelId: "small-q4",
      contextPerSlot: 131_072,
    });
    expect(h.runtimes[0]?.launch.idleUnloadSeconds).toBeUndefined();
    const state = await h.manager.state();
    expect(state.status).toMatchObject({ state: "ready", modelId: "small-q4", message: null });
    expect(state.installed[0]?.description).toBe(
      "Bundled runtime · 128K context · text only · loaded",
    );

    // Asking again reuses the loaded model.
    const again = await h.manager.requestModel("small-q4");
    expect(again.ok && again.grant.generation).toBe(1);
    expect(h.runtimes).toHaveLength(1);
  });

  it("shares one load between requests that arrive while it loads", async () => {
    const h = await setup({ autoReady: false });
    await downloaded(h, "small-q4");
    const a = h.manager.requestModel("small-q4");
    const b = h.manager.requestModel(null);
    await vi.waitFor(() => expect(h.runtimes).toHaveLength(1));
    await vi.waitFor(async () => expect((await h.manager.status()).state).toBe("loading"));
    expect((await h.manager.status()).message).toBe("Loading into memory");
    h.runtimes[0]?.becomeReady();
    const [first, second] = await Promise.all([a, b]);
    expect(first.ok && second.ok).toBe(true);
    expect(h.runtimes).toHaveLength(1);
  });

  it("swaps models: the old runtime stops, generation grows, the host is told", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    await downloaded(h, "mid-q6");
    const first = await h.manager.requestModel("small-q4");
    const changedBefore = h.modelsChanged();
    const second = await h.manager.requestModel("mid-q6");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(h.runtimes[0]?.stopped).toBe(true);
    expect(h.runtimes[1]?.launch.modelId).toBe("mid-q6");
    expect(h.runtimes[1]?.launch.projectorPath).toBeDefined();
    expect(second.grant.generation).toBeGreaterThan(first.grant.generation);
    expect(second.grant.endpoint.baseUrl).not.toBe(first.grant.endpoint.baseUrl);
    expect(h.modelsChanged()).toBeGreaterThan(changedBefore);
    expect((await h.manager.status()).modelId).toBe("mid-q6");
  });

  it("a runtime that restarts after a crash makes grants stale", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    const first = await h.manager.requestModel("small-q4");
    if (!first.ok) throw new Error("refused");
    const runtime = h.runtimes[0];
    if (!runtime) throw new Error("no runtime");
    const changedBefore = h.modelsChanged();
    const statuses: string[] = [];
    h.manager.onStatus((status) => {
      // The memory reading after "ready" is a status change too; only the states matter here.
      const line = `${status.state}:${status.message}`;
      if (statuses.at(-1) !== line) statuses.push(line);
    });
    runtime.crash();
    expect(h.modelsChanged()).toBeGreaterThan(changedBefore);
    expect((await h.manager.status()).state).toBe("loading");
    runtime.becomeReady();
    const after = await h.manager.requestModel("small-q4");
    if (!after.ok) throw new Error("refused");
    expect(after.grant.generation).toBe(first.grant.generation + 1);
    expect(after.grant.endpoint.baseUrl).not.toBe(first.grant.endpoint.baseUrl);
    expect(statuses).toEqual([
      "loading:The runtime stopped; restarting",
      "loading:Restarting after the runtime stopped",
      "ready:null",
    ]);
    expect(h.runtimes).toHaveLength(1);
  });

  it("reports a runtime that gave up, and loads again on the next request", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    await h.manager.requestModel("small-q4");
    h.runtimes[0]?.fail();
    const status = await h.manager.status();
    expect(status.state).toBe("error");
    expect(status.message).toBe(
      "The runtime kept stopping: llama-server exited unexpectedly (signal SIGKILL) after 3 restarts. Its log is in /data/logs/runtime.log.",
    );
    const again = await h.manager.requestModel("small-q4");
    expect(again.ok).toBe(true);
    expect(h.runtimes).toHaveLength(2);
  });

  it("refuses with a sentence when the runtime is missing", async () => {
    const { RuntimeError } = await import("@dawg/models");
    const h = await setup({
      createRuntimeError: new RuntimeError("not-found", "No executable llama-server"),
    });
    await downloaded(h, "small-q4");
    expect(await h.manager.requestModel(null)).toEqual({
      ok: false,
      message:
        "The bundled runtime (llama-server) is missing. In a checkout, run pnpm fetch-runtime.",
      retryable: false,
    });
    await expect(h.manager.start("small-q4")).rejects.toThrow(
      /runtime \(llama-server\) is missing/,
    );
    expect((await h.manager.status()).state).toBe("error");
  });

  it("answers host messages in the shape the contract gives", async () => {
    const h = await setup();
    const log: string[] = [];
    expect(await answerHostMessage(h.manager, { type: "nonsense" }, (m) => log.push(m))).toBeNull();
    expect(log).toHaveLength(1);
    const refused = await answerHostMessage(
      h.manager,
      { type: "model-request", requestId: "r1", modelId: null },
      () => {},
    );
    expect(MainToHostSchema.parse(refused)).toEqual({
      type: "model-refused",
      requestId: "r1",
      message: NO_MODEL_MESSAGE,
      retryable: false,
    });
    await downloaded(h, "small-q4");
    const granted = await answerHostMessage(
      h.manager,
      { type: "model-request", requestId: "r2", modelId: "small-q4" },
      () => {},
    );
    expect(MainToHostSchema.parse(granted)).toMatchObject({
      type: "model-grant",
      requestId: "r2",
      grant: { modelId: "small-q4" },
    });
  });
});

describe("start, stop, remove, default, idle unload", () => {
  it("starts and stops the bundled runtime", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    await h.manager.start("small-q4");
    expect((await h.manager.status()).state).toBe("ready");
    await vi.waitFor(async () => expect((await h.manager.status()).memoryBytes).toBe(31 * GB));
    const changed = h.modelsChanged();
    await h.manager.stop();
    expect(h.runtimes[0]?.stopped).toBe(true);
    expect(await h.manager.status()).toEqual({
      state: "stopped",
      modelId: null,
      label: null,
      message: "Not loaded",
      memoryBytes: null,
    });
    expect(h.modelsChanged()).toBeGreaterThan(changed);
    await expect(h.manager.start("big-q8")).rejects.toThrow(/not downloaded yet/);
  });

  it("removes a downloaded model: unloads it, deletes its files, clears the default", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    await h.manager.start("small-q4");
    const paths = cachePaths(
      h.hubDir,
      small.source.repo,
      small.source.revision,
      small.source.file,
      small.source.sha256,
    );
    expect((await stat(paths.blobPath)).size).toBe(1000);
    await h.manager.remove("small-q4");
    expect(h.runtimes[0]?.stopped).toBe(true);
    await expect(stat(paths.blobPath)).rejects.toThrow();
    const state = await h.manager.state();
    expect(state.installed).toEqual([]);
    expect(state.defaultModelId).toBeNull();
    expect(state.downloads).toEqual([]);
    await expect(h.manager.remove("small-q4")).rejects.toThrow(/not installed/);
  });

  it("sets the default only to a model that is installed", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    await downloaded(h, "mid-q6");
    await h.manager.setDefault("mid-q6");
    const state = await h.manager.state();
    expect(state.defaultModelId).toBe("mid-q6");
    expect(state.installed[0]?.id).toBe("mid-q6");
    await expect(h.manager.setDefault("big-q8")).rejects.toThrow(/not installed/);
  });

  it("applies idle unload through the runtime's own sleep, reloading a loaded model", async () => {
    const h = await setup();
    await downloaded(h, "small-q4");
    await h.manager.start("small-q4");
    await h.manager.setIdleUnload(15);
    expect((await h.manager.state()).idleUnloadMinutes).toBe(15);
    await vi.waitFor(() => expect(h.runtimes).toHaveLength(2));
    expect(h.runtimes[1]?.launch.idleUnloadSeconds).toBe(900);
    await vi.waitFor(async () => expect((await h.manager.status()).state).toBe("ready"));
    const saved = JSON.parse(await readFile(path.join(h.dataRoot, "models.json"), "utf8"));
    expect(saved.idleUnloadMinutes).toBe(15);
  });
});

describe("model files", () => {
  it("adds a GGUF file, warning when it may not fit", async () => {
    const h = await setup({ hardware: { ...M4_MAX, memoryBytes: 2 * GB } });
    const file = path.join(h.dir, "tiny.gguf");
    await writeFile(file, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(100)]));
    expect(await h.manager.addModelFile(async () => null)).toBeNull();
    const added = await h.manager.addModelFile(async () => file);
    expect(added?.option).toMatchObject({
      label: "tiny",
      origin: "file",
      source: "bundled",
      removable: false,
      contextWindow: 32_768,
    });
    expect(added?.option.id).toBe(`file:${sha(file)}`);
    expect(added?.memoryWarning).toMatch(/^This model may need more memory than this Mac has/);
    expect((await h.manager.state()).defaultModelId).toBe(added?.option.id);

    const answer = await h.manager.requestModel(null);
    expect(answer.ok && answer.grant.endpoint.model).toBe(added?.option.id);
    expect(answer.ok && "profile" in answer.grant).toBe(false);
    expect(h.runtimes[0]?.launch).toMatchObject({ modelPath: file, contextPerSlot: 32_768 });

    const text = path.join(h.dir, "notes.txt");
    await writeFile(text, "hello");
    await expect(h.manager.addModelFile(async () => text)).rejects.toThrow(/not a GGUF model file/);
  });

  it("does not warn when the file fits", async () => {
    const h = await setup();
    const file = path.join(h.dir, "fits.gguf");
    await writeFile(file, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(10)]));
    expect((await h.manager.addModelFile(async () => file))?.memoryWarning).toBeNull();
  });
});

describe("servers", () => {
  const ROOT = "http://remote.test/v1";

  it("keeps keys out of the state and out of plain files", async () => {
    const h = await setup({
      remote: { [ROOT]: { key: "sk-very-secret", models: ["gpt-oss-120b"] } },
    });
    await expect(h.manager.connectServer({ url: ROOT })).rejects.toThrow(
      "Could not connect to http://remote.test (HTTP 401): Unauthorized. The server wants a key.",
    );
    await expect(h.manager.connectServer({ url: ROOT, apiKey: "wrong" })).rejects.toThrow(
      /The server refused the key/,
    );
    const info = await h.manager.connectServer({ url: ROOT, apiKey: "sk-very-secret" });
    const id = remoteServerId(ROOT);
    expect(info).toEqual({
      id,
      kind: "remote",
      url: "http://remote.test",
      reachable: true,
      modelIds: [`${id}/gpt-oss-120b`],
      hasKey: true,
    });
    const state = await h.manager.state();
    expect(JSON.stringify(state)).not.toContain("sk-very-secret");
    expect(state.installed.map((o) => o.id)).toEqual([`${id}/gpt-oss-120b`]);
    expect(state.installed[0]).toMatchObject({
      source: "server",
      origin: "remote",
      label: "remote.test · gpt-oss-120b",
      description: "remote.test · 32K context · no prompt cache control",
    });
    expect(await readFile(path.join(h.dataRoot, "models.json"), "utf8")).not.toContain("sk-very");
    expect(await readFile(path.join(h.dataRoot, "server-keys.json"), "utf8")).not.toContain(
      "sk-very",
    );
    expect(h.logs.join("\n")).not.toContain("sk-very-secret");

    // The engine host gets the key, read from the Keychain, to make its requests.
    const answer = await h.manager.requestModel(`${id}/gpt-oss-120b`);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.grant.endpoint).toMatchObject({
      kind: "remote",
      baseUrl: ROOT,
      apiKey: "sk-very-secret",
      model: "gpt-oss-120b",
    });
    expect(answer.grant.slots).toBeUndefined();
    expect(answer.grant.profile).toBeUndefined();

    // Checking again uses the stored key.
    await h.manager.connectServer({ url: ROOT });
    expect(h.remoteCalls.at(-1)).toEqual({ url: ROOT, apiKey: "sk-very-secret" });

    await h.manager.removeServer(id);
    expect((await h.manager.state()).servers).toEqual([]);
    await expect(stat(path.join(h.dataRoot, "server-keys.json"))).rejects.toThrow();
  });

  it("tries once with /v1 added, and remembers the server across launches", async () => {
    const first = await setup({ remote: { [ROOT]: { models: ["m1", "m2"] } } });
    const info = await first.manager.connectServer({ url: "http://remote.test" });
    expect(first.remoteCalls.map((c) => c.url)).toEqual(["http://remote.test", ROOT]);
    expect(info.hasKey).toBe(false);
    await first.manager.dispose();

    const again = await harness({
      catalog: CATALOG,
      dir: first.dir,
      remote: { [ROOT]: { models: ["m1"] } },
    });
    current.unshift(again);
    const answer = await again.manager.requestModel(`${info.id}/m1`);
    expect(answer.ok).toBe(true);
    const gone = await again.manager.requestModel(`${info.id}/m2`);
    expect(gone).toMatchObject({ ok: false, message: "remote.test no longer has the model m2." });
  });

  it("says when a server stops answering, and lets it come back", async () => {
    const h = await setup({ remote: { [ROOT]: { models: ["m1"] } } });
    const info = await h.manager.connectServer({ url: ROOT });
    h.remote.delete(ROOT);
    const answer = await h.manager.requestModel(`${info.id}/m1`);
    expect(answer).toEqual({
      ok: false,
      message: "remote.test at http://remote.test is not answering.",
      retryable: true,
    });
    expect((await h.manager.state()).servers[0]).toMatchObject({ reachable: false, modelIds: [] });
    h.remote.set(ROOT, { models: ["m1"] });
    await h.manager.refreshServers();
    expect((await h.manager.state()).servers[0]).toMatchObject({ reachable: true });
  });

  it("finds Ollama and LM Studio, and does not remove them", async () => {
    const h = await setup({
      local: [
        {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: [
            {
              id: "qwen3:32b",
              contextWindow: 40_960,
              contextSource: "loaded",
              capabilities: { tools: true, vision: false, reasoning: true },
              capabilitiesSource: "reported",
            },
          ],
        },
      ],
    });
    await vi.waitFor(async () =>
      expect((await h.manager.state()).servers.map((s) => s.id)).toEqual(["ollama"]),
    );
    const state = await h.manager.state();
    expect(state.installed[0]).toMatchObject({
      id: "ollama/qwen3:32b",
      origin: "ollama",
      label: "Ollama · qwen3:32b",
      shortLabel: "qwen3:32b · Ollama",
    });
    await expect(h.manager.removeServer("ollama")).rejects.toThrow(/only servers you added/);
    await expect(h.manager.remove("ollama/qwen3:32b")).rejects.toThrow(/remove the server/);
    const answer = await h.manager.requestModel(null);
    expect(answer.ok && answer.grant.endpoint).toMatchObject({
      kind: "ollama",
      model: "qwen3:32b",
      contextWindow: 40_960,
    });
  });

  it("refuses an address with credentials in it", async () => {
    const h = await setup();
    await expect(
      h.manager.connectServer({ url: "https://user:pass@remote.test/v1" }),
    ).rejects.toThrow(/not in the server address/);
  });
});

describe("the end-to-end test hook", () => {
  it("adds the test server without a key, makes its first model the default, skips slow work", async () => {
    const url = "http://127.0.0.1:7777/v1";
    const h = await setup({
      testServerUrl: url,
      remote: { [url]: { models: ["mock-model", "other"] } },
    });
    const id = remoteServerId(url);
    const state = await h.manager.state();
    expect(state.defaultModelId).toBe(`${id}/mock-model`);
    expect(state.servers).toEqual([
      expect.objectContaining({ id, kind: "remote", hasKey: false, reachable: true }),
    ]);
    expect(h.calls).toMatchObject({ scan: 0, detectLocal: 0 });
    const answer = await h.manager.requestModel(null);
    expect(answer.ok && answer.grant).toMatchObject({
      modelId: `${id}/mock-model`,
      endpoint: { kind: "remote", baseUrl: url, model: "mock-model" },
    });
    expect(answer.ok && "apiKey" in answer.grant.endpoint).toBe(false);
    await h.manager.refreshServers();
    expect(h.calls.detectLocal).toBe(0);
    // Without DAWG_TEST_SERVER_SLOTS its requests go out at once, as any server's do.
    expect(answer.ok && answer.grant.slots).toBeUndefined();
  });

  it("keeps asking a test server that does not answer at first", async () => {
    const url = "http://127.0.0.1:7777/v1";
    const h = await setup({
      testServerUrl: url,
      remote: { [url]: { models: ["mock-model"], failFirst: 2 } },
    });
    const id = remoteServerId(url);
    expect((await h.manager.state()).defaultModelId).toBe(`${id}/mock-model`);
    expect(h.remoteCalls.filter((call) => call.url === url)).toHaveLength(3);
  });

  it("shares the runtime's slots with DAWG_TEST_SERVER_SLOTS, so sessions queue for it", async () => {
    const url = "http://127.0.0.1:7777/v1";
    const h = await setup({
      testServerUrl: url,
      testServerSlots: true,
      remote: { [url]: { models: ["mock-model"] } },
    });
    const answer = await h.manager.requestModel(null);
    expect(answer.ok && answer.grant.slots).toEqual({ conversation: [0], utility: [1] });
  });
});

describe("DAWG_ENGINE=mock", () => {
  it("serves the mock models, everything installed and ready, actions harmless", async () => {
    const service = createMockModelService();
    await service.init();
    const state = await service.state();
    expect(() => ModelsStateSchema.parse(state)).not.toThrow();
    expect(state.installed).toEqual(MOCK_MODELS.map((m) => m.option));
    expect(await service.list()).toEqual(MOCK_MODELS.map((m) => m.option));
    expect(state.defaultModelId).toBe(MOCK_DEFAULT_MODEL_ID);
    expect(state.status.state).toBe("ready");
    expect(state.catalog.every((m) => m.state === "installed")).toBe(true);
    expect(state.servers[0]?.modelIds).toEqual(["ollama/qwen3.6:35b-a3b"]);
    await service.download("anything");
    await service.remove(MOCK_DEFAULT_MODEL_ID);
    await service.stop();
    expect(await service.addModelFile(async () => "/x.gguf")).toBeNull();
    expect(await service.state()).toEqual(state);
    expect(await service.requestModel(null)).toMatchObject({ ok: false, retryable: false });
  });
});
