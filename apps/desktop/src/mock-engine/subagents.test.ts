/** Subagents in the mock engine: a scripted Agent call, the agent's own session, and stopping it. */
import { ErrorCodes } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import { all, type Harness, HOME, harness, type Peer } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

async function newSession(peer: Peer): Promise<string> {
  const snapshot = await peer.request("session.create", { cwd: `${HOME}/code/tally` });
  return snapshot.session.id;
}

function statuses(peer: Peer, sessionId: string): string[] {
  return all(peer.of(sessionId), "subagent.updated").map((event) => event.payload.agent.status);
}

describe("subagents", () => {
  it("runs a foreground Explore agent: queued, running, completed, and the call gets its answer", async () => {
    h = harness();
    const peer = await h.connect();
    const id = await newSession(peer);
    await peer.request("session.prompt", {
      sessionId: id,
      prompt: { content: [{ type: "text", text: "Ask an agent to find the config loader" }] },
    });
    await h.runAll();

    const events = peer.of(id);
    expect(peer.problems).toEqual([]);
    expect(checkConformance(events, { requireClosed: true })).toEqual([]);
    const started = all(events, "tool.started").find((e) => e.payload.toolName === "Agent");
    expect(started?.payload.input).toMatchObject({
      description: "Find the config loader",
      subagent_type: "Explore",
    });
    expect([...new Set(statuses(peer, id))]).toEqual(["queued", "running", "completed"]);
    const last = all(events, "subagent.updated").at(-1)?.payload.agent;
    expect(last).toMatchObject({
      agentId: "agent-1",
      agentType: "Explore",
      toolCallId: started?.payload.toolCallId,
      background: false,
      toolUses: 1,
      queuePosition: null,
    });
    expect(last?.result).toContain("config.toml");
    const finished = all(events, "tool.finished").find((e) => e.payload.toolName === "Agent");
    expect(finished?.payload.outcome).toBe("success");
    expect(finished?.payload.content).toEqual([{ type: "text", text: last?.result }]);
    // Updates come before the call ends, and the call before the turn does.
    const order = events.map((e) => e.event);
    expect(order.lastIndexOf("subagent.updated")).toBeLessThan(order.indexOf("tool.finished"));
    expect(order.indexOf("tool.finished")).toBeLessThan(order.indexOf("turn.finished"));

    // The agent's own session: read with session.replay, never listed.
    const childId = last?.sessionId ?? "";
    const replay = await peer.request("session.replay", { sessionId: childId, afterSeq: 0 });
    expect(checkConformance(replay.events, { requireClosed: true })).toEqual([]);
    const read = all(replay.events, "tool.started")[0];
    expect(read?.payload).toMatchObject({
      toolName: "Read",
      input: { file_path: `${HOME}/code/tally/README.md` },
    });
    expect(all(replay.events, "message.finished").at(-1)?.payload.text).toBe(last?.result);
    const listed = await peer.request("session.list", {});
    expect(listed.sessions.map((s) => s.id)).not.toContain(childId);
    // Later pages carry only what is new.
    const rest = await peer.request("session.replay", {
      sessionId: childId,
      afterSeq: replay.lastSeq,
    });
    expect(rest.events).toEqual([]);
  });

  it("runs a background agent past its turn, then starts a turn to read what it found", async () => {
    h = harness();
    const peer = await h.connect();
    const id = await newSession(peer);
    await peer.request("session.prompt", {
      sessionId: id,
      prompt: {
        content: [{ type: "text", text: "Have an agent look for the config in the background" }],
      },
    });
    await h.runAll();

    const events = peer.of(id);
    expect(checkConformance(events, { requireClosed: true })).toEqual([]);
    const agentCall = all(events, "tool.finished").find((e) => e.payload.toolName === "Agent");
    expect(agentCall?.payload.content).toEqual([
      { type: "text", text: "Started in the background as agent-1." },
    ]);
    const turns = all(events, "turn.started");
    expect(turns).toHaveLength(2);
    const second = turns[1]?.payload.prompt.content[0];
    expect(second?.type === "text" && second.text).toMatch(/^Background agent agent-1 /);
    // The first turn ended before the agent did.
    const order = events.map((e) => e.event);
    const completed = events.findIndex(
      (e) => e.event === "subagent.updated" && e.payload.agent.status === "completed",
    );
    expect(order.indexOf("turn.finished")).toBeLessThan(completed);
    expect(all(events, "subagent.updated").every((e) => e.payload.agent.background)).toBe(true);
  });

  it("stops a running background agent, once", async () => {
    h = harness();
    const peer = await h.connect();
    const id = await newSession(peer);
    await peer.request("session.prompt", {
      sessionId: id,
      prompt: { content: [{ type: "text", text: "Start a background agent for the config" }] },
    });
    // Far enough for the agent to run, not to finish.
    await h.advance(2_500);
    expect(statuses(peer, id).at(-1)).toBe("running");
    await expect(
      peer.request("subagent.stop", { sessionId: id, agentId: "agent-1" }),
    ).resolves.toEqual({ stopped: true });
    await h.runAll();
    expect(statuses(peer, id).at(-1)).toBe("stopped");
    expect(statuses(peer, id).filter((status) => status === "stopped")).toHaveLength(1);
    await expect(
      peer.request("subagent.stop", { sessionId: id, agentId: "agent-1" }),
    ).resolves.toEqual({ stopped: false });
    // No turn of its own for a stopped agent; its session ends with the stop.
    expect(all(peer.of(id), "turn.started")).toHaveLength(1);
    const childId = all(peer.of(id), "subagent.updated")[0]?.payload.agent.sessionId ?? "";
    const replay = await peer.request("session.replay", { sessionId: childId, afterSeq: 0 });
    expect(checkConformance(replay.events, { requireClosed: true })).toEqual([]);
    const error = await peer.failure("subagent.stop", { sessionId: id, agentId: "agent-9" });
    expect(error.code).toBe(ErrorCodes.InvalidParams);
  });

  it("stops a foreground agent and ends the turn that waited on it", async () => {
    h = harness();
    const peer = await h.connect();
    const id = await newSession(peer);
    await peer.request("session.prompt", {
      sessionId: id,
      prompt: { content: [{ type: "text", text: "Ask an agent to find the config loader" }] },
    });
    await h.advance(1_500);
    await peer.request("subagent.stop", { sessionId: id, agentId: "agent-1" });
    await h.runAll();
    const events = peer.of(id);
    expect(checkConformance(events, { requireClosed: true })).toEqual([]);
    const call = all(events, "tool.finished").find((e) => e.payload.toolName === "Agent");
    expect(call?.payload.outcome).toBe("interrupted");
    expect(all(events, "turn.finished")).toHaveLength(1);
    expect(statuses(peer, id).at(-1)).toBe("stopped");
  });
});
