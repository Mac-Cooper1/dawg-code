import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chatOnce,
  defaultTestModelDir,
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
import { fakeEncryption, GB, harness, testEntry } from "./test-fakes.ts";

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
});

/** Whether a llama-server (or its watchdog) launched for this data root runs: its slot path names it. */
function runningUnder(dataRoot: string): boolean {
  try {
    return (
      execFileSync("pgrep", ["-f", `${dataRoot}/runtime/slots`], { encoding: "utf8" }).trim() !== ""
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
