import { readFile } from "node:fs/promises";
import path from "node:path";
import { stalled, text, toolCall } from "@dawg/mock-model";
import {
  type EngineEvent,
  ErrorCodes,
  EVENT_NAMES,
  METHOD_NAMES,
  PROTOCOL_VERSION,
  RpcError,
} from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ask, type Setup, setup } from "./__fixtures__/setup.ts";
import { redactPaths } from "./errors.ts";

let s: Setup | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

/** Turn ids are per session ("turn-<seq>"), so a turn is named by both. */
const finished = (sessionId: string, turnId: string) => (e: EngineEvent) =>
  e.event === "turn.finished" && e.payload.sessionId === sessionId && e.payload.turnId === turnId;

const STREAMING = new Set(["message.delta", "reasoning.delta", "tool.progress", "prompt.progress"]);

describe("initialize", () => {
  it("lists every method and event and refuses work before it", async () => {
    s = await setup();
    const c = await s.connect();
    const second = await rpcError(
      c.client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "again", version: "1" },
        capabilities: {},
      }),
    );
    expect(second.code).toBe(ErrorCodes.InvalidState);

    const { createClient, createMemoryTransportPair } = await import("@dawg/protocol");
    const { createEngineHost } = await import("./host.ts");
    const [a, b] = createMemoryTransportPair();
    const host = createEngineHost(s.engine, b, { engineInfo: { name: "dawg", version: "9" } });
    const raw = createClient(a);
    const early = await rpcError(raw.request("session.list", {}));
    expect(early.code).toBe(ErrorCodes.NotInitialized);
    const result = await raw.initialize({ client: { name: "t", version: "1" }, capabilities: {} });
    expect(result.engine).toEqual({ name: "dawg", version: "9" });
    expect(result.capabilities.methods.sort()).toEqual([...METHOD_NAMES].sort());
    expect(result.capabilities.events.sort()).toEqual([...EVENT_NAMES].sort());
    raw.close();
    await host.done;
  });
});

describe("sessions", () => {
  it("creates, lists, renames, archives, forks and replays", async () => {
    s = await setup({ script: [text("hello")] });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project, title: "First" });
    expect(snap.session.cwd).toBe(s.project);
    expect(snap.commands.map((x) => x.name)).toEqual(
      expect.arrayContaining(["help", "compact", "context", "init", "status", "permissions"]),
    );
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: ask("hi"),
    });
    const end = await c.waitFor(finished(snap.session.id, turnId));
    expect(end.payload).toMatchObject({ stopReason: "completed", finalText: "hello" });

    const listed = await c.client.request("session.list", { projectDir: s.project });
    expect(listed.sessions.map((x) => x.id)).toEqual([snap.session.id]);

    const renamed = await c.client.request("session.rename", {
      sessionId: snap.session.id,
      title: "Renamed",
    });
    expect(renamed.session.title).toBe("Renamed");
    const archived = await c.client.request("session.archive", { sessionId: snap.session.id });
    expect(archived.session.archived).toBe(true);
    expect((await c.client.request("session.list", {})).sessions).toEqual([]);
    expect(
      (await c.client.request("session.list", { includeArchived: true })).sessions,
    ).toHaveLength(1);

    const fork = await c.client.request("session.fork", { sessionId: snap.session.id });
    expect(fork.session.forkedFrom?.sessionId).toBe(snap.session.id);
    expect(fork.session.title).toBe("Renamed (fork)");
    expect(c.host.openSessions()).toEqual([snap.session.id, fork.session.id]);

    const replay = await c.client.request("session.replay", {
      sessionId: snap.session.id,
      afterSeq: 0,
    });
    const live = c.events.filter(
      (e) => e.payload.sessionId === snap.session.id && !STREAMING.has(e.event),
    );
    expect(replay.events.map((e) => e.payload.seq)).toEqual(live.map((e) => e.payload.seq));
    expect(replay.lastSeq).toBe(live.at(-1)?.payload.seq);
    expect(c.problems).toEqual([]);
  });

  it("resumes a stored session and replays after a reconnect without gaps or doubles", async () => {
    s = await setup({ script: [text("one"), text("two")] });
    const first = await s.connect();
    const snap = await first.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    const t1 = await first.client.request("session.prompt", { sessionId: id, prompt: ask("1") });
    await first.waitFor(finished(id, t1.turnId));
    const seen = first.events.filter((e) => !STREAMING.has(e.event));
    const highWater = seen[Math.floor(seen.length / 2)]?.payload.seq ?? 0;
    first.client.close();
    await first.host.done;
    // Idle when the window closed: the session was closed and its lock released.
    expect(s.engine.get(id)).toBeUndefined();

    const second = await s.connect();
    const resumed = await second.client.request("session.resume", { sessionId: id });
    expect(resumed.session.lastSeq).toBeGreaterThanOrEqual(seen.at(-1)?.payload.seq ?? 0);
    const caught = await second.client.request("session.replay", {
      sessionId: id,
      afterSeq: highWater,
    });
    const expected = seen.filter((e) => e.payload.seq > highWater).map((e) => e.payload.seq);
    expect(caught.events.map((e) => e.payload.seq).slice(0, expected.length)).toEqual(expected);
    const t2 = await second.client.request("session.prompt", { sessionId: id, prompt: ask("2") });
    await second.waitFor(finished(id, t2.turnId));
    const after = second.events.filter((e) => e.payload.sessionId === id);
    expect(after[0]?.payload.seq).toBe(resumed.session.lastSeq + 1);
    expect(second.problems).toEqual([]);
  });

  it("serves two sessions on one connection, each in its own order", async () => {
    s = await setup({
      script: {
        replies: [],
        lanes: {
          alpha: { match: { lastUser: "alpha" }, replies: [text("A reply")] },
          beta: { match: { lastUser: "beta" }, replies: [text("B reply")] },
        },
      },
    });
    const c = await s.connect();
    const a = await c.client.request("session.create", { cwd: s.project });
    const b = await c.client.request("session.create", { cwd: s.project });
    const [ta, tb] = await Promise.all([
      c.client.request("session.prompt", { sessionId: a.session.id, prompt: ask("alpha") }),
      c.client.request("session.prompt", { sessionId: b.session.id, prompt: ask("beta") }),
    ]);
    const [ea, eb] = await Promise.all([
      c.waitFor(finished(a.session.id, ta.turnId)),
      c.waitFor(finished(b.session.id, tb.turnId)),
    ]);
    expect(ea.payload.sessionId).toBe(a.session.id);
    expect(ea.payload).toMatchObject({ finalText: "A reply" });
    expect(eb.payload).toMatchObject({ finalText: "B reply" });
    for (const id of [a.session.id, b.session.id]) {
      const names = c.names(id);
      expect(names.indexOf("turn.started")).toBeLessThan(names.indexOf("turn.finished"));
    }
    expect(c.problems).toEqual([]);
  });

  it("forwards only the sessions a connection has open", async () => {
    s = await setup({ script: [text("mine")] });
    const owner = await s.connect();
    const other = await s.connect();
    const snap = await owner.client.request("session.create", { cwd: s.project });
    const { turnId } = await owner.client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: ask("x"),
    });
    await owner.waitFor(finished(snap.session.id, turnId));
    expect(other.events).toEqual([]);
  });
});

describe("session.delete", () => {
  it("closes the session on every connection that holds it and removes it", async () => {
    s = await setup({ script: [text("hello")] });
    const first = await s.connect();
    const second = await s.connect();
    const snap = await first.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    const { turnId } = await first.client.request("session.prompt", {
      sessionId: id,
      prompt: ask("hi"),
    });
    await first.waitFor(finished(id, turnId));
    await second.client.request("session.resume", { sessionId: id });

    expect(await second.client.request("session.delete", { sessionId: id })).toEqual({});
    for (const c of [first, second]) {
      const deleted = await c.waitFor(
        (e) => e.event === "session.deleted" && e.payload.sessionId === id,
      );
      expect(c.names(id).at(-1)).toBe("session.deleted");
      expect(deleted.payload.seq).toBe(Math.max(...c.events.map((e) => e.payload.seq)));
      expect(c.host.openSessions()).toEqual([]);
      expect(c.problems).toEqual([]);
    }
    expect(s.engine.get(id)).toBeUndefined();

    const listed = await first.client.request("session.list", { projectDir: s.project });
    expect(listed.sessions).toEqual([]);
    // One at a time, so no failure goes unawaited.
    const later = [
      () => first.client.request("session.prompt", { sessionId: id, prompt: ask("again") }),
      () => second.client.request("session.replay", { sessionId: id, afterSeq: 0 }),
      () => second.client.request("session.resume", { sessionId: id }),
      () => first.client.request("session.delete", { sessionId: id }),
    ];
    for (const request of later) {
      expect((await rpcError(request())).code).toBe(ErrorCodes.SessionNotFound);
    }
  });

  it("interrupts a running turn before the session goes", async () => {
    s = await setup({ script: [stalled(text("never ends"))] });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: id,
      prompt: ask("go"),
    });
    await c.waitFor((e) => e.event === "turn.started");
    await c.client.request("session.delete", { sessionId: id });
    await c.waitFor((e) => e.event === "session.deleted" && e.payload.sessionId === id);
    const names = c.names(id);
    expect(names.slice(-3)).toEqual(["turn.finished", "session.status", "session.deleted"]);
    expect((await c.waitFor(finished(id, turnId))).payload).toMatchObject({
      stopReason: "interrupted",
    });
    expect(c.problems).toEqual([]);
  });

  it("deletes a stored session this connection never opened", async () => {
    s = await setup();
    const owner = await s.connect();
    const snap = await owner.client.request("session.create", { cwd: s.project });
    owner.client.close();
    await owner.host.done;

    const other = await s.connect();
    await other.client.request("session.delete", { sessionId: snap.session.id });
    const listed = await other.client.request("session.list", { projectDir: s.project });
    expect(listed.sessions).toEqual([]);
    expect(other.events).toEqual([]);
  });
});

describe("a whole turn with requests answered through the protocol", () => {
  it("asks permission, applies the answer and finishes", async () => {
    s = await setup({
      script: [
        toolCall("Write", { file_path: "a.txt", content: "allowed\n" }),
        toolCall("Write", { file_path: "b.txt", content: "refused\n" }),
        text("done"),
      ],
    });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: id,
      prompt: ask("write files"),
    });
    const first = await c.waitFor((e) => e.event === "permission.requested");
    if (first.event !== "permission.requested") throw new Error("unreachable");
    expect(first.payload.request.toolName).toBe("Write");
    const status = await c.waitFor(
      (e) => e.event === "session.status" && e.payload.status === "waiting",
    );
    expect(status.payload).toMatchObject({ waitingOn: "permission" });
    await c.client.request("permission.respond", {
      sessionId: id,
      requestId: first.payload.request.requestId,
      response: { behavior: "allow", scope: "once" },
    });
    const second = await c.waitFor(
      (e) =>
        e.event === "permission.requested" &&
        e.payload.request.requestId !== first.payload.request.requestId,
    );
    if (second.event !== "permission.requested") throw new Error("unreachable");
    await c.client.request("permission.respond", {
      sessionId: id,
      requestId: second.payload.request.requestId,
      response: { behavior: "deny", message: "not that one" },
    });
    const end = await c.waitFor(finished(id, turnId));
    expect(end.payload).toMatchObject({ stopReason: "completed", finalText: "done" });
    expect(await readFile(path.join(s.project, "a.txt"), "utf8")).toBe("allowed\n");
    await expect(readFile(path.join(s.project, "b.txt"), "utf8")).rejects.toThrow();
    const outcomes = c.events
      .filter((e) => e.event === "tool.finished")
      .map((e) => (e.event === "tool.finished" ? e.payload.outcome : null));
    expect(outcomes).toEqual(["success", "denied"]);
    // Answering again: the request is gone.
    const again = await rpcError(
      c.client.request("permission.respond", {
        sessionId: id,
        requestId: first.payload.request.requestId,
        response: { behavior: "allow", scope: "once" },
      }),
    );
    expect(again.code).toBe(ErrorCodes.RequestNotFound);
    expect(c.problems).toEqual([]);
  });

  it("denies by itself when the client said it cannot answer", async () => {
    s = await setup({
      script: [toolCall("Write", { file_path: "a.txt", content: "x" }), text("gave up")],
    });
    const c = await s.connect({
      capabilities: { permissionPrompts: false, questions: false, planApproval: false },
    });
    const snap = await c.client.request("session.create", { cwd: s.project });
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: ask("write"),
    });
    await c.waitFor(finished(snap.session.id, turnId));
    expect(c.events.some((e) => e.event === "permission.requested")).toBe(false);
    expect(c.events.find((e) => e.event === "tool.finished")?.payload).toMatchObject({
      outcome: "denied",
    });
  });

  it("asks a question and carries the answer back", async () => {
    s = await setup({
      script: [
        toolCall("AskUserQuestion", {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [{ label: "SQLite" }, { label: "Postgres" }],
              multiSelect: false,
            },
          ],
        }),
        text("Using SQLite."),
      ],
    });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project });
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: ask("set up storage"),
    });
    const asked = await c.waitFor((e) => e.event === "question.asked");
    if (asked.event !== "question.asked") throw new Error("unreachable");
    await c.client.request("question.respond", {
      sessionId: snap.session.id,
      requestId: asked.payload.requestId,
      response: {
        outcome: "answered",
        answers: [{ question: "Which database?", selected: ["SQLite"] }],
      },
    });
    const end = await c.waitFor(finished(snap.session.id, turnId));
    expect(end.payload).toMatchObject({ stopReason: "completed" });
    const resolved = c.events.find((e) => e.event === "request.resolved");
    expect(resolved?.payload).toMatchObject({ kind: "question", outcome: "answered" });
    expect(JSON.stringify(s.mock.messages(-1))).toContain("SQLite");
  });

  it("proposes a plan and switches mode on approval", async () => {
    s = await setup({
      script: [
        toolCall("ExitPlanMode", { plan: "1. Write a.txt" }),
        toolCall("Write", { file_path: "a.txt", content: "planned\n" }),
        text("done"),
      ],
    });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project, mode: "plan" });
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: ask("plan it"),
    });
    const proposed = await c.waitFor((e) => e.event === "plan.proposed");
    if (proposed.event !== "plan.proposed") throw new Error("unreachable");
    expect(proposed.payload.plan).toContain("Write a.txt");
    await c.client.request("plan.respond", {
      sessionId: snap.session.id,
      requestId: proposed.payload.requestId,
      response: { decision: "approve", mode: "acceptEdits" },
    });
    await c.waitFor(finished(snap.session.id, turnId));
    expect(await readFile(path.join(s.project, "a.txt"), "utf8")).toBe("planned\n");
    const updated = c.events.filter((e) => e.event === "session.updated").at(-1);
    expect(updated?.payload).toMatchObject({ mode: "acceptEdits" });
  });

  it("interrupts a running turn", async () => {
    s = await setup({ script: [stalled(text("never ends"))] });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project });
    const { turnId } = await c.client.request("session.prompt", {
      sessionId: snap.session.id,
      prompt: ask("go"),
    });
    await c.waitFor((e) => e.event === "turn.started");
    const busy = await rpcError(
      c.client.request("session.prompt", { sessionId: snap.session.id, prompt: ask("again") }),
    );
    expect(busy.code).toBe(ErrorCodes.SessionBusy);
    const { interrupted } = await c.client.request("session.interrupt", {
      sessionId: snap.session.id,
    });
    expect(interrupted).toBe(true);
    const end = await c.waitFor(finished(snap.session.id, turnId));
    expect(end.payload).toMatchObject({ stopReason: "interrupted" });
    const idle = await c.client.request("session.interrupt", { sessionId: snap.session.id });
    expect(idle.interrupted).toBe(false);
  });

  it("changes mode, model and effort", async () => {
    s = await setup({
      mock: { templateCaps: { reasoning_effort_levels: ["low", "high"] } },
    });
    s.mock.endpoint.template = { reasoningEffortLevels: ["low", "high"] };
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    expect(
      await c.client.request("session.setMode", { sessionId: id, mode: "acceptEdits" }),
    ).toEqual({ mode: "acceptEdits" });
    expect(await c.client.request("session.setEffort", { sessionId: id, effort: "high" })).toEqual({
      effort: "high",
    });
    const bad = await rpcError(
      c.client.request("session.setEffort", { sessionId: id, effort: "max" }),
    );
    expect(bad.code).toBe(ErrorCodes.InvalidState);
    const model = await c.client.request("session.setModel", { sessionId: id, model: "other" });
    expect(model.model).toBe("other");
    expect(model.modelInfo?.contextWindow).toBe(8192);
  });
});

describe("commands through the protocol", () => {
  it("answers, starts turns and opens sessions; unknown commands never reach the model", async () => {
    s = await setup({ script: [text("I wrote the file.")] });
    const c = await s.connect();
    const snap = await c.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    const help = await c.client.request("session.command", { sessionId: id, name: "help" });
    expect(help.output).toContain("/compact [focus]");
    expect(help.turnId).toBeNull();

    const unknown = await rpcError(
      c.client.request("session.command", { sessionId: id, name: "frobnicate", args: "now" }),
    );
    expect(unknown.code).toBe(ErrorCodes.InvalidParams);
    expect(unknown.message).toContain("/frobnicate");
    const badArgs = await rpcError(
      c.client.request("session.command", { sessionId: id, name: "mode", args: "sideways" }),
    );
    expect(badArgs.code).toBe(ErrorCodes.InvalidParams);
    expect(s.mock.chatRequests).toHaveLength(0);

    const init = await c.client.request("session.command", { sessionId: id, name: "init" });
    expect(init.turnId).not.toBeNull();
    await c.waitFor(finished(id, init.turnId as string));
    expect(JSON.stringify(s.mock.messages(0))).toContain("CLAUDE.md");

    const cleared = await c.client.request("session.command", { sessionId: id, name: "clear" });
    const next = cleared.openedSession;
    expect(next?.session.id).toBeDefined();
    expect(next?.session.id).not.toBe(id);
    expect(c.host.openSessions()).toEqual([next?.session.id]);
    const gone = await rpcError(c.client.request("session.interrupt", { sessionId: id }));
    expect(gone.code).toBe(ErrorCodes.InvalidState);
  });
});

describe("background commands", () => {
  it("sends their updates, serves their output and stops them", async () => {
    s = await setup({
      script: [
        toolCall("Bash", {
          command: "echo listening on 3000; sleep 30",
          description: "Start the dev server",
          run_in_background: true,
        }),
        text("started"),
      ],
    });
    const c = await s.connect();
    const other = await s.connect();
    const snap = await c.client.request("session.create", {
      cwd: s.project,
      mode: "bypassPermissions",
    });
    const sessionId = snap.session.id;
    expect(snap.background).toEqual([]);
    const { turnId } = await c.client.request("session.prompt", {
      sessionId,
      prompt: ask("start the server"),
    });
    await c.waitFor(finished(sessionId, turnId));
    const started = await c.waitFor((e) => e.event === "background.updated");
    expect(started.payload).toMatchObject({
      sessionId,
      task: { taskId: "bash-1", status: "running", description: "Start the dev server" },
    });

    const deadline = Date.now() + 10_000;
    let page = await c.client.request("background.output", { sessionId, taskId: "bash-1" });
    while (page.text === "" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      page = await c.client.request("background.output", { sessionId, taskId: "bash-1" });
    }
    expect(page).toEqual({
      text: "listening on 3000\n",
      nextOffset: 18,
      totalBytes: 18,
      done: false,
    });
    const tail = await c.client.request("background.output", {
      sessionId,
      taskId: "bash-1",
      offset: 13,
      limit: 2,
    });
    expect(tail).toMatchObject({ text: "30", nextOffset: 15 });

    const unknown = await rpcError(
      c.client.request("background.stop", { sessionId, taskId: "bash-7" }),
    );
    expect(unknown.code).toBe(ErrorCodes.InvalidParams);
    expect(unknown.message).toBe("There is no background task bash-7 in this session.");
    const notHere = await rpcError(
      other.client.request("background.output", { sessionId, taskId: "bash-1" }),
    );
    expect(notHere.code).toBe(ErrorCodes.InvalidState);

    expect(await c.client.request("background.stop", { sessionId, taskId: "bash-1" })).toEqual({
      stopped: true,
    });
    const stopped = await c.waitFor(
      (e) => e.event === "background.updated" && e.payload.task.status !== "running",
    );
    expect(stopped.payload).toMatchObject({
      task: { taskId: "bash-1", status: "stopped", stopReason: "requested" },
    });
    expect(await c.client.request("background.stop", { sessionId, taskId: "bash-1" })).toEqual({
      stopped: false,
    });
    expect(
      await c.client.request("background.output", { sessionId, taskId: "bash-1" }),
    ).toMatchObject({ done: true });

    const resumed = await other.client.request("session.resume", { sessionId });
    expect(resumed.background).toEqual([
      expect.objectContaining({ taskId: "bash-1", status: "stopped" }),
    ]);
    expect(c.problems).toEqual([]);
  });
});

describe("errors", () => {
  it("maps runtime errors to protocol codes", async () => {
    s = await setup();
    const owner = await s.connect();
    const other = await s.connect();
    const snap = await owner.client.request("session.create", { cwd: s.project });
    const missing = await rpcError(
      owner.client.request("session.prompt", { sessionId: "nope", prompt: ask("x") }),
    );
    expect(missing.code).toBe(ErrorCodes.SessionNotFound);
    const notHere = await rpcError(
      other.client.request("session.prompt", { sessionId: snap.session.id, prompt: ask("x") }),
    );
    expect(notHere.code).toBe(ErrorCodes.InvalidState);
    const unknownRequest = await rpcError(
      owner.client.request("plan.respond", {
        sessionId: snap.session.id,
        requestId: "request-0",
        response: { decision: "approve" },
      }),
    );
    expect(unknownRequest.code).toBe(ErrorCodes.RequestNotFound);
    const relative = await rpcError(owner.client.request("session.create", { cwd: "project" }));
    expect(relative.code).toBe(ErrorCodes.InvalidParams);
    const notADir = await rpcError(
      owner.client.request("session.create", { cwd: path.join(s.project, "missing") }),
    );
    expect(notADir.code).toBe(ErrorCodes.InvalidState);
    const resumeMissing = await rpcError(
      owner.client.request("session.resume", { sessionId: "abc123" }),
    );
    expect(resumeMissing.code).toBe(ErrorCodes.SessionNotFound);
  });

  it("redacts paths outside the directories the client knows", () => {
    expect(
      redactPaths("Cannot open /Users/someone/.dawg/projects/x/s.jsonl: locked.", ["/w/project"]),
    ).toBe("Cannot open [path]: locked.");
    expect(redactPaths("/w/project/src/a.ts is not a directory.", ["/w/project"])).toBe(
      "/w/project/src/a.ts is not a directory.",
    );
    expect(redactPaths("Unknown command /frobnicate.", [])).toBe("Unknown command /frobnicate.");
  });

  it("keeps internal details out of errors", async () => {
    const problems: unknown[] = [];
    s = await setup({
      engine: {
        models: {
          connect: async () => {
            throw new Error(
              "socket closed at /private/secret/place\n    at internal (file.ts:1:1)",
            );
          },
        },
      },
    });
    const c = await s.connect({ host: { onProblem: (p) => problems.push(p) } });
    const error = await rpcError(c.client.request("session.create", { cwd: s.project }));
    expect(error.code).toBe(ErrorCodes.InternalError);
    expect(error.message).toBe("The engine could not complete session.create.");
    expect(JSON.stringify(error.toJSON())).not.toContain("secret");
    expect(problems).toHaveLength(1);
  });
});

describe("when the client disconnects", () => {
  it("interrupts a running turn and closes the session when nothing may keep it", async () => {
    s = await setup({ script: [stalled(text("never ends"))] });
    const c = await s.connect({ host: { detachGraceMs: 0 } });
    const snap = await c.client.request("session.create", { cwd: s.project });
    await c.client.request("session.prompt", { sessionId: snap.session.id, prompt: ask("go") });
    await c.waitFor((e) => e.event === "turn.started");
    c.client.close();
    await c.host.done;
    expect(s.engine.get(snap.session.id)).toBeUndefined();
    const replay = await s.engine.replay(snap.session.id, 0);
    const end = replay.events.find((e) => e.event === "turn.finished");
    expect(end?.payload).toMatchObject({ stopReason: "interrupted" });
  });

  it("keeps a turn running for a while so another window can take it over", async () => {
    s = await setup({
      script: [toolCall("Write", { file_path: "a.txt", content: "later\n" }), text("finished")],
    });
    const first = await s.connect({ host: { detachGraceMs: 60_000 } });
    const snap = await first.client.request("session.create", { cwd: s.project });
    const id = snap.session.id;
    const { turnId } = await first.client.request("session.prompt", {
      sessionId: id,
      prompt: ask("write"),
    });
    await first.waitFor((e) => e.event === "permission.requested");
    first.client.close();
    await first.host.done;
    const runtime = s.engine.get(id);
    expect(runtime?.busy).toBe(true);

    const second = await s.connect({ host: { detachGraceMs: 60_000 } });
    const resumed = await second.client.request("session.resume", { sessionId: id });
    expect(resumed.activeTurnId).toBe(turnId);
    const pending = resumed.pending[0];
    if (pending?.kind !== "permission") throw new Error("expected a pending permission request");
    await second.client.request("permission.respond", {
      sessionId: id,
      requestId: pending.request.requestId,
      response: { behavior: "allow", scope: "once" },
    });
    const end = await second.waitFor(finished(id, turnId));
    expect(end.payload).toMatchObject({ stopReason: "completed", finalText: "finished" });
    expect(await readFile(path.join(s.project, "a.txt"), "utf8")).toBe("later\n");
    second.client.close();
    await second.host.done;
    expect(s.engine.get(id)).toBeUndefined();
  });

  it("closes an orphaned session once its turn ends", async () => {
    s = await setup({ script: [text(["slow ", "reply"], { pacing: { delayMs: 50 } })] });
    const c = await s.connect({ host: { detachGraceMs: 60_000 } });
    const snap = await c.client.request("session.create", { cwd: s.project });
    await c.client.request("session.prompt", { sessionId: snap.session.id, prompt: ask("go") });
    c.client.close();
    await c.host.done;
    const runtime = s.engine.get(snap.session.id);
    await runtime?.waitForIdle();
    for (let i = 0; i < 100 && s.engine.get(snap.session.id) !== undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(s.engine.get(snap.session.id)).toBeUndefined();
    const replay = await s.engine.replay(snap.session.id, 0);
    expect(replay.events.find((e) => e.event === "turn.finished")?.payload).toMatchObject({
      stopReason: "completed",
    });
  });
});
