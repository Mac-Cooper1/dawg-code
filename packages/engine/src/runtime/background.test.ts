import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { text, toolCall, toolCalls } from "@dawg/mock-model";
import type { BackgroundTask } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import { closeUnfinished, EventLog } from "./event-log.ts";
import type { SessionRuntime } from "./session.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function updates(harness: Harness, sessionId: string): BackgroundTask[] {
  return harness
    .ofType(sessionId, "background.updated")
    .map((e) => e.payload.task as BackgroundTask);
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Reads a task's whole output page by page. */
async function readAll(session: SessionRuntime, taskId: string, limit: number) {
  const texts: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await session.readBackgroundOutput(taskId, offset, limit);
    texts.push(page.text);
    if (page.done || page.nextOffset === offset) return { texts, last: page };
    offset = page.nextOffset;
  }
}

describe("background commands as protocol events", () => {
  it("reports start and end, serves output and stops, and survives a resume", async () => {
    h = await startHarness({
      script: [
        toolCalls([
          {
            id: "bg-server",
            name: "Bash",
            arguments: {
              command: "echo listening; sleep 30",
              description: "Start the server",
              run_in_background: true,
            },
          },
          {
            id: "bg-quick",
            name: "Bash",
            arguments: { command: "printf 'héllo\\n'", run_in_background: true },
          },
        ]),
        text("started both"),
        toolCall("Bash", { command: "sleep 30", run_in_background: true }),
        text("started another"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("start them"));
    await until(
      () =>
        updates(h as Harness, session.id).some(
          (t) => t.taskId === "bash-2" && t.status !== "running",
        ),
      "the quick command to end",
    );

    const seen = updates(h, session.id);
    expect(seen.slice(0, 2)).toEqual([
      expect.objectContaining({
        taskId: "bash-1",
        command: "echo listening; sleep 30",
        description: "Start the server",
        cwd: h.project,
        status: "running",
        exitCode: null,
        endedAt: null,
      }),
      expect.objectContaining({ taskId: "bash-2", status: "running", description: null }),
    ]);
    expect(seen.at(-1)).toMatchObject({ taskId: "bash-2", status: "completed", exitCode: 0 });
    // The start goes out before the call that started it finishes.
    const names = h.names(session.id);
    expect(names.indexOf("background.updated")).toBeLessThan(names.indexOf("tool.finished"));
    expect(session.snapshot().background).toEqual([
      expect.objectContaining({ taskId: "bash-1", status: "running" }),
      expect.objectContaining({ taskId: "bash-2", status: "completed" }),
    ]);

    // Output in pages: "é" is two bytes, so a two-byte page holds only "h".
    const first = await session.readBackgroundOutput("bash-2", 0, 2);
    expect(first).toEqual({ text: "h", nextOffset: 1, totalBytes: 7, done: false });
    const rest = await readAll(session, "bash-2", 2);
    expect(rest.texts.join("")).toBe("héllo\n");
    expect(rest.last).toMatchObject({ nextOffset: 7, totalBytes: 7, done: true });

    await until(
      async () => (await session.readBackgroundOutput("bash-1", 0, 1024)).text === "listening\n",
      "the server's output",
    );
    expect(await session.readBackgroundOutput("bash-1", 0, 1024)).toMatchObject({ done: false });

    // Stopping: a running task stops, an ended one is left alone, an unknown one is refused.
    expect(await session.stopBackground("bash-1")).toBe(true);
    expect(updates(h, session.id).at(-1)).toMatchObject({
      taskId: "bash-1",
      status: "stopped",
      stopReason: "requested",
    });
    expect(await session.readBackgroundOutput("bash-1", 0, 1024)).toMatchObject({
      text: "listening\n",
      done: true,
    });
    expect(await session.stopBackground("bash-1")).toBe(false);
    expect(await session.stopBackground("bash-2")).toBe(false);
    await expect(session.stopBackground("bash-9")).rejects.toMatchObject({ code: "InvalidParams" });
    await expect(session.readBackgroundOutput("bash-9", 0, 10)).rejects.toMatchObject({
      code: "InvalidParams",
    });
    await session.close();

    // A resumed session lists the earlier tasks, serves their output, and uses new ids.
    const resumed = await h.newEngine().resumeSession(session.id);
    expect(resumed.snapshot().background).toEqual([
      expect.objectContaining({ taskId: "bash-1", status: "stopped", stopReason: "requested" }),
      expect.objectContaining({ taskId: "bash-2", status: "completed" }),
    ]);
    expect(await resumed.readBackgroundOutput("bash-2", 0, 1024)).toEqual({
      text: "héllo\n",
      nextOffset: 7,
      totalBytes: 7,
      done: true,
    });
    expect(await resumed.stopBackground("bash-1")).toBe(false);
    await resumed.run(ask("one more"));
    expect(resumed.snapshot().background.map((t) => [t.taskId, t.status])).toEqual([
      ["bash-1", "stopped"],
      ["bash-2", "completed"],
      ["bash-3", "running"],
    ]);
    await resumed.close();
    expect(updates(h, session.id).at(-1)).toMatchObject({
      taskId: "bash-3",
      status: "stopped",
      stopReason: "session_end",
    });

    // A replay rebuilds the same list.
    const replayed = (await h.engine.replay(session.id, 0)).events
      .filter((e) => e.event === "background.updated")
      .map((e) => e.payload.task as BackgroundTask);
    const latest = new Map(replayed.map((t) => [t.taskId, t.status]));
    expect([...latest]).toEqual([
      ["bash-1", "stopped"],
      ["bash-2", "completed"],
      ["bash-3", "stopped"],
    ]);
  });
});

describe("after a crash", () => {
  it("reports a task left running as stopped with the session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dawg-bg-log-"));
    try {
      const file = path.join(dir, "events.jsonl");
      const task: BackgroundTask = {
        taskId: "bash-1",
        command: "npm run dev",
        description: null,
        cwd: dir,
        status: "running",
        exitCode: null,
        signal: null,
        stopReason: null,
        startedAt: 1000,
        endedAt: null,
        outputBytes: 0,
      };
      const ended: BackgroundTask = { ...task, taskId: "bash-2", status: "completed", exitCode: 0 };
      const log = EventLog.open(file, "s1", () => 5000);
      log.emit("background.updated", { task });
      log.emit("background.updated", { task: { ...ended, status: "running", exitCode: null } });
      log.emit("background.updated", { task: ended });
      // No clean close: the process died here.

      const reopened = EventLog.open(file, "s1", () => 9000);
      closeUnfinished(reopened, 9000);
      const closers = reopened.after(3).events;
      expect(closers.map((e) => [e.event, e.payload.task])).toEqual([
        [
          "background.updated",
          { ...task, status: "stopped", stopReason: "session_end", endedAt: 9000 },
        ],
      ]);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
