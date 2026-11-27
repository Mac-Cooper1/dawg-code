import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelClient } from "@dawg/engine";
import {
  cachePaths,
  catalogHelper,
  loadCatalog,
  UTILITY_CONTEXT_RESERVE,
  writeHelperEnabled,
} from "@dawg/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModelSetup, setupModels } from "./models.ts";

/**
 * A stand-in llama-server that records its arguments and works out the per-slot window the way
 * the pinned build (b12359) does: a unified cache is shared, each slot capped by
 * --kv-unified-per-slot; otherwise -c is divided between the slots.
 */
const FAKE_SERVER = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
// One record per server, by the name it serves (the helper runs a second one).
writeFileSync(process.env.DAWG_FAKE_RECORD, JSON.stringify(argv));
writeFileSync(process.env.DAWG_FAKE_RECORD + "." + value("--alias"), JSON.stringify(argv));
const ctx = Number(value("-c"));
const slots = Number(value("-np"));
const cap = value("--kv-unified-per-slot");
const perSlot = argv.includes("--kv-unified") ? Math.min(ctx, cap ? Number(cap) : ctx) : Math.floor(ctx / slots);
const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  if (req.url === "/health") return json(res, { status: "ok" });
  if (req.url === "/props") return json(res, { default_generation_settings: { n_ctx: perSlot }, total_slots: slots });
  if (req.url === "/v1/models") return json(res, { data: [{ id: value("--alias"), meta: { n_ctx: perSlot } }] });
  if (req.url === "/v1/chat/completions") {
    // Answers with the name it serves, so a test sees which server took the request.
    res.setHeader("content-type", "text/event-stream");
    const chunk = (body) => res.write("data: " + JSON.stringify(body) + "\\n\\n");
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: value("--alias") }, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    res.end("data: [DONE]\\n\\n");
    return;
  }
  res.statusCode = 404;
  json(res, {});
}).listen(Number(value("--port")), value("--host"));
process.on("SIGTERM", () => process.exit(0));
`;

let dir: string | undefined;
let setup: ModelSetup | undefined;
const recordBefore = process.env.DAWG_FAKE_RECORD;
afterEach(async () => {
  await setup?.close();
  setup = undefined;
  if (recordBefore === undefined) delete process.env.DAWG_FAKE_RECORD;
  else process.env.DAWG_FAKE_RECORD = recordBefore;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A fake llama-server binary, a model file, and a home of their own (no real caches). */
async function fakeRuntime() {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-cli-models-"));
  const script = path.join(dir, "fake-llama-server.mjs");
  const binary = path.join(dir, "llama-server");
  const record = path.join(dir, "argv.json");
  const model = path.join(dir, "tiny.gguf");
  await writeFile(script, FAKE_SERVER);
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(binary, 0o755);
  await writeFile(model, "GGUF");
  const home = path.join(dir, "home");
  // The model's runtime takes this process's environment; the helper's, the one given.
  process.env.DAWG_FAKE_RECORD = record;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    HF_HOME: path.join(home, "hf"),
    DAWG_RUNTIME_BIN: binary,
    DAWG_FAKE_RECORD: record,
  };
  return { dir, binary, record, model, env, dawgHome: path.join(dir, "dawg") };
}

/**
 * Puts the catalog's helper in the Hugging Face cache, as the app's download leaves it. The file
 * is sparse: the right size, without a gigabyte on the disk.
 */
async function placeHelper(hfHome: string) {
  const helper = catalogHelper((await loadCatalog()).catalog);
  if (!helper) throw new Error("the catalog has no helper");
  const s = helper.source;
  const paths = cachePaths(path.join(hfHome, "hub"), s.repo, s.revision, s.file, s.sha256);
  await mkdir(path.dirname(paths.blobPath), { recursive: true });
  const handle = await open(paths.blobPath, "w");
  await handle.truncate(s.sizeBytes);
  await handle.close();
  await mkdir(path.dirname(paths.snapshotPath), { recursive: true });
  await symlink(paths.snapshotTarget, paths.snapshotPath);
  return helper;
}

async function answerOf(client: ModelClient): Promise<string> {
  let text = "";
  for await (const event of client.stream({
    messages: [{ role: "user", kind: "prompt", content: [{ type: "text", text: "a title" }] }],
    tools: [],
  })) {
    if (event.type === "finished") text = event.reply.content;
  }
  return text;
}

describe("--model-file", () => {
  it("gives each conversation the whole --context-size, with a small slot for titles beside it", async () => {
    const f = await fakeRuntime();
    const lines: string[] = [];
    setup = await setupModels({
      endpoint: null,
      modelFile: f.model,
      contextSize: 65_536,
      model: null,
      env: f.env,
      dawgHome: f.dawgHome,
      log: (line) => lines.push(line),
    });
    const argv = JSON.parse(await readFile(f.record, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("-c")).toBe(String(65_536 + UTILITY_CONTEXT_RESERVE));
    expect(at("-np")).toBe("2");
    expect(argv).toContain("--kv-unified");
    expect(at("--kv-unified-per-slot")).toBe("65536");
    expect(at("--alias")).toBe("tiny");
    expect(lines.at(-1)).toBe(
      "Model tiny ready on the bundled runtime, context window 65536 tokens.",
    );
    const connection = await setup.provider.connect(null);
    expect(connection.pool).toEqual({ slots: [0] });
    // Without a helper, side requests go to the side slot of the same runtime.
    const side = connection.utility?.client as ModelClient;
    expect(side.endpoint.model).toBe("tiny");
    expect(await answerOf(side)).toBe("tiny");
  }, 30_000);
});

describe("the helper model", () => {
  it("runs beside the model file when the app has downloaded it, and takes side requests", async () => {
    const f = await fakeRuntime();
    const helper = await placeHelper(f.env.HF_HOME as string);
    const lines: string[] = [];
    setup = await setupModels({
      endpoint: null,
      modelFile: f.model,
      contextSize: 32_768,
      model: null,
      env: f.env,
      dawgHome: f.dawgHome,
      log: (line) => lines.push(line),
    });
    const connection = await setup.provider.connect(null);
    const side = connection.utility?.client as ModelClient;
    await vi.waitFor(() => expect(side.endpoint.model).toBe(helper.id), { timeout: 10_000 });
    expect(side.endpoint.contextWindow).toBe(32_768);
    expect(await answerOf(side)).toBe(helper.id);
    // The conversation stays on the model.
    expect(await answerOf(connection.client)).toBe("tiny");
    const argv = JSON.parse(await readFile(`${f.record}.${helper.id}`, "utf8")) as string[];
    const at = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(at("-c")).toBe("32768");
    expect(at("-np")).toBe("1");
    expect(at("--reasoning")).toBe("off");
    expect(at("--log-file")).toBe(path.join(f.dawgHome, "logs", "helper-llama-server.log"));
    expect(lines).toContain(
      `Helper model ${helper.id} ready for side requests, context window 32768 tokens.`,
    );
  }, 30_000);

  it("serves a remote endpoint's sessions too", async () => {
    const f = await fakeRuntime();
    const helper = await placeHelper(f.env.HF_HOME as string);
    // A llama-server of the person's own, standing in for a remote one.
    const remote = await setupModels({
      endpoint: null,
      modelFile: f.model,
      contextSize: 8_192,
      model: "remote-model",
      env: { ...f.env, HF_HOME: path.join(f.dir, "empty-hf") },
      dawgHome: path.join(f.dir, "other"),
      log: () => {},
    });
    try {
      const url = remote.describe("remote-model")?.url as string;
      setup = await setupModels({
        endpoint: url,
        modelFile: null,
        contextSize: null,
        model: null,
        env: { ...f.env, DAWG_API_KEY: "" },
        dawgHome: f.dawgHome,
        log: () => {},
      });
      const connection = await setup.provider.connect(null);
      const side = connection.utility?.client as ModelClient;
      // Until the helper is ready side requests go to the server; then to the helper.
      await vi.waitFor(() => expect(side.endpoint.model).toBe(helper.id), { timeout: 10_000 });
      expect(await answerOf(side)).toBe(helper.id);
    } finally {
      await remote.close();
    }
  }, 30_000);

  it("is left alone when the person turned it off", async () => {
    const f = await fakeRuntime();
    await placeHelper(f.env.HF_HOME as string);
    await writeHelperEnabled(f.dawgHome, false);
    const lines: string[] = [];
    setup = await setupModels({
      endpoint: null,
      modelFile: f.model,
      contextSize: 8_192,
      model: null,
      env: f.env,
      dawgHome: f.dawgHome,
      log: (line) => lines.push(line),
    });
    const connection = await setup.provider.connect(null);
    expect(await answerOf(connection.utility?.client as ModelClient)).toBe("tiny");
    expect(lines).toContain(
      "The helper model is turned off; the model answers titles and page summaries.",
    );
  }, 30_000);
});
