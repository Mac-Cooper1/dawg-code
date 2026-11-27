import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CatalogEntry,
  chatOnce,
  defaultTestModelDir,
  helperWorkingSetBytes,
  hostArch,
  loadCatalog,
  RuntimeError,
  readRuntimeLock,
  UTILITY_CONTEXT_RESERVE,
} from "@dawg/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyStore } from "./keys.ts";
import { ModelManager } from "./manager.ts";
import {
  bundledRuntimeFactory,
  contextPerSlot,
  describeRuntimeError,
  MIN_CONTEXT,
  MODEL_FILE_CONTEXT,
  RUNTIME_SLOTS,
  residentBytes,
} from "./runtime.ts";
import { createModelsStore, modelsFilePath } from "./store.ts";
import { fakeEncryption, GB, harness, testEntry, testHelperEntry } from "./test-fakes.ts";

const here = import.meta.dirname;
const packageWatchdog = path.resolve(
  here,
  "../../../../../packages/models/src/runtime/watchdog.ts",
);
const fakeServer = path.join(here, "__fixtures__", "fake-llama-server.mjs");
const appScript = path.join(here, "__fixtures__", "app.ts");

describe("the conversation's window", () => {
  const entry = testEntry("e", { sizeBytes: 20 * GB });

  it("is the catalog's default when memory allows it", () => {
    expect(contextPerSlot(entry, 256 * GB)).toBe(131_072);
  });

  it("shrinks so the shared cache, window plus reserve, fits the memory rule", () => {
    // 40 GB × 0.7 − 20 GB weights − 2 GB = 6 GB of cache, at 64 KiB a token.
    const window = contextPerSlot(entry, 40 * GB);
    const cacheTokens = Math.floor((6 * GB) / 65_536);
    expect(window).toBe(Math.floor((cacheTokens - UTILITY_CONTEXT_RESERVE) / 1024) * 1024);
    expect(window % 1024).toBe(0);
  });

  it("leaves room for the helper model when it runs beside the model", () => {
    const helper = testHelperEntry();
    const reserve = helperWorkingSetBytes(helper);
    const beside = contextPerSlot(entry, 40 * GB, reserve);
    // 40 GB × 0.7 − 20 GB weights − 2 GB − the helper, at 64 KiB a token.
    const cacheTokens = Math.floor((40 * GB * 0.7 - 22 * GB - reserve) / 65_536);
    expect(beside).toBe(Math.floor((cacheTokens - UTILITY_CONTEXT_RESERVE) / 1024) * 1024);
    expect(beside).toBeLessThan(contextPerSlot(entry, 40 * GB));
  });

  it("gives the 8-bit Qwen at least 90% of its window beside the catalog's helper on 64 GB", async () => {
    const { catalog } = await loadCatalog();
    const qwen = catalog.entries.find((e) => e.id === "qwen3.8-27b-q8") as CatalogEntry;
    const helper = catalog.entries.find((e) => e.role === "helper") as CatalogEntry;
    const beside = contextPerSlot(qwen, 64 * GB, helperWorkingSetBytes(helper));
    expect(beside).toBeGreaterThanOrEqual(204_800 * 0.9);
    expect(beside).toBeLessThan(204_800);
  });

  it("never goes below the minimum, and model files get a fixed window", () => {
    expect(contextPerSlot(entry, 8 * GB)).toBe(MIN_CONTEXT);
    expect(contextPerSlot(undefined, 8 * GB)).toBe(MODEL_FILE_CONTEXT);
  });

  it("gives the 8-bit Qwen its full 204.8K on a 64 GB Mac", async () => {
    const { catalog } = await loadCatalog();
    const qwen = catalog.entries.find((e) => e.id === "qwen3.8-27b-q8");
    if (!qwen) throw new Error("the catalog has no qwen3.8-27b-q8");
    expect(contextPerSlot(qwen, 64 * GB)).toBe(204_800);
    expect(RUNTIME_SLOTS).toEqual({ conversation: [0], utility: [1] });
  });
});

describe("runtime errors", () => {
  it("become sentences", () => {
    expect(describeRuntimeError(new RuntimeError("not-found", "No executable"))).toBe(
      "The bundled runtime (llama-server) is missing. In a checkout, run pnpm fetch-runtime.",
    );
    expect(describeRuntimeError(new RuntimeError("load-timeout", "x"), "/logs/runtime.log")).toBe(
      "The model took too long to load. Its log is in /logs/runtime.log.",
    );
    expect(describeRuntimeError(new Error("spawn EACCES\nmore"))).toBe(
      "The runtime could not start: spawn EACCES.",
    );
  });
});

describe("the bundled runtime under its watchdog", () => {
  let dir: string | undefined;
  let app: ChildProcess | undefined;
  afterEach(async () => {
    app?.kill("SIGKILL");
    app = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function fakeRuntime() {
    dir = await mkdtemp(path.join(tmpdir(), "dawg-watchdog-"));
    const binary = path.join(dir, "llama-server");
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}" "$@"\n`);
    await chmod(binary, 0o755);
    const model = path.join(dir, "tiny.gguf");
    await writeFile(model, "GGUF");
    return { dataRoot: path.join(dir, "dawg"), binary, model };
  }

  it("launches with the two-slot layout: the conversation gets the whole window", async () => {
    const { dataRoot, binary, model } = await fakeRuntime();
    const create = bundledRuntimeFactory({
      dataRoot,
      runtimeDir: dataRoot,
      env: { ...process.env, DAWG_RUNTIME_BIN: binary },
      watchdog: { path: packageWatchdog, nodePath: process.execPath },
    });
    const runtime = await create({ modelId: "tiny", modelPath: model, contextPerSlot: 4096 });
    try {
      const endpoint = await runtime.start();
      expect(endpoint).toMatchObject({ model: "tiny", contextWindow: 4096 });
      const args = processArgs(runtime.pid as number);
      expect(args).toContain(`-c ${4096 + UTILITY_CONTEXT_RESERVE} -np 2`);
      expect(args).toContain("--kv-unified --kv-unified-per-slot 4096");
    } finally {
      await runtime.stop();
    }
    expect(runningUnder(dataRoot)).toBe(false);
  });

  it("launches the helper model apart: one slot, thinking off, its own logs and watchdog", async () => {
    const { dataRoot, binary, model } = await fakeRuntime();
    const create = bundledRuntimeFactory({
      dataRoot,
      runtimeDir: dataRoot,
      env: { ...process.env, DAWG_RUNTIME_BIN: binary },
      watchdog: { path: packageWatchdog, nodePath: process.execPath },
    });
    const helper = testHelperEntry();
    const [main, side] = await Promise.all([
      create({ modelId: "tiny", modelPath: model, contextPerSlot: 4096 }),
      create({
        role: "helper",
        modelId: helper.id,
        modelPath: model,
        catalogEntry: helper,
        contextPerSlot: 32_768,
        idleUnloadSeconds: 600,
      }),
    ]);
    try {
      const [mainEndpoint, helperEndpoint] = await Promise.all([main.start(), side.start()]);
      expect(helperEndpoint).toMatchObject({ model: helper.id, contextWindow: 32_768 });
      expect(helperEndpoint.baseUrl).not.toBe(mainEndpoint.baseUrl);
      const args = processArgs(side.pid as number);
      expect(args).toContain("-c 32768 -np 1");
      expect(args).toContain("--cache-ram 0");
      expect(args).toContain("--reasoning off");
      expect(args).toContain("--no-kv-unified");
      expect(args).toContain("--sleep-idle-seconds 600");
      expect(args).toContain(`${dataRoot}/runtime/helper-slots`);
      expect(side.logPath).toBe(path.join(dataRoot, "logs", "helper-runtime.log"));
      expect(processArgs(parentOf(side.pid as number))).toContain(packageWatchdog);
      expect(parentOf(side.pid as number)).not.toBe(parentOf(main.pid as number));
      expect(await readdir(path.join(dataRoot, "logs"))).toEqual(
        expect.arrayContaining(["runtime.log", "helper-runtime.log"]),
      );
    } finally {
      await Promise.all([main.stop(), side.stop()]);
    }
    expect(runningUnder(dataRoot)).toBe(false);
    expect(runningUnder(dataRoot, "helper-slots")).toBe(false);
  });

  it("leaves no llama-server behind when the app is killed", async () => {
    const { dataRoot, binary, model } = await fakeRuntime();
    const child = spawn(process.execPath, [appScript, dataRoot, binary, model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    app = child;
    const pids = await firstJsonLine<{ app: number; server: number; contextWindow: number }>(child);
    expect(pids.contextWindow).toBe(4096);
    expect(isAlive(pids.server)).toBe(true);
    expect(runningUnder(dataRoot)).toBe(true);
    // The watchdog is what keeps llama-server: it runs the script it was given.
    expect(processArgs(parentOf(pids.server))).toContain(packageWatchdog);

    child.kill("SIGKILL");
    await vi.waitFor(
      () => {
        expect(isAlive(pids.server)).toBe(false);
        expect(runningUnder(dataRoot)).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 30_000);
});

/**
 * Opt-in, like the package's runtime tests: DAWG_RUNTIME_TESTS=1, with the runtime and the test
 * model fetched (node scripts/fetch-runtime.ts --test-model). Skips when either is missing.
 */
const runtimeDir = path.resolve(here, "../../../resources/runtime");
const testModel = await (async () => {
  if (process.env.DAWG_RUNTIME_TESTS !== "1") return null;
  try {
    const lock = await readRuntimeLock();
    const file = path.join(defaultTestModelDir, lock.testModel.file);
    const binary = path.join(runtimeDir, hostArch(), "llama-server");
    return existsSync(file) && existsSync(binary) ? file : null;
  } catch {
    return null;
  }
})();

describe.skipIf(testModel === null)("the manager with the real runtime", () => {
  it("loads a model file on request, answers, and stops on dispose", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-manager-it-"));
    const dataRoot = path.join(dir, "dawg");
    const h = await harness({ dir });
    const manager = new ModelManager({
      backend: {
        ...h.backend,
        createRuntime: bundledRuntimeFactory({
          dataRoot,
          runtimeDir,
          env: process.env,
          watchdog: { path: packageWatchdog, nodePath: process.execPath },
        }),
        residentBytes,
      },
      store: createModelsStore(modelsFilePath(dataRoot), () => {}),
      keys: createKeyStore(dataRoot, fakeEncryption, () => {}),
      hubDir: path.join(dir, "hub"),
      log: () => {},
    });
    try {
      const added = await manager.addModelFile(async () => testModel);
      const answer = await manager.requestModel(null);
      if (!answer.ok) throw new Error(answer.message);
      expect(answer.grant.endpoint.model).toBe(added?.option.id);
      // The server also caps each slot at the model's training context (8192 for this model),
      // and the manager shows the window it reads back.
      expect(answer.grant.endpoint.contextWindow).toBe(8192);
      expect((await manager.list())[0]?.description).toBe("Model file · 8K context · loaded");
      expect(answer.grant.slots).toEqual({ conversation: [0], utility: [1] });
      const reply = await chatOnce(answer.grant.endpoint, {
        messages: [{ role: "user", content: "Say hello." }],
        maxTokens: 8,
      });
      expect(reply.content.length + (reply.reasoning?.length ?? 0)).toBeGreaterThan(0);
      expect(runningUnder(dataRoot)).toBe(true);
    } finally {
      await manager.dispose();
      await h.cleanup();
    }
    expect((await manager.status()).state).toBe("stopped");
    expect(runningUnder(dataRoot)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("runs the helper model in a second runtime beside the main one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-helper-it-"));
    const dataRoot = path.join(dir, "dawg");
    const lock = await readRuntimeLock();
    // The tiny test model stands in for the helper (never a real catalog model in tests): the
    // catalog's helper entry, pointed at its file, already "downloaded".
    const helper: CatalogEntry = {
      ...testHelperEntry("test-helper"),
      source: {
        repo: lock.testModel.repo,
        revision: lock.testModel.revision,
        file: lock.testModel.file,
        sha256: lock.testModel.sha256,
        sizeBytes: lock.testModel.sizeBytes,
      },
    };
    const store = createModelsStore(modelsFilePath(dataRoot), () => {});
    await store.save({
      installed: [{ id: helper.id, source: "download", modelPath: testModel as string }],
      files: [],
      servers: [],
      defaultModelId: null,
      idleUnloadMinutes: null,
      downloads: [],
    });
    const h = await harness({ dir, catalog: [helper] });
    const logs: string[] = [];
    const manager = new ModelManager({
      backend: {
        ...h.backend,
        createRuntime: bundledRuntimeFactory({
          dataRoot,
          runtimeDir,
          env: process.env,
          watchdog: { path: packageWatchdog, nodePath: process.execPath },
        }),
        residentBytes,
      },
      store,
      keys: createKeyStore(dataRoot, fakeEncryption, () => {}),
      hubDir: path.join(dir, "hub"),
      log: (line) => logs.push(line),
      pollIntervalMs: 3_600_000,
    });
    const timing: Record<string, number> = {};
    try {
      await manager.addModelFile(async () => testModel);
      const started = performance.now();
      const first = await manager.requestModel(null);
      if (!first.ok) throw new Error(first.message);
      // The helper loads beside the main model; the engine host is told when it is ready.
      await vi.waitFor(async () => expect((await manager.state()).helper?.state).toBe("running"), {
        timeout: 60_000,
        interval: 50,
      });
      timing.bothReadyMs = Math.round(performance.now() - started);
      const answer = await manager.requestModel(null);
      if (!answer.ok) throw new Error(answer.message);
      const side = answer.grant.helper;
      if (!side) throw new Error("the grant has no helper");
      expect(side.modelId).toBe("test-helper");
      expect(side.slots).toEqual([0]);
      expect(side.endpoint.baseUrl).not.toBe(answer.grant.endpoint.baseUrl);
      // 32K asked for; this server caps a slot at the test model's 8K training context.
      expect(side.endpoint.contextWindow).toBe(8192);
      expect(runningUnder(dataRoot)).toBe(true);
      expect(runningUnder(dataRoot, "helper-slots")).toBe(true);

      const asked = performance.now();
      const reply = await chatOnce(side.endpoint, {
        messages: [{ role: "user", content: "Write a three-word title for: fix the login bug." }],
        maxTokens: 12,
        extra: { id_slot: 0, chat_template_kwargs: { enable_thinking: false } },
      });
      timing.titleMs = Math.round(performance.now() - asked);
      expect(reply.content.length).toBeGreaterThan(0);

      // Memory: polled for both runtimes.
      await (manager as unknown as { pollRuntime(): Promise<void> }).pollRuntime();
      const memory = (await manager.state()).helper?.runtimeMemoryBytes ?? 0;
      timing.helperResidentMiB = Math.round(memory / 1024 ** 2);
      expect(memory).toBeGreaterThan(0);

      // Killed outright, it comes back on another port and the grant follows it.
      const pid = Number(
        execFileSync("pgrep", ["-f", `${dataRoot}/runtime/helper-slots`], { encoding: "utf8" })
          .trim()
          .split("\n")
          .find((line) => processArgs(Number(line)).includes("llama-server")),
      );
      process.kill(pid, "SIGKILL");
      await vi.waitFor(
        async () => {
          const again = await manager.requestModel(null);
          expect(again.ok && again.grant.helper?.endpoint.baseUrl).not.toBe(side.endpoint.baseUrl);
          expect(again.ok && again.grant.helper).toBeTruthy();
        },
        { timeout: 60_000, interval: 100 },
      );
      expect(logs.join("\n")).toContain("The helper model stopped unexpectedly; restarting it.");
      console.log(`[helper runtime] ${JSON.stringify(timing)}`);
    } finally {
      await manager.dispose();
      await h.cleanup();
    }
    expect(runningUnder(dataRoot)).toBe(false);
    expect(runningUnder(dataRoot, "helper-slots")).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 180_000);
});

/**
 * Whether a llama-server (or its watchdog) launched for this data root runs: its slot path names
 * it ("slots" for the main runtime, "helper-slots" for the helper model's).
 */
function runningUnder(dataRoot: string, slots = "slots"): boolean {
  try {
    return (
      execFileSync("pgrep", ["-f", `${dataRoot}/runtime/${slots}`], { encoding: "utf8" }).trim() !==
      ""
    );
  } catch {
    return false;
  }
}

function processArgs(pid: number): string {
  return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
}

function parentOf(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function firstJsonLine<T>(child: ChildProcess): Promise<T> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const newline = out.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(out.slice(0, newline)) as T);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("exit", (code) => reject(new Error(`the app exited early (${code}): ${err}`)));
  });
}
