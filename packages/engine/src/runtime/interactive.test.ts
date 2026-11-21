import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";

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

function noteTexts(view: readonly Message[]): string[] {
  return view.filter((m) => m.role === "user" && m.kind === "note").map(textOf);
}

describe("plan mode end to end", () => {
  it("plans read-only, proposes the plan, and on approval continues in the chosen mode", async () => {
    h = await startHarness({
      script: [
        toolCall("EnterPlanMode", {}),
        toolCall("Write", { file_path: "a.txt", content: "early\n" }),
        toolCall("ExitPlanMode", { plan: "1. Write a.txt\n2. Check it" }),
        toolCall("Write", { file_path: "a.txt", content: "planned\n" }),
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("plan then write"));
    const proposed = await h.waitFor((e) => e.event === "plan.proposed");
    expect(session.mode).toBe("plan");
    expect(session.status).toBe("waiting");
    expect(proposed.payload.plan).toContain("Write a.txt");
    const planPath = proposed.payload.planPath as string;
    expect(await readFile(planPath, "utf8")).toContain("Check it");
    session.respondPlan(String(proposed.payload.requestId), {
      decision: "approve",
      mode: "acceptEdits",
    });
    const outcome = await session.waitForIdle();
    expect(outcome?.stopReason).toBe("completed");
    expect(session.mode).toBe("acceptEdits");
    expect(await readFile(path.join(h.project, "a.txt"), "utf8")).toBe("planned\n");

    const finished = h
      .ofType(session.id, "tool.finished")
      .map((e) => [e.payload.toolName, e.payload.outcome]);
    expect(finished).toEqual([
      ["EnterPlanMode", "success"],
      ["Write", "denied"],
      ["ExitPlanMode", "success"],
      ["Write", "success"],
    ]);
    expect(toolResults(session.view, "ExitPlanMode")[0]).toContain("acceptEdits");
    const notes = noteTexts(session.view);
    expect(notes.some((n) => n.includes('"mode_changed"') && n.includes('"plan"'))).toBe(true);
    expect(notes.some((n) => n.includes('"plan_approved"') && n.includes('"acceptEdits"'))).toBe(
      true,
    );
    const modes = h
      .ofType(session.id, "session.updated")
      .filter((e) => (e.payload.changed as string[]).includes("mode"))
      .map((e) => e.payload.mode);
    expect(modes).toEqual(["plan", "acceptEdits"]);
    expect(h.ofType(session.id, "request.resolved")[0]?.payload).toMatchObject({
      kind: "plan",
      outcome: "answered",
      response: { decision: "approve", mode: "acceptEdits" },
    });
    expect(historyProblems(session.view)).toEqual([]);
  });

  it("stays in plan mode and passes on the feedback when the plan is rejected", async () => {
    h = await startHarness({
      script: [toolCall("ExitPlanMode", { plan: "Do it" }), text("revising")],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "plan" });
    await session.prompt(ask("plan"));
    const proposed = await h.waitFor((e) => e.event === "plan.proposed");
    session.respondPlan(String(proposed.payload.requestId), {
      decision: "reject",
      message: "add tests first",
    });
    await session.waitForIdle();
    expect(session.mode).toBe("plan");
    expect(toolResults(session.view, "ExitPlanMode")[0]).toContain("add tests first");
  });

  it("returns to the mode the session was in before planning when the answer names none", async () => {
    h = await startHarness({
      script: [toolCall("EnterPlanMode", {}), toolCall("ExitPlanMode", { plan: "p" }), text("ok")],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.prompt(ask("plan"));
    const proposed = await h.waitFor((e) => e.event === "plan.proposed");
    session.respondPlan(String(proposed.payload.requestId), { decision: "approve" });
    await session.waitForIdle();
    expect(session.mode).toBe("acceptEdits");
  });

  it("keeps plan mode when nobody can approve plans", async () => {
    h = await startHarness({
      engine: { capabilities: { planApproval: false } },
      script: [toolCall("ExitPlanMode", { plan: "p" }), text("Here is the plan.")],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "plan" });
    await session.run(ask("plan"));
    expect(h.ofType(session.id, "plan.proposed")).toHaveLength(0);
    expect(session.mode).toBe("plan");
    expect(toolResults(session.view, "ExitPlanMode")[0]).toContain("No one can approve");
  });
});

describe("questions end to end", () => {
  it("pauses the turn until the person answers", async () => {
    h = await startHarness({
      script: [
        toolCall("AskUserQuestion", {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [{ label: "SQLite" }, { label: "Postgres", description: "Bigger" }],
              multiSelect: false,
            },
          ],
        }),
        text("Using SQLite."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("set up storage"));
    const asked = await h.waitFor((e) => e.event === "question.asked");
    expect(session.snapshot().pending[0]?.kind).toBe("question");
    expect(h.ofType(session.id, "session.status").at(-1)?.payload.waitingOn).toBe("question");
    session.respondQuestion(String(asked.payload.requestId), {
      outcome: "answered",
      answers: [{ question: "Which database?", selected: ["SQLite"], text: "keep it simple" }],
    });
    const outcome = await session.waitForIdle();
    expect(outcome?.finalText).toBe("Using SQLite.");
    const result = toolResults(session.view, "AskUserQuestion")[0] ?? "";
    expect(result).toContain("Which database?");
    expect(result).toContain("SQLite");
    expect(result).toContain("keep it simple");
  });

  it("tells the model when the person dismisses the question", async () => {
    h = await startHarness({
      script: [
        toolCall("AskUserQuestion", {
          questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
        }),
        text("ok"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.prompt(ask("go"));
    const asked = await h.waitFor((e) => e.event === "question.asked");
    session.respondQuestion(String(asked.payload.requestId), {
      outcome: "dismissed",
      message: "you pick",
    });
    await session.waitForIdle();
    const result = toolResults(session.view, "AskUserQuestion")[0] ?? "";
    expect(result).toContain("closed the questions");
    expect(result).toContain("you pick");
  });

  it("says nobody can answer when the client cannot show questions", async () => {
    h = await startHarness({
      engine: { capabilities: { questions: false } },
      script: [
        toolCall("AskUserQuestion", {
          questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
        }),
        text("ok"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("go"));
    expect(h.ofType(session.id, "question.asked")).toHaveLength(0);
    expect(toolResults(session.view, "AskUserQuestion")[0]).toContain("No one can answer");
  });
});

describe("the task list", () => {
  it("replaces the list, records it, and announces it", async () => {
    h = await startHarness({
      script: [
        toolCall("TodoWrite", {
          todos: [
            { content: "Read the code", status: "completed", activeForm: "Reading the code" },
            { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
            { content: "Run the tests", status: "pending" },
          ],
        }),
        text("on it"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("fix it"));
    const expected = [
      { content: "Read the code", status: "completed", activeForm: "Reading the code" },
      { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Run the tests", status: "pending" },
    ];
    expect(h.ofType(session.id, "tasks.updated")[0]?.payload.tasks).toEqual(expected);
    expect(session.snapshot().tasks).toEqual(expected);
    const stored = await h.engine.store.read(session.cwd, session.id);
    expect(stored.snapshot.state.tasks).toEqual(expected);
    expect(toolResults(session.view, "TodoWrite")[0]).toContain(
      "1 completed, 1 in progress, 1 pending",
    );
    await access(path.join(h.project)); // the project is untouched by the list
  });
});
