import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chatOnce } from "../endpoint/chat.ts";
import type { Endpoint } from "../types.ts";
import { isAlive, waitFor } from "./__fixtures__/fake.ts";
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
