import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTree, groupAlive, spawnInGroup } from "./process.ts";
import { processesMatching, readPid, survivors } from "./test-support.ts";

// Distinctive sleep lengths let the final check find anything these tests left behind.
const MARK = "4711";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-process-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  expect(await processesMatching(`sleep ${MARK}`)).toEqual([]);
});

function sh(script: string, onOutput?: (stream: string, text: string) => void) {
  return spawnInGroup("/bin/sh", ["-c", script], { cwd: dir, env: process.env, onOutput });
}

describe("spawnInGroup", () => {
  it("reports output and the exit code", async () => {
    const seen: string[] = [];
    const handle = sh("echo out; echo err >&2; exit 3", (stream, text) =>
      seen.push(`${stream}:${text}`),
    );
    const exit = await handle.exited;
    await handle.drained;
    expect(exit).toEqual({ code: 3, signal: null });
    expect(seen.sort()).toEqual(["stderr:err\n", "stdout:out\n"]);
  });

  it("gives the child no standard input", async () => {
    let out = "";
    const handle = sh('read line; echo "status:$?"', (_s, text) => {
      out += text;
    });
    await handle.exited;
    await handle.drained;
    expect(out).toBe("status:1\n");
  });

  it("starts the child as the leader of its own process group", async () => {
    const handle = sh(`sleep ${MARK}`);
    expect(handle.pid).toBeDefined();
    expect(groupAlive(handle.pid ?? -1)).toBe(true);
    await handle.terminate(200);
    expect(groupAlive(handle.pid ?? -1)).toBe(false);
  });

  it("reports a missing executable instead of throwing", async () => {
    const handle = spawnInGroup(path.join(dir, "no-such-binary"), [], {
      cwd: dir,
      env: process.env,
    });
    const exit = await handle.exited;
    expect(exit.error).toBeInstanceOf(Error);
  });
});

describe("terminate", () => {
  it("kills children and grandchildren that ignore SIGINT", async () => {
    // Background jobs in a non-interactive shell ignore SIGINT, so this needs the SIGKILL step.
    const script = `sh -c 'sleep ${MARK} & echo $! > gc.pid; wait' & echo $! > c.pid; wait`;
    const handle = sh(script);
    const child = await readPid(path.join(dir, "c.pid"));
    const grandchild = await readPid(path.join(dir, "gc.pid"));
    await handle.terminate(200);
    expect(await survivors([child, grandchild, handle.pid ?? -1])).toEqual([]);
  });

  it("also kills a descendant that moved to a session of its own", async () => {
    const script = `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "escaped.pid"); print F $$; close F; exec "sleep", "${MARK}"' & wait`;
    const handle = sh(script);
    const escaped = await readPid(path.join(dir, "escaped.pid"));
    const tree = await findTree([handle.pid ?? -1], handle.pid ?? -1);
    expect(tree.has(escaped)).toBe(true);
    await handle.terminate(200);
    expect(await survivors([escaped])).toEqual([]);
  });

  it("returns quickly when SIGINT is enough", async () => {
    const handle = sh(`exec sleep ${MARK}`);
    const started = Date.now();
    await handle.terminate(5000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await survivors([handle.pid ?? -1])).toEqual([]);
  });
});
