import { type ChildProcess, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type FakeRuntime, isAlive, makeFakeRuntime, waitFor } from "./__fixtures__/fake.ts";

/**
 * The guarantee under test: llama-server never outlives the app, however the app dies. The
 * "app" here is a separate Node process running a real supervisor (see __fixtures__/parent.ts).
 */

vi.setConfig({ testTimeout: 30_000 });

const parentScript = fileURLToPath(new URL("./__fixtures__/parent.ts", import.meta.url));

interface Pids {
  parent: number;
  watchdog: number;
  server: number;
}

let fake: FakeRuntime;
let parent: ChildProcess | undefined;
const spawned: number[] = [];

beforeEach(async () => {
  fake = await makeFakeRuntime();
});

afterEach(async () => {
  // Never leave anything behind, even when an assertion failed.
  parent?.kill("SIGKILL");
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await fake.cleanup();
});

async function startParent(spec: Record<string, unknown> = {}, graceMs = 1000): Promise<Pids> {
  const model = await fake.model("m", spec);
  const work = join(fake.dir, "work");
  await mkdir(work, { recursive: true });
  const child = spawn(
    process.execPath,
    [parentScript, fake.binary, model.path, work, String(graceMs)],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  parent = child;
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const pids = await new Promise<Pids>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) resolve(JSON.parse(line) as Pids);
    });
    child.once("exit", (code) => reject(new Error(`parent exited early (${code}): ${stderr}`)));
  });
  spawned.push(pids.server, pids.watchdog);
  expect(isAlive(pids.server)).toBe(true);
  expect(isAlive(pids.watchdog)).toBe(true);
  return pids;
}

describe("llama-server dies with the app", () => {
  test("parent killed with SIGKILL", async () => {
    const pids = await startParent();
    process.kill(pids.parent, "SIGKILL");
    await waitFor(() => !isAlive(pids.server) && !isAlive(pids.watchdog), 5_000);
  });

  test("parent killed with SIGTERM (no exit handlers run)", async () => {
    const pids = await startParent();
    process.kill(pids.parent, "SIGTERM");
    await waitFor(() => !isAlive(pids.server) && !isAlive(pids.watchdog), 5_000);
  });

  test("parent crashes with an uncaught exception", async () => {
    const pids = await startParent();
    parent?.stdin?.write("crash\n");
    await waitFor(() => !isAlive(pids.parent), 5_000);
    await waitFor(() => !isAlive(pids.server) && !isAlive(pids.watchdog), 5_000);
  });

  test("parent SIGKILLed while llama-server ignores SIGTERM: the watchdog escalates", async () => {
    const pids = await startParent({ hangOnTerm: true }, 500);
    process.kill(pids.parent, "SIGKILL");
    // Still alive right after (SIGTERM is ignored) …
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pids.server)).toBe(true);
    // … and gone once the grace period has passed.
    await waitFor(() => !isAlive(pids.server) && !isAlive(pids.watchdog), 5_000);
  });
});
