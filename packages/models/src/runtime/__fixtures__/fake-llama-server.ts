/**
 * A stand-in for llama-server (b12359) for offline tests. It accepts the same flags the
 * supervisor emits, serves the endpoints the runtime uses, and checks the API key from the key
 * file. Its behaviour comes from the "model" file, which is JSON (see FakeModel):
 *
 *   loadDelayMs      /health answers 503 for this long, then 200 (default 50)
 *   neverHealthy     /health never leaves 503
 *   crashOnStart     exit 1 before binding, on the first N launches (true = always)
 *   crashAfterMs     exit 139 this long after becoming ready, on the first `crashTimes` launches
 *   hangOnTerm       ignore SIGTERM / SIGINT
 *   leakKey          print the API key to stderr (to prove the supervisor redacts it)
 *   logLines/logLineBytes  write this much to stderr at start (log rotation)
 *   counterFile      where launch counts are kept across processes
 *   recordFile       write argv, key-file modes and selected env here at start
 *
 * Run with: node fake-llama-server.ts <llama-server flags>
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface FakeModel {
  loadDelayMs?: number;
  neverHealthy?: boolean;
  crashOnStart?: boolean | number;
  crashAfterMs?: number;
  crashTimes?: number;
  hangOnTerm?: boolean;
  leakKey?: boolean;
  logLines?: number;
  logLineBytes?: number;
  counterFile?: string;
  recordFile?: string;
  nCtxTrain?: number;
  chatTemplate?: string;
  templateCaps?: Record<string, unknown>;
  content?: string;
}

const VALUE_FLAGS = new Set([
  "-m",
  "--model",
  "--host",
  "--port",
  "--api-key-file",
  "-c",
  "--ctx-size",
  "-np",
  "--parallel",
  "-ngl",
  "--slot-save-path",
  "--cache-ram",
  "--ctx-checkpoints",
  "--checkpoint-min-step",
  "--log-file",
  "--mmproj",
  "--reasoning",
  "--reasoning-format",
  "--reasoning-budget",
  "--reasoning-effort",
  "--kv-unified-per-slot",
  "--sleep-idle-seconds",
  "--timeout",
  "--alias",
  "--chat-template-file",
]);
const BOOL_FLAGS = new Set([
  "--no-webui",
  "--no-ui",
  "--offline",
  "--reasoning-preserve",
  "--no-reasoning-preserve",
  "--kv-unified",
  "--no-kv-unified",
  "--jinja",
]);

const started = Date.now();
const argv = process.argv.slice(2);
const flags = new Map<string, string>();
let logFile: string | undefined;

function log(line: string): void {
  const stamped = `0.00.${String(Date.now() - started).padStart(3, "0")}.000 ${line}\n`;
  process.stderr.write(stamped);
  if (logFile) {
    try {
      writeFileSync(logFile, stamped, { flag: "a" });
    } catch {
      // ignore
    }
  }
}

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i] ?? "";
  if (VALUE_FLAGS.has(arg)) {
    const value = argv[i + 1];
    if (value === undefined) {
      process.stderr.write(`error: expected value for argument: ${arg}\n`);
      process.exit(1);
    }
    flags.set(arg, value);
    i++;
  } else if (BOOL_FLAGS.has(arg)) {
    flags.set(arg, "true");
  } else {
    process.stderr.write(`error: invalid argument: ${arg}\n`);
    process.exit(1);
  }
}

const flag = (...names: string[]) => {
  for (const n of names) {
    const v = flags.get(n);
    if (v !== undefined) return v;
  }
  return undefined;
};

logFile = flag("--log-file");
if (logFile) writeFileSync(logFile, "");

const modelPath = flag("-m", "--model");
if (!modelPath) {
  log("E srv    load_model: no model given");
  process.exit(1);
}
let model: FakeModel;
try {
  model = JSON.parse(readFileSync(modelPath, "utf8")) as FakeModel;
} catch {
  log(`E gguf_init_from_file: failed to open GGUF file '${modelPath}'`);
  log("E srv  server_run_i: exiting due to model loading error");
  process.exit(1);
}

const host = flag("--host") ?? "127.0.0.1";
const port = Number(flag("--port") ?? "8080");
const nCtx = Number(flag("-c", "--ctx-size") ?? "4096");
const nSlots = Number(flag("-np", "--parallel") ?? "1");
const slotSavePath = flag("--slot-save-path");
const alias = flag("--alias");
const keyFile = flag("--api-key-file");
const keys = keyFile
  ? readFileSync(keyFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  : [];

function launchCount(): number {
  if (!model.counterFile) return 1;
  let count = 0;
  try {
    count = Number(readFileSync(model.counterFile, "utf8")) || 0;
  } catch {
    count = 0;
  }
  count++;
  writeFileSync(model.counterFile, String(count));
  return count;
}
const launch = launchCount();

if (model.recordFile) {
  const keyStat = keyFile ? statSync(keyFile) : undefined;
  const dirStat = keyFile ? statSync(dirname(keyFile)) : undefined;
  writeFileSync(
    model.recordFile,
    JSON.stringify({
      argv,
      pid: process.pid,
      launch,
      keyFileMode: keyStat ? keyStat.mode & 0o777 : null,
      keyDirMode: dirStat ? dirStat.mode & 0o777 : null,
      env: { LLAMA_ARG_HOST: process.env.LLAMA_ARG_HOST ?? null },
    }),
  );
}

log("I srv  llama_server: initializing ...");
if (model.leakKey) log(`I srv  debug: api key is ${keys[0] ?? ""}`);
for (let i = 0; i < (model.logLines ?? 0); i++) {
  log(`I srv  filler ${i}: ${"x".repeat(model.logLineBytes ?? 80)}`);
}

const crashOnStart =
  model.crashOnStart === true ||
  (typeof model.crashOnStart === "number" && launch <= model.crashOnStart);
if (crashOnStart) {
  log(`E srv    load_model: failed to load model, '${modelPath}' (fake crash on start)`);
  process.exit(1);
}

// --- server state -----------------------------------------------------------------------------

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const propsTemplate = JSON.parse(readFileSync(join(fixtureDir, "llama-props-b12359.json"), "utf8"));
const modelsTemplate = JSON.parse(
  readFileSync(join(fixtureDir, "llama-models-b12359.json"), "utf8"),
);

let loaded = false;
let lastTask = Date.now();
const slotCache: string[] = Array.from({ length: nSlots }, () => "");
const modelId = alias ?? modelPath;
const content = model.content ?? "Hello from the fake server.";

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function error(res: ServerResponse, status: number, message: string, type: string): void {
  json(res, status, { error: { code: status, message, type } });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function render(messages: { role: string; content: string }[], tools: unknown): string {
  const head = tools ? `<|tools|>${JSON.stringify(tools)}<|end|>` : "";
  return `${head}${messages.map((m) => `<|${m.role}|>${m.content}<|end|>`).join("")}<|assistant|>`;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function processPrompt(slot: number, prompt: string, predicted: string) {
  const common = commonPrefix(slotCache[slot] ?? "", prompt);
  // Like llama-server, at least one prompt token is always evaluated.
  const cacheN = Math.min(common, Math.max(0, prompt.length - 1));
  slotCache[slot] = prompt + predicted;
  lastTask = Date.now();
  return {
    cache_n: cacheN,
    prompt_n: prompt.length - cacheN,
    prompt_ms: 1,
    predicted_n: predicted.length,
    predicted_ms: 1,
  };
}

function props() {
  return {
    ...propsTemplate,
    default_generation_settings: {
      ...propsTemplate.default_generation_settings,
      n_ctx: Math.floor(nCtx / nSlots),
    },
    total_slots: nSlots,
    model_path: modelPath,
    model_alias: modelId,
    chat_template: model.chatTemplate ?? propsTemplate.chat_template,
    chat_template_caps: { ...propsTemplate.chat_template_caps, ...model.templateCaps },
    modalities: { vision: flags.has("--mmproj"), video: false, audio: false },
    build_info: "b12359-fake",
    is_sleeping:
      flags.has("--sleep-idle-seconds") &&
      Date.now() - lastTask > Number(flag("--sleep-idle-seconds")) * 1000,
  };
}

function models() {
  const entry = modelsTemplate.data[0];
  return {
    ...modelsTemplate,
    data: [
      {
        ...entry,
        id: modelId,
        aliases: [modelId],
        meta: { ...entry.meta, n_ctx: Math.floor(nCtx / nSlots), n_ctx_train: model.nCtxTrain ?? 8192 },
      },
    ],
  };
}

function slotFromBody(body: Record<string, unknown>): number {
  const id = body.id_slot;
  return typeof id === "number" && id >= 0 && id < nSlots ? id : 0;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const path = url.pathname;
  if (path === "/health" || path === "/v1/health") {
    if (!loaded) return error(res, 503, "Loading model", "unavailable_error");
    return json(res, 200, { status: "ok" });
  }
  const auth = req.headers.authorization ?? "";
  if (keys.length > 0 && !keys.some((k) => auth === `Bearer ${k}`)) {
    return error(res, 401, "Invalid API Key", "authentication_error");
  }
  if (!loaded) return error(res, 503, "Loading model", "unavailable_error");

  if (req.method === "GET" && path === "/props") return json(res, 200, props());
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return json(res, 200, models());
  }
  if (req.method === "GET" && path === "/slots") {
    return json(
      res,
      200,
      slotCache.map((c, id) => ({ id, n_ctx: Math.floor(nCtx / nSlots), is_processing: false, cached: c.length })),
    );
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    const body = await readBody(req);
    const messages = (body.messages ?? []) as { role: string; content: string }[];
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : -1;
    const reply = maxTokens >= 0 && maxTokens < 4 ? content.slice(0, 1) : content;
    const slot = slotFromBody(body);
    const prompt = render(messages, body.tools);
    const timings = processPrompt(slot, prompt, reply);
    return json(res, 200, {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          finish_reason: reply === content ? "stop" : "length",
          message: { role: "assistant", content: reply },
        },
      ],
      usage: {
        prompt_tokens: prompt.length,
        completion_tokens: reply.length,
        total_tokens: prompt.length + reply.length,
        prompt_tokens_details: { cached_tokens: timings.cache_n },
      },
      timings,
    });
  }
  if (req.method === "POST" && path === "/completion") {
    const body = await readBody(req);
    const prompt = String(body.prompt ?? "");
    const slot = slotFromBody(body);
    const reply = content.slice(0, 1);
    const timings = processPrompt(slot, prompt, reply);
    return json(res, 200, {
      content: reply,
      id_slot: slot,
      tokens_cached: prompt.length,
      tokens_evaluated: prompt.length,
      timings,
    });
  }
  const slotMatch = /^\/slots\/(\d+)$/.exec(path);
  if (req.method === "POST" && slotMatch) {
    const id = Number(slotMatch[1]);
    const action = url.searchParams.get("action");
    const body = await readBody(req);
    if (action === "erase") {
      const n = (slotCache[id] ?? "").length;
      slotCache[id] = "";
      return json(res, 200, { id_slot: id, n_erased: n });
    }
    if (!slotSavePath) return error(res, 501, "This server does not support slots action.", "not_supported_error");
    const filename = String(body.filename ?? "");
    if (!filename || filename !== basename(filename) || filename.includes("..")) {
      return error(res, 400, "Invalid filename", "invalid_request_error");
    }
    const file = join(slotSavePath, filename);
    if (action === "save") {
      const data = JSON.stringify({ prompt: slotCache[id] ?? "" });
      writeFileSync(file, data);
      return json(res, 200, {
        id_slot: id,
        filename,
        n_saved: (slotCache[id] ?? "").length,
        n_written: data.length,
        timings: { save_ms: 1 },
      });
    }
    if (action === "restore") {
      let saved: string;
      try {
        saved = (JSON.parse(readFileSync(file, "utf8")) as { prompt: string }).prompt;
      } catch {
        return error(
          res,
          400,
          "Unable to restore slot: No available space in KV cache or invalid slot save file",
          "invalid_request_error",
        );
      }
      slotCache[id] = saved;
      return json(res, 200, {
        id_slot: id,
        filename,
        n_restored: saved.length,
        n_read: saved.length,
        timings: { restore_ms: 1 },
      });
    }
    return error(res, 400, "Invalid action", "invalid_request_error");
  }
  return error(res, 404, "File Not Found", "not_found_error");
}

const server = createServer((req, res) => {
  handle(req, res).catch((e: unknown) => error(res, 500, String(e), "server_error"));
});

server.once("error", (e: NodeJS.ErrnoException) => {
  log(`E srv         start: couldn't bind HTTP server socket, hostname: ${host}, port: ${port}`);
  log(`E srv  server_run_i: exiting due to HTTP server error (${e.code})`);
  process.exit(1);
});

server.listen({ host, port, exclusive: true }, () => {
  log(`I srv  init: listening on http://${host}:${port}`);
  log(`I srv    load_model: loading model '${modelPath}'`);
  if (model.neverHealthy) return;
  setTimeout(() => {
    loaded = true;
    log(`I srv    load_model: initializing, n_slots = ${nSlots}, n_ctx_slot = ${Math.floor(nCtx / nSlots)}`);
    log("I main: model loaded");
    const crashTimes = model.crashTimes ?? Number.POSITIVE_INFINITY;
    if (model.crashAfterMs !== undefined && launch <= crashTimes) {
      setTimeout(() => {
        log("E fake: simulated crash");
        process.exit(139);
      }, model.crashAfterMs);
    }
  }, model.loadDelayMs ?? 50);
});

function shutdown(signal: string): void {
  if (model.hangOnTerm) {
    log(`I srv  signal: ignoring ${signal}`);
    return;
  }
  log("I srv    operator(): cleaning up before exit...");
  server.closeAllConnections();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
if (model.hangOnTerm) {
  // A truly stuck process does not die when its stderr pipe breaks either (a real llama-server
  // would get SIGPIPE on its next log line). Only SIGKILL can end this one.
  process.stderr.on("error", () => {});
  process.on("SIGPIPE", () => {});
}
