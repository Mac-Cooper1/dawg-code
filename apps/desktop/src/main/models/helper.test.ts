/**
 * The helper model in the model manager: a second runtime beside the main one, for side
 * requests. Fakes only: the runtimes become ready, crash or fail when told.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { helperWorkingSetBytes, RuntimeError } from "@dawg/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsStateSchema } from "../../shared/bridge.ts";
import type { ModelGrant } from "../../shared/engine-host-messages.ts";
import { contextPerSlot } from "./runtime.ts";
import { GB, harness, M4_MAX, testEntry, testHelperEntry } from "./test-fakes.ts";

const main = testEntry("main-q8", { rank: 10, minMemoryGb: 24 });
const other = testEntry("other-q4", { rank: 5, minMemoryGb: 24 });
const helper = testHelperEntry();
const CATALOG = [main, other, helper];

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

async function install(h: Harness, id: string): Promise<void> {
  await h.manager.download(id);
  const call = await vi.waitFor(() => {
    const found = h.downloads.find((d) => d.entry.id === id && !d.signal.aborted);
    if (!found) throw new Error("not started");
    return found;
  });
  await call.finish();
  await vi.waitFor(async () => {
    const state = await h.manager.state();
    const done =
      id === helper.id
        ? state.helper?.state !== "available" && state.helper?.state !== "downloading"
        : state.installed.some((o) => o.id === id);
    expect(done).toBe(true);
  });
}

async function grant(h: Harness): Promise<ModelGrant> {
  const answer = await h.manager.requestModel(null);
  if (!answer.ok) throw new Error(answer.message);
  return answer.grant;
}

const helperRuntimes = (h: Harness) => h.runtimes.filter((r) => r.launch.role === "helper");
const mainRuntimes = (h: Harness) => h.runtimes.filter((r) => r.launch.role !== "helper");

describe("the helper model in the catalog", () => {
  it("is listed apart: never in the catalog list, the installed models or the default", async () => {
    const h = await setup();
    let state = await h.manager.state();
    expect(() => ModelsStateSchema.parse(state)).not.toThrow();
    expect(state.catalog.map((m) => m.id)).toEqual(["main-q8", "other-q4"]);
    expect(state.helper).toMatchObject({
      id: helper.id,
      displayName: "Tiny helper (8-bit)",
      sizeBytes: 900,
      memoryBytes: helperWorkingSetBytes(helper),
      contextWindow: 32_768,
      recommended: true,
      fits: true,
      state: "available",
      enabled: true,
      message: null,
      runtimeMemoryBytes: null,
    });
    // Downloaded first, it still does not become the model to chat with.
    await install(h, helper.id);
    state = await h.manager.state();
    expect(state.installed).toEqual([]);
    expect(state.defaultModelId).toBeNull();
    expect(state.helper?.state).toBe("ready");
    expect(await h.manager.requestModel(null)).toMatchObject({ ok: false });
    expect(await h.manager.requestModel(helper.id)).toMatchObject({
      ok: false,
      message: expect.stringContaining("is the helper model"),
    });
    await expect(h.manager.setDefault(helper.id)).rejects.toThrow("not installed");
    // Nothing asked for a model to talk to, so the helper did not start.
    expect(helperRuntimes(h)).toEqual([]);
  });

  it("is not offered on a Mac below its tier, and says why", async () => {
    const h = await setup({ hardware: { ...M4_MAX, memoryBytes: 32 * GB } });
    expect((await h.manager.state()).helper).toMatchObject({
      recommended: false,
      fits: false,
      fitNote: "Needs 48 GB of memory; this Mac has 32 GB.",
    });
  });
});

describe("running the helper beside the main model", () => {
  it("starts with the main model and rides in its grant, on its own runtime and slot", async () => {
    const h = await setup();
    await install(h, helper.id);
    await install(h, main.id);
    const first = await grant(h);
    const [helperRuntime] = helperRuntimes(h);
    expect(helperRuntime?.launch).toMatchObject({
      role: "helper",
      modelId: helper.id,
      catalogEntry: helper,
      contextPerSlot: 32_768,
    });
    expect(helperRuntime?.launch.idleUnloadSeconds).toBeUndefined();
    expect(mainRuntimes(h)).toHaveLength(1);
    expect(first.helper).toEqual({
      modelId: helper.id,
      endpoint: expect.objectContaining({ model: helper.id, contextWindow: 32_768 }),
      slots: [0],
      profile: "minicpm5",
    });
    // The helper's own port and key, not the main runtime's.
    expect(first.helper?.endpoint.baseUrl).not.toBe(first.endpoint.baseUrl);
    expect(first.helper?.endpoint.apiKey).not.toBe(first.endpoint.apiKey);
    expect((await h.manager.state()).helper?.state).toBe("running");
    expect(h.logs.join("\n")).toContain(`The helper model ${helper.id} is ready for side requests`);
  });

  it("takes its memory before the main model's window is chosen", async () => {
    const mac = { ...M4_MAX, memoryBytes: 16 * GB };
    const h = await setup({ hardware: mac });
    await install(h, main.id);
    await grant(h);
    const alone = mainRuntimes(h)[0]?.launch.contextPerSlot;
    expect(alone).toBe(contextPerSlot(main, mac.memoryBytes));
    await install(h, helper.id);
    await h.manager.start(main.id);
    // A fresh load of the main model, now with the helper's share taken off.
    await h.manager.stop();
    await grant(h);
    const beside = mainRuntimes(h).at(-1)?.launch.contextPerSlot;
    expect(beside).toBe(contextPerSlot(main, mac.memoryBytes, helperWorkingSetBytes(helper)));
    expect(beside).toBeLessThan(alone as number);
    expect((await h.manager.state()).installed[0]?.contextWindow).toBe(
      mainRuntimes(h).at(-1)?.launch.contextPerSlot,
    );
  });

  it("starts as soon as it is downloaded when a model is already in use", async () => {
    const h = await setup();
    await install(h, main.id);
    const before = await grant(h);
    expect(before.helper).toBeUndefined();
    const changed = h.modelsChanged();
    await install(h, helper.id);
    await vi.waitFor(() => expect(helperRuntimes(h)[0]?.state).toBe("ready"));
    // The engine host is told, and asks again.
    expect(h.modelsChanged()).toBeGreaterThan(changed);
    const after = await grant(h);
    expect(after.helper?.modelId).toBe(helper.id);
    expect(after.generation).toBeGreaterThan(before.generation);
  });

  it("serves a server's model too", async () => {
    const h = await setup({ remote: { "http://gpu.example.com:8080/v1": { models: ["big"] } } });
    await install(h, helper.id);
    await h.manager.connectServer({ url: "http://gpu.example.com:8080/v1" });
    const answer = await h.manager.requestModel(null);
    expect(answer.ok).toBe(true);
    await vi.waitFor(() => expect(helperRuntimes(h)[0]?.state).toBe("ready"));
    const later = await grant(h);
    expect(later.endpoint.kind).toBe("remote");
    expect(later.helper?.modelId).toBe(helper.id);
  });

  it("unloads with the idle-unload setting and restarts with a new one", async () => {
    const h = await setup();
    await install(h, helper.id);
    await install(h, main.id);
    await h.manager.setIdleUnload(10);
    await grant(h);
    expect(helperRuntimes(h)[0]?.launch.idleUnloadSeconds).toBe(600);
    await h.manager.setIdleUnload(5);
    await vi.waitFor(() => expect(helperRuntimes(h).at(-1)?.launch.idleUnloadSeconds).toBe(300));
    expect(helperRuntimes(h)[0]?.stopped).toBe(true);
    await vi.waitFor(async () => expect((await grant(h)).helper).toBeDefined());
    // Asleep: still running, as the state says.
    const latest = helperRuntimes(h).at(-1);
    if (latest) latest.sleeping = true;
    h.setResident((pid) => (pid === latest?.pid ? 0.1 * GB : 31 * GB));
    await h.manager.setIdleUnload(5);
    await (h.manager as unknown as { pollRuntime(): Promise<void> }).pollRuntime();
    expect((await h.manager.state()).helper).toMatchObject({
      state: "running",
      message: "Unloaded while idle; it loads again with the next side request",
    });
  });

  it("restarts after a crash; grants leave it out until it is back", async () => {
    const h = await setup();
    await install(h, helper.id);
    await install(h, main.id);
    const first = await grant(h);
    const runtime = helperRuntimes(h)[0];
    const changed = h.modelsChanged();
    runtime?.crash();
    expect(h.modelsChanged()).toBeGreaterThan(changed);
    expect(h.logs.join("\n")).toContain(
      "The helper model stopped unexpectedly; restarting it. Side requests use the main model meanwhile.",
    );
    expect((await h.manager.state()).helper?.state).toBe("starting");
    expect((await grant(h)).helper).toBeUndefined();
    runtime?.becomeReady();
    const back = await grant(h);
    expect(back.helper?.endpoint.baseUrl).not.toBe(first.helper?.endpoint.baseUrl);
    expect(back.generation).toBeGreaterThan(first.generation);
    // The main runtime was never touched.
    expect(mainRuntimes(h)).toHaveLength(1);
  });

  it("falls back to the main model when it cannot start, and tries again on the next load", async () => {
    const h = await setup({ helperRuntimeError: new RuntimeError("not-found", "no binary") });
    await install(h, helper.id);
    await install(h, main.id);
    const answer = await grant(h);
    expect(answer.helper).toBeUndefined();
    await vi.waitFor(async () => expect((await h.manager.state()).helper?.state).toBe("error"));
    const state = await h.manager.state();
    expect(state.helper?.message).toContain("Side requests use the main model.");
    expect(h.logs.join("\n")).toContain(
      "The helper model could not start (no binary); side requests use the main model.",
    );
    // Asking again does not hammer a helper that cannot start.
    await grant(h);
    const starts = () => h.logs.filter((line) => line.startsWith("Starting the helper model"));
    expect(starts()).toHaveLength(1);
    // Loading another model is a fresh chance.
    await install(h, other.id);
    expect(await h.manager.requestModel(other.id)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
  });

  it("gives up after a crash loop without taking the main model down", async () => {
    const h = await setup();
    await install(h, helper.id);
    await install(h, main.id);
    await grant(h);
    helperRuntimes(h)[0]?.fail();
    await vi.waitFor(async () => expect((await h.manager.state()).helper?.state).toBe("error"));
    expect((await grant(h)).helper).toBeUndefined();
    expect((await h.manager.status()).state).toBe("ready");
  });

  it("can be turned off and on: the choice is saved for the command line too", async () => {
    const h = await setup();
    await install(h, helper.id);
    await install(h, main.id);
    await grant(h);
    await h.manager.setHelperEnabled(false);
    expect(helperRuntimes(h)[0]?.stopped).toBe(true);
    expect((await grant(h)).helper).toBeUndefined();
    expect((await h.manager.state()).helper).toMatchObject({
      enabled: false,
      state: "ready",
      message: "Turned off: the main model answers titles and page summaries",
    });
    expect(JSON.parse(await readFile(path.join(h.dataRoot, "helper-model.json"), "utf8"))).toEqual({
      enabled: false,
    });
    await h.manager.setHelperEnabled(true);
    await vi.waitFor(async () => expect((await grant(h)).helper).toBeDefined());
    expect(helperRuntimes(h)).toHaveLength(2);
  });

  it("remembers being turned off at the next launch", async () => {
    const first = await setup();
    await install(first, helper.id);
    await first.manager.setHelperEnabled(false);
    await first.manager.dispose();
    const again = await setup({ dir: first.dir });
    expect((await again.manager.state()).helper?.enabled).toBe(false);
  });

  it("stops with the models, is removed cleanly, and shows its memory while it runs", async () => {
    const h = await setup();
    await install(h, helper.id);
    await install(h, main.id);
    await grant(h);
    const runtime = helperRuntimes(h)[0];
    h.setResident((pid) => (pid === runtime?.pid ? 1.5 * GB : 31 * GB));
    await (h.manager as unknown as { pollRuntime(): Promise<void> }).pollRuntime();
    expect((await h.manager.state()).helper?.runtimeMemoryBytes).toBe(1.5 * GB);
    await h.manager.stop();
    expect(runtime?.stopped).toBe(true);
    expect((await h.manager.state()).helper?.state).toBe("ready");
    await grant(h);
    await h.manager.remove(helper.id);
    expect(helperRuntimes(h).every((r) => r.stopped)).toBe(true);
    expect((await h.manager.state()).helper?.state).toBe("available");
    expect((await grant(h)).helper).toBeUndefined();
  });
});
