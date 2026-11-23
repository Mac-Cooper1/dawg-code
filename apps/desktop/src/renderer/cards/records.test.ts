import { describe, expect, it } from "vitest";
import { permissionItem, planItem, questionItem } from "../transcript/testing.ts";
import { permissionRecord, planRecord, questionRecord } from "./records.ts";

describe("permissionRecord", () => {
  it("says what the person answered", () => {
    expect(
      permissionRecord(
        permissionItem({ state: "answered", response: { behavior: "allow", scope: "once" } }),
      ),
    ).toBe("You allowed this once");
    expect(
      permissionRecord(
        permissionItem({ state: "answered", response: { behavior: "allow", scope: "always" } }),
      ),
    ).toBe("You allowed it always · rule saved: Bash(uv add --dev *)");
    expect(
      permissionRecord(
        permissionItem({
          state: "answered",
          response: { behavior: "allow", scope: "always", rules: ["Bash(uv add *)"] },
        }),
      ),
    ).toBe("You allowed it always · rule saved: Bash(uv add *)");
    expect(
      permissionRecord(
        permissionItem({
          state: "answered",
          response: { behavior: "deny", message: "Loop it in the shell instead." },
        }),
      ),
    ).toBe("You denied it · note sent: “Loop it in the shell instead.”");
    expect(
      permissionRecord(permissionItem({ state: "answered", response: { behavior: "deny" } })),
    ).toBe("You denied it");
    expect(permissionRecord(permissionItem({ state: "cancelled" }))).toBe(
      "No answer needed: the turn ended",
    );
  });
});

describe("questionRecord", () => {
  it("quotes free text and lists options", () => {
    const question = "How should the tip be shared?";
    expect(
      questionRecord(
        questionItem({
          state: "answered",
          response: {
            outcome: "answered",
            answers: [{ question, selected: ["Evenly, with the bill"] }],
          },
        }),
      ),
    ).toBe("You answered: Evenly, with the bill");
    expect(
      questionRecord(
        questionItem({
          state: "answered",
          response: {
            outcome: "answered",
            answers: [{ question, selected: [], text: "Skip tips" }],
          },
        }),
      ),
    ).toBe("You answered: “Skip tips”");
    expect(
      questionRecord(questionItem({ state: "answered", response: { outcome: "dismissed" } })),
    ).toBe("You dismissed the question");
  });
});

describe("planRecord", () => {
  it("names the mode the session is in afterwards", () => {
    expect(
      planRecord(
        planItem({ state: "answered", response: { decision: "approve", mode: "acceptEdits" } }),
      ),
    ).toBe("You approved the plan · mode is now Accept edits");
    expect(planRecord(planItem({ state: "answered", response: { decision: "approve" } }))).toBe(
      "You approved the plan · back to Ask first",
    );
    expect(
      planRecord(
        planItem({ state: "answered", response: { decision: "approve" }, modeBeforePlan: null }),
      ),
    ).toBe("You approved the plan");
    expect(
      planRecord(planItem({ state: "answered", response: { decision: "reject", message: "x" } })),
    ).toBe("You asked for changes · still planning");
  });
});
