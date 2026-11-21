import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempStore, tempStore } from "./__fixtures__/script.ts";
import { acquireLock } from "./lock.ts";
import { SessionStore } from "./store.ts";

const holdLockScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "hold-lock.ts",
);

let t: TempStore;
const children: ChildProcess[] = [];

beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  await t.cleanup();
});

/** Starts a separate process holding `lockFile`; resolves once it has the lock. */
async function holdInChild(lockFile: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [holdLockScript, lockFile], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (d) => {
      if (String(d).includes("locked")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`holder exited with ${code}: ${stderr}`)));
  });
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

describe("one writer per session", () => {
  it("refuses a second writer in the same process", async () => {
    const writer = await t.store.create({ cwd: t.project });
    await expect(t.store.open(t.project, writer.sessionId)).rejects.toMatchObject({
      code: "locked",
    });
    // A second store object in the same process is a second writer too.
    const other = new SessionStore({ root: t.store.root, durability: "none" });
    const error = await other.open(t.project, writer.sessionId).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "locked",
      holder: { pid: process.pid, hostname: hostname() },
    });
    expect((error as Error).message).toMatch(/already open in another process \(pid \d+/);
    await writer.close();
    const again = await other.open(t.project, writer.sessionId);
    await again.close();
  });

  it("refuses a writer while another process holds the session, and allows it after", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const id = writer.sessionId;
    await writer.close();
    const { lock } = await t.store.paths(t.project, id);

    const child = await holdInChild(lock);
    const error = await t.store.open(t.project, id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "locked", holder: { pid: child.pid }, lockFile: lock });
    await expect(t.store.rename(t.project, id, "x")).rejects.toMatchObject({ code: "locked" });
    await expect(t.store.delete(t.project, id)).rejects.toMatchObject({ code: "locked" });

    child.stdin?.end();
    await new Promise((resolve) => child.once("exit", resolve));
    const reopened = await t.store.open(t.project, id);
    await reopened.close();
  });

  it("takes over the lock of a process that died without releasing it", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const id = writer.sessionId;
    await writer.close();
    const { lock } = await t.store.paths(t.project, id);

    const child = await holdInChild(lock);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(child.pid);

    const reopened = await t.store.open(t.project, id);
    expect(JSON.parse(await readFile(lock, "utf8")).pid).toBe(process.pid);
    await reopened.close();
  });

  it("treats an unreadable lock file as stale", async () => {
    const lockFile = path.join(t.root, "x.lock");
    await writeFile(lockFile, "{garbage");
    const lock = await acquireLock(lockFile, "x");
    await lock.release();
  });

  it("does not let two racing takeovers of a stale lock both win", async () => {
    const lockFile = path.join(t.root, "race.lock");
    const pid = await deadPid();
    await writeFile(
      lockFile,
      JSON.stringify({ pid, hostname: hostname(), since: new Date().toISOString(), token: "dead" }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireLock(lockFile, "race")),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "locked" });
    }
    if (won[0]?.status === "fulfilled") await won[0].value.release();
  });

  it("never treats a lock from another host as stale", async () => {
    const lockFile = path.join(t.root, "remote.lock");
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: 1,
        hostname: "some-other-host",
        since: "2026-01-01T00:00:00.000Z",
        token: "t",
      }),
    );
    await expect(acquireLock(lockFile, "x")).rejects.toMatchObject({
      code: "locked",
      holder: { hostname: "some-other-host" },
    });
  });

  it("does not remove a lock it no longer owns", async () => {
    const lockFile = path.join(t.root, "own.lock");
    const lock = await acquireLock(lockFile, "x");
    const replacement = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      since: "now",
      token: "other",
    });
    await writeFile(lockFile, replacement);
    await lock.release();
    expect(await readFile(lockFile, "utf8")).toBe(replacement);
  });
});
