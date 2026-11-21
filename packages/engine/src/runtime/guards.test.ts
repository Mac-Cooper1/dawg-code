import {
  contextOverflow,
  dropped,
  empty,
  malformedToolCall,
  text,
  toolCall,
  toolCalls,
} from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { fakeCompactor } from "./__fixtures__/fakes.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function notes(view: readonly Message[]): string[] {
  return view.filter((m) => m.role === "user" && m.kind === "note").map(textOf);
}

function requestNotes(h: Harness, index: number): string[] {
  return (h.mock.messages(index) as { role: string; content: unknown }[])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

describe("malformed calls", () => {
  it("runs a repaired call, refuses invalid, unknown and truncated ones, and keeps history valid", async () => {
    h = await startHarness({
      files: { "a.txt": "alpha\n" },
      script: [
        malformedToolCall("Read", '{"file_path": "a.txt",}'),
        toolCalls([
          { name: "Read", arguments: {} },
          { name: "ReadFile", arguments: { file_path: "a.txt" } },
        ]),
        {
          toolCalls: [{ name: "Write", arguments: '{"file_path": "b.txt", "content": "abc' }],
          finishReason: "length",
        },
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    const outcome = await session.run(ask("go"));
    expect(outcome.stopReason).toBe("completed");

    const finished = h.ofType(session.id, "tool.finished").map((e) => e.payload);
    expect(finished.map((p) => [p.toolName, p.outcome])).toEqual([
      ["Read", "success"],
      ["Read", "invalid"],
      ["ReadFile", "invalid"],
      ["Write", "invalid"],
    ]);
    expect(JSON.stringify(finished[2]?.content)).toContain("no tool named");
    expect(JSON.stringify(finished[3]?.content)).toContain("output length limit");

    const assistant = session.view.filter((m) => m.role === "assistant");
    const repaired = assistant[0]?.role === "assistant" ? assistant[0].toolCalls[0] : undefined;
    expect(repaired?.arguments).toBe('{"file_path":"a.txt"}');
    expect(repaired?.rawArguments).toBe('{"file_path": "a.txt",}');
    // Every stored call's arguments parse: the server would reject the history otherwise.
    for (const m of assistant) {
      if (m.role === "assistant")
        for (const c of m.toolCalls) expect(() => JSON.parse(c.arguments)).not.toThrow();
    }
    expect(notes(session.view).some((n) => n.includes("output_truncated"))).toBe(true);
    expect(historyProblems(session.view)).toEqual([]);
    expect(session.snapshot().usage?.totals.malformedToolCalls).toBe(4);
    // Error results say they are errors in their own words.
    for (const m of session.view) {
      if (m.role === "tool" && m.isError) expect(textOf(m)).toMatch(/^(Error|Denied|Interrupted)/);
    }
  });
});

describe("empty replies", () => {
  it("retries an empty reply once", async () => {
    h = await startHarness({ script: [empty(), text("hello")] });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("hi"));
    expect(outcome).toMatchObject({ stopReason: "completed", finalText: "hello" });
    expect(h.mock.chatRequests).toHaveLength(2);
    // The retry is the same request again.
    expect(h.mock.chatRequests[1]?.rawBody).toBe(h.mock.chatRequests[0]?.rawBody);
  });

  it("stops with an error after two empty replies", async () => {
    h = await startHarness({ script: [empty(), empty()] });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("hi"));
    expect(outcome.stopReason).toBe("error");
    expect(outcome.error?.kind).toBe("invalid_model_output");
    expect(session.status).toBe("error");
    expect(session.view.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("dropped streams", () => {
  it("sends the request again once when the stream breaks", async () => {
    h = await startHarness({
      script: [dropped(text("partial reply that breaks"), 2), text("whole")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("hi"));
    expect(outcome).toMatchObject({ stopReason: "completed", finalText: "whole" });
    const finished = h.ofType(session.id, "message.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload.text).toBe("whole");
    expect(session.view.filter((m) => m.role === "assistant").map(textOf)).toEqual(["whole"]);
  });

  it("gives up after the retry also breaks", async () => {
    h = await startHarness({ script: [dropped(), dropped()] });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("hi"));
    expect(outcome.stopReason).toBe("error");
    expect(outcome.error).toMatchObject({ kind: "model_unavailable", retryable: true });
    // A message that started is finished before the turn ends.
    const names = h.names(session.id);
    expect(names.indexOf("message.finished")).toBeLessThan(names.indexOf("turn.finished"));
  });
});

describe("context", () => {
  it("compacts and retries once when the model reports an overflow", async () => {
    const compactor = fakeCompactor();
    h = await startHarness({
      engine: { compactor },
      script: [text("first"), contextOverflow(9000, 8192), text("after compaction")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("one"));
    const outcome = await session.run(ask("two"));
    expect(outcome).toMatchObject({ stopReason: "completed", finalText: "after compaction" });
    expect(compactor.calls).toHaveLength(1);
    const names = h.names(session.id);
    const start = names.indexOf("compaction.started");
    expect(start).toBeGreaterThan(-1);
    expect(names[start + 1]).toBe("compaction.finished");
    expect(h.ofType(session.id, "compaction.finished")[0]?.payload).toMatchObject({
      outcome: "completed",
      summary: expect.stringContaining("Summary"),
    });
    // The retried request holds the compacted view: session context, summary, new prompt.
    const retried = h.mock.messages(2) as { role: string; content: unknown }[];
    expect(JSON.stringify(retried)).toContain("<summary>");
    expect(JSON.stringify(retried)).not.toContain('"first"');
    const stored = await h.engine.store.read(session.cwd, session.id);
    expect(stored.records.some((r) => r.type === "compact")).toBe(true);
  });

  it("compacts before a request once the context passes the profile's threshold", async () => {
    const compactor = fakeCompactor();
    h = await startHarness({
      engine: { compactor },
      mock: { contextWindow: 16_000 },
      files: { "big.txt": `${"x".repeat(80)}\n`.repeat(750) },
      script: [toolCall("Read", { file_path: "big.txt" }), text("read it")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("read big.txt"));
    expect(outcome.stopReason).toBe("completed");
    expect(compactor.calls).toHaveLength(1);
    expect(h.ofType(session.id, "compaction.started")[0]?.payload).toMatchObject({
      trigger: "auto",
      turnId: outcome.turnId,
    });
  });

  it("tells the model to send less when a reply is cut off by the output limit", async () => {
    h = await startHarness({
      script: [
        { text: "", finishReason: "length" },
        { text: "a long answer th", finishReason: "length" },
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("hi"));
    expect(outcome).toMatchObject({ stopReason: "completed", finalText: "done" });
    expect(h.mock.chatRequests).toHaveLength(3);
    // The empty cut-off reply is not "empty": it is answered with a note, not a blind retry.
    expect(requestNotes(h, 1).some((n) => n.includes("output_truncated"))).toBe(true);
    expect(requestNotes(h, 2).filter((n) => n.includes("output_truncated"))).toHaveLength(2);
    expect(historyProblems(session.view)).toEqual([]);
  });
});

describe("repetition", () => {
  it("adds a note at three identical calls and stops at five", async () => {
    const same = () => toolCall("Glob", { pattern: "*.txt" });
    h = await startHarness({
      files: { "a.txt": "a" },
      script: [same(), same(), same(), same(), same()],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("find text files"));
    expect(outcome.stopReason).toBe("error");
    expect(outcome.error?.kind).toBe("repetition");
    expect(requestNotes(h, 2).some((n) => n.includes("repeating"))).toBe(false);
    expect(requestNotes(h, 3).some((n) => n.includes('"times":3'))).toBe(true);
    expect(requestNotes(h, 4).some((n) => n.includes('"times":4'))).toBe(true);
    expect(historyProblems(session.view)).toEqual([]);
    h.mock.assertDone();
  });

  it("stops at the turn limit", async () => {
    h = await startHarness({
      engine: { limits: { maxRequestsPerTurn: 2 } },
      files: { "a.txt": "a" },
      script: [toolCall("Glob", { pattern: "a*" }), toolCall("Glob", { pattern: "b*" })],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const outcome = await session.run(ask("go"));
    expect(outcome.stopReason).toBe("turn_limit");
    expect(historyProblems(session.view)).toEqual([]);
  });
});
