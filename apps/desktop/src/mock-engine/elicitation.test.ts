/** A scripted MCP server's request for input in the mock engine: the form, the page, the answers. */
import { ErrorCodes } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import { TRACKER_URL } from "./elicitation.ts";
import { all, type Harness, HOME, harness, type Peer } from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

async function asked(text: string): Promise<{ peer: Peer; id: string }> {
  h = harness();
  const peer = await h.connect();
  const snapshot = await peer.request("session.create", { cwd: `${HOME}/code/tally` });
  const id = snapshot.session.id;
  await peer.request("session.prompt", {
    sessionId: id,
    prompt: { content: [{ type: "text", text }] },
  });
  await h.runAll();
  return { peer, id };
}

describe("the scripted request for input", () => {
  it("asks with a form while the tracker's call runs, checks the answer, then ends the call", async () => {
    const { peer, id } = await asked("File an issue through the MCP form");
    const request = all(peer.of(id), "elicitation.requested")[0]?.payload;
    expect(request).toMatchObject({ server: "tracker", mode: "form", url: null });
    expect(request?.fields.map((f) => f.type)).toEqual([
      "string",
      "string",
      "string",
      "integer",
      "boolean",
      "select",
      "multiselect",
    ]);
    const snapshot = await peer.request("session.resume", { sessionId: id });
    expect(snapshot.pending).toEqual([expect.objectContaining({ kind: "elicitation" })]);
    expect(snapshot.session.status).toBe("waiting");

    const requestId = request?.requestId ?? "";
    const wrong = await peer.failure("elicitation.respond", {
      sessionId: id,
      requestId,
      action: "accept",
      content: { title: "x", reporter: "nope", priority: "normal" },
    });
    expect(wrong.code).toBe(ErrorCodes.InvalidParams);
    const unknown = await peer.failure("elicitation.respond", {
      sessionId: id,
      requestId: "no-such",
      action: "decline",
    });
    expect(unknown.code).toBe(ErrorCodes.RequestNotFound);

    const content = { title: "Rounding bug", reporter: "me@example.com", priority: "high" };
    await peer.request("elicitation.respond", {
      sessionId: id,
      requestId,
      action: "accept",
      content,
    });
    await h.runAll();
    const events = peer.of(id);
    expect(all(events, "request.resolved").at(-1)?.payload).toMatchObject({
      kind: "elicitation",
      outcome: "answered",
      response: { action: "accept", content },
    });
    const finished = all(events, "tool.finished").at(-1)?.payload;
    expect(finished?.toolName).toBe("mcp__tracker__create_issue");
    expect(finished?.content[0]).toMatchObject({ text: expect.stringContaining("Rounding bug") });
    expect(checkConformance(events, { requireClosed: true })).toEqual([]);
    expect(peer.problems).toEqual([]);
  });

  it("asks to open a page, and a decline ends the call", async () => {
    const { peer, id } = await asked("Connect the tracker with the MCP page");
    const request = all(peer.of(id), "elicitation.requested")[0]?.payload;
    expect(request).toMatchObject({ mode: "url", url: TRACKER_URL, fields: [] });
    await peer.request("elicitation.respond", {
      sessionId: id,
      requestId: request?.requestId ?? "",
      action: "decline",
    });
    await h.runAll();
    const events = peer.of(id);
    expect(all(events, "tool.finished").at(-1)?.payload.content[0]).toMatchObject({
      text: "tracker: you declined, so nothing was created.",
    });
    expect(checkConformance(events, { requireClosed: true })).toEqual([]);
  });

  it("is cancelled with the turn", async () => {
    const { peer, id } = await asked("Use the MCP form");
    await peer.request("session.interrupt", { sessionId: id });
    await h.runAll();
    const events = peer.of(id);
    expect(all(events, "request.resolved").at(-1)?.payload).toMatchObject({
      kind: "elicitation",
      outcome: "cancelled",
    });
    expect(checkConformance(events, { requireClosed: true })).toEqual([]);
  });
});
