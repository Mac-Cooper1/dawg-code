import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UTILITY_CONTEXT_RESERVE } from "@dawg/models";
import { afterEach, describe, expect, it } from "vitest";
import { setupModels } from "./models.ts";

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
writeFileSync(process.env.DAWG_FAKE_RECORD, JSON.stringify(argv));
const ctx = Number(value("-c"));
const slots = Number(value("-np"));
const cap = value("--kv-unified-per-slot");
const perSlot = argv.includes("--kv-unified") ? Math.min(ctx, cap ? Number(cap) : ctx) : Math.floor(ctx / slots);
const json = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  if (req.url === "/health") return json(res, { status: "ok" });
  if (req.url === "/props") return json(res, { default_generation_settings: { n_ctx: perSlot }, total_slots: slots });
  if (req.url === "/v1/models") return json(res, { data: [{ id: value("--alias"), meta: { n_ctx: perSlot } }] });
  res.statusCode = 404;
  json(res, {});
}).listen(Number(value("--port")), value("--host"));
process.on("SIGTERM", () => process.exit(0));
`;

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("--model-file", () => {
  it("gives each conversation the whole --context-size, with a small slot for titles beside it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dawg-cli-models-"));
    const script = path.join(dir, "fake-llama-server.mjs");
    const binary = path.join(dir, "llama-server");
    const record = path.join(dir, "argv.json");
    const model = path.join(dir, "tiny.gguf");
    await writeFile(script, FAKE_SERVER);
    await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(binary, 0o755);
    await writeFile(model, "GGUF");
    const previous = process.env.DAWG_FAKE_RECORD;
    process.env.DAWG_FAKE_RECORD = record;
    const lines: string[] = [];
    const setup = await setupModels({
      endpoint: null,
      modelFile: model,
      contextSize: 65_536,
      model: null,
      env: { ...process.env, DAWG_RUNTIME_BIN: binary },
      dawgHome: path.join(dir, "dawg"),
      log: (line) => lines.push(line),
    });
    try {
      const argv = JSON.parse(await readFile(record, "utf8")) as string[];
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
      expect(connection.utility?.pool).toEqual({ slots: [1] });
    } finally {
      await setup.close();
      if (previous === undefined) delete process.env.DAWG_FAKE_RECORD;
      else process.env.DAWG_FAKE_RECORD = previous;
    }
  }, 30_000);
});
