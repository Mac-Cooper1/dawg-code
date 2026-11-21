/**
 * The `dawg` adapter end to end: the real runner, the real recording proxy and the real CLI from
 * this checkout, against the scripted mock model (its command-line server), on a fixture task the
 * script solves.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TASKS, tempDir } from "../__fixtures__/paths.ts";
import { REPO_ROOT } from "../cli.ts";
import { defaultProxyCommand } from "../proxy.ts";
import { runSuite } from "../run.ts";
import { loadTask } from "../task.ts";
import { createAdapter } from "./index.ts";

const MOCK_CLI = resolve(REPO_ROOT, "packages", "mock-model", "src", "cli.ts");

let dir: string;
let cleanup: () => void;
let mock: ChildProcess | null = null;
beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => {
  mock?.kill("SIGTERM");
  mock = null;
  cleanup();
});

async function startMock(script: unknown): Promise<string> {
  const file = join(dir, "script.json");
  writeFileSync(file, JSON.stringify(script));
  const child = spawn(process.execPath, [MOCK_CLI, "--script", file, "--port", "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  mock = child;
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  for await (const line of lines) {
    const event = JSON.parse(line) as { event: string; baseUrl?: string };
    if (event.event === "listening" && event.baseUrl !== undefined) return event.baseUrl;
  }
  throw new Error("the mock model did not start");
}

test("runs the dawg CLI on a task through the proxy and passes", async () => {
  const baseUrl = await startMock({
    replies: [
      { toolCalls: [{ name: "Read", arguments: { file_path: "greeting.txt" } }] },
      {
        toolCalls: [
          { name: "Write", arguments: { file_path: "greeting.txt", content: "hello, world\n" } },
        ],
      },
      { text: "greeting.txt now says hello, world." },
    ],
  });
  const { rows } = await runSuite({
    adapter: createAdapter("dawg"),
    tasks: [loadTask(join(TASKS, "edit-greeting"))],
    model: "mock-model",
    trials: 1,
    repoRoot: dir,
    resultsDir: join(dir, "results"),
    artifactsRoot: join(dir, "results", "tmp"),
    tempParent: dir,
    endpoint: { url: baseUrl, proxyCommand: defaultProxyCommand(REPO_ROOT) },
  });
  expect(rows.map((r) => [r.status, r.agent_exit_code])).toEqual([["pass", 0]]);
  const runDir = join(dir, "results", "tmp", rows[0]?.run_id ?? "");
  // The transcript: every protocol event of the run, one JSON object per line.
  const events = readFileSync(join(runDir, "agent.stdout.log"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown> });
  expect(events.find((e) => e.event === "turn.finished")?.payload).toMatchObject({
    stopReason: "completed",
  });
  expect(events.filter((e) => e.event === "tool.finished").map((e) => e.payload.outcome)).toEqual([
    "success",
    "success",
  ]);
  // Every model request went through the recording proxy.
  const records = readFileSync(join(runDir, "proxy.jsonl"), "utf8").trim().split("\n");
  expect(records.filter((r) => r.includes("/v1/chat/completions"))).toHaveLength(3);
  // The session transcript is kept with the artefacts.
  const projects = join(runDir, "dawg-home", "projects");
  expect(existsSync(projects)).toBe(true);
  expect(readdirSync(projects)).toHaveLength(1);
}, 60_000);
