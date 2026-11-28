/**
 * An MCP server's request for input in the window's state: the card in the transcript and the
 * pending list, its resolution and the end of its turn, the sidebar's line and the composer's
 * placeholder, a snapshot that has one pending, and a message typed while it waits (which
 * declines it and goes on queued behind the turn).
 */
import type { EventPayloadInput, SessionSnapshot } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import {
  applyLive,
  applyReplay,
  createStream,
  HOME,
  makeSnapshot,
  makeSummary,
  type Stream,
} from "./__fixtures__/streams.ts";
import { emptyEngineSlice, reduce } from "./reducer.ts";
import { selectComposer, selectSidebar, selectTranscript } from "./selectors.ts";
import { type AppStoreApi, createAppStore, initialAppState } from "./store.ts";
import type { AppStore, EngineSlice } from "./types.ts";

const ASK: Omit<EventPayloadInput<"elicitation.requested">, "sessionId" | "seq" | "time"> = {
  turnId: "t1",
  requestId: "e1",
  toolCallId: "c1",
  server: "tracker",
  message: "Which project?",
  mode: "form",
  fields: [
    {
      name: "project",
      type: "string",
      title: "Project",
      description: null,
      required: true,
      format: null,
      minLength: null,
      maxLength: null,
      default: null,
    },
  ],
  url: null,
};

function running(stream: Stream): void {
  stream.emit("session.status", { status: "working", waitingOn: null, message: null });
  stream.emit("turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text: "File the issue" }], mentions: [] },
    command: null,
  });
  stream.emit("message.started", { turnId: "t1", messageId: "m1" });
  stream.emit("message.finished", {
    turnId: "t1",
    messageId: "m1",
    text: "",
    reasoning: null,
    toolCalls: [{ toolCallId: "c1", toolName: "mcp__tracker__create_issue" }],
  });
  stream.emit("tool.started", {
    turnId: "t1",
    messageId: "m1",
    toolCallId: "c1",
    toolName: "mcp__tracker__create_issue",
    input: {},
  });
}

function opened(): EngineSlice {
  return applyReplay(
    reduce(emptyEngineSlice(), { type: "snapshot", snapshot: makeSnapshot(makeSummary("s1")) }),
    "s1",
    [],
  );
}

function app(slice: EngineSlice): AppStore {
  return { ...initialAppState(HOME), ...slice } as AppStore;
}

describe("a server's request for input in the state", () => {
  it("adds a card after the call, is pending and waited on, and closes when answered", () => {
    const stream = createStream("s1");
    running(stream);
    stream.emit("elicitation.requested", ASK);
    stream.emit("session.status", {
      status: "waiting",
      waitingOn: "elicitation",
      message: "Waiting for your input",
    });
    let slice = applyLive(opened(), stream.events);
    const items = slice.transcripts.s1 ?? [];
    expect(items.map((item) => item.kind).slice(-2)).toEqual(["tool", "elicitation"]);
    expect(items.at(-1)).toMatchObject({
      kind: "elicitation",
      id: "elicitation:e1",
      server: "tracker",
      state: "pending",
      response: null,
    });
    expect(slice.pending.s1).toEqual([{ kind: "elicitation", requestId: "e1", turnId: "t1" }]);
    expect(slice.sessions.s1?.waitingOn).toBe("elicitation");
    const state = app(slice);
    expect(selectComposer(state, "s1")?.placeholder).toBe(
      "Waiting on you. Answer the form above; a message here declines it.",
    );
    const row = selectSidebar(state, Date.now())
      .flatMap((group) => group.rows)
      .find((r) => r.sessionId === "s1");
    expect(row?.subtitle).toBe("Needs you: fill in tracker’s form");

    const next = createStream("s1", { seq: stream.events.length });
    next.emit("request.resolved", {
      kind: "elicitation",
      turnId: "t1",
      requestId: "e1",
      outcome: "answered",
      response: { action: "accept", content: { project: "tally" } },
    });
    slice = applyLive(slice, next.events);
    expect(slice.pending.s1).toEqual([]);
    expect(slice.transcripts.s1?.at(-1)).toMatchObject({
      state: "answered",
      response: { action: "accept", content: { project: "tally" } },
    });
    expect(selectTranscript(app(slice), "s1")?.items.at(-1)?.kind).toBe("elicitation");
  });

  it("keeps a subagent's label on the card it raised in the parent", () => {
    const stream = createStream("s1");
    running(stream);
    const agent = {
      agentId: "agent-1",
      sessionId: "s1-agent",
      agentType: "booker",
      description: "Book",
    };
    stream.emit("elicitation.requested", { ...ASK, toolCallId: "agent-call", agent });
    const slice = applyLive(opened(), stream.events);
    expect(slice.transcripts.s1?.at(-1)).toMatchObject({
      kind: "elicitation",
      agent,
      toolCallId: "agent-call",
    });
    expect(slice.pending.s1).toEqual([{ kind: "elicitation", requestId: "e1", turnId: "t1" }]);
  });

  it("asks the person to open a page in the sidebar, and is cancelled when the turn ends", () => {
    const stream = createStream("s1");
    running(stream);
    stream.emit("elicitation.requested", {
      ...ASK,
      toolCallId: null,
      mode: "url",
      fields: [],
      url: "https://tracker.example.com/connect",
    });
    let slice = applyLive(opened(), stream.events);
    const row = selectSidebar(app(slice), Date.now())
      .flatMap((group) => group.rows)
      .find((r) => r.sessionId === "s1");
    expect(row?.subtitle).toBe("Needs you: open a page for tracker");
    const end = createStream("s1", { seq: stream.events.length });
    end.emit("turn.finished", {
      turnId: "t1",
      stopReason: "interrupted",
      finalText: null,
      error: null,
      durationMs: 10,
    });
    slice = applyLive(slice, end.events);
    expect(slice.pending.s1).toEqual([]);
    expect(slice.transcripts.s1?.find((item) => item.kind === "elicitation")).toMatchObject({
      state: "cancelled",
    });
  });

  it("lists one a snapshot has pending", () => {
    const snapshot: SessionSnapshot = makeSnapshot(makeSummary("s1", { status: "waiting" }), {
      pending: [{ kind: "elicitation", ...ASK }],
      activeTurnId: "t1",
    });
    const slice = reduce(emptyEngineSlice(), { type: "snapshot", snapshot });
    expect(slice.pending.s1).toEqual([{ kind: "elicitation", requestId: "e1", turnId: "t1" }]);
    expect(slice.sessions.s1?.waitingOn).toBe("elicitation");
  });
});

// --- The composer, against the fake engine --------------------------------------------------------

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

describe("a message typed while a server's form waits", () => {
  it("declines the request and is queued to go when the turn ends", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    const stream = createStream("s1");
    running(stream);
    stream.emit("elicitation.requested", ASK);
    stream.emit("session.status", { status: "waiting", waitingOn: "elicitation", message: null });
    engine.emitAll("s1", stream.events);
    const bridge = createFakeBridge({ engine });
    const store = createAppStore({ bridge });
    harnesses.push({ engine, bridge, store });
    const actions = store.getState().actions;
    await actions.start();
    actions.selectSession("s1");
    await vi.waitFor(() => expect(store.getState().sessions.s1?.loaded).toBe(true));

    actions.setDraft("s1", "Use the other tracker");
    await actions.submit("s1", "Use the other tracker");
    expect(engine.callsOf("elicitation.respond")).toEqual([
      { sessionId: "s1", requestId: "e1", action: "decline" },
    ]);
    expect(engine.callsOf("session.prompt")).toEqual([]);
    expect(store.getState().ui.queues.s1).toEqual([
      expect.objectContaining({ state: "queued", text: "Use the other tracker" }),
    ]);
    expect(store.getState().ui.drafts.s1).toBeUndefined();
  });

  it("answers through the action", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    const stream = createStream("s1");
    running(stream);
    stream.emit("elicitation.requested", ASK);
    engine.emitAll("s1", stream.events);
    const bridge = createFakeBridge({ engine });
    const store = createAppStore({ bridge });
    harnesses.push({ engine, bridge, store });
    const actions = store.getState().actions;
    await actions.start();
    actions.selectSession("s1");
    await vi.waitFor(() => expect(store.getState().sessions.s1?.loaded).toBe(true));
    await actions.respondElicitation("s1", "e1", { action: "accept", content: { project: "a" } });
    expect(engine.callsOf("elicitation.respond")).toEqual([
      { sessionId: "s1", requestId: "e1", action: "accept", content: { project: "a" } },
    ]);
  });
});
