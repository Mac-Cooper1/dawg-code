import { type ScriptReply, stalled, text } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRegistry } from "../commands/index.ts";
import { fakeCompactor } from "./__fixtures__/fakes.ts";
import { type Harness, historyProblems, startHarness } from "./__fixtures__/harness.ts";
import type { LoggedEvent } from "./event-log.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Long enough for another session to start and join the queue meanwhile. */
const SLOW = { pacing: { firstEventDelayMs: 500 } };

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** `[status, message, queuePosition]` of each of a session's status events. */
function statuses(harness: Harness, sessionId: string): unknown[][] {
  return harness
    .ofType(sessionId, "session.status")
    .map((e) => [e.payload.status, e.payload.message, e.payload.queuePosition ?? null]);
}

function queuedAt(sessionId: string, position: number) {
  return (e: LoggedEvent) =>
    e.event === "session.status" &&
    e.payload.sessionId === sessionId &&
    e.payload.queuePosition === position;
}

function slotsSent(harness: Harness): unknown[] {
  return harness.mock.chatRequests.map((r) => (r.body as { id_slot?: unknown }).id_slot);
}

describe("sessions sharing one model", () => {
  it("a second session waits for the slot, shows its place in line, then runs", async () => {
    h = await startHarness({
      pools: { conversation: [0] },
      script: [text("first", SLOW), text("second")],
    });
    const harness = h;
    const a = await h.engine.createSession({ cwd: h.project });
    const b = await h.engine.createSession({ cwd: h.project });
    await a.prompt(ask("one"));
    // Once its request is on the way, a holds the only slot.
    await until(() => harness.mock.chatRequests.length === 1);
    await b.prompt(ask("two"));
    const queued = await h.waitFor(queuedAt(b.id, 1));
    expect(queued.payload).toMatchObject({
      status: "working",
      waitingOn: null,
      message: "Waiting for the model",
      queuePosition: 1,
    });
    expect(b.summary()).toMatchObject({ status: "working", queuePosition: 1 });
    expect(h.mock.chatRequests).toHaveLength(1);
    const status = await createCommandRegistry().run("status", {
      args: "",
      session: b,
      engine: h.engine,
      homeDir: h.home,
      settingsFlags: undefined,
      capabilities: {},
      describeEndpoint: () => null,
    });
    expect(status.kind === "output" && status.text).toContain(
      "Status: working, waiting for the model (next in line)",
    );

    expect((await a.waitForIdle())?.finalText).toBe("first");
    expect((await b.waitForIdle())?.finalText).toBe("second");
    expect(slotsSent(h)).toEqual([0, 0]);
    expect(statuses(h, b.id)).toEqual([
      ["working", "Working", null],
      ["working", "Waiting for the model", 1],
      ["working", "Working", null],
      ["idle", null, null],
    ]);
    expect(b.summary().queuePosition).toBeNull();
    expect(statuses(h, a.id).every(([, , position]) => position === null)).toBe(true);
  });

  it("moves the line up, cancels a wait at once on interrupt, and never leaks the slot", async () => {
    h = await startHarness({
      pools: { conversation: [0] },
      script: [stalled(text("a")), stalled(text("b")), text("after")],
    });
    const harness = h;
    const [a, b, c] = [
      await h.engine.createSession({ cwd: h.project }),
      await h.engine.createSession({ cwd: h.project }),
      await h.engine.createSession({ cwd: h.project }),
    ];
    await a.prompt(ask("a"));
    await until(() => harness.mock.chatRequests.length === 1);
    await b.prompt(ask("b"));
    await h.waitFor(queuedAt(b.id, 1));
    await c.prompt(ask("c"));
    await h.waitFor(queuedAt(c.id, 2));
    expect(c.summary().queuePosition).toBe(2);

    // An interrupt ends a's stream and frees the slot: b runs, c moves up.
    a.interrupt();
    expect((await a.waitForIdle())?.stopReason).toBe("interrupted");
    await h.waitFor(queuedAt(c.id, 1));
    await until(() => harness.mock.chatRequests.length === 2);

    // c is interrupted while it waits: it sends nothing and stops at once.
    expect(c.interrupt()).toBe(true);
    expect((await c.waitForIdle())?.stopReason).toBe("interrupted");
    expect(h.mock.chatRequests).toHaveLength(2);
    expect(historyProblems(c.view)).toEqual([]);
    expect(statuses(h, c.id)).toEqual([
      ["working", "Working", null],
      ["working", "Waiting for the model", 2],
      ["working", "Waiting for the model", 1],
      ["idle", null, null],
    ]);

    b.interrupt();
    await b.waitForIdle();
    // Nothing holds the slot now: a runs again without waiting.
    const before = h.ofType(a.id, "session.status").length;
    expect((await a.run(ask("again"))).finalText).toBe("after");
    const later = h.ofType(a.id, "session.status").slice(before);
    expect(later.every((e) => e.payload.queuePosition == null)).toBe(true);
    expect(slotsSent(h)).toEqual([0, 0, 0]);
  });

  it("gives the slot back when a request fails", async () => {
    const failing: ScriptReply = {
      ...text("partial", SLOW),
      fault: { type: "stream_error", afterEvents: 1, status: 400, message: "bad request" },
    };
    h = await startHarness({ pools: { conversation: [0] }, script: [failing, text("fine")] });
    const harness = h;
    const a = await h.engine.createSession({ cwd: h.project });
    const b = await h.engine.createSession({ cwd: h.project });
    await a.prompt(ask("one"));
    await until(() => harness.mock.chatRequests.length === 1);
    await b.prompt(ask("two"));
    await h.waitFor(queuedAt(b.id, 1));
    expect((await a.waitForIdle())?.stopReason).toBe("error");
    expect((await b.waitForIdle())?.finalText).toBe("fine");
  });

  it("runs sessions side by side when there are enough slots, each on the slot it used last", async () => {
    h = await startHarness({
      pools: { conversation: [0, 1] },
      script: [stalled(text("held")), text("b1"), text("b2"), text("a2"), text("b3")],
    });
    const harness = h;
    const a = await h.engine.createSession({ cwd: h.project });
    const b = await h.engine.createSession({ cwd: h.project });
    await a.prompt(ask("a"));
    await until(() => harness.mock.chatRequests.length === 1);
    expect((await b.run(ask("b"))).finalText).toBe("b1");
    expect((await b.run(ask("b again"))).finalText).toBe("b2");
    a.interrupt();
    await a.waitForIdle();
    expect((await a.run(ask("a again"))).finalText).toBe("a2");
    expect((await b.run(ask("b once more"))).finalText).toBe("b3");
    expect(slotsSent(h)).toEqual([0, 1, 1, 0, 1]);
    for (const s of [a, b]) {
      expect(statuses(h, s.id).every(([, , position]) => position === null)).toBe(true);
    }
  });

  it("queues compaction requests like turns", async () => {
    h = await startHarness({
      pools: { conversation: [0] },
      engine: { compactor: fakeCompactor({ useModel: true }) },
      script: [text("hello"), stalled(text("held")), text("the summary")],
    });
    const harness = h;
    const a = await h.engine.createSession({ cwd: h.project });
    const b = await h.engine.createSession({ cwd: h.project });
    await b.run(ask("hi"));
    await a.prompt(ask("hold the model"));
    await until(() => harness.mock.chatRequests.length === 2);
    const compaction = b.compact();
    const queued = await h.waitFor(queuedAt(b.id, 1));
    expect(queued.payload).toMatchObject({ status: "working", message: "Waiting for the model" });
    a.interrupt();
    expect(await compaction).toMatchObject({ outcome: "completed", summary: "the summary" });
    const last = statuses(h, b.id).slice(-3);
    expect(last).toEqual([
      ["working", "Waiting for the model", 1],
      ["working", "Compacting the conversation", null],
      ["idle", null, null],
    ]);
  });

  it("sends titles to the utility pool and never shows them as queued", async () => {
    h = await startHarness({
      pools: { conversation: [0], utility: [1] },
      engine: { generateTitles: true },
      script: [text("hello"), text("A short title")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("say hello"));
    await h.waitFor(
      (e) =>
        e.event === "session.updated" &&
        e.payload.sessionId === session.id &&
        (e.payload.changed as string[]).includes("title"),
    );
    expect(session.summary().title).toBe("A short title");
    expect(slotsSent(h)).toEqual([0, 1]);
    expect(statuses(h, session.id).every(([, , position]) => position === null)).toBe(true);
  });
});
