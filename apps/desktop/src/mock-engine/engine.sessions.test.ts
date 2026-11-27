/** Sessions: listing, opening, forking, settings, commands, replay and connections. */
import {
  createClient,
  createMemoryTransportPair,
  ErrorCodes,
  EVENT_NAMES,
  METHOD_NAMES,
} from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { findMockModel, MOCK_DEFAULT_MODEL_ID } from "../shared/mock-models.ts";
import { checkConformance } from "./conformance.ts";
import { all, first, flush, type Harness, HOME, harness, names } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

const prompt = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("initialize", () => {
  it("reports the engine and everything it implements", async () => {
    h = harness();
    const [clientEnd, engineEnd] = createMemoryTransportPair();
    h.engine.connect(engineEnd);
    const client = createClient(clientEnd);
    await expect(client.request("session.list", {})).rejects.toMatchObject({
      code: ErrorCodes.NotInitialized,
    });
    const result = await client.initialize({
      client: { name: "t", version: "1" },
      capabilities: {},
    });
    expect(result.engine).toEqual({ name: "dawg mock engine", version: "0.0.0" });
    expect(result.capabilities.methods.sort()).toEqual([...METHOD_NAMES].sort());
    expect(result.capabilities.events.sort()).toEqual([...EVENT_NAMES].sort());
    await expect(
      client.initialize({ client: { name: "t", version: "1" }, capabilities: {} }),
    ).rejects.toMatchObject({ code: ErrorCodes.InvalidState });
  });
});

describe("session.list", () => {
  it("lists every session, newest activity first, with absolute paths", async () => {
    h = harness();
    const peer = await h.connect();
    const { sessions, nextCursor } = await peer.request("session.list", {});
    expect(nextCursor).toBeNull();
    expect(sessions.map((s) => s.id)).toEqual([
      "fix-split",
      "receipt-pdf",
      "docs-search",
      "flaky-csv",
      "tip-support",
      "multi-currency",
      "broken-links",
      "python-313",
      "export-md",
    ]);
    const fix = sessions[0];
    expect(fix).toMatchObject({
      cwd: `${HOME}/code/tally/.dawg/worktrees/split-cents`,
      projectDir: `${HOME}/code/tally`,
      mode: "acceptEdits",
      model: "qwen3.8-27b-q8",
      effort: "xhigh",
      status: "idle",
    });
    const status = Object.fromEntries(sessions.map((s) => [s.id, s.status]));
    expect(status).toMatchObject({
      "flaky-csv": "waiting",
      "tip-support": "waiting",
      "multi-currency": "waiting",
      "docs-search": "working",
      "receipt-pdf": "working",
      "python-313": "error",
      "broken-links": "idle",
    });
    const ago = (id: string) =>
      h.clock.now() - (sessions.find((s) => s.id === id)?.lastActivityAt ?? 0);
    expect(ago("flaky-csv")).toBe(3 * 60_000);
    expect(ago("broken-links")).toBe(26 * 60 * 60_000);
  });

  it("filters by project and title, and pages with a cursor", async () => {
    h = harness();
    const peer = await h.connect();
    const tally = await peer.request("session.list", { projectDir: `${HOME}/code/tally` });
    expect(tally.sessions.map((s) => s.id).sort()).toEqual(
      ["fix-split", "flaky-csv", "multi-currency", "receipt-pdf", "tip-support"].sort(),
    );
    const split = await peer.request("session.list", { query: "SPLIT" });
    expect(split.sessions.map((s) => s.id)).toEqual(["fix-split"]);
    const page1 = await peer.request("session.list", { limit: 4 });
    expect(page1.sessions).toHaveLength(4);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await peer.request("session.list", { limit: 4, cursor: page1.nextCursor ?? "" });
    const page3 = await peer.request("session.list", { limit: 4, cursor: page2.nextCursor ?? "" });
    expect(page3.nextCursor).toBeNull();
    expect([...page1.sessions, ...page2.sessions, ...page3.sessions].map((s) => s.id)).toHaveLength(
      9,
    );
    const bad = await peer.failure("session.list", { cursor: "nope" });
    expect(bad.code).toBe(ErrorCodes.InvalidParams);
  });

  it("hides archived sessions unless asked", async () => {
    h = harness();
    const peer = await h.connect();
    const { session } = await peer.request("session.archive", { sessionId: "export-md" });
    expect(session.archived).toBe(true);
    const listed = await peer.request("session.list", {});
    expect(listed.sessions.map((s) => s.id)).not.toContain("export-md");
    const withArchived = await peer.request("session.list", { includeArchived: true });
    expect(withArchived.sessions.map((s) => s.id)).toContain("export-md");
    await peer.request("session.archive", { sessionId: "export-md", archived: false });
    expect((await peer.request("session.list", {})).sessions.map((s) => s.id)).toContain(
      "export-md",
    );
  });
});

describe("opening sessions", () => {
  it("creates an empty session with the defaults", async () => {
    h = harness();
    const peer = await h.connect();
    const snapshot = await peer.request("session.create", { cwd: "/work/app" });
    expect(snapshot.session).toMatchObject({
      title: null,
      cwd: "/work/app",
      projectDir: "/work/app",
      mode: "default",
      model: MOCK_DEFAULT_MODEL_ID,
      effort: null,
      status: "idle",
      archived: false,
      forkedFrom: null,
      lastSeq: 0,
    });
    expect(snapshot.modelInfo).toEqual(findMockModel(MOCK_DEFAULT_MODEL_ID)?.info);
    expect(snapshot.usage).toBeNull();
    expect(snapshot.pending).toEqual([]);
    expect(snapshot.activeTurnId).toBeNull();
    expect(snapshot.commands.map((c) => c.name)).toEqual([
      "help",
      "context",
      "compact",
      "clear",
      "rewind",
      "memory",
    ]);
    const other = await peer.request("session.create", {
      cwd: "/work/app/.dawg/worktrees/x",
      projectDir: "/work/app",
      title: "Named",
      mode: "plan",
      model: "gpt-oss-20b-q4",
      effort: "low",
    });
    expect(other.session).toMatchObject({
      title: "Named",
      mode: "plan",
      model: "gpt-oss-20b-q4",
      effort: "low",
    });
    expect((await peer.failure("session.create", { cwd: "/x", model: "nope" })).code).toBe(
      ErrorCodes.InvalidParams,
    );
    expect((await peer.failure("session.create", { cwd: "/x", effort: "turbo" })).code).toBe(
      ErrorCodes.InvalidParams,
    );
  });

  it("resumes a stored session with its pending request and usage", async () => {
    h = harness();
    const peer = await h.connect();
    const snapshot = await peer.request("session.resume", { sessionId: "flaky-csv" });
    expect(snapshot.session.status).toBe("waiting");
    expect(snapshot.activeTurnId).not.toBeNull();
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]).toMatchObject({
      kind: "permission",
      request: { requestId: "request-flaky-csv-uv-add", title: "Run a shell command" },
    });
    expect(snapshot.usage?.contextUsed).toBe(24_896);
    expect(snapshot.usage?.contextWindow).toBe(204_800);
    expect((await peer.failure("session.resume", { sessionId: "nope" })).code).toBe(
      ErrorCodes.SessionNotFound,
    );
  });

  it("needs a session open on this connection for session methods", async () => {
    h = harness();
    const peer = await h.connect();
    const error = await peer.failure("session.prompt", {
      sessionId: "broken-links",
      prompt: prompt("hi"),
    });
    expect(error.code).toBe(ErrorCodes.InvalidState);
    expect(
      (await peer.failure("session.prompt", { sessionId: "nope", prompt: prompt("hi") })).code,
    ).toBe(ErrorCodes.SessionNotFound);
  });

  it("forks at the end, before a turn and after a turn", async () => {
    h = harness({ speed: Number.POSITIVE_INFINITY, startPlayback: "created" });
    await h.runAll();
    const peer = await h.connect();
    const parent = await peer.request("session.replay", { sessionId: "fix-split", afterSeq: 0 });
    const turns = all(parent.events, "turn.started").map((e) => e.payload.turnId);
    expect(turns).toHaveLength(2);

    const end = await peer.request("session.fork", { sessionId: "fix-split" });
    expect(end.session).toMatchObject({
      title: "Fix the failing split test (fork)",
      forkedFrom: { sessionId: "fix-split", point: { position: "end" } },
      lastSeq: parent.lastSeq,
      status: "idle",
      cwd: `${HOME}/code/tally/.dawg/worktrees/split-cents`,
    });
    expect(end.session.id).not.toBe("fix-split");
    const copied = await peer.request("session.replay", { sessionId: end.session.id, afterSeq: 0 });
    expect(copied.events.map((e) => e.event)).toEqual(parent.events.map((e) => e.event));
    expect(copied.events.every((e) => e.payload.sessionId === end.session.id)).toBe(true);
    expect(checkConformance(copied.events)).toEqual([]);

    const before = await peer.request("session.fork", {
      sessionId: "fix-split",
      point: { position: "beforeTurn", turnId: turns[1] ?? "" },
      title: "Just turn one",
    });
    const beforeEvents = (
      await peer.request("session.replay", { sessionId: before.session.id, afterSeq: 0 })
    ).events;
    expect(all(beforeEvents, "turn.started")).toHaveLength(1);
    expect(beforeEvents.at(-1)?.event).toBe("session.status");
    expect(before.session.title).toBe("Just turn one");
    expect(before.usage?.contextUsed).toBe(35_090);

    const after = await peer.request("session.fork", {
      sessionId: "fix-split",
      point: { position: "afterTurn", turnId: turns[0] ?? "" },
    });
    expect(after.session.lastSeq).toBe(before.session.lastSeq);
    expect(
      (
        await peer.failure("session.fork", {
          sessionId: "fix-split",
          point: { position: "afterTurn", turnId: "x" },
        })
      ).code,
    ).toBe(ErrorCodes.InvalidState);
  });

  it("forks a session waiting on a decision without its running turn", async () => {
    h = harness();
    const peer = await h.connect();
    const fork = await peer.request("session.fork", { sessionId: "flaky-csv" });
    expect(fork.session.lastSeq).toBe(0);
    expect(fork.pending).toEqual([]);
    expect(fork.activeTurnId).toBeNull();
  });
});

describe("rename and archive", () => {
  it("work on sessions not open here and reach only connections that have them open", async () => {
    h = harness();
    const a = await h.connect();
    const b = await h.connect();
    await a.request("session.resume", { sessionId: "broken-links" });
    const { session } = await b.request("session.rename", {
      sessionId: "broken-links",
      title: "Links, fixed",
    });
    expect(session.title).toBe("Links, fixed");
    await b.request("session.archive", { sessionId: "broken-links" });
    await flush();
    const updates = all(a.of("broken-links"), "session.updated");
    expect(updates.map((u) => u.payload.changed)).toEqual([["title"], ["archived"]]);
    expect(updates[1]?.payload).toMatchObject({
      title: "Links, fixed",
      archived: true,
      mode: "acceptEdits",
    });
    expect(b.of("broken-links")).toEqual([]);
  });
});

describe("session.delete", () => {
  it("deletes a stored session: every connection with it open hears, later calls fail", async () => {
    h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const c = await h.connect();
    await a.request("session.resume", { sessionId: "broken-links" });
    await b.request("session.resume", { sessionId: "broken-links" });
    expect(await c.request("session.delete", { sessionId: "broken-links" })).toEqual({});
    await flush();
    for (const peer of [a, b]) {
      expect(names(peer.of("broken-links"))).toEqual(["session.deleted"]);
      expect(peer.problems).toEqual([]);
    }
    expect(c.of("broken-links")).toEqual([]);
    const { sessions } = await c.request("session.list", { includeArchived: true });
    expect(sessions.map((s) => s.id)).not.toContain("broken-links");
    for (const failure of [
      await a.failure("session.resume", { sessionId: "broken-links" }),
      await a.failure("session.replay", { sessionId: "broken-links", afterSeq: 0 }),
      await a.failure("session.rename", { sessionId: "broken-links", title: "x" }),
      await b.failure("session.prompt", { sessionId: "broken-links", prompt: prompt("hi") }),
      await c.failure("session.delete", { sessionId: "broken-links" }),
    ]) {
      expect(failure.code).toBe(ErrorCodes.SessionNotFound);
    }
  });

  it("interrupts a running turn first, so the turn ends before the session goes", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "fix-split" });
    await h.advance(5_000);
    const before = peer.of("fix-split").length;
    await peer.request("session.delete", { sessionId: "fix-split" });
    await flush();
    const after = peer.of("fix-split").slice(before);
    const order = names(after);
    expect(order.at(-1)).toBe("session.deleted");
    expect(order.indexOf("turn.finished")).toBeLessThan(order.indexOf("session.status"));
    expect(first(after, "turn.finished").payload.stopReason).toBe("interrupted");
    expect(checkConformance(peer.of("fix-split"), { midSession: true })).toEqual([]);
    // Nothing more plays for it.
    await h.advance(200_000);
    expect(peer.of("fix-split").at(-1)?.event).toBe("session.deleted");
  });

  it("frees the model for a session queued behind it", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "docs-search" });
    await peer.request("session.delete", { sessionId: "fix-split" });
    await h.advance(1_000);
    expect(first(peer.of("docs-search"), "session.status").payload).toMatchObject({
      status: "working",
      message: "Working",
      queuePosition: null,
    });
  });

  it("stops a compaction, and leaves forks of the session working", async () => {
    h = harness();
    const peer = await h.connect();
    const fork = await peer.request("session.fork", { sessionId: "broken-links" });
    await peer.request("session.resume", { sessionId: "broken-links" });
    await peer.request("session.command", { sessionId: "broken-links", name: "compact" });
    await peer.request("session.delete", { sessionId: "broken-links" });
    await flush();
    expect(names(peer.of("broken-links"))).toEqual([
      "session.status",
      "compaction.started",
      "compaction.finished",
      "session.status",
      "session.deleted",
    ]);
    expect(checkConformance(peer.of("broken-links"), { midSession: true })).toEqual([]);
    await peer.request("session.prompt", { sessionId: fork.session.id, prompt: prompt("hi") });
    await h.advance(60_000);
    expect(names(peer.of(fork.session.id))).toContain("turn.finished");
  });
});

describe("settings", () => {
  it("emits session.updated for mode, model and effort, and resets effort the model lacks", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "broken-links" });
    expect(
      await peer.request("session.setMode", { sessionId: "broken-links", mode: "plan" }),
    ).toEqual({ mode: "plan" });
    expect(
      await peer.request("session.setEffort", { sessionId: "broken-links", effort: "xhigh" }),
    ).toEqual({
      effort: "xhigh",
    });
    const model = await peer.request("session.setModel", {
      sessionId: "broken-links",
      model: "gpt-oss-20b-q4",
    });
    expect(model).toEqual({
      model: "gpt-oss-20b-q4",
      modelInfo: findMockModel("gpt-oss-20b-q4")?.info,
      effort: null,
    });
    await flush();
    const updates = all(peer.of("broken-links"), "session.updated");
    expect(updates.map((u) => u.payload.changed)).toEqual([
      ["mode"],
      ["effort"],
      ["model", "effort"],
    ]);
    expect(updates[2]?.payload).toMatchObject({
      model: "gpt-oss-20b-q4",
      modelInfo: { contextWindow: 65_536 },
      effort: null,
      mode: "plan",
    });
    const bad = await peer.failure("session.setEffort", {
      sessionId: "broken-links",
      effort: "xhigh",
    });
    expect(bad.code).toBe(ErrorCodes.InvalidState);
    expect(
      (await peer.failure("session.setModel", { sessionId: "broken-links", model: "nope" })).code,
    ).toBe(ErrorCodes.InvalidParams);
  });

  it("refuses a model change while a turn runs", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "flaky-csv" });
    const error = await peer.failure("session.setModel", {
      sessionId: "flaky-csv",
      model: "qwen3.8-27b-q6",
    });
    expect(error.code).toBe(ErrorCodes.SessionBusy);
  });
});

describe("commands", () => {
  it("answers /help and /context in Markdown", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "fix-split" });
    const help = await peer.request("session.command", { sessionId: "fix-split", name: "help" });
    expect(help.turnId).toBeNull();
    expect(help.openedSession).toBeNull();
    expect(help.output).toContain("| `/compact [focus]` |");
    expect(help.output?.split("\n").filter((l) => l.startsWith("| `/"))).toHaveLength(6);
    const one = await peer.request("session.command", {
      sessionId: "fix-split",
      name: "help",
      args: "compact",
    });
    expect(one.output).toMatch(/^`\/compact \[focus\]`/);
    const context = await peer.request("session.command", {
      sessionId: "fix-split",
      name: "context",
    });
    expect(context.output).toContain("35,090 of 204,800 tokens");
    expect(context.output).toContain("| System prompt | 4,112 |");
    expect(context.output).toContain("| Messages |");
    expect(context.output).toContain("| Free |");
    expect(context.output).toContain("Compacts on its own above 133,120 tokens (65%).");
    const unknown = await peer.failure("session.command", {
      sessionId: "fix-split",
      name: "deploy",
    });
    expect(unknown.code).toBe(ErrorCodes.InvalidParams);
  });

  it("compacts: started, then finished and a smaller usage", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "broken-links" });
    const result = await peer.request("session.command", {
      sessionId: "broken-links",
      name: "compact",
      args: "links",
    });
    expect(result).toEqual({ output: null, turnId: null, openedSession: null });
    await flush();
    expect(names(peer.of("broken-links"))).toEqual(["session.status", "compaction.started"]);
    const busy = await peer.failure("session.prompt", {
      sessionId: "broken-links",
      prompt: prompt("hi"),
    });
    expect(busy.code).toBe(ErrorCodes.SessionBusy);
    await h.advance(2_000);
    const events = peer.of("broken-links");
    expect(names(events)).toEqual([
      "session.status",
      "compaction.started",
      "compaction.finished",
      "usage.updated",
      "session.status",
    ]);
    const started = first(events, "compaction.started").payload;
    expect(started).toMatchObject({
      trigger: "manual",
      turnId: null,
      focus: "links",
      contextUsed: 19_557,
    });
    const finished = first(events, "compaction.finished").payload;
    expect(finished).toMatchObject({ outcome: "completed", contextBefore: 19_557 });
    expect(finished.contextAfter).toBeLessThan(19_557);
    const { usage } = first(events, "usage.updated").payload;
    expect(usage.contextUsed).toBe(finished.contextAfter);
    expect(usage.compactAt).toBe(133_120);
    // The fixed parts stay; the conversation shrinks to what is left.
    expect(usage.breakdown).toMatchObject({
      systemPrompt: 4_112,
      instructions: 1_186,
      tools: 10_992,
    });
    const parts = usage.breakdown;
    expect(parts && parts.systemPrompt + parts.instructions + parts.tools + parts.messages).toBe(
      usage.contextUsed,
    );
  });

  it("clears into a new open session in the same directory", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "broken-links" });
    const result = await peer.request("session.command", {
      sessionId: "broken-links",
      name: "clear",
    });
    const opened = result.openedSession;
    expect(opened?.session).toMatchObject({
      title: null,
      cwd: `${HOME}/code/dawg-site`,
      lastSeq: 0,
      mode: "acceptEdits",
    });
    const id = opened?.session.id ?? "";
    await peer.request("session.prompt", { sessionId: id, prompt: prompt("hello") });
    await h.advance(30_000);
    expect(names(peer.of(id))).toContain("turn.finished");
    const busy = harness();
    const other = await busy.connect();
    await other.request("session.resume", { sessionId: "flaky-csv" });
    expect(
      (await other.failure("session.command", { sessionId: "flaky-csv", name: "clear" })).code,
    ).toBe(ErrorCodes.SessionBusy);
    busy.engine.dispose();
  });
});

describe("session.replay", () => {
  it("returns events after a seq, with limit and hasMore", async () => {
    h = harness();
    const peer = await h.connect();
    const whole = await peer.request("session.replay", { sessionId: "flaky-csv", afterSeq: 0 });
    expect(whole.events.map((e) => e.payload.seq)).toEqual(whole.events.map((_, i) => i + 1));
    expect(whole.lastSeq).toBe(whole.events.length);
    expect(whole.hasMore).toBe(false);
    const page = await peer.request("session.replay", {
      sessionId: "flaky-csv",
      afterSeq: 10,
      limit: 5,
    });
    expect(page.events.map((e) => e.payload.seq)).toEqual([11, 12, 13, 14, 15]);
    expect(page.hasMore).toBe(true);
    expect(page.lastSeq).toBe(whole.lastSeq);
    const tail = await peer.request("session.replay", {
      sessionId: "flaky-csv",
      afterSeq: whole.lastSeq - 2,
      limit: 5,
    });
    expect(tail.events).toHaveLength(2);
    expect(tail.hasMore).toBe(false);
  });
});

describe("connections", () => {
  it("send each connection only the sessions it opened, and keep playing when one closes", async () => {
    h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const snapA = await a.request("session.resume", { sessionId: "fix-split" });
    await b.request("session.resume", { sessionId: "receipt-pdf" });
    await h.advance(5_000);
    expect(new Set(a.events.map((e) => e.payload.sessionId))).toEqual(new Set(["fix-split"]));
    expect(new Set(b.events.map((e) => e.payload.sessionId))).toEqual(new Set(["receipt-pdf"]));
    expect(a.events[0]?.payload.seq).toBe(snapA.session.lastSeq + 1);
    a.close();
    await h.advance(90_000);
    const c = await h.connect();
    const later = await c.request("session.resume", { sessionId: "fix-split" });
    expect(later.session.status).toBe("idle");
    expect(later.usage?.contextUsed).toBe(74_246);
    expect(a.problems).toEqual([]);
    expect(b.problems).toEqual([]);
  });

  it("closes connections on dispose", async () => {
    h = harness();
    const [clientEnd, engineEnd] = createMemoryTransportPair();
    const connection = h.engine.connect(engineEnd);
    h.engine.dispose();
    await connection.closed;
    expect(clientEnd.closed || engineEnd.closed).toBe(true);
    expect(h.clock.pending).toBe(0);
  });
});
