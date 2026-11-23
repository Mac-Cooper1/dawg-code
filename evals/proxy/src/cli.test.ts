import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { chunk, rawRequest, sendJson, sendSse, startFakeUpstream } from "./fake-upstream.ts";
import { ProxyRecordSchema } from "./record.ts";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function spawnCli(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  return child;
}

async function firstStdoutLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("no stdout");
  const rl = createInterface({ input: stdout });
  const [line] = (await once(rl, "line")) as [string];
  return line;
}

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (d: Buffer) => {
    text += d.toString("utf8");
  });
  return () => text;
}

// Each test starts the proxy as a separate Node process. On a slow, busy machine (the Intel
// CI runner, with other packages' tests running alongside) that alone can take over 5 seconds.
describe("cli", { timeout: 30_000 }, () => {
  test("prints the listening line, records requests, and flushes on SIGTERM", async () => {
    const upstream = await startFakeUpstream((req, res) => {
      if ((req.json as { stream?: boolean }).stream) {
        // Slow enough that SIGTERM arrives while this request is in flight.
        void sendSse(res, [chunk({ content: "slow" }), chunk({}, {}, "stop")], { delayMs: 150 });
      } else {
        sendJson(res, 200, {
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        });
      }
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "eval-proxy-cli-"));
    cleanups.push(async () => {
      await upstream.close();
      await rm(dir, { recursive: true, force: true });
    });
    const recordPath = path.join(dir, "nested", "records.jsonl");
    const child = spawnCli(
      [
        "--upstream",
        upstream.url,
        "--port",
        "0",
        "--record",
        recordPath,
        "--label",
        "trial-1",
        "--upstream-key-env",
        "CLI_TEST_KEY",
      ],
      { CLI_TEST_KEY: "cli-secret-key-xyz" },
    );
    const stderr = collect(child.stderr);
    const line = await firstStdoutLine(child);
    const ready = JSON.parse(line) as { event: string; port: number };
    expect(Object.keys(ready)).toEqual(["event", "port"]);
    expect(ready.event).toBe("listening");
    expect(ready.port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${ready.port}`;

    const plain = await rawRequest(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    expect(plain.status).toBe(200);
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer cli-secret-key-xyz");

    const inFlight = rawRequest(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 100));
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const streamed = await inFlight;
    expect(streamed.body.toString("utf8")).toContain("[DONE]");
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);

    const records = (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((l) => ProxyRecordSchema.parse(JSON.parse(l)))
      .sort((a, b) => a.seq - b.seq);
    expect(records.map((r) => [r.seq, r.stream, r.status, r.label, r.error])).toEqual([
      [1, false, 200, "trial-1", null],
      [2, true, 200, "trial-1", null],
    ]);
    expect(records[0]?.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 1,
      cached_tokens: null,
    });
    expect(stderr()).not.toContain("cli-secret-key-xyz");
  });

  test("bad arguments exit with code 2 and nothing on stdout", async () => {
    const child = spawnCli(["--port", "0"]);
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(2);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("--upstream is required");
  });

  test("a missing key env var exits with code 1", async () => {
    const child = spawnCli([
      "--upstream",
      "http://127.0.0.1:9/v1",
      "--record",
      path.join(os.tmpdir(), "eval-proxy-never.jsonl"),
      "--upstream-key-env",
      "EVAL_PROXY_TEST_UNSET_VAR",
    ]);
    const stderr = collect(child.stderr);
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(1);
    expect(stderr()).toContain("EVAL_PROXY_TEST_UNSET_VAR");
  });
});
