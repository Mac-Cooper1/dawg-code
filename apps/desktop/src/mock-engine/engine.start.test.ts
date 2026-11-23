/** When live playback starts: at the first `initialize`, once per engine. */
import { createMemoryTransportPair } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createManualClock } from "./clock.ts";
import { checkConformance } from "./conformance.ts";
import { builtIn, first, type Harness, harness, names } from "./test-support.ts";

const engines: Harness[] = [];
afterEach(() => {
  for (const h of engines.splice(0)) h.engine.dispose();
});

function make(options: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(options);
  engines.push(h);
  return h;
}

const STORED_EVENTS = (id: string) => builtIn(id).recordings["stored.jsonl"]?.length ?? 0;

describe("live playback", () => {
  it("waits for the first connection's initialize, so a window that opens late sees it", async () => {
    const h = make();
    const created = h.clock.now();
    await h.advance(120_000);
    expect(h.clock.pending).toBe(0);

    // A connection alone does not start it; initialize does.
    const [, engineEnd] = createMemoryTransportPair();
    h.engine.connect(engineEnd);
    await h.advance(10_000);
    expect(h.clock.pending).toBe(0);

    const peer = await h.connect();
    const opened = h.clock.now();
    const pdf = await peer.request("session.resume", { sessionId: "receipt-pdf" });
    expect(pdf.session.status).toBe("working");
    expect(pdf.activeTurnId).not.toBeNull();
    const fix = await peer.request("session.resume", { sessionId: "fix-split" });
    expect(fix.session.lastSeq).toBe(STORED_EVENTS("fix-split"));

    // Stored times stay relative to the engine's creation.
    const csv = await peer.request("session.replay", { sessionId: "flaky-csv", afterSeq: 0 });
    expect(csv.events.at(-1)?.payload.time).toBe(created - 3 * 60_000);

    await h.advance(3_000);
    const pdfEvents = peer.of("receipt-pdf");
    expect(names(pdfEvents).slice(-2)).toEqual(["turn.finished", "session.status"]);
    expect(pdfEvents.every((e) => e.payload.time >= opened)).toBe(true);
    const turn = first(peer.of("fix-split"), "turn.started").payload;
    expect(turn.time).toBeGreaterThan(opened);
    expect(turn.seq).toBe(STORED_EVENTS("fix-split") + 2);
  });

  it("starts once: later connections join what is already playing", async () => {
    const h = make();
    const a = await h.connect();
    await a.request("session.resume", { sessionId: "fix-split" });
    await h.advance(10_000);
    const b = await h.connect();
    await b.request("session.resume", { sessionId: "fix-split" });
    await b.request("session.resume", { sessionId: "docs-search" });
    await h.advance(200_000);
    const whole = await b.request("session.replay", { sessionId: "fix-split", afterSeq: 0 });
    expect(whole.events.filter((e) => e.event === "turn.started")).toHaveLength(2);
    expect(checkConformance(whole.events, { requireClosed: true })).toEqual([]);
    expect(first(b.of("docs-search"), "turn.finished").payload.stopReason).toBe("completed");
  });

  it("plays from the start again in a fresh engine, as after an engine-host restart", async () => {
    const clock = createManualClock();
    const before = make({ clock });
    const old = await before.connect();
    await before.advance(300_000);
    const done = await old.request("session.resume", { sessionId: "fix-split" });
    expect(done.session.lastSeq).toBeGreaterThan(STORED_EVENTS("fix-split"));
    before.engine.dispose();

    const after = make({ clock });
    await after.advance(30_000);
    expect(clock.pending).toBe(0);
    const peer = await after.connect();
    const fix = await peer.request("session.resume", { sessionId: "fix-split" });
    expect(fix.session.lastSeq).toBe(STORED_EVENTS("fix-split"));
    expect(fix.activeTurnId).toBeNull();
    const pdf = await peer.request("session.resume", { sessionId: "receipt-pdf" });
    expect(pdf.session.status).toBe("working");
    await after.advance(3_000);
    expect(names(peer.of("receipt-pdf")).slice(-2)).toEqual(["turn.finished", "session.status"]);
    expect(names(peer.of("fix-split"))).toContain("turn.started");
  });

  it("can start when the engine is created, for tests without a client", async () => {
    const h = make({ startPlayback: "created" });
    expect(h.clock.pending).toBeGreaterThan(0);
    await h.advance(5_000);
    const peer = await h.connect();
    const pdf = await peer.request("session.resume", { sessionId: "receipt-pdf" });
    expect(pdf.session.status).toBe("idle");
    expect(pdf.activeTurnId).toBeNull();
  });

  it("does not start in an engine disposed before anyone connected", async () => {
    const h = make();
    h.engine.dispose();
    const [, engineEnd] = createMemoryTransportPair();
    const connection = h.engine.connect(engineEnd);
    await connection.closed;
    expect(h.clock.pending).toBe(0);
  });
});
