/** Decisions: each recorded branch, generated continuations, and the whole output's conformance. */
import { type EngineEvent, ErrorCodes, type PendingRequest } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { checkConformance } from "./conformance.ts";
import { BUILT_IN_SCENARIOS } from "./scenarios.ts";
import {
  all,
  builtIn,
  first,
  type Harness,
  HOME,
  harness,
  names,
  type Peer,
} from "./test-support.ts";

let h: Harness;
afterEach(() => h?.engine.dispose());

const CSV = "request-flaky-csv-uv-add";
const TIP = "request-tip-support-split";
const PLAN = "request-multi-currency-plan";
const PLAN_EDIT = "request-multi-currency-edit";
const PLAN_2 = "request-multi-currency-plan-2";
const QUESTION = "How should the tip be shared?";

async function open(sessionId: string, speed = Number.POSITIVE_INFINITY): Promise<Peer> {
  h = harness({ speed });
  const peer = await h.connect();
  await peer.request("session.resume", { sessionId });
  return peer;
}

function text(event: EngineEvent | undefined): string {
  if (event?.event !== "tool.finished") return "";
  const part = event.payload.content[0];
  return part?.type === "text" ? part.text : "";
}

function finishedTool(events: readonly EngineEvent[], toolName: string) {
  return all(events, "tool.finished").filter((e) => e.payload.toolName === toolName);
}

function replies(events: readonly EngineEvent[]): string[] {
  return all(events, "message.finished")
    .map((e) => e.payload.text)
    .filter((t) => t !== "");
}

async function wholeConforms(peer: Peer, sessionId: string) {
  const whole = await peer.request("session.replay", { sessionId, afterSeq: 0 });
  expect(checkConformance(whole.events, { requireClosed: true })).toEqual([]);
  expect(peer.problems).toEqual([]);
}

describe("permission", () => {
  it("allow once plays the recorded run and the explanation", async () => {
    const peer = await open("flaky-csv");
    const result = await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "allow", scope: "once" },
    });
    expect(result).toEqual({});
    await h.runAll();
    const events = peer.of("flaky-csv");
    expect(events[0]?.payload).toMatchObject({
      kind: "permission",
      requestId: CSV,
      outcome: "answered",
      response: { behavior: "allow", scope: "once" },
    });
    expect(events[1]?.payload).toMatchObject({ status: "working" });
    const runs = finishedTool(events, "Bash");
    expect(
      runs.map((e) => [
        e.payload.outcome,
        e.payload.display?.kind === "command" ? e.payload.display.exitCode : null,
      ]),
    ).toEqual([
      ["success", 0],
      ["error", 1],
    ]);
    expect(text(runs[0])).toContain("pytest-repeat==0.9.4");
    expect(
      all(events, "tool.progress").some(
        (e) =>
          e.payload.progress.kind === "status" &&
          e.payload.progress.message === "34 of 50 runs · 1 failure so far",
      ),
    ).toBe(true);
    expect(replies(events).at(-1)).toContain("executor.map");
    expect(first(events, "turn.finished").payload.stopReason).toBe("completed");
    await wholeConforms(peer, "flaky-csv");
  });

  it("allow always carries the scope and rules to request.resolved and takes the same branch", async () => {
    const peer = await open("flaky-csv");
    await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "allow", scope: "always", rules: ["Bash(uv add --dev pytest-repeat)"] },
    });
    await h.runAll();
    expect(peer.of("flaky-csv")[0]?.payload).toMatchObject({
      response: { behavior: "allow", scope: "always", rules: ["Bash(uv add --dev pytest-repeat)"] },
    });
    expect(replies(peer.of("flaky-csv")).at(-1)).toContain("executor.map");
  });

  it("deny with a note: the note reaches request.resolved and the call's result", async () => {
    const peer = await open("flaky-csv");
    await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny", message: "No new packages, please." },
    });
    await h.runAll();
    const events = peer.of("flaky-csv");
    expect(events[0]?.payload).toMatchObject({
      outcome: "answered",
      response: { behavior: "deny", message: "No new packages, please." },
    });
    const denied = finishedTool(events, "Bash")[0];
    expect(denied?.payload).toMatchObject({ outcome: "denied", durationMs: null });
    expect(text(denied)).toContain("They said: No new packages, please.");
    expect(replies(events)[0]).toMatch(
      /^Understood, no new dependency\. I'll loop it in the shell instead: `for i in/,
    );
    await wholeConforms(peer, "flaky-csv");
  });

  it("deny without a note says nothing more", async () => {
    const peer = await open("flaky-csv");
    await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny" },
    });
    await h.runAll();
    expect(text(finishedTool(peer.of("flaky-csv"), "Bash")[0])).not.toContain("They said");
  });
});

describe("question", () => {
  const replyFor = {
    "Evenly, with the bill": "add the tip to the total and split everything evenly",
    "By what each person ordered": "apply it to each person’s items",
    "Only among people who opt in": "a list of the people who opt in",
  };

  for (const [label, expected] of Object.entries(replyFor)) {
    it(`"${label}" plays its own continuation`, async () => {
      const peer = await open("tip-support");
      await peer.request("question.respond", {
        sessionId: "tip-support",
        requestId: TIP,
        response: { outcome: "answered", answers: [{ question: QUESTION, selected: [label] }] },
      });
      await h.runAll();
      const events = peer.of("tip-support");
      expect(events[0]?.payload).toMatchObject({ kind: "question", outcome: "answered" });
      expect(text(finishedTool(events, "AskUserQuestion")[0])).toBe(
        `The person answered:\n- ${QUESTION}\n  Answer: ${label}`,
      );
      expect(replies(events)[0]).toContain(expected);
      expect(
        finishedTool(events, "Edit").map(
          (e) => e.payload.display?.kind === "diff" && e.payload.display.filePath,
        ),
      ).toEqual([`${HOME}/code/tally/src/tally/bill.py`, `${HOME}/code/tally/tests/test_bill.py`]);
      expect(first(events, "turn.finished").payload.stopReason).toBe("completed");
      await wholeConforms(peer, "tip-support");
    });
  }

  it("a free-text answer reaches the tool's result as written", async () => {
    const peer = await open("tip-support");
    await peer.request("question.respond", {
      sessionId: "tip-support",
      requestId: TIP,
      response: {
        outcome: "answered",
        answers: [{ question: QUESTION, selected: [], text: "Round the tip up to the dollar." }],
      },
    });
    await h.runAll();
    const events = peer.of("tip-support");
    expect(text(finishedTool(events, "AskUserQuestion")[0])).toContain(
      "Answer: Round the tip up to the dollar.",
    );
    expect(replies(events)[0]).toBe(
      "Got it. I’ll do it that way and update the receipt tests to match.",
    );
  });

  it("a dismissal ends the turn without changes", async () => {
    const peer = await open("tip-support");
    await peer.request("question.respond", {
      sessionId: "tip-support",
      requestId: TIP,
      response: { outcome: "dismissed", message: "Later." },
    });
    await h.runAll();
    const events = peer.of("tip-support");
    expect(text(finishedTool(events, "AskUserQuestion")[0])).toContain("They said: Later.");
    expect(finishedTool(events, "Edit")).toEqual([]);
    expect(replies(events)).toEqual([
      "No problem. I’ll leave tips out and finish the rest; ask me again when you’ve decided.",
    ]);
    await wholeConforms(peer, "tip-support");
  });
});

describe("plan", () => {
  it("approve returns to Ask first, then the first edit asks for permission", async () => {
    const peer = await open("multi-currency");
    await peer.request("plan.respond", {
      sessionId: "multi-currency",
      requestId: PLAN,
      response: { decision: "approve" },
    });
    await h.runAll();
    let events = peer.of("multi-currency");
    expect(first(events, "session.updated").payload).toMatchObject({
      mode: "default",
      changed: ["mode"],
    });
    expect(text(finishedTool(events, "ExitPlanMode")[0])).toContain("now in default mode");
    const asked = first(events, "permission.requested").payload.request;
    expect(asked).toMatchObject({
      requestId: PLAN_EDIT,
      title: "Edit a file",
      suggestions: ["Edit(src/tally/**)"],
      display: {
        kind: "diff",
        filePath: `${HOME}/code/tally/.dawg/worktrees/multi-currency/src/tally/money.py`,
      },
    });
    expect(events.at(-1)?.payload).toMatchObject({ status: "waiting", waitingOn: "permission" });
    const snapshot = await peer.request("session.resume", { sessionId: "multi-currency" });
    expect(snapshot.session.mode).toBe("default");
    expect(snapshot.pending.map((p) => p.kind)).toEqual(["permission"]);

    await peer.request("permission.respond", {
      sessionId: "multi-currency",
      requestId: PLAN_EDIT,
      response: { behavior: "allow", scope: "once" },
    });
    await h.runAll();
    events = peer.of("multi-currency");
    expect(finishedTool(events, "Edit").at(-1)?.payload.outcome).toBe("success");
    expect(names(events).slice(-2)).toEqual(["turn.finished", "session.status"]);
    await wholeConforms(peer, "multi-currency");
  });

  it("approve, then deny the edit", async () => {
    const peer = await open("multi-currency");
    await peer.request("plan.respond", {
      sessionId: "multi-currency",
      requestId: PLAN,
      response: { decision: "approve" },
    });
    await h.runAll();
    await peer.request("permission.respond", {
      sessionId: "multi-currency",
      requestId: PLAN_EDIT,
      response: { behavior: "deny" },
    });
    await h.runAll();
    const events = peer.of("multi-currency");
    expect(finishedTool(events, "Edit")[0]?.payload.outcome).toBe("denied");
    expect(replies(events).at(-1)).toContain("I’ve left money.py alone");
    await wholeConforms(peer, "multi-currency");
  });

  it("approve and accept edits carries the plan out", async () => {
    const peer = await open("multi-currency");
    await peer.request("plan.respond", {
      sessionId: "multi-currency",
      requestId: PLAN,
      response: { decision: "approve", mode: "acceptEdits" },
    });
    await h.runAll();
    const events = peer.of("multi-currency");
    expect(first(events, "session.updated").payload).toMatchObject({ mode: "acceptEdits" });
    expect(all(events, "tool.started").map((e) => e.payload.toolName)).toEqual([
      "Edit",
      "Write",
      "Edit",
      "Edit",
      "Bash",
    ]);
    const write = finishedTool(events, "Write")[0];
    expect(write?.payload.display).toMatchObject({ kind: "diff", created: true });
    expect(replies(events)[0]).toBe("Starting with the Money type in money.py.");
    expect(all(events, "permission.requested")).toEqual([]);
    await wholeConforms(peer, "multi-currency");
  });

  it("approve into another mode takes the approve branch with that mode", async () => {
    const peer = await open("multi-currency");
    await peer.request("plan.respond", {
      sessionId: "multi-currency",
      requestId: PLAN,
      response: { decision: "approve", mode: "bypassPermissions" },
    });
    await h.runAll();
    const events = peer.of("multi-currency");
    expect(first(events, "session.updated").payload.mode).toBe("bypassPermissions");
    expect(text(finishedTool(events, "ExitPlanMode")[0])).toContain(
      "now in bypassPermissions mode",
    );
  });

  it("reject with feedback revises the plan and proposes it again", async () => {
    const peer = await open("multi-currency");
    await peer.request("plan.respond", {
      sessionId: "multi-currency",
      requestId: PLAN,
      response: { decision: "reject", message: "Use the ECB file." },
    });
    await h.runAll();
    const events = peer.of("multi-currency");
    expect(text(finishedTool(events, "ExitPlanMode")[0])).toContain(
      "Their feedback: Use the ECB file.",
    );
    expect(replies(events)[0]).toMatch(/^Fair\. I’ll read the ECB daily file instead/);
    const revised = first(events, "plan.proposed").payload;
    expect(revised.requestId).toBe(PLAN_2);
    expect(revised.plan).toContain("eurofxref-daily.xml");
    expect(revised.planPath).toBe(`${HOME}/.dawg/plans/multi-currency-totals.md`);
    expect(all(events, "session.updated")).toEqual([]);

    await peer.request("plan.respond", {
      sessionId: "multi-currency",
      requestId: PLAN_2,
      response: { decision: "approve" },
    });
    await h.runAll();
    const after = peer.of("multi-currency");
    expect(all(after, "session.updated").map((e) => e.payload.mode)).toEqual(["default"]);
    expect(names(after).slice(-2)).toEqual(["turn.finished", "session.status"]);
    await wholeConforms(peer, "multi-currency");
  });
});

describe("answers that are refused", () => {
  it("RequestNotFound for unknown, already answered, or another kind's requests", async () => {
    const peer = await open("flaky-csv");
    const unknown = await peer.failure("permission.respond", {
      sessionId: "flaky-csv",
      requestId: "nope",
      response: { behavior: "deny" },
    });
    expect(unknown.code).toBe(ErrorCodes.RequestNotFound);
    const wrongKind = await peer.failure("question.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { outcome: "dismissed" },
    });
    expect(wrongKind.code).toBe(ErrorCodes.RequestNotFound);
    await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny" },
    });
    const twice = await peer.failure("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny" },
    });
    expect(twice.code).toBe(ErrorCodes.RequestNotFound);
  });

  it("refuses an answer from a connection that does not have the session open", async () => {
    h = harness();
    const peer = await h.connect();
    const error = await peer.failure("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny" },
    });
    expect(error.code).toBe(ErrorCodes.InvalidState);
  });

  it("lets another window's answer win: the first answer resolves, the second is not found", async () => {
    h = harness();
    const a = await h.connect();
    const b = await h.connect();
    await a.request("session.resume", { sessionId: "flaky-csv" });
    await b.request("session.resume", { sessionId: "flaky-csv" });
    await a.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny" },
    });
    const late = await b.failure("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "allow", scope: "once" },
    });
    expect(late.code).toBe(ErrorCodes.RequestNotFound);
    await h.advance(0);
    expect(b.of("flaky-csv")[0]?.payload).toMatchObject({
      kind: "permission",
      outcome: "answered",
    });
  });
});

describe("answers no recording covers", () => {
  it("end the call with the answer's result and close the turn", async () => {
    const recorded = builtIn("flaky-csv");
    const bare = {
      scenario: { ...recorded.scenario, branches: {} },
      recordings: recorded.recordings,
    };
    h = harness({ scenarios: [bare], speed: Number.POSITIVE_INFINITY });
    const peer = await h.connect();
    await peer.request("session.resume", { sessionId: "flaky-csv" });
    await peer.request("permission.respond", {
      sessionId: "flaky-csv",
      requestId: CSV,
      response: { behavior: "deny", message: "No." },
    });
    await h.runAll();
    const events = peer.of("flaky-csv");
    expect(names(events)).toEqual([
      "request.resolved",
      "session.status",
      "tool.finished",
      "message.started",
      ...all(events, "message.delta").map(() => "message.delta"),
      "message.finished",
      "usage.updated",
      "turn.finished",
      "session.status",
    ]);
    expect(first(events, "tool.finished").payload).toMatchObject({ outcome: "denied" });
    expect(text(first(events, "tool.finished"))).toContain("They said: No.");
    expect(replies(events)[0]).toContain("as far as the recording goes");
    await wholeConforms(peer, "flaky-csv");
  });
});

/** The first answer that fits a pending request. */
function defaultAnswer(sessionId: string, request: PendingRequest) {
  switch (request.kind) {
    case "permission":
      return {
        method: "permission.respond" as const,
        params: {
          sessionId,
          requestId: request.request.requestId,
          response: { behavior: "allow" as const, scope: "once" as const },
        },
      };
    case "question":
      return {
        method: "question.respond" as const,
        params: {
          sessionId,
          requestId: request.requestId,
          response: {
            outcome: "answered" as const,
            answers: request.questions.map((q) => ({
              question: q.question,
              selected: q.options.slice(0, 1).map((o) => o.label),
            })),
          },
        },
      };
    case "plan":
      return {
        method: "plan.respond" as const,
        params: {
          sessionId,
          requestId: request.requestId,
          response: { decision: "approve" as const },
        },
      };
  }
}

describe("the engine's whole output", () => {
  it.each(BUILT_IN_SCENARIOS.map((s) => s.scenario.id))(
    "conforms for %s, through every decision and two more prompts",
    async (id) => {
      h = harness({ speed: Number.POSITIVE_INFINITY });
      const peer = await h.connect();
      await h.runAll();
      for (let round = 0; round < 6; round++) {
        const snapshot = await peer.request("session.resume", { sessionId: id });
        const request = snapshot.pending[0];
        if (request === undefined) break;
        const answer = defaultAnswer(id, request);
        if (answer.method === "permission.respond")
          await peer.request(answer.method, answer.params);
        else if (answer.method === "question.respond")
          await peer.request(answer.method, answer.params);
        else await peer.request(answer.method, answer.params);
        await h.runAll();
      }
      for (const words of ["One more thing.", "And another."]) {
        await peer.request("session.prompt", {
          sessionId: id,
          prompt: { content: [{ type: "text", text: words }] },
        });
        await h.runAll();
      }
      const whole = await peer.request("session.replay", { sessionId: id, afterSeq: 0 });
      expect(checkConformance(whole.events, { requireClosed: true })).toEqual([]);
      expect(all(whole.events, "turn.started").length).toBeGreaterThanOrEqual(2);
      expect(peer.problems).toEqual([]);
      const received = peer.of(id);
      expect(received.map((e) => e.payload.seq)).toEqual(
        whole.events.slice(whole.events.length - received.length).map((e) => e.payload.seq),
      );
    },
  );
});
