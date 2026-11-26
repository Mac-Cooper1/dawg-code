/** The composer's images and mentions through the store: sending, queueing, holding, clearing. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { fullTurn } from "./__fixtures__/scenarios.ts";
import { createStream, PROJECT } from "./__fixtures__/streams.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";
import type { ImageAttachment } from "./types.ts";

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

async function started(engine: FakeEngine, files?: Record<string, string>): Promise<Harness> {
  const bridge = createFakeBridge({ engine, ...(files ? { files } : {}) });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  await store.getState().actions.start();
  return harness;
}

function idle(engine: FakeEngine, id: string) {
  engine.addSession(id);
  const stream = createStream(id);
  fullTurn(stream);
  engine.emitAll(id, stream.events);
}

function running(engine: FakeEngine, id: string) {
  engine.addSession(id);
  engine.emit(id, "session.status", { status: "working", waitingOn: null, message: null });
  engine.emit(id, "turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text: "Work" }], mentions: [] },
    command: null,
  });
}

function finish(engine: FakeEngine, id: string) {
  engine.emit(id, "turn.finished", {
    turnId: "t1",
    stopReason: "completed",
    finalText: null,
    error: null,
    durationMs: 1000,
  });
  engine.emit(id, "session.status", { status: "idle", waitingOn: null, message: null });
}

function image(name: string): ImageAttachment {
  return {
    id: `id-${name}`,
    name,
    mediaType: "image/png",
    data: `data-${name}`,
    width: 4,
    height: 3,
  };
}

const MONEY = { path: "src/tally/money.py", startLine: 10, endLine: 20 };

describe("sending with images and mentions", () => {
  it("sends the attached images first, then the text, with the mentions", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.loaded).toBe(true));

    actions.addAttachments("s1", [image("a.png")]);
    actions.addAttachments("s1", [image("b.png")]);
    actions.setDraft("s1", "What changed? @src/tally/money.py#L10-20");
    actions.rememberMention("s1", "src/tally/money.py");
    actions.rememberMention("s1", "src/tally/money.py");
    expect(harness.store.getState().ui.mentionPaths.s1).toEqual(["src/tally/money.py"]);

    await actions.submit("s1", "What changed? @src/tally/money.py#L10-20", [MONEY]);
    expect(engine.callsOf("session.prompt")).toEqual([
      {
        sessionId: "s1",
        prompt: {
          content: [
            { type: "image", mediaType: "image/png", data: "data-a.png" },
            { type: "image", mediaType: "image/png", data: "data-b.png" },
            { type: "text", text: "What changed? @src/tally/money.py#L10-20" },
          ],
          mentions: [MONEY],
        },
      },
    ]);
    const ui = harness.store.getState().ui;
    expect(ui.attachments.s1).toBeUndefined();
    expect(ui.drafts.s1).toBeUndefined();
    expect(ui.mentionPaths.s1).toBeUndefined();
  });

  it("sends images without text, and does nothing with neither", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.loaded).toBe(true));

    await actions.submit("s1", "   ");
    expect(engine.callsOf("session.prompt")).toEqual([]);
    actions.addAttachments("s1", [image("only.png")]);
    await actions.submit("s1", "");
    expect(engine.callsOf("session.prompt")[0]?.prompt).toEqual({
      content: [{ type: "image", mediaType: "image/png", data: "data-only.png" }],
      mentions: [],
    });
    expect(harness.store.getState().ui.attachments.s1).toBeUndefined();
  });

  it("keeps images for the next message when the text is a command", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.loaded).toBe(true));

    actions.addAttachments("s1", [image("keep.png")]);
    await actions.submit("s1", "/help", [MONEY]);
    expect(engine.callsOf("session.command")).toEqual([
      { sessionId: "s1", name: "help", args: "" },
    ]);
    expect(harness.store.getState().ui.attachments.s1?.map((i) => i.name)).toEqual(["keep.png"]);
  });

  it("removes one attached image", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    actions.addAttachments("s1", [image("a.png"), image("b.png")]);
    actions.removeAttachment("s1", "id-a.png");
    expect(harness.store.getState().ui.attachments.s1?.map((i) => i.name)).toEqual(["b.png"]);
    actions.removeAttachment("s1", "id-b.png");
    expect(harness.store.getState().ui.attachments.s1).toBeUndefined();
  });

  it("keeps each session's images apart", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    idle(engine, "s2");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    actions.addAttachments("s1", [image("one.png")]);
    actions.addAttachments("s2", [image("two.png")]);
    actions.selectSession("s2");
    actions.selectSession("s1");
    const ui = harness.store.getState().ui;
    expect(ui.attachments.s1?.map((i) => i.name)).toEqual(["one.png"]);
    expect(ui.attachments.s2?.map((i) => i.name)).toEqual(["two.png"]);
  });
});

describe("queued messages with images and mentions", () => {
  it("queues them with the message and sends them when the turn completes", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.loaded).toBe(true));

    actions.addAttachments("s1", [image("shot.png")]);
    await actions.submit("s1", "Then look at @src/tally/money.py#L10-20", [MONEY]);
    expect(engine.callsOf("session.prompt")).toEqual([]);
    const ui = harness.store.getState().ui;
    expect(ui.queues.s1).toEqual([
      expect.objectContaining({
        text: "Then look at @src/tally/money.py#L10-20",
        state: "queued",
        images: [image("shot.png")],
        mentions: [MONEY],
      }),
    ]);
    // The images went with the queued message; the composer is free for the next one.
    expect(ui.attachments.s1).toBeUndefined();

    finish(engine, "s1");
    await vi.waitFor(() => expect(engine.callsOf("session.prompt")).toHaveLength(1));
    expect(engine.callsOf("session.prompt")[0]?.prompt).toEqual({
      content: [
        { type: "image", mediaType: "image/png", data: "data-shot.png" },
        { type: "text", text: "Then look at @src/tally/money.py#L10-20" },
      ],
      mentions: [MONEY],
    });
  });

  it("holds them when the turn is stopped, and sends them with Send now", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.loaded).toBe(true));

    actions.addAttachments("s1", [image("held.png")]);
    await actions.submit("s1", "", []);
    await actions.interrupt("s1");
    const held = harness.store.getState().ui.queues.s1?.[0];
    expect(held).toMatchObject({ text: "", state: "held", images: [image("held.png")] });
    engine.emit("s1", "turn.finished", {
      turnId: "t1",
      stopReason: "interrupted",
      finalText: null,
      error: null,
      durationMs: 10,
    });
    engine.emit("s1", "session.status", { status: "idle", waitingOn: null, message: null });
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.activeTurnId).toBeNull());

    await actions.sendQueuedNow("s1", held?.id ?? "");
    expect(engine.callsOf("session.prompt")[0]?.prompt).toEqual({
      content: [{ type: "image", mediaType: "image/png", data: "data-held.png" }],
      mentions: [],
    });
  });

  it("drops a deleted session's images and remembered paths", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    const harness = await started(engine);
    const { actions } = harness.store.getState();
    actions.addAttachments("s1", [image("gone.png")]);
    actions.rememberMention("s1", "a.ts");
    await actions.deleteSession("s1");
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1).toBeUndefined());
    const ui = harness.store.getState().ui;
    expect(ui.attachments.s1).toBeUndefined();
    expect(ui.mentionPaths.s1).toBeUndefined();
  });
});

describe("the fake bridge's file search", () => {
  it("searches the tracked session's files, as main does", async () => {
    const engine = new FakeEngine();
    idle(engine, "s1");
    const harness = await started(engine, {
      [`${PROJECT}/src/tally/money.py`]: "x",
      [`${PROJECT}/README.md`]: "x",
      "/elsewhere/money.py": "x",
    });
    const cwd = harness.store.getState().sessions.s1?.summary.cwd ?? PROJECT;
    await harness.store.getState().actions.trackSession("s1");
    const result = await harness.bridge.workspace.findFiles({ sessionId: "s1", query: "money" });
    expect(result.matches.map((match) => match.path)).toEqual([`${cwd}/src/tally/money.py`]);
    const start = await harness.bridge.workspace.findFiles({ sessionId: "s1", query: "" });
    expect(start.matches.map((match) => match.relativePath)).toEqual(["src/", "README.md"]);
    expect(harness.bridge.findFilesCalls).toHaveLength(2);
    await expect(
      harness.bridge.workspace.findFiles({ sessionId: "nope", query: "a" }),
    ).rejects.toThrow(/not tracked/);
  });
});
