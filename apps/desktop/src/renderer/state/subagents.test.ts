/**
 * Subagents in the state: each session keeps its agents from `subagent.updated` (the latest per
 * agent), the call that started an agent's task carries its state, a replay rebuilds both, and
 * an agent's own transcript is read with `session.replay` on its session, again as it moves on.
 */
import type { SubagentInfo } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import {
  applyLive,
  applyReplay,
  createStream,
  makeSubagent,
  makeSummary,
  openSession,
  type Stream,
} from "./__fixtures__/streams.ts";
import { selectSubagentPanel, selectTasksPane, selectTranscript } from "./selectors.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";
import type { ToolCallItem, UserMessageItem } from "./types.ts";

const ID = "s1";

function agentCall(s: Stream, toolCallId = "c1", input: Record<string, unknown> = {}): void {
  s.emit("message.started", { turnId: "t1", messageId: `m-${toolCallId}` });
  s.emit("message.finished", {
    turnId: "t1",
    messageId: `m-${toolCallId}`,
    text: "",
    reasoning: null,
    toolCalls: [{ toolCallId, toolName: "Agent" }],
  });
  s.emit("tool.started", {
    turnId: "t1",
    messageId: `m-${toolCallId}`,
    toolCallId,
    toolName: "Agent",
    input: {
      description: "Find the config loader",
      prompt: "Find where the config is loaded",
      subagent_type: "Explore",
      ...input,
    },
  });
}

function turnStarted(s: Stream, turnId: string, text: string): void {
  s.emit("session.status", { status: "working", waitingOn: null, message: null });
  s.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text }], mentions: [] },
    command: null,
  });
}

function toolItem(items: readonly unknown[], toolCallId: string): ToolCallItem | undefined {
  return (items as ToolCallItem[]).find(
    (item) => item.kind === "tool" && item.toolCallId === toolCallId,
  );
}

describe("subagents in the reducer", () => {
  it("keeps the latest state of each agent, oldest first, and puts it on its call", () => {
    const s = createStream(ID);
    turnStarted(s, "t1", "Look around");
    agentCall(s);
    s.emit("subagent.updated", {
      agent: makeSubagent("agent-1", { status: "queued", queuePosition: 2, toolUses: 0 }),
    });
    s.emit("subagent.updated", { agent: makeSubagent("agent-2", { toolCallId: null }) });
    s.emit("subagent.updated", {
      agent: makeSubagent("agent-1", { status: "completed", result: "In `src/config.ts`." }),
    });
    const slice = applyLive(openSession(makeSummary(ID)), s.events);
    const session = slice.sessions[ID];
    expect(session?.subagents.map((agent) => [agent.agentId, agent.status])).toEqual([
      ["agent-1", "completed"],
      ["agent-2", "running"],
    ]);
    const call = toolItem(slice.transcripts[ID] ?? [], "c1");
    expect(call?.agent?.status).toBe("completed");
    expect(call?.agent?.result).toBe("In `src/config.ts`.");

    // A replay of the same log rebuilds the same thing.
    const replayed = applyReplay(openSession(makeSummary(ID)), ID, s.events);
    expect(replayed.sessions[ID]?.subagents).toEqual(session?.subagents);
    expect(toolItem(replayed.transcripts[ID] ?? [], "c1")?.agent).toEqual(call?.agent);
  });

  it("joins an update that came before its call's start", () => {
    const s = createStream(ID);
    turnStarted(s, "t1", "Look around");
    s.emit("subagent.updated", { agent: makeSubagent("agent-1", { status: "queued" }) });
    agentCall(s);
    const slice = applyLive(openSession(makeSummary(ID)), s.events);
    expect(toolItem(slice.transcripts[ID] ?? [], "c1")?.agent?.status).toBe("queued");
  });

  it("leaves an earlier call with the task it started when a SendMessage starts another", () => {
    const s = createStream(ID);
    turnStarted(s, "t1", "Look around");
    agentCall(s);
    s.emit("subagent.updated", {
      agent: makeSubagent("agent-1", { status: "completed", result: "First answer" }),
    });
    s.emit("tool.started", {
      turnId: "t1",
      messageId: "m-c1",
      toolCallId: "c2",
      toolName: "SendMessage",
      input: { to: "agent-1", message: "Now check the tests" },
    });
    s.emit("subagent.updated", {
      agent: makeSubagent("agent-1", { toolCallId: "c2", status: "running", result: null }),
    });
    const items = applyLive(openSession(makeSummary(ID)), s.events).transcripts[ID] ?? [];
    expect(toolItem(items, "c1")?.agent?.result).toBe("First answer");
    expect(toolItem(items, "c2")?.agent?.status).toBe("running");
  });

  it("draws the turn the engine starts for a background agent as a notice", () => {
    const s = createStream(ID);
    s.emit("subagent.updated", {
      agent: makeSubagent("agent-1", {
        background: true,
        status: "completed",
        endedAt: s.time,
        result: "Found it",
      }),
    });
    turnStarted(s, "t2", "Background agent agent-1 (Explore: Find the config loader) finished.");
    turnStarted(s, "t3", "Background agent is what I typed");
    const items = applyLive(openSession(makeSummary(ID)), s.events).transcripts[ID] ?? [];
    const users = items.filter((item): item is UserMessageItem => item.kind === "user");
    expect(users.map((item) => item.fromAgent ?? false)).toEqual([true, true]);

    // Without an ended background agent, the same words are the person's.
    const t = createStream(ID);
    turnStarted(t, "t1", "Background agent tasks: explain them");
    const plain = applyLive(openSession(makeSummary(ID)), t.events).transcripts[ID] ?? [];
    expect((plain[0] as UserMessageItem).fromAgent).toBeUndefined();
  });

  it("lists background agents in the Tasks pane", () => {
    const s = createStream(ID);
    s.emit("subagent.updated", { agent: makeSubagent("agent-1") });
    s.emit("subagent.updated", { agent: makeSubagent("agent-2", { background: true }) });
    const store = createAppStore({ bridge: createFakeBridge({ engine: new FakeEngine() }) });
    store.setState(applyLive(openSession(makeSummary(ID)), s.events));
    const pane = selectTasksPane(store.getState(), ID);
    expect(pane?.agents.map((agent) => agent.agentId)).toEqual(["agent-2"]);
    expect(selectTasksPane(store.getState(), ID)).toBe(pane);
  });
});

// --- The agent's own transcript ----------------------------------------------------------------

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
  child: Stream;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

const CHILD = "s1-agent-1";

/** `s1` open and selected, with an Explore agent running; its session's log is `child`. */
async function started(): Promise<Harness> {
  const engine = new FakeEngine();
  engine.addSession(ID);
  const child = createStream(CHILD);
  engine.overrides["session.replay"] = (params) => {
    if (params.sessionId !== CHILD) {
      const session = engine.session(params.sessionId);
      const after = session.log.filter((event) => event.payload.seq > params.afterSeq);
      return { events: after, lastSeq: session.summary.lastSeq, hasMore: false };
    }
    const after = child.events.filter((event) => event.payload.seq > params.afterSeq);
    const limit = params.limit ?? after.length;
    return { events: after.slice(0, limit), lastSeq: child.seq, hasMore: after.length > limit };
  };
  const bridge = createFakeBridge({ engine, windowState: { selectedSessionId: ID } });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store, child };
  harnesses.push(harness);
  await store.getState().actions.start();
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.loaded).toBe(true));
  return harness;
}

function emitAgent(engine: FakeEngine, changes: Partial<SubagentInfo> = {}): void {
  engine.emit(ID, "subagent.updated", { agent: makeSubagent("agent-1", changes) });
}

function childReplays(engine: FakeEngine): { sessionId: string; afterSeq: number }[] {
  return engine
    .callsOf("session.replay")
    .filter((params) => (params as { sessionId: string }).sessionId === CHILD) as {
    sessionId: string;
    afterSeq: number;
  }[];
}

describe("an agent's own transcript", () => {
  it("opens in place of the session's, read with session.replay, and follows the agent", async () => {
    const { engine, store, child } = await started();
    turnStarted(child, "ct1", "Find where the config is loaded");
    child.emit("message.started", { turnId: "ct1", messageId: "cm1" });
    child.emit("message.finished", {
      turnId: "ct1",
      messageId: "cm1",
      text: "",
      reasoning: null,
      toolCalls: [{ toolCallId: "cc1", toolName: "Read" }],
    });
    child.emit("tool.started", {
      turnId: "ct1",
      messageId: "cm1",
      toolCallId: "cc1",
      toolName: "Read",
      input: { file_path: "/Users/you/code/tally/src/config.ts" },
    });
    emitAgent(engine);
    await vi.waitFor(() => expect(store.getState().sessions[ID]?.subagents).toHaveLength(1));

    store.getState().actions.openSubagent(ID, "agent-1");
    await vi.waitFor(() =>
      expect(selectSubagentPanel(store.getState(), ID)?.transcript?.loaded).toBe(true),
    );
    const panel = selectSubagentPanel(store.getState(), ID);
    expect(panel?.title).toBe("Explore agent: Find the config loader");
    expect(panel?.transcript?.sessionId).toBe(CHILD);
    expect(panel?.transcript?.items.map((item) => item.kind)).toEqual(["user", "tool"]);
    expect(childReplays(engine)).toEqual([expect.objectContaining({ afterSeq: 0 })]);
    // The agent's session stays out of the sidebar's sessions.
    expect(store.getState().sessions[CHILD]).toBeUndefined();

    // The agent moves on: its transcript is read again from where it stopped.
    const seen = child.seq;
    child.emit("tool.finished", {
      turnId: "ct1",
      toolCallId: "cc1",
      toolName: "Read",
      outcome: "success",
      content: [{ type: "text", text: "export function loadConfig() {}" }],
      display: null,
      durationMs: 10,
    });
    child.emit("message.started", { turnId: "ct1", messageId: "cm2" });
    child.emit("message.finished", {
      turnId: "ct1",
      messageId: "cm2",
      text: "It is `loadConfig` in src/config.ts.",
      reasoning: null,
      toolCalls: [],
    });
    emitAgent(engine, { status: "completed", result: "It is `loadConfig` in src/config.ts." });
    await vi.waitFor(() =>
      expect(
        selectSubagentPanel(store.getState(), ID)?.transcript?.items.map((item) => item.kind),
      ).toEqual(["user", "tool", "assistant"]),
    );
    expect(childReplays(engine).at(-1)).toEqual(expect.objectContaining({ afterSeq: seen }));
    expect(selectSubagentPanel(store.getState(), ID)?.agent.status).toBe("completed");

    // Closed, it is not read again; the parent's transcript is what shows.
    store.getState().actions.closeSubagent();
    const reads = childReplays(engine).length;
    emitAgent(engine, { status: "completed", toolUses: 3 });
    await vi.waitFor(() => expect(store.getState().sessions[ID]?.subagents[0]?.toolUses).toBe(3));
    expect(childReplays(engine)).toHaveLength(reads);
    expect(selectSubagentPanel(store.getState(), ID)).toBeNull();
    expect(selectTranscript(store.getState(), ID)?.sessionId).toBe(ID);
  });

  it("says why when the agent's transcript cannot be read", async () => {
    const { engine, store } = await started();
    emitAgent(engine);
    await vi.waitFor(() => expect(store.getState().sessions[ID]?.subagents).toHaveLength(1));
    const replay = engine.overrides["session.replay"];
    engine.overrides["session.replay"] = (params, context) => {
      if (params.sessionId === CHILD) throw new Error("No session has the id s1-agent-1");
      return (replay as NonNullable<typeof replay>)(params, context);
    };
    store.getState().actions.openSubagent(ID, "agent-1");
    await vi.waitFor(() =>
      expect(selectSubagentPanel(store.getState(), ID)?.error).toMatch(
        /^Could not read the agent's transcript/,
      ),
    );
  });

  it("closes when another session is shown, and stops an agent with subagent.stop", async () => {
    const { engine, store } = await started();
    emitAgent(engine, { background: true });
    await vi.waitFor(() => expect(store.getState().sessions[ID]?.subagents).toHaveLength(1));
    store.getState().actions.openSubagent(ID, "agent-1");
    expect(store.getState().ui.openSubagent).toEqual({ sessionId: ID, agentId: "agent-1" });
    store.getState().actions.selectSession("s2");
    expect(store.getState().ui.openSubagent).toBeNull();

    await expect(store.getState().actions.stopSubagent(ID, "agent-1")).resolves.toBe(true);
    expect(engine.callsOf("subagent.stop")).toEqual([{ sessionId: ID, agentId: "agent-1" }]);
    await vi.waitFor(() =>
      expect(store.getState().sessions[ID]?.subagents[0]?.status).toBe("stopped"),
    );
  });
});
