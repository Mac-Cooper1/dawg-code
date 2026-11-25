import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stalled, text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { EventLog } from "./event-log.ts";

let h: Harness | null = null;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

async function listedIds(harness: Harness): Promise<string[]> {
  const { sessions } = await harness.engine.listSessions({ projectDir: harness.project });
  return sessions.map((s) => s.id);
}

describe("deleteSession", () => {
  it("deletes a stored session that is not open, with its side files and plans", async () => {
    h = await startHarness({ script: [text("hello")] });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("hi"));
    const id = session.id;
    await session.close();
    const paths = await h.engine.store.paths(h.project, id);
    expect(await exists(path.join(paths.dir, "events.jsonl"))).toBe(true);
    const plans = path.join(h.storeRoot, "plans");
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(plans, `${id}-request-1.md`), "# Plan\n");
    await writeFile(path.join(plans, "other-session-request-1.md"), "# Plan\n");

    await h.engine.deleteSession(id);
    expect(await listedIds(h)).toEqual([]);
    expect(await exists(paths.file)).toBe(false);
    expect(await exists(paths.dir)).toBe(false);
    expect(await exists(paths.lock)).toBe(false);
    expect(await readdir(plans)).toEqual(["other-session-request-1.md"]);
    await expect(h.engine.replay(id, 0)).rejects.toMatchObject({ code: "SessionNotFound" });
    await expect(h.engine.resumeSession(id)).rejects.toMatchObject({ code: "SessionNotFound" });
    await expect(h.engine.deleteSession(id)).rejects.toMatchObject({ code: "SessionNotFound" });
  });

  it("closes an open session first and sends session.deleted as its last event", async () => {
    h = await startHarness({ script: [text("hello")] });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("hi"));
    const lastSeq = session.lastSeq;

    await h.engine.deleteSession(session.id);
    expect(session.closed).toBe(true);
    expect(h.engine.get(session.id)).toBeUndefined();
    const last = h.events.filter((e) => e.payload.sessionId === session.id).at(-1);
    expect(last?.event).toBe("session.deleted");
    expect(last?.payload.seq).toBe(lastSeq + 1);
    expect(await listedIds(h)).toEqual([]);
    await expect(h.engine.replay(session.id, 0)).rejects.toMatchObject({
      code: "SessionNotFound",
    });
  });

  it("interrupts a running turn, whose turn.finished comes before session.deleted", async () => {
    // The OpenAI flavour sends no progress chunks, so the stall comes right after the first text.
    h = await startHarness({
      mock: { flavor: "openai" },
      script: [stalled(text("an answer that never ends", { pacing: { chunkSize: 8 } }), 2)],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const { turnId } = await session.prompt(ask("talk"));
    await h.waitFor((e) => e.event === "message.delta");

    await h.engine.deleteSession(session.id);
    const names = h.names(session.id);
    expect(names.slice(-3)).toEqual(["turn.finished", "session.status", "session.deleted"]);
    expect(h.ofType(session.id, "turn.finished")[0]?.payload).toMatchObject({
      turnId,
      stopReason: "interrupted",
    });
    expect(await listedIds(h)).toEqual([]);
  });

  it("leaves forks working, and keeps only the tool results they still name", async () => {
    h = await startHarness({
      script: [toolCall("Bash", { command: "seq 1 5000" }), text("done")],
      engine: { toolLimits: { bashMaxOutputChars: 200 } },
    });
    const parent = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await parent.run(ask("count"));
    const saved = h.ofType(parent.id, "tool.finished")[0]?.payload.display as {
      outputPath: string | null;
    };
    expect(saved.outputPath).not.toBeNull();
    const fork = await h.engine.forkSession(parent.id);
    const forkId = fork.id;
    await fork.close();

    await h.engine.deleteSession(parent.id);
    const paths = await h.engine.store.paths(h.project, parent.id);
    expect(await exists(paths.file)).toBe(false);
    expect((await readdir(paths.dir)).sort()).toEqual(["deleted.json", "tool-results"]);
    expect((await readFile(saved.outputPath as string, "utf8")).split("\n")).toContain("5000");
    expect(await listedIds(h)).toEqual([forkId]);

    const replayed = await h.engine.replay(forkId, 0);
    expect(replayed.events.map((e) => e.event)).toContain("tool.finished");
    const resumed = await h.engine.resumeSession(forkId);
    expect(resumed.snapshot().session.forkedFrom?.sessionId).toBe(parent.id);
  });

  it("refuses a session another process has open, and keeps it", async () => {
    h = await startHarness();
    const session = await h.engine.createSession({ cwd: h.project });
    const id = session.id;
    await session.close();
    const paths = await h.engine.store.paths(h.project, id);
    await holdInChild(paths.lock);

    await expect(h.engine.deleteSession(id)).rejects.toMatchObject({
      code: "InvalidState",
      message: expect.stringMatching(/^The session is open in another process/),
    });
    expect(await exists(paths.file)).toBe(true);
    expect(await listedIds(h)).toEqual([id]);

    // The failed delete left nothing behind that refuses the session.
    for (const child of children.splice(0)) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin?.end();
      await exited;
    }
    const resumed = await h.engine.resumeSession(id);
    expect(resumed.closed).toBe(false);
  });

  it("refuses to open, fork, rename or archive a session while it is being deleted", async () => {
    // The OpenAI flavour sends no progress chunks, so the stall comes right after the first text.
    h = await startHarness({
      mock: { flavor: "openai" },
      script: [stalled(text("an answer that never ends", { pacing: { chunkSize: 8 } }), 2)],
    });
    const engine = h.engine;
    const session = await engine.createSession({ cwd: h.project });
    await session.prompt(ask("talk"));
    await h.waitFor((e) => e.event === "message.delta");

    // The delete waits for the turn to wind down; the session is being deleted all that time.
    const deleting = engine.deleteSession(session.id);
    const refused = { code: "InvalidState", message: "This session is being deleted." };
    await expect(engine.resumeSession(session.id)).rejects.toMatchObject(refused);
    await expect(engine.forkSession(session.id)).rejects.toMatchObject(refused);
    await expect(engine.renameSession(session.id, "x")).rejects.toMatchObject(refused);
    await expect(engine.archiveSession(session.id)).rejects.toMatchObject(refused);
    await expect(engine.deleteSession(session.id)).rejects.toMatchObject(refused);
    await deleting;

    expect(h.names(session.id).at(-1)).toBe("session.deleted");
    await expect(engine.resumeSession(session.id)).rejects.toMatchObject({
      code: "SessionNotFound",
    });
  });

  it("knows no session by an unknown id", async () => {
    h = await startHarness();
    await expect(h.engine.deleteSession("no-such-session")).rejects.toMatchObject({
      code: "SessionNotFound",
    });
  });
});

describe("the event log and session.deleted", () => {
  it("sends it, never stores it, and sends nothing after it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-deleted-log-"));
    try {
      const file = path.join(dir, "events.jsonl");
      const log = EventLog.open(file, "s1", () => 1000);
      const seen: string[] = [];
      log.subscribe((e) => seen.push(`${e.event} #${e.payload.seq}`));
      log.emit("session.status", {
        status: "idle",
        waitingOn: null,
        message: null,
        queuePosition: null,
      });
      log.emit("session.deleted", {});
      log.emit("session.status", {
        status: "idle",
        waitingOn: null,
        message: null,
        queuePosition: null,
      });
      log.close();
      expect(seen).toEqual(["session.status #1", "session.deleted #2"]);
      expect(log.after(0).events.map((e) => e.event)).toEqual(["session.status"]);
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"session.status"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const holdLockScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "session",
  "__fixtures__",
  "hold-lock.ts",
);

/** Starts a separate process holding `lockFile`, as a `dawg` run in a terminal would. */
async function holdInChild(lockFile: string): Promise<void> {
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
}
