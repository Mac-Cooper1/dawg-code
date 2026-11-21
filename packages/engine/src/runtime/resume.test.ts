import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stalled, text, toolCalls } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";
import { isStreamingEvent } from "./event-log.ts";

let h: Harness | null = null;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const childScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "crash-child.ts",
);

function promptIndex(view: readonly Message[], prompt: string): number {
  return view.findIndex((m) => m.role === "user" && m.kind === "prompt" && textOf(m) === prompt);
}

describe("fork", () => {
  it("copies history up to a turn, names its parent, and goes on by itself", async () => {
    h = await startHarness({
      script: [text("a"), text("b"), text("c"), text("forked reply")],
    });
    const parent = await h.engine.createSession({ cwd: h.project });
    await parent.rename("Parent");
    await parent.run(ask("one"));
    const two = await parent.run(ask("two"));
    await parent.run(ask("three"));

    const before = await h.engine.forkSession(parent.id, {
      point: { position: "beforeTurn", turnId: two.turnId },
    });
    const cut = promptIndex(parent.view, "two");
    expect(JSON.stringify(before.view)).toBe(JSON.stringify(parent.view.slice(0, cut)));
    expect(before.summary()).toMatchObject({
      title: "Parent (fork)",
      forkedFrom: { sessionId: parent.id, point: { position: "beforeTurn", turnId: two.turnId } },
    });
    // The fork's transcript is described by events a client can replay.
    const replayed = before.eventsAfter(0).events.map((e) => e.event);
    expect(replayed.filter((e) => e === "turn.started")).toHaveLength(1);
    expect(replayed.filter((e) => e === "turn.finished")).toHaveLength(1);

    const after = await h.engine.forkSession(parent.id, {
      point: { position: "afterTurn", turnId: two.turnId },
      title: "Second fork",
    });
    const three = promptIndex(parent.view, "three");
    expect(JSON.stringify(after.view)).toBe(JSON.stringify(parent.view.slice(0, three)));
    expect(after.summary().title).toBe("Second fork");

    const whole = await h.engine.forkSession(parent.id);
    expect(JSON.stringify(whole.view)).toBe(JSON.stringify(parent.view));

    const parentLength = parent.view.length;
    const outcome = await before.run(ask("instead"));
    expect(outcome.finalText).toBe("forked reply");
    expect(parent.view).toHaveLength(parentLength);
    const sent = JSON.stringify(h.mock.messages(-1));
    expect(sent).toContain('"one"');
    expect(sent).not.toContain('"two"');
    await expect(
      h.engine.forkSession(parent.id, { point: { position: "afterTurn", turnId: "turn-999" } }),
    ).rejects.toMatchObject({ code: "InvalidState" });
  });

  it("forks a session mid-turn at the end of its last finished turn", async () => {
    h = await startHarness({
      mock: { flavor: "openai" },
      script: [text("first"), stalled(text("never finishes"), 2)],
    });
    const parent = await h.engine.createSession({ cwd: h.project });
    await parent.run(ask("one"));
    await parent.prompt(ask("two"));
    await h.waitFor((e) => e.event === "message.delta" && e.payload.text !== "first");
    const fork = await h.engine.forkSession(parent.id);
    expect(promptIndex(fork.view, "two")).toBe(-1);
    expect(promptIndex(fork.view, "one")).toBeGreaterThan(-1);
    expect(historyProblems(fork.view)).toEqual([]);
    parent.interrupt();
    await parent.waitForIdle();
  });
});

describe("crash safety", () => {
  it("a session left mid-turn by a killed process opens again, repaired, and goes on", async () => {
    h = await startHarness({
      files: { "a.txt": "alpha\n" },
      script: [
        toolCalls([
          { id: "read-1", name: "Read", arguments: { file_path: "a.txt" } },
          { id: "write-1", name: "Write", arguments: { file_path: "b.txt", content: "beta\n" } },
        ]),
        text("after the crash"),
      ],
    });
    const child = spawn(
      process.execPath,
      [childScript, h.storeRoot, h.home, h.project, JSON.stringify(h.mock.endpoint)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const sessionId = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout?.on("data", (d) => {
        out += String(d);
        const line = out.split("\n")[0];
        if (out.includes("\n") && line)
          resolve((JSON.parse(line) as { sessionId: string }).sessionId);
      });
      child.once("exit", () => reject(new Error(`child exited early: ${stderr}`)));
    });
    const paths = await h.engine.store.paths(h.project, sessionId);
    const eventsFile = path.join(paths.dir, "events.jsonl");
    // Mid-turn: the first call has its result, the second waits for permission.
    const deadline = Date.now() + 10_000;
    while (!(await readFile(eventsFile, "utf8").catch(() => "")).includes("permission.requested")) {
      if (Date.now() > deadline) throw new Error(`the child never asked: ${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const storedBefore = (await readFile(eventsFile, "utf8")).trim().split("\n");
    const highest = Math.max(
      ...storedBefore.map((l) => {
        const v = JSON.parse(l) as { payload?: { seq: number }; reserve?: number };
        return v.payload?.seq ?? v.reserve ?? 0;
      }),
    );

    const session = await h.engine.resumeSession(sessionId);
    expect(historyProblems(session.view)).toEqual([]);
    const results = session.view.filter((m) => m.role === "tool");
    expect(results.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual([
      "read-1",
      "write-1",
    ]);
    expect(textOf(results[1])).toMatch(/^Interrupted/);
    expect(textOf(session.view.at(-1))).toContain('"interrupted"');

    // Whatever the crash left open is closed for clients, with numbers never used before.
    const closers = session.eventsAfter(highest).events;
    expect(closers.map((e) => e.event)).toEqual([
      "request.resolved",
      "tool.finished",
      "turn.finished",
      "session.status",
    ]);
    expect(closers[0]?.payload.seq).toBeGreaterThan(highest);
    expect(closers[2]?.payload.stopReason).toBe("interrupted");

    const outcome = await session.run(ask("carry on"));
    expect(outcome.finalText).toBe("after the crash");
    expect(JSON.stringify(h.mock.messages(-1))).toContain("Interrupted: the session stopped");
    h.mock.assertDone();
  });
});

describe("events across restarts", () => {
  it("continue with the next number after a clean close, and replay without opening", async () => {
    h = await startHarness({ script: [text("one"), text("two")] });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("first"));
    const lastSeq = session.lastSeq;
    const live = h.events.filter(
      (e) => e.payload.sessionId === session.id && !isStreamingEvent(e.event),
    );
    await session.close();

    const stored = await h.engine.replay(session.id, 0);
    expect(stored.lastSeq).toBe(lastSeq);
    expect(stored.events.map((e) => e.payload.seq)).toEqual(live.map((e) => e.payload.seq));
    // Streaming events are not stored, so stored numbers have gaps; pages follow them.
    const seqs = stored.events.map((e) => e.payload.seq);
    const page = await h.engine.replay(session.id, seqs[0] as number, 2);
    expect(page.events.map((e) => e.payload.seq)).toEqual(seqs.slice(1, 3));
    expect(page.hasMore).toBe(true);

    const engine = h.newEngine();
    const resumed = await engine.resumeSession(session.id);
    await resumed.run(ask("second"));
    const after = h.events.filter((e) => e.payload.sessionId === session.id);
    const firstNew = after.find((e) => e.payload.seq > lastSeq);
    expect(firstNew?.payload.seq).toBe(lastSeq + 1);
  });
});

describe("listing", () => {
  it("lists, renames and archives stored and open sessions", async () => {
    h = await startHarness({ script: [text("one")] });
    const a = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await a.run(ask("first"));
    await a.close();
    const b = await h.engine.createSession({ cwd: h.project });

    let listed = await h.engine.listSessions();
    expect(listed.sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    const storedA = listed.sessions.find((s) => s.id === a.id);
    expect(storedA).toMatchObject({
      mode: "acceptEdits",
      status: "idle",
      cwd: h.project,
      title: null,
    });
    expect(storedA?.lastSeq).toBeGreaterThan(0);

    const renamed = await h.engine.renameSession(a.id, "Stored session");
    expect(renamed.title).toBe("Stored session");
    await h.engine.archiveSession(a.id);
    listed = await h.engine.listSessions();
    expect(listed.sessions.map((s) => s.id)).toEqual([b.id]);
    listed = await h.engine.listSessions({ includeArchived: true, query: "stored" });
    expect(listed.sessions.map((s) => s.id)).toEqual([a.id]);
    const paged = await h.engine.listSessions({ includeArchived: true, limit: 1 });
    expect(paged.sessions).toHaveLength(1);
    expect(paged.nextCursor).toBe("1");
    await expect(h.engine.resumeSession("missing-session")).rejects.toMatchObject({
      code: "SessionNotFound",
    });
  });

  it("clears into a new session with the same settings", async () => {
    h = await startHarness({ script: [text("one")] });
    const old = await h.engine.createSession({ cwd: h.project, mode: "plan" });
    await old.run(ask("first"));
    const fresh = await h.engine.clearSession(old.id);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.mode).toBe("plan");
    expect(fresh.view.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(old.closed).toBe(true);
  });
});
