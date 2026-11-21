import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chatOnce } from "../endpoint/chat.ts";
import { requestJson } from "../endpoint/http.ts";
import {
  type FakeModelSpec,
  type FakeRuntime,
  isAlive,
  makeFakeRuntime,
  waitFor,
} from "./__fixtures__/fake.ts";
import { RuntimeCrashLoopError, RuntimeError } from "./errors.ts";
import { findFreePort } from "./port.ts";
import {
  type RuntimeState,
  RuntimeSupervisor,
  type SupervisorOptions,
  type SupervisorTiming,
} from "./supervisor.ts";

const fast: Partial<SupervisorTiming> = {
  loadTimeoutMs: 10_000,
  healthIntervalMs: 20,
  stopGraceMs: 3_000,
  restartBaseDelayMs: 40,
  restartMaxDelayMs: 1_000,
  maxRestarts: 3,
  stableAfterMs: 60_000,
  portAttempts: 3,
  requestTimeoutMs: 5_000,
};

vi.setConfig({ testTimeout: 30_000 });

let fake: FakeRuntime;
const supervisors: RuntimeSupervisor[] = [];

beforeEach(async () => {
  fake = await makeFakeRuntime();
});

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
  await fake.cleanup();
});

async function supervisor(
  spec: FakeModelSpec = {},
  overrides: Partial<SupervisorOptions> = {},
): Promise<{
  sup: RuntimeSupervisor;
  states: RuntimeState[];
  model: Awaited<ReturnType<FakeRuntime["model"]>>;
}> {
  const model = await fake.model("m", spec);
  const sup = new RuntimeSupervisor({
    binary: fake.binary,
    model: { path: model.path },
    contextSize: 8192,
    slots: 2,
    settings: { cacheRamMiB: 256, ctxCheckpoints: 4, checkpointMinStep: 256 },
    paths: fake.paths,
    timing: fast,
    ...overrides,
  });
  supervisors.push(sup);
  const states: RuntimeState[] = [];
  sup.on("state", (s) => states.push(s));
  return { sup, states, model };
}

describe("RuntimeSupervisor with a fake llama-server", () => {
  test("starting → ready, then reads back the endpoint; stop leaves no process", async () => {
    const { sup, states, model } = await supervisor({ loadDelayMs: 1_000 });
    const starting = sup.start();
    // While the model loads, /health answers 503 and the state stays "starting".
    await waitFor(() => sup.port !== undefined, 5_000);
    let saw503 = false;
    await waitFor(async () => {
      const r = await requestJson(`http://127.0.0.1:${sup.port}/health`, { timeoutMs: 1000 });
      saw503 = !r.ok && r.status === 503;
      return saw503 || sup.state === "ready";
    }, 5_000);
    expect(saw503).toBe(true);
    expect(sup.state).toBe("starting");
    const endpoint = await starting;
    expect(states).toEqual(["starting", "ready"]);
    expect(sup.state).toBe("ready");
    expect(endpoint).toEqual({
      kind: "bundled",
      baseUrl: `http://127.0.0.1:${sup.port}/v1`,
      apiKey: expect.any(String),
      model: model.path,
      contextWindow: 4096, // -c 8192 split over 2 slots, as /props reports
      capabilities: { tools: false, vision: false, reasoning: false, cacheControl: true },
      template: { parallelToolCalls: false, reasoningEffortLevels: [] },
    });
    expect(sup.serverInfo?.totalSlots).toBe(2);
    expect(sup.serverInfo?.trainedContext).toBe(8192);

    const reply = await chatOnce(endpoint, "hi");
    expect(reply.content).toBe("Hello from the fake server.");

    const { server, watchdog } = sup.processIds;
    expect(server).toBeGreaterThan(0);
    expect(watchdog).toBeGreaterThan(0);
    await sup.stop();
    expect(sup.state).toBe("stopped");
    expect(states.at(-1)).toBe("stopped");
    expect(isAlive(server as number)).toBe(false);
    expect(isAlive(watchdog as number)).toBe(false);
  });

  test("the key lives in a 0600 file, never in argv or logs, and is required", async () => {
    const { sup, model } = await supervisor({ leakKey: true });
    const endpoint = await sup.start();
    const key = endpoint.apiKey as string;
    expect(key.length).toBeGreaterThanOrEqual(40);

    const record = await model.record();
    expect(record.keyFileMode).toBe(0o600);
    expect(record.keyDirMode).toBe(0o700);
    expect(record.argv.join(" ")).not.toContain(key);
    expect(record.argv).toContain("--api-key-file");

    // The key file is deleted once the server has read it.
    expect(await readdir(fake.paths.keyDir)).toEqual([]);

    // The fake prints the key to stderr (leakKey); the captured log must not contain it.
    await sup.stop();
    const log = await readFile(join(fake.paths.logDir, "runtime.log"), "utf8");
    expect(log).toContain("api key is [redacted]");
    expect(log).not.toContain(key);
    expect(sup.logTail(200)).not.toContain(key);

    const again = await sup.start();
    expect(again.apiKey).not.toBe(key); // per launch
    const unauthorized = await requestJson(`${again.baseUrl}/models`, { timeoutMs: 2000 });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.status).toBe(401);
    const wrong = await requestJson(`${again.baseUrl}/models`, { apiKey: key, timeoutMs: 2000 });
    expect(wrong.ok).toBe(false);
  });

  test("strips LLAMA_* variables from the runtime's environment", async () => {
    const { sup, model } = await supervisor(
      {},
      { env: { ...process.env, LLAMA_ARG_HOST: "0.0.0.0" } },
    );
    await sup.start();
    expect((await model.record()).env.LLAMA_ARG_HOST).toBeNull();
  });

  test("an unexpected exit restarts the process", async () => {
    const { sup, states, model } = await supervisor({ crashAfterMs: 150, crashTimes: 1 });
    const restarts: number[] = [];
    sup.on("restarting", (attempt) => restarts.push(attempt));
    const exits: { code: number | null; expected: boolean }[] = [];
    sup.on("exit", (e) => exits.push({ code: e.code, expected: e.expected }));
    const first = await sup.start();
    await waitFor(() => states.filter((s) => s === "ready").length === 2, 10_000);
    expect(states).toEqual(["starting", "ready", "crashed", "starting", "ready"]);
    expect(restarts).toEqual([1]);
    expect(exits).toEqual([{ code: 139, expected: false }]);
    expect(await model.launches()).toBe(2);
    expect(sup.endpoint?.baseUrl).not.toBe(first.baseUrl); // fresh port and key
    expect(sup.endpoint?.apiKey).not.toBe(first.apiKey);
  });

  test("gives up after 3 restarts with exponential backoff and a typed error carrying the log tail", async () => {
    const { sup, states, model } = await supervisor({ crashOnStart: true });
    const delays: number[] = [];
    sup.on("restarting", (_attempt, delay) => delays.push(delay));
    const failures: RuntimeError[] = [];
    sup.on("failure", (e) => failures.push(e));
    const error = await sup.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeCrashLoopError);
    const crash = error as RuntimeCrashLoopError;
    expect(crash.code).toBe("crash-loop");
    expect(crash.restarts).toBe(3);
    expect(crash.lastExit).toEqual({ code: 1, signal: null });
    expect(crash.logTail).toContain("fake crash on start");
    expect(failures).toEqual([crash]);
    expect(delays).toEqual([40, 80, 160]);
    expect(await model.launches()).toBe(4);
    expect(states).toEqual([
      "starting",
      "crashed",
      "starting",
      "crashed",
      "starting",
      "crashed",
      "starting",
      "crashed",
      "stopped",
    ]);
    expect(sup.state).toBe("stopped");
    expect(sup.error).toBe(crash);
    await expect(sup.waitUntilReady()).rejects.toBe(crash);
  });

  test("recovers when a crash on start is transient", async () => {
    const { sup, states, model } = await supervisor({ crashOnStart: 2 });
    await sup.start();
    expect(await model.launches()).toBe(3);
    expect(states.at(-1)).toBe("ready");
  });

  test("a stable run restores the restart budget", async () => {
    const { sup, model } = await supervisor(
      { crashAfterMs: 120 },
      { timing: { ...fast, stableAfterMs: 60, restartBaseDelayMs: 10 } },
    );
    await sup.start();
    // With the budget restored after each stable period, it keeps going past 4 launches.
    await waitFor(async () => (await model.launches()) >= 6, 15_000);
    expect(sup.error).toBeUndefined();
  });

  test("stop escalates to SIGKILL when SIGTERM is ignored", async () => {
    const { sup } = await supervisor(
      { hangOnTerm: true },
      { timing: { ...fast, stopGraceMs: 400 } },
    );
    await sup.start();
    const { server, watchdog } = sup.processIds;
    const exits: { signal: string | null; expected: boolean }[] = [];
    sup.on("exit", (e) => exits.push({ signal: e.signal, expected: e.expected }));
    const started = Date.now();
    await sup.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(380);
    // Both were SIGKILLed at once; give launchd a moment to reap the orphaned server.
    await waitFor(() => !isAlive(server as number) && !isAlive(watchdog as number), 2_000);
    expect(exits).toEqual([{ signal: "SIGKILL", expected: true }]);
    expect(sup.logTail()).toContain("ignoring SIGTERM");
    expect(sup.logTail()).toContain("sending SIGKILL");
  });

  test("stop is idempotent and safe in any state", async () => {
    const { sup } = await supervisor({ loadDelayMs: 200 });
    await sup.stop(); // never started
    const starting = sup.start();
    await waitFor(() => sup.state === "starting", 2_000);
    await Promise.all([sup.stop(), sup.stop(), sup.stop()]);
    await expect(starting).rejects.toMatchObject({ code: "stopped" });
    expect(sup.state).toBe("stopped");
    await sup.stop();
    // And it can start again afterwards.
    await sup.start();
    expect(sup.state).toBe("ready");
  });

  test("a model that never becomes healthy hits the load timeout and is killed", async () => {
    const { sup } = await supervisor(
      { neverHealthy: true },
      { timing: { ...fast, loadTimeoutMs: 1_500 } },
    );
    const starting = sup.start();
    await waitFor(() => sup.processIds.server !== undefined, 5_000);
    const pid = sup.processIds.server as number;
    await expect(starting).rejects.toMatchObject({ code: "load-timeout" });
    expect(sup.state).toBe("stopped");
    await waitFor(() => !isAlive(pid), 2_000);
  });

  test("retries on a new port when the chosen one is taken", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) =>
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r),
    );
    const taken = (blocker.address() as { port: number }).port;
    const picks = [taken];
    try {
      const { sup } = await supervisor(
        {},
        { pickPort: async () => picks.shift() ?? findFreePort("127.0.0.1") },
      );
      const endpoint = await sup.start();
      expect(sup.port).not.toBe(taken);
      expect(endpoint.baseUrl).toContain(`:${sup.port}/`);
      expect(sup.logTail()).toContain(`port ${taken} was taken`);
    } finally {
      blocker.close();
    }
  });

  test("gives up with port-unavailable when every attempt collides", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) =>
      blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r),
    );
    const taken = (blocker.address() as { port: number }).port;
    try {
      const { sup } = await supervisor(
        {},
        { pickPort: async () => taken, timing: { ...fast, portAttempts: 2 } },
      );
      await expect(sup.start()).rejects.toMatchObject({ code: "port-unavailable" });
    } finally {
      blocker.close();
    }
  });

  test("kill -9 of llama-server is recovered", async () => {
    const { sup, states } = await supervisor();
    await sup.start();
    const pid = sup.pid as number;
    const exits: (string | null)[] = [];
    sup.on("exit", (e) => exits.push(e.signal));
    process.kill(pid, "SIGKILL");
    await waitFor(() => states.filter((s) => s === "ready").length === 2, 10_000);
    expect(exits).toEqual(["SIGKILL"]);
    expect(sup.pid).not.toBe(pid);
    await waitFor(() => !isAlive(pid), 2_000);
  });

  test("kill -9 of the watchdog takes llama-server down with it, then restarts", async () => {
    const { sup, states } = await supervisor();
    await sup.start();
    const { server, watchdog } = sup.processIds;
    process.kill(watchdog as number, "SIGKILL");
    await waitFor(() => !isAlive(server as number), 3_000);
    await waitFor(() => states.filter((s) => s === "ready").length === 2, 10_000);
  });

  test("changing model or context restarts the process", async () => {
    const { sup } = await supervisor();
    const first = await sup.start();
    const firstPid = sup.pid;
    const other = await fake.model("other", { content: "other model" });
    const second = await sup.reconfigure({ model: { path: other.path }, contextSize: 16384 });
    expect(sup.pid).not.toBe(firstPid);
    expect(isAlive(firstPid as number)).toBe(false);
    expect(second.model).toBe(other.path);
    expect(second.contextWindow).toBe(8192);
    expect(second.baseUrl).not.toBe(first.baseUrl);
    expect((await chatOnce(second, "hi")).content).toBe("other model");
  });

  test("rejects a bad configuration before touching the running process", async () => {
    const { sup } = await supervisor();
    await sup.start();
    const pid = sup.pid;
    await expect(sup.reconfigure({ contextSize: -1 })).rejects.toThrow(/contextSize/);
    expect(sup.pid).toBe(pid);
    expect(sup.state).toBe("ready");
  });

  test("a missing binary fails fast with spawn-failed", async () => {
    const { sup } = await supervisor({}, { binary: join(fake.dir, "does-not-exist") });
    await expect(sup.start()).rejects.toMatchObject({ code: "spawn-failed" });
    expect(sup.state).toBe("stopped");
  });

  test("without the watchdog the process is still supervised", async () => {
    const { sup } = await supervisor({ crashAfterMs: 100, crashTimes: 1 }, { watchdog: false });
    const states: RuntimeState[] = [];
    sup.on("state", (s) => states.push(s));
    await sup.start();
    expect(sup.processIds.watchdog).toBeUndefined();
    await waitFor(() => states.includes("crashed") && sup.state === "ready", 10_000);
  });

  test("captured output rotates at the size cap", async () => {
    const { sup } = await supervisor(
      { logLines: 400, logLineBytes: 100 },
      { log: { maxBytes: 8 * 1024, files: 2 } },
    );
    await sup.start();
    await sup.stop();
    const files = (await readdir(fake.paths.logDir)).sort();
    expect(files).toEqual(["llama-server.log", "runtime.log", "runtime.log.1", "runtime.log.2"]);
    for (const f of ["runtime.log", "runtime.log.1", "runtime.log.2"]) {
      expect((await stat(join(fake.paths.logDir, f))).size).toBeLessThanOrEqual(8 * 1024);
    }
  });

  test("prompt-cache hooks: warm, save, restore, keys", async () => {
    const { sup } = await supervisor();
    const endpoint = await sup.start();
    const system = { role: "system", content: "You are terse. ".repeat(20) };
    const cold = await sup.warm({ slot: 1, messages: [system] });
    expect(cold.cachedTokens).toBe(0);
    expect(cold.promptTokens).toBeGreaterThan(300);
    const followUp = await sup.warm({
      slot: 1,
      messages: [system, { role: "user", content: "hi" }],
    });
    expect(followUp.cachedTokens).toBeGreaterThanOrEqual(system.content.length);

    const key = await sup.slotKey(JSON.stringify([system]));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const saved = await sup.saveSlot(1, key);
    expect(saved.tokens).toBeGreaterThan(0);
    expect(saved.file).toBe(join(fake.paths.slotSaveDir, `${key}.bin`));

    await sup.eraseSlot(1);
    const restored = await sup.restoreSlot(1, key);
    expect(restored).toMatchObject({ restored: true, tokens: saved.tokens });
    const afterRestore = await sup.warm({
      slot: 1,
      messages: [system, { role: "user", content: "hi" }],
    });
    expect(afterRestore.cachedTokens).toBeGreaterThanOrEqual(system.content.length);

    const otherKey = await sup.slotKey(JSON.stringify([system]), "q8_0 kv cache");
    expect(otherKey).not.toBe(key);
    expect(await sup.restoreSlot(1, otherKey)).toMatchObject({
      restored: false,
      reason: "missing",
    });
    await expect(sup.saveSlot(2, key)).rejects.toThrow(/slot 2 does not exist/);
    expect(endpoint.capabilities.cacheControl).toBe(true);
  });

  test("cache hooks refuse to run when not ready", async () => {
    const { sup } = await supervisor();
    await expect(sup.warm({ slot: 0, prompt: "x" })).rejects.toBeInstanceOf(RuntimeError);
    await expect(sup.slotKey("x")).rejects.toMatchObject({ code: "not-ready" });
  });
});
