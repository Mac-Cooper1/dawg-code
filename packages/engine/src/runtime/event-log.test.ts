import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeUnfinished, EventLog, findUnfinished } from "./event-log.ts";

let dir: string;
let file: string;
const now = () => 1_000;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-events-"));
  file = path.join(dir, "s", "events.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function lines(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("the event log", () => {
  it("numbers events from 1 and writes all but the streaming ones", async () => {
    const log = EventLog.open(file, "s1", now);
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.payload.seq));
    log.emit("turn.started", {
      turnId: "t",
      prompt: { content: [{ type: "text", text: "hi" }] },
      command: null,
    });
    log.emit("message.started", { turnId: "t", messageId: "m" });
    log.emit("message.delta", { turnId: "t", messageId: "m", text: "he" });
    log.emit("message.delta", { turnId: "t", messageId: "m", text: "llo" });
    expect(seen).toEqual([1, 2, 3, 4]);
    // Unfinished streaming events are replayed until their message finishes.
    expect(log.after(0).events.map((e) => e.payload.seq)).toEqual([1, 2, 3, 4]);
    log.emit("message.finished", {
      turnId: "t",
      messageId: "m",
      text: "hello",
      reasoning: null,
      toolCalls: [],
    });
    expect(log.after(0).events.map((e) => e.payload.seq)).toEqual([1, 2, 5]);
    expect(log.after(2).events.map((e) => e.event)).toEqual(["message.finished"]);
    log.close();
    const stored = lines(await readFile(file, "utf8"));
    expect(stored.filter((l) => "event" in l).map((l) => l.event)).toEqual([
      "turn.started",
      "message.started",
      "message.finished",
    ]);
    expect(stored.at(-1)).toEqual({ closed: 5 });
  });

  it("continues without a gap after a clean close", () => {
    const log = EventLog.open(file, "s1", now);
    log.emit("tasks.updated", { tasks: [] });
    log.emit("prompt.progress", { turnId: "t", total: 1, cached: 0, processed: 1 });
    log.close();
    const again = EventLog.open(file, "s1", now);
    expect(again.lastSeq).toBe(2);
    expect(again.emit("tasks.updated", { tasks: [] }).payload.seq).toBe(3);
    again.close();
  });

  it("never reuses a number after a crash, even for events it did not write", () => {
    const log = EventLog.open(file, "s1", now);
    log.emit("tasks.updated", { tasks: [] });
    for (let i = 0; i < 10; i++)
      log.emit("message.delta", { turnId: "t", messageId: "m", text: "x" });
    // No close: the process died. The deltas (2..11) were never written.
    const again = EventLog.open(file, "s1", now);
    expect(again.lastSeq).toBeGreaterThanOrEqual(11);
    again.close();
  });

  it("drops a line cut short by a crash before appending", async () => {
    const log = EventLog.open(file, "s1", now);
    log.emit("tasks.updated", { tasks: [] });
    await appendFile(file, '{"event":"tasks.upd');
    const again = EventLog.open(file, "s1", now);
    again.emit("tasks.updated", { tasks: [] });
    again.close();
    const stored = lines(await readFile(file, "utf8"));
    expect(stored.filter((l) => "event" in l)).toHaveLength(2);
    expect(EventLog.read(file, 0).events.map((e) => e.payload.seq)).toEqual([1, 2]);
  });

  it("closes what a crash left open", () => {
    const log = EventLog.open(file, "s1", now);
    log.emit("session.status", { status: "working", waitingOn: null, message: null });
    log.emit("turn.started", {
      turnId: "t",
      prompt: { content: [{ type: "text", text: "hi" }] },
      command: null,
    });
    log.emit("message.started", { turnId: "t", messageId: "m" });
    log.emit("message.finished", {
      turnId: "t",
      messageId: "m",
      text: "",
      reasoning: null,
      toolCalls: [{ toolCallId: "c", toolName: "Write" }],
    });
    log.emit("tool.started", {
      turnId: "t",
      messageId: "m",
      toolCallId: "c",
      toolName: "Write",
      input: {},
    });
    log.emit("permission.requested", {
      turnId: "t",
      request: {
        requestId: "r",
        toolCallId: "c",
        toolName: "Write",
        input: {},
        title: "t",
        reason: "r",
        suggestions: [],
      },
    });
    const again = EventLog.open(file, "s1", now);
    closeUnfinished(again, 2_000);
    expect(again.after(6).events.map((e) => e.event)).toEqual([
      "request.resolved",
      "tool.finished",
      "turn.finished",
      "session.status",
    ]);
    const open = findUnfinished(again.all());
    expect(open).toMatchObject({ turn: null, messages: [], tools: [], requests: [] });
    again.close();
  });
});
