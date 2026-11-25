import type { PermissionMode, PlanResponse } from "@dawg/protocol";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createTestStore, renderWithStore } from "../../app/testing.tsx";
import {
  applyReplay,
  createStream,
  makeSummary,
  openSession,
  PROJECT,
} from "../../state/__fixtures__/streams.ts";
import { reduceAll } from "../../state/reducer.ts";
import type { EngineSlice } from "../../state/types.ts";
import { THEMES } from "../../test/render.tsx";
import { PlanPane } from "./index.tsx";

const PLAN = "## Split refunds\n\n1. Handle negative totals\n2. Add tests";

function sessionWithPlan(answer: {
  response?: PlanResponse;
  cancelled?: boolean;
  modeBeforePlan?: PermissionMode | null;
}): EngineSlice {
  const stream = createStream("s1");
  stream.emit("turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text: "Plan the refunds" }], mentions: [] },
    command: null,
  });
  stream.emit("plan.proposed", {
    turnId: "t1",
    requestId: "r1",
    toolCallId: "c1",
    plan: PLAN,
    planPath: `${PROJECT}/.dawg/plans/refunds.md`,
    modeBeforePlan: answer.modeBeforePlan === undefined ? "default" : answer.modeBeforePlan,
  });
  if (answer.response || answer.cancelled) {
    stream.emit("request.resolved", {
      kind: "plan",
      turnId: "t1",
      requestId: "r1",
      outcome: answer.cancelled ? "cancelled" : "answered",
      response: answer.response ?? null,
    });
  }
  return applyReplay(openSession(makeSummary("s1")), "s1", stream.events);
}

function setup(theme: "dark" | "light", slice: EngineSlice) {
  const test = createTestStore(() => slice);
  renderWithStore(<PlanPane sessionId="s1" />, { theme, store: test.store });
  return test;
}

describe.each(THEMES)("PlanPane (%s)", (theme) => {
  it("says how to get a plan when the session has none", () => {
    setup(theme, applyReplay(openSession(makeSummary("s1")), "s1", []));
    expect(screen.getByRole("heading", { name: "No plan in this session" })).toBeInTheDocument();
  });

  it("waits for the session's history before saying there is none", () => {
    setup(theme, reduceAll(openSession(makeSummary("s1")), []));
    expect(screen.getByRole("status")).toHaveTextContent("Loading the session…");
  });

  it("shows a plan waiting for an answer, and the mode approving leaves it in", () => {
    setup(theme, sessionWithPlan({}));
    const plan = screen.getByRole("article", { name: "Plan" });
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
    expect(plan).toHaveTextContent(
      "Approve returns to Ask first; Approve and accept edits switches to Accept edits.",
    );
    expect(screen.getByRole("heading", { name: "Split refunds" })).toBeInTheDocument();
    expect(screen.getByText(".dawg/plans/refunds.md")).toBeInTheDocument();
    // Read-only: nothing to answer here.
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("shows an approved plan and the mode it left plan mode in", () => {
    setup(theme, sessionWithPlan({ response: { decision: "approve", mode: "acceptEdits" } }));
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Approved. It left plan mode for Accept edits.")).toBeInTheDocument();
  });

  it("names the mode it returned to when the answer named none", () => {
    setup(theme, sessionWithPlan({ response: { decision: "approve" }, modeBeforePlan: "default" }));
    expect(screen.getByText("Approved. It left plan mode for Ask first.")).toBeInTheDocument();
  });

  it("shows a rejected plan with the feedback", () => {
    setup(
      theme,
      sessionWithPlan({ response: { decision: "reject", message: "Keep the old rounding." } }),
    );
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("You asked for changes, so dawg kept planning.")).toBeInTheDocument();
    expect(screen.getByText("Keep the old rounding.")).toBeInTheDocument();
  });

  it("says when the turn ended before an answer", () => {
    setup(theme, sessionWithPlan({ cancelled: true }));
    expect(screen.getByText("Not answered")).toBeInTheDocument();
  });
});
