/**
 * A turn that waits on the person when its session stops (closed, or the process ended) waits on
 * when the session opens again: the same request is pending, and answering it carries the turn
 * on. Everything else a stop leaves open is still closed as interrupted (resume.test.ts).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stalled, text, toolCall, toolCalls } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";
import { readSidecar } from "./sidecar.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function toolResults(view: readonly Message[], name: string): string[] {
  return view.filter((m) => m.role === "tool" && m.toolName === name).map(textOf);
}

async function sessionDir(harness: Harness, sessionId: string): Promise<string> {
  return (await harness.engine.store.paths(harness.project, sessionId)).dir;
}

describe("a turn waiting for permission when the session closes", () => {
  it("waits on after opening again, and the answer carries the turn on", async () => {
    h = await startHarness({
      files: { "a.txt": "alpha\n" },
      script: [
        toolCalls([
          { id: "read-1", name: "Read", arguments: { file_path: "a.txt" } },
          { id: "write-1", name: "Write", arguments: { file_path: "b.txt", content: "beta\n" } },
        ]),
        text("Wrote b."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const { turnId } = await session.prompt(ask("read a, then write b"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    const requestId = (requested.payload.request as { requestId: string }).requestId;
    const lastSeq = session.lastSeq;
    await session.close();

    // Nothing was ended on the way out.
    const closed = await h.engine.replay(session.id, 0);
    expect(closed.lastSeq).toBe(lastSeq);
    expect(closed.events.map((e) => e.event)).not.toContain("turn.finished");
    // A listing says it waits on the person.
    const listed = await h.engine.listSessions({ projectDir: h.project });
    expect(listed.sessions.find((s) => s.id === session.id)?.status).toBe("waiting");
    expect((await readSidecar(await sessionDir(h, session.id)))?.waitingOn).toBe("permission");

    const engine = h.newEngine();
    const resumed = await engine.resumeSession(session.id);
    expect(resumed.status).toBe("waiting");
    expect(resumed.activeTurnId).toBe(turnId);
    const snapshot = resumed.snapshot();
    expect(snapshot.activeTurnId).toBe(turnId);
    expect(snapshot.session.status).toBe("waiting");
    expect(snapshot.pending).toEqual([
      expect.objectContaining({
        kind: "permission",
        turnId,
        request: expect.objectContaining({ requestId, toolCallId: "write-1", toolName: "Write" }),
      }),
    ]);
    // Opening says nothing new: clients already know the turn waits.
    expect(resumed.lastSeq).toBe(lastSeq);
    // A prompt cannot start while the turn waits.
    await expect(resumed.prompt(ask("something else"))).rejects.toMatchObject({
      code: "SessionBusy",
    });

    resumed.respondPermission(requestId, { behavior: "allow", scope: "once" });
    const outcome = await resumed.waitForIdle();
    expect(outcome).toMatchObject({ turnId, stopReason: "completed", finalText: "Wrote b." });
    expect(await readFile(path.join(h.project, "b.txt"), "utf8")).toBe("beta\n");
    expect(historyProblems(resumed.view)).toEqual([]);

    // The call was announced once, and finished once, after the answer.
    const after = h.events.filter((e) => e.payload.sessionId === session.id);
    const writeEvents = after
      .filter((e) => e.payload.toolCallId === "write-1" && e.event.startsWith("tool."))
      .map((e) => e.event);
    expect(writeEvents).toEqual(["tool.started", "tool.finished"]);
    const tail = after.filter((e) => e.payload.seq > lastSeq).map((e) => e.event);
    expect(tail.slice(0, 3)).toEqual(["request.resolved", "session.status", "tool.finished"]);
    expect(tail).toContain("turn.finished");
    expect(resumed.status).toBe("idle");
    expect((await readSidecar(await sessionDir(h, session.id)))?.waitingOn ?? null).toBeNull();
  });

  it("keeps a denial the person gives on the brought-back card, whatever the mode is now", async () => {
    h = await startHarness({
      script: [
        toolCall("Write", { file_path: "b.txt", content: "beta\n" }, { id: "write-1" }),
        text("Understood, not writing it."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("write b"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    const requestId = (requested.payload.request as { requestId: string }).requestId;
    await session.close();

    const resumed = await h.newEngine().resumeSession(session.id);
    // Edits would be allowed in this mode, but the person's answer stands.
    resumed.setMode("acceptEdits");
    resumed.respondPermission(requestId, { behavior: "deny", message: "not that file" });
    const outcome = await resumed.waitForIdle();
    expect(outcome?.stopReason).toBe("completed");
    expect(toolResults(resumed.view, "Write")[0]).toContain("not that file");
    await expect(readFile(path.join(h.project, "b.txt"), "utf8")).rejects.toThrow();
  });

  it("ends as an interrupted turn when it is stopped before anyone answers", async () => {
    h = await startHarness({
      script: [
        toolCall("Write", { file_path: "b.txt", content: "beta\n" }, { id: "write-1" }),
        text("after the stop"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const { turnId } = await session.prompt(ask("write b"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    const requestId = (requested.payload.request as { requestId: string }).requestId;
    const lastSeq = session.lastSeq;
    await session.close();

    const resumed = await h.newEngine().resumeSession(session.id);
    expect(resumed.interrupt()).toBe(true);
    const outcome = await resumed.waitForIdle();
    expect(outcome).toMatchObject({ turnId, stopReason: "interrupted" });
    const tail = h.events
      .filter((e) => e.payload.sessionId === session.id && e.payload.seq > lastSeq)
      .map((e) => [e.event, e.payload.outcome ?? e.payload.status ?? null]);
    expect(tail).toEqual([
      ["request.resolved", "cancelled"],
      ["session.status", "working"],
      ["tool.finished", "interrupted"],
      ["turn.finished", null],
      ["session.status", "idle"],
    ]);
    expect(h.ofType(session.id, "request.resolved").at(-1)?.payload.requestId).toBe(requestId);
    expect(historyProblems(resumed.view)).toEqual([]);
    expect(resumed.pending()).toEqual([]);
    // And the session goes on.
    const next = await resumed.run(ask("carry on"));
    expect(next.finalText).toBe("after the stop");
  });

  it("waits on through another close before anyone answers", async () => {
    h = await startHarness({
      script: [
        toolCall("Write", { file_path: "b.txt", content: "beta\n" }, { id: "write-1" }),
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("write b"));
    const requested = await h.waitFor((e) => e.event === "permission.requested");
    const requestId = (requested.payload.request as { requestId: string }).requestId;
    await session.close();

    const second = await h.newEngine().resumeSession(session.id);
    await second.close();
    expect((await readSidecar(await sessionDir(h, session.id)))?.waitingOn).toBe("permission");
    const third = await h.newEngine().resumeSession(session.id);
    expect(third.status).toBe("waiting");
    third.respondPermission(requestId, { behavior: "allow", scope: "once" });
    expect((await third.waitForIdle())?.stopReason).toBe("completed");
    expect(await readFile(path.join(h.project, "b.txt"), "utf8")).toBe("beta\n");
  });

  it("is closed as interrupted when nobody could answer it now", async () => {
    h = await startHarness({
      script: [toolCall("Write", { file_path: "b.txt", content: "beta\n" }, { id: "write-1" })],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("write b"));
    await h.waitFor((e) => e.event === "permission.requested");
    await session.close();

    const headless = h.newEngine({ capabilities: { permissionPrompts: false } });
    const resumed = await headless.resumeSession(session.id);
    expect(resumed.status).toBe("idle");
    expect(resumed.pending()).toEqual([]);
    expect(historyProblems(resumed.view)).toEqual([]);
    expect(h.ofType(session.id, "turn.finished").at(-1)?.payload.stopReason).toBe("interrupted");
  });
});

describe("questions and plans waiting when the session closes", () => {
  it("brings the question back and passes on the answer", async () => {
    h = await startHarness({
      script: [
        toolCall("AskUserQuestion", {
          questions: [
            { question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
          ],
        }),
        text("Using SQLite."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("set up storage"));
    const asked = await h.waitFor((e) => e.event === "question.asked");
    await session.close();

    const resumed = await h.newEngine().resumeSession(session.id);
    expect(resumed.snapshot().pending).toEqual([
      expect.objectContaining({ kind: "question", requestId: asked.payload.requestId }),
    ]);
    resumed.respondQuestion(String(asked.payload.requestId), {
      outcome: "answered",
      answers: [{ question: "Which database?", selected: ["SQLite"], text: "" }],
    });
    const outcome = await resumed.waitForIdle();
    expect(outcome?.finalText).toBe("Using SQLite.");
    expect(toolResults(resumed.view, "AskUserQuestion")[0]).toContain("SQLite");
    expect(h.ofType(session.id, "question.asked")).toHaveLength(1);
  });

  it("brings the plan back, with its file, and approving switches the mode", async () => {
    h = await startHarness({
      script: [
        toolCall("EnterPlanMode", {}),
        toolCall("ExitPlanMode", { plan: "1. Write b.txt" }),
        toolCall("Write", { file_path: "b.txt", content: "planned\n" }),
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("plan, then write"));
    const proposed = await h.waitFor((e) => e.event === "plan.proposed");
    await session.close();

    const resumed = await h.newEngine().resumeSession(session.id);
    expect(resumed.mode).toBe("plan");
    const pending = resumed.snapshot().pending[0];
    expect(pending).toMatchObject({
      kind: "plan",
      requestId: proposed.payload.requestId,
      planPath: proposed.payload.planPath,
      modeBeforePlan: "default",
    });
    resumed.respondPlan(String(proposed.payload.requestId), {
      decision: "approve",
      mode: "acceptEdits",
    });
    expect((await resumed.waitForIdle())?.stopReason).toBe("completed");
    expect(resumed.mode).toBe("acceptEdits");
    expect(await readFile(path.join(h.project, "b.txt"), "utf8")).toBe("planned\n");
    expect(h.ofType(session.id, "plan.proposed")).toHaveLength(1);
  });
});

describe("what cannot wait on", () => {
  it("a reply that was streaming is closed as interrupted, as before", async () => {
    h = await startHarness({
      mock: { flavor: "openai" },
      script: [stalled(text(["never ", "finishes"]), 3), text("fresh")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("go"));
    await h.waitFor((e) => e.event === "message.delta");
    await session.close();

    const resumed = await h.newEngine().resumeSession(session.id);
    expect(resumed.status).toBe("idle");
    expect(resumed.activeTurnId).toBeNull();
    expect(h.ofType(session.id, "turn.finished").at(-1)?.payload.stopReason).toBe("interrupted");
    expect((await resumed.run(ask("again"))).finalText).toBe("fresh");
  });
});
