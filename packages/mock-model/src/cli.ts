/**
 * Runs the mock model server from a script file:
 *
 *   node packages/mock-model/src/cli.ts --script <file.json> [--port <n|0>] [--kind <kind>]
 *       [--model <id>] [--context <tokens>] [--verbose]
 *
 * Prints one JSON line, {"event":"listening","port":n,"baseUrl":"..."}, then serves until SIGTERM
 * or SIGINT. The script file holds a script (see README.md), optionally with a "server" object
 * of options. An API key, when wanted, comes from DAWG_MOCK_API_KEY so it never sits in a file.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { EndpointKind } from "@dawg/models";
import { parseScript } from "./script.ts";
import { startMockModel } from "./server.ts";
import type { MockModelOptions, TemplateCaps } from "./types.ts";

const KINDS = new Set<EndpointKind>(["bundled", "ollama", "lmstudio", "remote"]);

function fail(message: string): never {
  process.stderr.write(`mock-model: ${message}\n`);
  process.exit(2);
}

function serverOptions(value: unknown): MockModelOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail('"server" must be an object');
  }
  const v = value as Record<string, unknown>;
  const out: MockModelOptions = {};
  if (v.kind !== undefined) {
    if (!KINDS.has(v.kind as EndpointKind))
      fail(`server.kind must be one of ${[...KINDS].join(", ")}`);
    out.kind = v.kind as EndpointKind;
  }
  if (v.flavor !== undefined) {
    if (v.flavor !== "llama.cpp" && v.flavor !== "openai")
      fail('server.flavor must be "llama.cpp" or "openai"');
    out.flavor = v.flavor;
  }
  if (typeof v.model === "string") out.model = v.model;
  if (typeof v.contextWindow === "number") out.contextWindow = v.contextWindow;
  if (typeof v.enforceContextWindow === "boolean")
    out.enforceContextWindow = v.enforceContextWindow;
  if (typeof v.totalSlots === "number") out.totalSlots = v.totalSlots;
  if (typeof v.chatTemplate === "string") out.chatTemplate = v.chatTemplate;
  if (typeof v.templateCaps === "object" && v.templateCaps !== null) {
    out.templateCaps = v.templateCaps as TemplateCaps;
  }
  if (typeof v.capabilities === "object" && v.capabilities !== null) {
    out.capabilities = v.capabilities as MockModelOptions["capabilities"];
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      script: { type: "string" },
      port: { type: "string" },
      kind: { type: "string" },
      model: { type: "string" },
      context: { type: "string" },
      verbose: { type: "boolean" },
    },
    strict: true,
  });
  if (!values.script) fail("--script <file.json> is required");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(values.script, "utf8"));
  } catch (error) {
    fail(`cannot read ${values.script}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let fileOptions: MockModelOptions = {};
  let scriptPart: unknown = raw;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "server" in raw) {
    const { server, ...rest } = raw as Record<string, unknown>;
    fileOptions = serverOptions(server);
    scriptPart = rest;
  }
  let options: MockModelOptions;
  try {
    options = { ...fileOptions, script: parseScript(scriptPart) };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be 0-65535");
    options.port = port;
  }
  if (values.kind !== undefined) {
    if (!KINDS.has(values.kind as EndpointKind))
      fail(`--kind must be one of ${[...KINDS].join(", ")}`);
    options.kind = values.kind as EndpointKind;
  }
  if (values.model !== undefined) options.model = values.model;
  if (values.context !== undefined) {
    const context = Number(values.context);
    if (!Number.isInteger(context) || context <= 0) fail("--context must be a positive integer");
    options.contextWindow = context;
  }
  const key = process.env.DAWG_MOCK_API_KEY;
  if (key) options.apiKey = key;

  const mock = await startMockModel(options);
  let seen = 0;
  const report = setInterval(() => {
    if (!values.verbose) return;
    for (; seen < mock.requests.length; seen++) {
      const r = mock.requests[seen];
      if (!r) break;
      process.stderr.write(
        `${JSON.stringify({ event: "request", index: r.index, method: r.method, path: r.path, lane: r.lane })}\n`,
      );
    }
  }, 50);
  report.unref();

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(report);
    mock.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdout.write(
    `${JSON.stringify({ event: "listening", port: mock.port, baseUrl: mock.baseUrl })}\n`,
  );
}

await main();
