import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chatOnce } from "../endpoint/chat.ts";
import type { CatalogEntry, Endpoint } from "../types.ts";
import { isAlive, waitFor } from "./__fixtures__/fake.ts";
import { twoSlotLayout } from "./args.ts";
import { helperPaths, helperRuntimeConfig } from "./helper.ts";
import { ensureTestModel } from "./install.ts";
import { readRuntimeLock } from "./lock.ts";
import { resolveRuntimeBinary } from "./resolve.ts";
import { type RuntimeState, RuntimeSupervisor } from "./supervisor.ts";

/**
 * Opt-in: DAWG_RUNTIME_TESTS=1. Runs the real pinned llama-server for this machine's
 * architecture (or DAWG_RUNTIME_BIN) against the tiny test model pinned in runtime.lock.json.
 * Fetch the runtime first: node scripts/fetch-runtime.ts --test-model
 * DAWG_RUNTIME_TEST_LOG_DIR keeps the runtime logs there (CI prints them on failure).
 */

const enabled = process.env.DAWG_RUNTIME_TESTS === "1";
const timing: Record<string, number> = {};

async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timing[name] = Math.round(performance.now() - started);
  }
}

describe.skipIf(!enabled)("runtime integration (real llama-server)", () => {
  let work: string;
  let sup: RuntimeSupervisor;
  let endpoint: Endpoint;
  let binary: string;
  const states: RuntimeState[] = [];
  const seenPids = new Set<number>();
  const system = {
    role: "system" as const,
    content: `You are a careful assistant that answers in one short sentence. ${Array.from(
      { length: 40 },
      (_, i) => `Rule ${i + 1}: be concise and precise.`,
    ).join(" ")}`,
  };
  const question = { role: "user" as const, content: "Say hello." };

  beforeAll(async () => {
    const lock = await readRuntimeLock();
    binary = (await resolveRuntimeBinary()).binary;
    const model = await timed("ensureTestModel", () => ensureTestModel({ pin: lock.testModel }));
    work = await mkdtemp(join(tmpdir(), "dawg-runtime-it-"));
    sup = new RuntimeSupervisor({
      binary,
      model: { path: model, sha256: lock.testModel.sha256 },
      contextSize: 4096,
      slots: 2,
      settings: { cacheRamMiB: 256, ctxCheckpoints: 4, checkpointMinStep: 256 },
      paths: {
        slotSaveDir: join(work, "slots"),
        logDir: process.env.DAWG_RUNTIME_TEST_LOG_DIR ?? join(work, "logs"),
        keyDir: join(work, "keys"),
      },
      timing: { loadTimeoutMs: 180_000, healthIntervalMs: 100, restartBaseDelayMs: 500 },
    });
    sup.on("state", (s) => {
      states.push(s);
      const pid = sup.pid;
      if (pid) seenPids.add(pid);
    });
  }, 600_000);

  afterAll(async () => {
    await sup?.stop();
    if (work) await rm(work, { recursive: true, force: true });
    console.log(`[runtime integration] timings (ms): ${JSON.stringify(timing)}`);
  });

  test("starts and becomes ready", async () => {
    endpoint = await timed("startToReady", () => sup.start());
    if (sup.pid) seenPids.add(sup.pid);
    expect(states).toEqual(["starting", "ready"]);
    expect(endpoint).toMatchObject({
      kind: "bundled",
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
      contextWindow: 2048, // -c 4096 over 2 slots, read back from /props
      capabilities: { cacheControl: true },
    });
  }, 300_000);

  test("answers a chat completion", async () => {
    const reply = await timed("chatCompletion", () =>
      chatOnce(endpoint, { messages: [question], maxTokens: 32, temperature: 0 }),
    );
    console.log(`[runtime integration] reply: ${JSON.stringify(reply.content)}`);
    expect(reply.content.trim().length).toBeGreaterThan(0);
  }, 120_000);

  test("reads back /props and /v1/models", () => {
    const info = sup.serverInfo;
    expect(info?.buildInfo).toMatch(/^b12359-/);
    expect(info?.totalSlots).toBe(2);
    expect(info?.trainedContext).toBe(8192);
    expect(info?.chatTemplate).toContain("<|im_start|>");
    expect(info?.isSleeping).toBe(false);
    expect(endpoint.model).toBe(info?.modelId);
  });

  test("warm-up leaves the prefix cached for the next request", async () => {
    await sup.eraseSlot(1);
    const warm = await timed("warm", () => sup.warm({ slot: 1, messages: [system] }));
    expect(warm.cachedTokens).toBe(0);
    expect(warm.promptTokens).toBeGreaterThan(300);
    const next = await timed("requestAfterWarm", () =>
      chatOnce(endpoint, {
        messages: [system, question],
        maxTokens: 8,
        temperature: 0,
        extra: { id_slot: 1, cache_prompt: true },
      }),
    );
    const cacheN = (next.raw as { timings?: { cache_n?: number } }).timings?.cache_n ?? 0;
    console.log(
      `[runtime integration] warm processed ${warm.promptTokens} tokens; next request reused ${cacheN}`,
    );
    // Everything but the assistant header that the warm-up rendered after the system prompt.
    expect(cacheN).toBeGreaterThanOrEqual(warm.promptTokens - 8);
  }, 120_000);

  test("saves and restores a slot", async () => {
    await sup.eraseSlot(0);
    await sup.warm({ slot: 0, messages: [system] });
    const key = await sup.slotKey(JSON.stringify([system]));
    const saved = await timed("slotSave", () => sup.saveSlot(0, key));
    expect(saved.tokens).toBeGreaterThan(300);

    const ask = () =>
      chatOnce(endpoint, {
        messages: [system, question],
        maxTokens: 4,
        temperature: 0,
        extra: { id_slot: 0, cache_prompt: true },
      }).then((r) => (r.raw as { timings?: { cache_n?: number } }).timings?.cache_n ?? 0);

    await sup.eraseSlot(0);
    expect(await ask()).toBe(0); // erased: nothing to reuse
    await sup.eraseSlot(0);
    const restored = await timed("slotRestore", () => sup.restoreSlot(0, key));
    expect(restored).toMatchObject({ restored: true, tokens: saved.tokens });
    expect(await ask()).toBeGreaterThanOrEqual(saved.tokens - 8);

    const stale = await sup.slotKey(JSON.stringify([{ ...system, content: `${system.content} ` }]));
    expect(await sup.restoreSlot(0, stale)).toMatchObject({ restored: false, reason: "missing" });
  }, 120_000);

  test("kill -9 of llama-server is recovered", async () => {
    const pid = sup.pid as number;
    expect(pid).toBeGreaterThan(0);
    const readyBefore = states.filter((s) => s === "ready").length;
    const killedAt = performance.now();
    process.kill(pid, "SIGKILL");
    await waitFor(() => states.filter((s) => s === "ready").length > readyBefore, 180_000, 50);
    timing.recoverAfterKill9 = Math.round(performance.now() - killedAt);
    expect(states.slice(-3)).toEqual(["crashed", "starting", "ready"]);
    expect(isAlive(pid)).toBe(false);
    expect(sup.pid).not.toBe(pid);
    if (sup.pid) seenPids.add(sup.pid);
    endpoint = sup.endpoint as Endpoint;
    const reply = await chatOnce(endpoint, { messages: [question], maxTokens: 16, temperature: 0 });
    expect(reply.content.trim().length).toBeGreaterThan(0);
  }, 300_000);

  test("idle unload: the server sleeps when idle and wakes on the next request", async () => {
    const settings = { ...sup.currentConfig.settings, idleUnloadSeconds: 1 };
    endpoint = await sup.reconfigure({ settings });
    if (sup.pid) seenPids.add(sup.pid);
    expect(await sup.isSleeping()).toBe(false);
    await waitFor(() => sup.isSleeping(), 30_000, 250);
    const reply = await timed("requestWhileAsleep", () =>
      chatOnce(endpoint, { messages: [question], maxTokens: 8, temperature: 0 }),
    );
    expect(reply.content.trim().length).toBeGreaterThan(0);
    expect(await sup.isSleeping()).toBe(false);
    expect(sup.state).toBe("ready");
  }, 120_000);

  test("a clean stop leaves no process behind", async () => {
    const { watchdog } = sup.processIds;
    await timed("stop", () => sup.stop());
    expect(sup.state).toBe("stopped");
    for (const pid of [...seenPids, watchdog]) {
      if (pid) expect(isAlive(pid)).toBe(false);
    }
    const running = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(binary) || line.includes(work));
    expect(running).toEqual([]);
  }, 60_000);
});

/** Resident memory of a process in bytes, from `ps`. */
function residentBytes(pid: number): number {
  const kib = Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
  return kib * 1024;
}

/**
 * The helper model's runtime beside a main one, as the app and the command line run them: two
 * supervisors, each with its own port, key file, logs and slots. The tiny test model stands in
 * for both models (never a real catalog model in tests).
 */
describe.skipIf(!enabled)("helper runtime beside the main runtime (real llama-server)", () => {
  let work: string;
  let main: RuntimeSupervisor;
  let helper: RuntimeSupervisor;
  let mainEndpoint: Endpoint;
  let helperEndpoint: Endpoint;
  let binary: string;
  const helperStates: RuntimeState[] = [];
  const mainStates: RuntimeState[] = [];
  const pids = new Set<number>();
  const measured: Record<string, number> = {};
  const question = {
    role: "user" as const,
    content: "Write a three-word title for: fix the login bug.",
  };

  beforeAll(async () => {
    const lock = await readRuntimeLock();
    binary = (await resolveRuntimeBinary()).binary;
    const model = await ensureTestModel({ pin: lock.testModel });
    work = await mkdtemp(join(tmpdir(), "dawg-helper-it-"));
    const logDir = process.env.DAWG_RUNTIME_TEST_LOG_DIR ?? join(work, "logs");
    const timingOptions = {
      loadTimeoutMs: 180_000,
      healthIntervalMs: 100,
      restartBaseDelayMs: 500,
    };
    const layout = twoSlotLayout(2048, 1024);
    main = new RuntimeSupervisor({
      binary,
      model: { path: model, sha256: lock.testModel.sha256 },
      contextSize: layout.contextSize,
      slots: layout.slots,
      settings: { cacheRamMiB: 256, ctxCheckpoints: 4, checkpointMinStep: 256, ...layout.settings },
      paths: { slotSaveDir: join(work, "slots"), logDir, keyDir: join(work, "keys") },
      timing: timingOptions,
    });
    // A stand-in catalog entry: the test model's own file, laid out as the helper.
    const entry: CatalogEntry = {
      id: "test-helper",
      role: "helper",
      displayName: "Test helper",
      licence: { spdx: "Apache-2.0", url: "https://example.com/LICENSE" },
      source: {
        repo: lock.testModel.repo,
        revision: lock.testModel.revision,
        file: lock.testModel.file,
        sha256: lock.testModel.sha256,
        sizeBytes: lock.testModel.sizeBytes,
      },
      minMemoryBytes: 48 * 1024 ** 3,
      // The test model was trained on 8K; the real helper's window is 32K.
      context: { default: 8192, max: 8192 },
      capabilities: { tools: false, vision: false, reasoning: false },
      profile: "minicpm5",
      rank: 1,
    };
    const config = helperRuntimeConfig({ entry, modelPath: model });
    helper = new RuntimeSupervisor({
      binary,
      model: config.model,
      contextSize: config.contextSize,
      slots: config.slots,
      settings: config.settings,
      paths: { ...helperPaths(work), logDir, keyDir: join(work, "keys") },
      timing: timingOptions,
    });
    main.on("state", (s) => mainStates.push(s));
    helper.on("state", (s) => {
      helperStates.push(s);
      if (helper.pid) pids.add(helper.pid);
    });
  }, 600_000);

  afterAll(async () => {
    await Promise.all([helper?.stop(), main?.stop()]);
    if (work) await rm(work, { recursive: true, force: true });
    console.log(`[helper integration] measured: ${JSON.stringify(measured)}`);
  });

  test("both start, on different ports, each with its own window", async () => {
    const started = performance.now();
    [mainEndpoint, helperEndpoint] = await Promise.all([
      main.start(),
      helper.start().then((endpoint) => {
        measured.helperStartToReadyMs = Math.round(performance.now() - started);
        return endpoint;
      }),
    ]);
    for (const pid of [main.pid, helper.pid]) if (pid) pids.add(pid);
    expect(main.port).not.toBe(helper.port);
    expect(mainEndpoint.baseUrl).not.toBe(helperEndpoint.baseUrl);
    expect(mainEndpoint.apiKey).not.toBe(helperEndpoint.apiKey);
    expect(helperEndpoint.model).toBe("test-helper");
    expect(helperEndpoint.contextWindow).toBe(8192);
    expect(helper.serverInfo?.totalSlots).toBe(1);
    expect(mainEndpoint.contextWindow).toBe(2048);
    measured.helperResidentBytes = residentBytes(helper.pid as number);
  }, 300_000);

  test("keeps its own log files beside the main runtime's", async () => {
    const logs = await readdir(process.env.DAWG_RUNTIME_TEST_LOG_DIR ?? join(work, "logs"));
    expect(logs).toEqual(
      expect.arrayContaining([
        "runtime.log",
        "llama-server.log",
        "helper-runtime.log",
        "helper-llama-server.log",
      ]),
    );
  });

  test("the helper answers a side request with thinking switched off", async () => {
    const started = performance.now();
    const reply = await chatOnce(helperEndpoint, {
      messages: [question],
      maxTokens: 16,
      temperature: 0.2,
      extra: { chat_template_kwargs: { enable_thinking: false }, id_slot: 0 },
    });
    measured.helperTitleMs = Math.round(performance.now() - started);
    expect(reply.content.trim().length).toBeGreaterThan(0);
    // And a long prompt, a page to summarise (about 4,000 tokens: half the stand-in's window, and
    // well inside a CPU-only runner's time even when the machine is busy).
    const page = Array.from(
      { length: 300 },
      (_, i) => `Line ${i}: the page says nothing new.`,
    ).join("\n");
    const before = performance.now();
    const summary = await chatOnce(helperEndpoint, {
      messages: [{ role: "user", content: `Summarise this page in one sentence.\n\n${page}` }],
      maxTokens: 32,
      temperature: 0.2,
      timeoutMs: 240_000,
      extra: { chat_template_kwargs: { enable_thinking: false } },
    });
    measured.helperPageMs = Math.round(performance.now() - before);
    measured.helperPagePromptTokens = summary.usage?.promptTokens ?? 0;
    expect(summary.content.trim().length).toBeGreaterThan(0);
    measured.helperResidentAfterPageBytes = residentBytes(helper.pid as number);
  }, 300_000);

  test("kill -9 of the helper is recovered on a new port; the main runtime is untouched", async () => {
    const pid = helper.pid as number;
    const mainPid = main.pid;
    const readyBefore = helperStates.filter((s) => s === "ready").length;
    const killedAt = performance.now();
    process.kill(pid, "SIGKILL");
    await waitFor(
      () => helperStates.filter((s) => s === "ready").length > readyBefore,
      180_000,
      50,
    );
    measured.helperRecoverAfterKill9Ms = Math.round(performance.now() - killedAt);
    expect(helperStates.slice(-3)).toEqual(["crashed", "starting", "ready"]);
    expect(isAlive(pid)).toBe(false);
    if (helper.pid) pids.add(helper.pid);
    helperEndpoint = helper.endpoint as Endpoint;
    expect(main.pid).toBe(mainPid);
    expect(mainStates).toEqual(["starting", "ready"]);
    const reply = await chatOnce(helperEndpoint, {
      messages: [question],
      maxTokens: 8,
      temperature: 0,
    });
    expect(reply.content.trim().length).toBeGreaterThan(0);
    const mainReply = await chatOnce(mainEndpoint, {
      messages: [question],
      maxTokens: 8,
      temperature: 0,
    });
    expect(mainReply.content.trim().length).toBeGreaterThan(0);
  }, 300_000);

  test("idle unload: the helper sleeps with the idle setting and wakes on the next side request", async () => {
    const settings = { ...helper.currentConfig.settings, idleUnloadSeconds: 1 };
    helperEndpoint = await helper.reconfigure({ settings });
    if (helper.pid) pids.add(helper.pid);
    await waitFor(() => helper.isSleeping(), 30_000, 250);
    measured.helperAsleepResidentBytes = residentBytes(helper.pid as number);
    const woke = performance.now();
    const reply = await chatOnce(helperEndpoint, {
      messages: [question],
      maxTokens: 8,
      temperature: 0,
    });
    measured.helperWakeAndAnswerMs = Math.round(performance.now() - woke);
    expect(reply.content.trim().length).toBeGreaterThan(0);
    expect(await helper.isSleeping()).toBe(false);
  }, 120_000);

  test("stopping both leaves no process behind", async () => {
    const watchdogs = [main.processIds.watchdog, helper.processIds.watchdog];
    await Promise.all([helper.stop(), main.stop()]);
    for (const pid of [...pids, ...watchdogs]) if (pid) expect(isAlive(pid)).toBe(false);
    const running = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.includes(binary) && line.includes(work));
    expect(running).toEqual([]);
  }, 60_000);
});
