/** Playback: timing, times and paths, prompts, interrupts and the model queue. */
import { type EngineEvent, ErrorCodes, type EventName, parseEvent } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import type { LoadedScenario, Scenario } from "./format.ts";
import { INTERRUPTED_WAITING } from "./results.ts";
import {
  all,
  builtIn,
  first,
  type Harness,
  HOME,
  harness,
  names,
  type Peer,
} from "./test-support.ts";
import type { Fields } from "./types.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

const prompt = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Events of a hand-made recording, with explicit times. */
function recording(sessionId: string) {
  const out: EngineEvent[] = [];
  let seq = 0;
  const at = <E extends EventName>(time: number, event: E, fields: Fields<E>) => {
    seq += 1;
    const result = parseEvent(event, { sessionId, seq, time, ...fields });
    if (!result.ok) throw new Error(`bad test event ${event}`);
    out.push(result.event);
  };
  return { out, at, take: () => out.splice(0) };
}

/** A scenario: one turn whose reply streams live with gaps of 100, 100 and 5,000 ms. */
function timingScenario(): LoadedScenario {
  const r = recording("timing");
  r.at(1_000, "session.status", { status: "working", waitingOn: null, message: "Working" });
  r.at(1_000, "turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text: "go" }], mentions: [] },
    command: null,
  });
  r.at(1_400, "message.started", { turnId: "t1", messageId: "m1" });
  const stored = r.take();
  r.at(1_500, "message.delta", { turnId: "t1", messageId: "m1", text: "one " });
  r.at(1_600, "message.delta", { turnId: "t1", messageId: "m1", text: "two " });
  r.at(6_600, "message.delta", { turnId: "t1", messageId: "m1", text: "three" });
  r.at(6_610, "message.finished", {
    turnId: "t1",
    messageId: "m1",
    text: "one two three",
    reasoning: null,
    toolCalls: [],
  });
  r.at(6_640, "turn.finished", {
    turnId: "t1",
    stopReason: "completed",
    finalText: "one two three",
    error: null,
    durationMs: 5_640,
  });
  r.at(6_640, "session.status", { status: "idle", waitingOn: null, message: null });
  const live = r.take();
  const scenario: Scenario = {
    id: "timing",
    session: {
      title: "Timing",
      cwd: "~/t",
      projectDir: "~/t",
      mode: "default",
      model: "qwen3.8-27b-q8",
      effort: null,
    },
    storedEndedAgoMs: 10_000,
    stored: "stored.jsonl",
    live: "live.jsonl",
    queuedBehind: null,
    branches: {},
    turns: [],
  };
  return { scenario, recordings: { "stored.jsonl": stored, "live.jsonl": live } };
}

async function deltas(peer: Peer, h: Harness, ms: number): Promise<number> {
  await h.advance(ms);
  return all(peer.of("timing"), "message.delta").length;
}

describe("timing", () => {
  it("plays live events with their recorded gaps, long ones capped at 3 s", async () => {
    h = harness({ scenarios: [timingScenario()] });
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "timing" });
    expect(await deltas(peer, h, 99)).toBe(0);
    expect(await deltas(peer, h, 1)).toBe(1);
    expect(await deltas(peer, h, 99)).toBe(1);
    expect(await deltas(peer, h, 1)).toBe(2);
    expect(await deltas(peer, h, 2_999)).toBe(2);
    expect(await deltas(peer, h, 1)).toBe(3);
    await h.advance(40);
    expect(names(peer.of("timing")).slice(-3)).toEqual([
      "message.finished",
      "turn.finished",
      "session.status",
    ]);
    const times = peer.of("timing").map((e) => e.payload.time - h.clock.now());
    expect(times).toEqual([-3_140, -3_040, -40, -30, 0, 0]);
  });

  it("scales gaps by the speed", async () => {
    h = harness({ scenarios: [timingScenario()], speed: 2 });
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "timing" });
    expect(await deltas(peer, h, 49)).toBe(0);
    expect(await deltas(peer, h, 1)).toBe(1);
    expect(await deltas(peer, h, 50)).toBe(2);
    expect(await deltas(peer, h, 1_499)).toBe(2);
    expect(await deltas(peer, h, 1)).toBe(3);
  });

  it("plays everything at once at speed Infinity, but never inside a request", async () => {
    h = harness({ speed: Number.POSITIVE_INFINITY });
    const peer = await h.connect();
    const before = await peer.request("session.resume", { sessionId: "fix-split" });
    expect(before.activeTurnId).toBeNull();
    expect(h.clock.pending).toBeGreaterThan(0);
    await h.advance(0);
    expect(names(peer.of("fix-split")).at(-2)).toBe("turn.finished");
    const recorded = first(builtIn("fix-split").recordings["live.jsonl"] ?? [], "turn.finished");
    expect(first(peer.of("fix-split"), "turn.finished").payload.durationMs).toBe(
      recorded.payload.durationMs,
    );
    const docs = await peer.request("session.resume", { sessionId: "docs-search" });
    expect(docs.session.status).toBe("idle");
    const turn = await peer.request("session.prompt", {
      sessionId: "fix-split",
      prompt: prompt("next"),
    });
    const replay = await peer.request("session.replay", { sessionId: "fix-split", afterSeq: 0 });
    expect(replay.events.at(-1)?.event).toBe("turn.started");
    expect(first(replay.events.slice(-1), "turn.started").payload.turnId).toBe(turn.turnId);
    await h.advance(0);
    expect(names(peer.of("fix-split")).at(-1)).toBe("session.status");
  });
});

describe("times and paths", () => {
  it("rebases stored events to end before engine start, keeping their spacing", async () => {
    h = harness();
    const peer = await h.connect();
    const replay = await peer.request("session.replay", { sessionId: "flaky-csv", afterSeq: 0 });
    const recorded = builtIn("flaky-csv").recordings["stored.jsonl"] ?? [];
    expect(replay.events.at(-1)?.payload.time).toBe(h.clock.now() - 3 * 60_000);
    const gaps = (events: readonly EngineEvent[]) =>
      events.slice(1).map((e, i) => e.payload.time - (events[i]?.payload.time ?? 0));
    expect(gaps(replay.events)).toEqual(gaps(recorded));
    const snapshot = await peer.request("session.resume", { sessionId: "flaky-csv" });
    expect(snapshot.session.createdAt).toBe(replay.events[0]?.payload.time);
    expect(snapshot.session.lastActivityAt).toBe(replay.events.at(-1)?.payload.time);
  });

  it("stamps live events with the clock's time and the session's own seq", async () => {
    h = harness();
    const peer = await h.connect();
    const snapshot = await peer.request("session.resume", { sessionId: "fix-split" });
    await h.advance(2_000);
    const live = peer.of("fix-split");
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]?.payload.seq).toBe(snapshot.session.lastSeq + 1);
    expect(live[0]?.payload.time).toBeGreaterThan(snapshot.session.lastActivityAt);
    expect(live.every((e) => e.payload.time <= h.clock.now())).toBe(true);
  });

  it("expands ~/ in settings, tool input, output and displays", async () => {
    h = harness();
    const peer = await h.connect();
    const replay = await peer.request("session.replay", { sessionId: "fix-split", afterSeq: 0 });
    const read = all(replay.events, "tool.started").find((e) => e.payload.toolName === "Read");
    expect(read?.payload.input.file_path).toBe(
      `${HOME}/code/tally/.dawg/worktrees/split-cents/src/tally/money.py`,
    );
    const grep = all(replay.events, "tool.finished").find((e) => e.payload.toolName === "Grep");
    const text = grep?.payload.content[0]?.type === "text" ? grep.payload.content[0].text : "";
    expect(text.split("\n").every((line) => line.startsWith(`${HOME}/code/tally/`))).toBe(true);
    const bash = all(replay.events, "tool.finished").find(
      (e) => e.payload.display?.kind === "command",
    );
    expect(bash?.payload.display).toMatchObject({
      cwd: `${HOME}/code/tally/.dawg/worktrees/split-cents`,
    });
    expect(JSON.stringify(replay.events)).not.toContain("~/");
  });
});

describe("prompts", () => {
  it("plays the next recorded turn with the prompt actually sent, then generic replies", async () => {
    h = harness({ speed: Number.POSITIVE_INFINITY, startPlayback: "created" });
    await h.runAll();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "fix-split" });
    const sent = {
      content: [{ type: "text" as const, text: "Also update the README, please." }],
      mentions: [{ path: "README.md" }],
    };
    const { turnId } = await peer.request("session.prompt", {
      sessionId: "fix-split",
      prompt: sent,
    });
    await h.runAll();
    const turn3 = peer.of("fix-split");
    expect(first(turn3, "turn.started").payload).toMatchObject({
      turnId,
      prompt: sent,
      command: null,
    });
    expect(all(turn3, "tool.started").map((e) => e.payload.toolName)).toEqual(["Read", "Edit"]);
    expect(first(turn3, "prompt.progress").payload).toMatchObject({
      total: 24_410,
      cached: 14_080,
    });
    expect(first(turn3, "turn.finished").payload).toMatchObject({
      turnId,
      stopReason: "completed",
    });

    const generic = await peer.request("session.prompt", {
      sessionId: "fix-split",
      prompt: prompt("And the changelog?"),
    });
    await h.runAll();
    const events = peer
      .of("fix-split")
      .filter((e) => "turnId" in e.payload && e.payload.turnId === generic.turnId);
    const message = first(events, "message.finished").payload.text;
    expect(message).toContain("**mock engine**");
    expect(message).toContain("- Your message: “And the changelog?”");
    expect(message).toMatch(/`[^`]+`/);
    expect(message).toBe(
      all(events, "message.delta")
        .map((e) => e.payload.text)
        .join(""),
    );
    expect(first(events, "turn.finished").payload).toMatchObject({
      stopReason: "completed",
      finalText: message,
    });
    const again = await peer.request("session.prompt", {
      sessionId: "fix-split",
      prompt: prompt("Once more"),
    });
    await h.runAll();
    expect(again.turnId).not.toBe(generic.turnId);
    const whole = await peer.request("session.replay", { sessionId: "fix-split", afterSeq: 0 });
    expect(checkConformance(whole.events)).toEqual([]);
    expect(whole.events.at(-1)?.payload).toMatchObject({ status: "idle" });
    const usage = all(whole.events, "usage.updated").map((e) => e.payload.usage.totals.requests);
    expect(usage).toEqual(usage.map((_, i) => i + 1));
  });

  it("titles a new session from its first prompt once the turn ends", async () => {
    h = harness();
    const peer = await h.connect();
    const { session } = await peer.request("session.create", { cwd: "/work/app" });
    await peer.request("session.prompt", {
      sessionId: session.id,
      prompt: prompt("fix the login redirect loop. it breaks on safari"),
    });
    await h.advance(60_000);
    const events = peer.of(session.id);
    expect(names(events).slice(-3)).toEqual(["turn.finished", "session.status", "session.updated"]);
    expect(events.at(-1)?.payload).toMatchObject({
      title: "Fix the login redirect loop",
      changed: ["title"],
    });
    await peer.request("session.prompt", { sessionId: session.id, prompt: prompt("thanks") });
    await h.advance(60_000);
    expect(all(peer.of(session.id), "session.updated")).toHaveLength(1);
    expect(checkConformance(peer.of(session.id))).toEqual([]);
  });

  it("is refused while a turn runs or waits on a decision", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "fix-split" });
    await peer.request("session.resume", { sessionId: "tip-support" });
    await h.advance(3_000);
    for (const sessionId of ["fix-split", "tip-support"]) {
      const error = await peer.failure("session.prompt", { sessionId, prompt: prompt("hi") });
      expect(error.code).toBe(ErrorCodes.SessionBusy);
    }
  });

  it("renames ids when a recording plays twice", async () => {
    const r = recording("twice");
    r.at(0, "session.status", { status: "working", waitingOn: null, message: "Working" });
    r.at(0, "turn.started", {
      turnId: "turn-x",
      prompt: { content: [{ type: "text", text: "x" }], mentions: [] },
      command: null,
    });
    r.at(10, "message.started", { turnId: "turn-x", messageId: "m-x" });
    r.at(20, "message.finished", {
      turnId: "turn-x",
      messageId: "m-x",
      text: "",
      reasoning: null,
      toolCalls: [{ toolCallId: "c-x", toolName: "Glob" }],
    });
    r.at(30, "tool.started", {
      turnId: "turn-x",
      messageId: "m-x",
      toolCallId: "c-x",
      toolName: "Glob",
      input: { pattern: "*" },
    });
    r.at(40, "tool.finished", {
      turnId: "turn-x",
      toolCallId: "c-x",
      toolName: "Glob",
      outcome: "success",
      content: [],
      display: null,
      durationMs: 10,
    });
    r.at(50, "turn.finished", {
      turnId: "turn-x",
      stopReason: "completed",
      finalText: null,
      error: null,
      durationMs: 50,
    });
    r.at(50, "session.status", { status: "idle", waitingOn: null, message: null });
    const scenario: Scenario = {
      id: "twice",
      session: {
        title: "Twice",
        cwd: "/t",
        projectDir: "/t",
        mode: "default",
        model: null,
        effort: null,
      },
      storedEndedAgoMs: 0,
      stored: null,
      live: null,
      queuedBehind: null,
      branches: {},
      turns: ["t.jsonl", "t.jsonl"],
    };
    h = harness({ scenarios: [{ scenario, recordings: { "t.jsonl": r.take() } }] });
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "twice" });
    const one = await peer.request("session.prompt", { sessionId: "twice", prompt: prompt("a") });
    await h.advance(100);
    const two = await peer.request("session.prompt", { sessionId: "twice", prompt: prompt("b") });
    await h.advance(100);
    expect(one.turnId).toBe("turn-x");
    expect(two.turnId).toBe("turn-x~2");
    const tools = all(peer.of("twice"), "tool.started").map((e) => [
      e.payload.toolCallId,
      e.payload.messageId,
    ]);
    expect(tools).toEqual([
      ["c-x", "m-x"],
      ["c-x~2", "m-x~2"],
    ]);
    expect(checkConformance(peer.of("twice"))).toEqual([]);
  });
});

/** Advances in steps of `step` ms until `done` holds for the session's events. */
async function until(
  h: Harness,
  peer: Peer,
  sessionId: string,
  done: (events: EngineEvent[]) => boolean,
  step = 25,
) {
  for (let i = 0; i < 2_000; i++) {
    if (done(peer.of(sessionId))) return;
    await h.advance(step);
  }
  throw new Error("never happened");
}

describe("interrupt", () => {
  it("in the middle of streaming text: the message finishes with what it has", async () => {
    h = harness();
    const peer = await h.connect();
    const { session } = await peer.request("session.create", { cwd: "/work" });
    await peer.request("session.prompt", {
      sessionId: session.id,
      prompt: prompt("Tell me a story"),
    });
    await until(h, peer, session.id, (events) => all(events, "message.delta").length >= 3);
    const before = peer.of(session.id).length;
    const streamed = all(peer.of(session.id), "message.delta")
      .map((e) => e.payload.text)
      .join("");
    expect(await peer.request("session.interrupt", { sessionId: session.id })).toEqual({
      interrupted: true,
    });
    await h.advance(5_000);
    const after = peer.of(session.id).slice(before);
    // The title made from the first prompt follows the end of the turn, as in the real engine.
    expect(names(after)).toEqual([
      "message.finished",
      "turn.finished",
      "session.status",
      "session.updated",
    ]);
    expect(first(after, "message.finished").payload).toMatchObject({
      text: streamed,
      toolCalls: [],
    });
    expect(first(after, "turn.finished").payload).toMatchObject({
      stopReason: "interrupted",
      finalText: streamed,
    });
    expect(after[2]?.payload).toMatchObject({ status: "idle", waitingOn: null });
    expect(checkConformance(peer.of(session.id))).toEqual([]);
    expect(await peer.request("session.interrupt", { sessionId: session.id })).toEqual({
      interrupted: false,
    });
  });

  it("while a tool runs: the call finishes interrupted with its output so far", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "flaky-csv" });
    await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: "request-flaky-csv-uv-add",
      response: { behavior: "allow", scope: "once" },
    });
    await until(h, peer, "flaky-csv", (events) =>
      all(events, "tool.progress").some((e) => e.payload.progress.kind === "status"),
    );
    const before = peer.of("flaky-csv").length;
    await peer.request("session.interrupt", { sessionId: "flaky-csv" });
    await h.advance(30_000);
    const after = peer.of("flaky-csv").slice(before);
    expect(names(after)).toEqual(["tool.finished", "turn.finished", "session.status"]);
    const finished = first(after, "tool.finished").payload;
    expect(finished).toMatchObject({
      toolName: "Bash",
      outcome: "interrupted",
      display: {
        kind: "command",
        command: "uv run pytest tests/test_csv_import.py --count 50 -q",
        exitCode: null,
        interrupted: true,
        cwd: `${HOME}/code/tally`,
      },
    });
    const text = finished.content[0]?.type === "text" ? finished.content[0].text : "";
    expect(text).toMatch(/^Error: \.+/);
    expect(text.endsWith("The command was interrupted.")).toBe(true);
    expect(first(after, "turn.finished").payload.stopReason).toBe("interrupted");
    expect(checkConformance(peer.of("flaky-csv"), { midSession: true })).toEqual([]);
  });

  it("while a permission is pending: cancelled, then the call, the turn and the status", async () => {
    h = harness();
    const peer = await h.connect();
    const snapshot = await peer.request("session.resume", { sessionId: "flaky-csv" });
    await peer.request("session.interrupt", { sessionId: "flaky-csv" });
    await h.advance(10_000);
    const after = peer.of("flaky-csv");
    expect(names(after)).toEqual([
      "request.resolved",
      "tool.finished",
      "turn.finished",
      "session.status",
    ]);
    expect(after[0]?.payload).toMatchObject({
      kind: "permission",
      requestId: "request-flaky-csv-uv-add",
      outcome: "cancelled",
      response: null,
      turnId: snapshot.activeTurnId,
    });
    expect(after[1]?.payload).toMatchObject({
      outcome: "interrupted",
      content: [{ type: "text", text: INTERRUPTED_WAITING }],
      durationMs: null,
    });
    const error = await peer.failure("permission.respond", {
      sessionId: "flaky-csv",
      requestId: "request-flaky-csv-uv-add",
      response: { behavior: "allow", scope: "once" },
    });
    expect(error.code).toBe(ErrorCodes.RequestNotFound);
    const whole = await peer.request("session.replay", { sessionId: "flaky-csv", afterSeq: 0 });
    expect(checkConformance(whole.events, { requireClosed: true })).toEqual([]);
  });

  it("stops a compaction", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "export-md" });
    await peer.request("session.command", { sessionId: "export-md", name: "compact" });
    await peer.request("session.interrupt", { sessionId: "export-md" });
    await h.advance(5_000);
    const events = peer.of("export-md");
    expect(names(events)).toEqual([
      "session.status",
      "compaction.started",
      "compaction.finished",
      "session.status",
    ]);
    expect(events[2]?.payload).toMatchObject({
      outcome: "interrupted",
      contextAfter: null,
      summary: null,
    });
  });
});

describe("queuedBehind", () => {
  it("waits, reported as working and queued, until the other session's turn ends", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "fix-split" });
    const docs = await peer.request("session.resume", { sessionId: "docs-search" });
    expect(docs.session.status).toBe("working");
    expect(docs.activeTurnId).not.toBeNull();
    const stored = await peer.request("session.replay", { sessionId: "docs-search", afterSeq: 0 });
    expect(stored.events.map((e) => e.event)).toEqual(["session.status", "turn.started"]);
    expect(stored.events[0]?.payload).toMatchObject({
      status: "working",
      message: "Queued: waits for the model",
    });
    await until(h, peer, "fix-split", (events) => names(events).includes("turn.finished"), 100);
    expect(peer.of("docs-search")).toEqual([]);
    const ended = first(peer.of("fix-split"), "turn.finished").payload.time;
    await h.advance(1_000);
    const started = peer.of("docs-search")[0];
    expect(started?.payload).toMatchObject({ status: "working", message: "Working" });
    expect((started?.payload.time ?? 0) - ended).toBe(500);
    await h.advance(200_000);
    const finished = first(peer.of("docs-search"), "turn.finished").payload;
    expect(finished.stopReason).toBe("completed");
    expect(finished.durationMs).toBeGreaterThan(60_000 + 70_000);
    const whole = await peer.request("session.replay", { sessionId: "docs-search", afterSeq: 0 });
    expect(checkConformance(whole.events, { requireClosed: true })).toEqual([]);
  });

  it("starts when the other session's turn is interrupted", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "fix-split" });
    await peer.request("session.resume", { sessionId: "docs-search" });
    await h.advance(10_000);
    expect(peer.of("docs-search")).toEqual([]);
    await peer.request("session.interrupt", { sessionId: "fix-split" });
    await h.advance(600);
    expect(peer.of("docs-search")[0]?.payload).toMatchObject({
      status: "working",
      message: "Working",
    });
  });

  it("never starts once interrupted itself", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "docs-search" });
    await peer.request("session.interrupt", { sessionId: "docs-search" });
    await h.advance(200_000);
    expect(names(peer.of("docs-search"))).toEqual(["turn.finished", "session.status"]);
    expect(first(peer.of("docs-search"), "turn.finished").payload.durationMs).toBe(60_000);
  });
});

describe("receipt-pdf", () => {
  it("finishes its stored turn within about 3 s", async () => {
    h = harness();
    const peer = await h.connect();
    const snapshot = await peer.request("session.resume", { sessionId: "receipt-pdf" });
    expect(snapshot.session.status).toBe("working");
    await h.advance(3_000);
    expect(names(peer.of("receipt-pdf")).slice(-2)).toEqual(["turn.finished", "session.status"]);
    const replay = await peer.request("session.replay", { sessionId: "receipt-pdf", afterSeq: 0 });
    expect(checkConformance(replay.events, { requireClosed: true })).toEqual([]);
  });
});
