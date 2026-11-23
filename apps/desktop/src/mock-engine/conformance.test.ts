import { type EngineEvent, type EventName, parseEvent } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import { Recorder } from "./record/recorder.ts";
import { hunk } from "./record/text.ts";
import { callBash, callEdit, runBash, runEdit } from "./record/tools.ts";
import type { Fields } from "./types.ts";

/** Parses recorder output the way a client receives it. */
function parsed(events: readonly { event: string; payload: unknown }[]): EngineEvent[] {
  return events.map((e) => {
    const result = parseEvent(e.event, e.payload);
    if (!result.ok) throw new Error(`bad test event ${e.event}`);
    return result.event;
  });
}

/** A conforming session: a turn with a reply, an edit, a permission, a command and a summary. */
function goodStream(): EngineEvent[] {
  const rec = new Recorder({
    sessionId: "s1",
    cwd: "/p",
    settings: {
      title: "t",
      mode: "default",
      model: null,
      effort: null,
      archived: false,
      additionalDirectories: [],
    },
    startTime: 1_000_000,
    seed: 1,
  });
  rec.startTurn("Fix it");
  let m = rec.message();
  m.think("Look first.");
  m.say("Editing.");
  const h = hunk(1, 1, ["-a", "+b"]);
  const edit = callEdit(m, rec, "a.txt", h);
  const run = callBash(m, "make test", "Run the tests");
  m.end();
  runEdit(rec, edit, h);
  rec.startTool(run);
  rec.requestPermission(run, {
    requestId: "r1",
    title: "Run a shell command",
    reason: "No rule.",
    suggestions: [],
  });
  rec.resolve({
    kind: "permission",
    requestId: "r1",
    response: { behavior: "allow", scope: "once" },
  });
  runBash(rec, run, { output: "ok\n", exitCode: 0, durationMs: 300, start: false });
  m = rec.message();
  m.say("Done.");
  m.end();
  rec.finishTurn();
  return parsed(rec.take());
}

/** Builds events by hand, numbering them from `seq`. */
function stream(seq = 1) {
  const out: EngineEvent[] = [];
  let next = seq;
  const add = <E extends EventName>(event: E, fields: Fields<E>) => {
    const result = parseEvent(event, {
      sessionId: "s1",
      seq: next++,
      time: 1_000 + next,
      ...fields,
    });
    if (!result.ok) throw new Error(`bad test event ${event}`);
    out.push(result.event);
    return add;
  };
  return { out, add };
}

const working = { status: "working" as const, waitingOn: null, message: "Working" };
const idle = { status: "idle" as const, waitingOn: null, message: null };
const prompt = { content: [{ type: "text" as const, text: "hi" }], mentions: [] };
const finished = (turnId: string) => ({
  turnId,
  stopReason: "completed" as const,
  finalText: null,
  error: null,
  durationMs: 10,
});

describe("checkConformance", () => {
  it("accepts a conforming stream", () => {
    expect(checkConformance(goodStream())).toEqual([]);
  });

  it("checks that seq starts at 1 and grows by one", () => {
    const events = goodStream();
    const shifted = events.map(
      (e) => ({ ...e, payload: { ...e.payload, seq: e.payload.seq + 4 } }) as EngineEvent,
    );
    expect(checkConformance(shifted)[0]).toMatch(/first seq is 5/);
    expect(checkConformance(shifted, { midSession: true })).toEqual([]);
    const gapped = events.filter((_, i) => i !== 5);
    expect(checkConformance(gapped)).toEqual([expect.stringMatching(/does not follow/)]);
    expect(checkConformance(gapped, { allowSeqGaps: true })).toEqual([]);
    const backwards = [...events.slice(0, 3), events[1] as EngineEvent];
    expect(checkConformance(backwards, { allowSeqGaps: true }).join()).toMatch(/does not grow/);
  });

  it("finds turns that overlap, start without working, or end without a status", () => {
    const a = stream();
    a.add("session.status", working)("turn.started", { turnId: "t1", prompt, command: null })(
      "turn.started",
      { turnId: "t2", prompt, command: null },
    );
    expect(checkConformance(a.out).join()).toMatch(/starts while turn t1 runs/);

    const b = stream();
    b.add("turn.started", { turnId: "t1", prompt, command: null });
    expect(checkConformance(b.out).join()).toMatch(/status is idle, not working/);

    const c = stream();
    c.add("session.status", working)("turn.started", { turnId: "t1", prompt, command: null })(
      "turn.finished",
      finished("t1"),
    )("usage.updated", {
      usage: {
        contextWindow: 1,
        contextUsed: 1,
        last: {
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          promptTokensPerSecond: null,
          completionTokensPerSecond: null,
        },
        totals: {
          requests: 1,
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          malformedToolCalls: 0,
        },
      },
    });
    expect(checkConformance(c.out).join()).toMatch(/followed by session.status idle or error/);

    const d = stream();
    d.add("session.status", working)("turn.started", { turnId: "t1", prompt, command: null })(
      "turn.finished",
      finished("t1"),
    )("session.status", idle)("message.started", { turnId: "t1", messageId: "m1" });
    expect(checkConformance(d.out).join()).toMatch(/already finished/);
  });

  it("finds interleaved messages and deltas without a message", () => {
    const s = stream();
    s.add("session.status", working)("turn.started", { turnId: "t1", prompt, command: null })(
      "message.started",
      { turnId: "t1", messageId: "m1" },
    )("message.started", { turnId: "t1", messageId: "m2" })("message.delta", {
      turnId: "t1",
      messageId: "m9",
      text: "x",
    });
    const violations = checkConformance(s.out).join("\n");
    expect(violations).toMatch(/m2 starts while message m1 streams/);
    expect(violations).toMatch(/delta for message m9/);
  });

  it("finds tool calls out of order, before their message, unfinished or finished twice", () => {
    const s = stream();
    s.add("session.status", working)("turn.started", { turnId: "t1", prompt, command: null })(
      "message.started",
      { turnId: "t1", messageId: "m1" },
    )("tool.started", {
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c0",
      toolName: "Read",
      input: {},
    })("message.finished", {
      turnId: "t1",
      messageId: "m1",
      text: "",
      reasoning: null,
      toolCalls: [
        { toolCallId: "c1", toolName: "Read" },
        { toolCallId: "c2", toolName: "Read" },
      ],
    })("tool.started", {
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c2",
      toolName: "Read",
      input: {},
    })("tool.finished", {
      turnId: "t1",
      toolCallId: "c2",
      toolName: "Read",
      outcome: "success",
      content: [],
      display: null,
      durationMs: 1,
    })("tool.finished", {
      turnId: "t1",
      toolCallId: "c2",
      toolName: "Read",
      outcome: "success",
      content: [],
      display: null,
      durationMs: 1,
    })("tool.started", {
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "Read",
      input: {},
    })("turn.finished", finished("t1"))("session.status", idle);
    const violations = checkConformance(s.out).join("\n");
    expect(violations).toMatch(/c0 starts while message m1 streams/);
    expect(violations).toMatch(/c2 starts out of order; c1 is next/);
    expect(violations).toMatch(/c2 finishes but is not running/);
    expect(violations).toMatch(/turn ends before tool call c1 finished/);
  });

  it("finds requests left pending, without a waiting status, or resolved twice", () => {
    const base = () => {
      const s = stream();
      s.add("session.status", working)("turn.started", { turnId: "t1", prompt, command: null })(
        "message.started",
        { turnId: "t1", messageId: "m1" },
      )("message.finished", {
        turnId: "t1",
        messageId: "m1",
        text: "",
        reasoning: null,
        toolCalls: [{ toolCallId: "c1", toolName: "AskUserQuestion" }],
      })("tool.started", {
        turnId: "t1",
        messageId: "m1",
        toolCallId: "c1",
        toolName: "AskUserQuestion",
        input: {},
      })("question.asked", {
        turnId: "t1",
        requestId: "q1",
        toolCallId: "c1",
        questions: [{ question: "Which?", options: [{ label: "A" }], multiSelect: false }],
      });
      return s;
    };
    const noWaiting = base();
    noWaiting.add("tool.finished", {
      turnId: "t1",
      toolCallId: "c1",
      toolName: "AskUserQuestion",
      outcome: "success",
      content: [],
      display: null,
      durationMs: 1,
    })("turn.finished", finished("t1"))("session.status", idle);
    const violations = checkConformance(noWaiting.out).join("\n");
    expect(violations).toMatch(/status is working, not waiting/);
    expect(violations).toMatch(/finishes while request q1 is pending/);
    expect(violations).toMatch(/turn ends before request q1 was resolved/);

    const twice = base();
    twice.add("session.status", { status: "waiting", waitingOn: "question", message: null })(
      "request.resolved",
      { kind: "question", turnId: "t1", requestId: "q1", outcome: "cancelled", response: null },
    )("request.resolved", {
      kind: "question",
      turnId: "t1",
      requestId: "q1",
      outcome: "cancelled",
      response: null,
    });
    expect(checkConformance(twice.out).join()).toMatch(/q1 is resolved but is not pending/);

    const idleWhilePending = base();
    idleWhilePending.add("session.status", idle);
    expect(checkConformance(idleWhilePending.out).join()).toMatch(/idle while 1 request/);
  });

  it("finds message events inside a compaction and unpaired compactions", () => {
    const s = stream();
    s.add("compaction.started", {
      compactionId: "k1",
      trigger: "manual",
      turnId: null,
      contextUsed: 10,
      contextWindow: 100,
      focus: null,
    })("message.started", { turnId: "t1", messageId: "m1" })("compaction.finished", {
      compactionId: "k2",
      outcome: "completed",
      summary: "s",
      contextBefore: 10,
      contextAfter: 5,
      error: null,
    });
    const violations = checkConformance(s.out).join("\n");
    expect(violations).toMatch(/message.started while compaction k1 runs/);
    expect(violations).toMatch(/k2 finishes but is not running/);
  });

  it("accepts a slice that starts mid-turn when told so", () => {
    const events = goodStream();
    const slice = events.slice(events.findIndex((e) => e.event === "reasoning.delta") + 1);
    expect(checkConformance(slice)).not.toEqual([]);
    expect(checkConformance(slice, { midSession: true })).toEqual([]);
  });

  it("reports what is left open only with requireClosed", () => {
    const events = goodStream();
    const cut = events.slice(0, events.findIndex((e) => e.event === "permission.requested") + 2);
    expect(checkConformance(cut)).toEqual([]);
    const open = checkConformance(cut, { requireClosed: true }).join("\n");
    expect(open).toMatch(/never finished/);
    expect(open).toMatch(/r1 never resolved/);
  });
});
