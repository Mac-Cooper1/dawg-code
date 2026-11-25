/** Background commands: the snapshot's list, their output in pages, and stopping them. */
import { ErrorCodes } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { byteLength, outputPage } from "./background.ts";
import { checkConformance } from "./conformance.ts";
import { all, builtIn, flush, type Harness, HOME, harness } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

const ID = "broken-links";
const OUTPUT = (builtIn(ID).scenario.backgroundOutput?.["bash-1"] ?? "").replaceAll(
  "~/",
  `${HOME}/`,
);

describe("background commands", () => {
  it("lists the dev server a recording left running, with its output so far", async () => {
    h = harness();
    const peer = await h.connect();
    const snapshot = await peer.request("session.resume", { sessionId: ID });
    expect(snapshot.background).toEqual([
      {
        taskId: "bash-1",
        command: "pnpm dev",
        description: "Start the dev server",
        cwd: `${HOME}/code/dawg-site`,
        status: "running",
        exitCode: null,
        signal: null,
        stopReason: null,
        startedAt: expect.any(Number),
        endedAt: null,
        outputBytes: byteLength(OUTPUT),
      },
    ]);
    // Its start moved with the session's times: about a day before the engine started.
    const started = snapshot.background[0]?.startedAt ?? 0;
    expect(h.clock.now() - started).toBeGreaterThan(26 * 60 * 60_000);
    expect(h.clock.now() - started).toBeLessThan(27 * 60 * 60_000);
    expect(snapshot.session.lastActivityAt).toBeGreaterThanOrEqual(started);
    const other = await peer.request("session.resume", { sessionId: "export-md" });
    expect(other.background).toEqual([]);
  });

  it("serves the output in pages that never split a character", async () => {
    h = harness();
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: ID });
    const whole = await peer.request("background.output", { sessionId: ID, taskId: "bash-1" });
    expect(whole).toEqual({
      text: OUTPUT,
      nextOffset: byteLength(OUTPUT),
      totalBytes: byteLength(OUTPUT),
      done: false,
    });
    expect(OUTPUT).toContain("http://localhost:4321/");

    // "┃" is three bytes; a page edge inside it moves back before it.
    const bar = byteLength(OUTPUT.slice(0, OUTPUT.indexOf("┃")));
    const before = await peer.request("background.output", {
      sessionId: ID,
      taskId: "bash-1",
      offset: bar - 2,
      limit: 3,
    });
    expect(before).toMatchObject({ text: "\n\n", nextOffset: bar });
    const texts: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await peer.request("background.output", {
        sessionId: ID,
        taskId: "bash-1",
        offset,
        limit: 7,
      });
      if (page.nextOffset === offset) break;
      texts.push(page.text);
      offset = page.nextOffset;
    }
    expect(texts.join("")).toBe(OUTPUT);
    expect(texts.some((t) => t.includes("�"))).toBe(false);
  });

  it("stops a running command once and refuses unknown ones", async () => {
    h = harness();
    const peer = await h.connect();
    const elsewhere = await h.connect();
    await peer.request("session.resume", { sessionId: ID });
    const notOpen = await elsewhere.failure("background.stop", { sessionId: ID, taskId: "bash-1" });
    expect(notOpen.code).toBe(ErrorCodes.InvalidState);
    const unknown = await peer.failure("background.output", { sessionId: ID, taskId: "bash-9" });
    expect(unknown.code).toBe(ErrorCodes.InvalidParams);
    expect(unknown.message).toBe("There is no background task bash-9 in this session.");

    await h.advance(5_000);
    expect(await peer.request("background.stop", { sessionId: ID, taskId: "bash-1" })).toEqual({
      stopped: true,
    });
    await flush();
    const updates = all(peer.of(ID), "background.updated");
    expect(updates.map((e) => e.payload.task)).toEqual([
      expect.objectContaining({
        taskId: "bash-1",
        status: "stopped",
        stopReason: "requested",
        signal: "SIGINT",
        exitCode: null,
        endedAt: h.clock.now(),
        outputBytes: byteLength(OUTPUT),
      }),
    ]);
    expect(await peer.request("background.stop", { sessionId: ID, taskId: "bash-1" })).toEqual({
      stopped: false,
    });
    expect(
      await peer.request("background.output", { sessionId: ID, taskId: "bash-1" }),
    ).toMatchObject({ text: OUTPUT, done: true });
    const snapshot = await elsewhere.request("session.resume", { sessionId: ID });
    expect(snapshot.background.map((t) => t.status)).toEqual(["stopped"]);
    const replay = await peer.request("session.replay", { sessionId: ID, afterSeq: 0 });
    expect(checkConformance(replay.events, { requireClosed: true })).toEqual([]);
  });

  it("leaves the commands with the parent when a session is forked", async () => {
    h = harness();
    const peer = await h.connect();
    const fork = await peer.request("session.fork", { sessionId: ID });
    expect(fork.background).toEqual([]);
    const replay = await peer.request("session.replay", {
      sessionId: fork.session.id,
      afterSeq: 0,
    });
    expect(replay.events.some((e) => e.event === "background.updated")).toBe(false);
    expect(checkConformance(replay.events)).toEqual([]);
  });
});

describe("outputPage", () => {
  it("reads by bytes from an offset", () => {
    expect(outputPage("abc", 1, 1)).toEqual({ text: "b", nextOffset: 2, totalBytes: 3 });
    expect(outputPage("abc", 9, 1)).toEqual({ text: "", nextOffset: 3, totalBytes: 3 });
  });

  it("keeps characters whole at both edges and with a small limit", () => {
    // "é" is two bytes and "🐶" four.
    expect(outputPage("aé🐶", 0, 2)).toEqual({ text: "a", nextOffset: 1, totalBytes: 7 });
    expect(outputPage("aé🐶", 2, 10)).toEqual({ text: "🐶", nextOffset: 7, totalBytes: 7 });
    expect(outputPage("🐶!", 0, 1)).toEqual({ text: "🐶", nextOffset: 4, totalBytes: 5 });
  });
});
