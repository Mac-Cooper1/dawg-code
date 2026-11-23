import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import {
  CWD,
  MONEY_HUNKS,
  makeEnv,
  permissionItem,
  permissionRequest,
  planItem,
  questionItem,
} from "../transcript/testing.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";

describe.each(THEMES)("PermissionCard (%s)", (theme) => {
  it("shows what will run, why it asks, and the rule always-allow saves", () => {
    renderInTheme(
      <PermissionCard
        item={permissionItem()}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    const card = screen.getByRole("region", { name: "Permission needed: Run a shell command" });
    expect(within(card).getByText("Bash")).toBeInTheDocument();
    expect(within(card).getByText("uv add --dev pytest-repeat")).toBeInTheDocument();
    // `code` spans in the reason render as inline code, not literal backticks.
    const reason = within(card).getByText(/No rule allows/);
    expect(reason).toHaveTextContent("No rule allows uv add in this project.");
    expect(reason.querySelector("code")).toHaveTextContent("uv add");
    expect(card).toHaveTextContent(
      "Always allow saves the rule Bash(uv add --dev *) to .dawg/settings.local.json.",
    );
    expect(within(card).getByRole("button", { name: /Allow once/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "Enter",
    );
    expect(within(card).getByRole("button", { name: /Always allow/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Enter",
    );
    expect(within(card).getByRole("button", { name: /Deny…/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "Escape",
    );
  });

  it("shows the diff an edit would make", () => {
    const request = permissionRequest({
      toolName: "Edit",
      title: "Edit a file",
      input: { file_path: `${CWD}/src/tally/money.py` },
      suggestions: [],
      display: {
        kind: "diff",
        filePath: `${CWD}/src/tally/money.py`,
        created: false,
        hunks: MONEY_HUNKS,
        additions: 3,
        deletions: 2,
      },
    });
    const { container } = renderInTheme(
      <PermissionCard
        item={permissionItem({ request })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText("src/tally/money.py")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-kind='add']")).toHaveLength(3);
    expect(screen.getByText("Always allow applies to this session.")).toBeInTheDocument();
  });

  it("allows once and always, with the exact responses", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const { unmount } = renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(env.respondPermission).toHaveBeenLastCalledWith("perm-1", {
      behavior: "allow",
      scope: "once",
    });
    // Answered once: the card does not send a second answer.
    await user.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(env.respondPermission).toHaveBeenCalledTimes(1);
    unmount();

    renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(env.respondPermission).toHaveBeenLastCalledWith("perm-1", {
      behavior: "allow",
      scope: "always",
      rules: ["Bash(uv add --dev *)"],
    });
  });

  it("saves an edited rule", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: "Edit the rule first" }));
    const field = screen.getByRole("textbox", { name: "Rule to save" });
    await user.clear(field);
    await user.type(field, "Bash(uv add *)");
    await user.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(env.respondPermission).toHaveBeenCalledWith("perm-1", {
      behavior: "allow",
      scope: "always",
      rules: ["Bash(uv add *)"],
    });
  });

  it("denies with a note, or goes back", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Deny…/ }));
    const note = screen.getByRole("textbox", {
      name: "Tell dawg why, or what to do instead (optional)",
    });
    expect(note).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("button", { name: /Deny…/ })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: /Deny…/ }));
    await user.type(
      screen.getByRole("textbox", { name: /Tell dawg why/ }),
      "Don’t add dependencies.{Enter}Loop it in the shell instead.",
    );
    // Enter in the note adds a line; it does not send.
    expect(env.respondPermission).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Deny and send the note/ }));
    expect(env.respondPermission).toHaveBeenCalledWith("perm-1", {
      behavior: "deny",
      message: "Don’t add dependencies.\nLoop it in the shell instead.",
    });
  });

  it("denies without a message when the note is empty", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Deny…/ }));
    await user.click(screen.getByRole("button", { name: /^Deny/ }));
    expect(env.respondPermission).toHaveBeenCalledWith("perm-1", { behavior: "deny" });
  });

  it("takes ⏎, ⌘⏎ and esc only while focus is inside the card", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const { unmount } = renderInTheme(
      <>
        <textarea aria-label="Composer" />
        <PermissionCard item={permissionItem()} shownAgain={false} autoFocus env={env} />
      </>,
      theme,
    );
    // Focus went to the primary action when the card appeared.
    expect(screen.getByRole("button", { name: /Allow once/ })).toHaveFocus();
    await user.click(screen.getByRole("textbox", { name: "Composer" }));
    await user.keyboard("{Meta>}{Enter}{/Meta}{Escape}");
    expect(env.respondPermission).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /Tell dawg why/ })).toBeNull();

    // Inside the card: esc opens the note, esc again goes back, ⌘⏎ always allows.
    const card = screen.getByRole("region", { name: /Permission needed/ });
    within(card).getByText("Run a shell command").setAttribute("tabindex", "-1");
    within(card).getByText("Run a shell command").focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: /Tell dawg why/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: /Tell dawg why/ })).toBeNull();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(env.respondPermission).toHaveBeenCalledWith("perm-1", {
      behavior: "allow",
      scope: "always",
      rules: ["Bash(uv add --dev *)"],
    });
    unmount();

    renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    const title = screen.getByText("Run a shell command");
    title.setAttribute("tabindex", "-1");
    title.focus();
    await user.keyboard("{Enter}");
    expect(env.respondPermission).toHaveBeenLastCalledWith("perm-1", {
      behavior: "allow",
      scope: "once",
    });
  });

  it("keeps Escape from reaching the window while it answers", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    renderInTheme(
      <PermissionCard item={permissionItem()} shownAgain={false} autoFocus env={makeEnv()} />,
      theme,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /Allow once/ }), { key: "Escape" });
    window.removeEventListener("keydown", onWindowKey);
    expect(onWindowKey).not.toHaveBeenCalled();
  });

  it("does not take focus when the composer has text", () => {
    renderInTheme(
      <PermissionCard
        item={permissionItem()}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByRole("button", { name: /Allow once/ })).not.toHaveFocus();
  });

  it("leaves a one-line record and shows the card again read-only", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = permissionItem({
      state: "answered",
      response: { behavior: "allow", scope: "always", rules: ["Bash(uv add --dev *)"] },
    });
    const { rerender } = renderInTheme(
      <PermissionCard item={item} shownAgain={false} autoFocus env={env} />,
      theme,
    );
    expect(
      screen.getByText("You allowed it always · rule saved: Bash(uv add --dev *)"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the card again" }));
    expect(env.showCardAgain).toHaveBeenCalledWith("perm-1", true);

    rerender(<PermissionCard item={item} shownAgain autoFocus env={env} />);
    const card = screen.getByRole("region", { name: "Permission, answered: Run a shell command" });
    const always = within(card).getByRole("button", { name: "Always allow" });
    expect(always).toBeDisabled();
    expect(always).toHaveAttribute("aria-pressed", "true");
    expect(within(card).getByRole("button", { name: "Allow once" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Hide the card" }));
    expect(env.showCardAgain).toHaveBeenLastCalledWith("perm-1", false);
  });

  it("shows the note of a denial and says when no answer was needed", () => {
    const { rerender } = renderInTheme(
      <PermissionCard
        item={permissionItem({
          state: "answered",
          response: { behavior: "deny", message: "Loop it in the shell." },
        })}
        shownAgain
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(
      screen.getByText("You denied it · note sent: “Loop it in the shell.”"),
    ).toBeInTheDocument();
    expect(screen.getByText("Loop it in the shell.")).toBeInTheDocument();
    rerender(
      <PermissionCard
        item={permissionItem({ state: "cancelled" })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
    );
    expect(screen.getByText("No answer needed: the turn ended")).toBeInTheDocument();
  });
});

describe.each(THEMES)("QuestionCard (%s)", (theme) => {
  it("asks with a real radio group and sends the chosen option", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    const card = screen.getByRole("region", {
      name: "dawg is asking: How should the tip be shared?",
    });
    expect(within(card).getByText("Tip split")).toBeInTheDocument();
    const group = within(card).getByRole("radiogroup", { name: "How should the tip be shared?" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAccessibleName("Evenly, with the bill");
    expect(radios[0]).toHaveAccessibleDescription(
      "Add the tip to the total, then split everything the same way",
    );
    expect(radios[0]).toHaveAttribute("aria-keyshortcuts", "1");
    expect(radios[1]).toHaveAccessibleDescription("Each person tips on their own items");
    expect(within(group).getByText("items").tagName).toBe("CODE");
    await user.click(within(group).getByText("By what each person ordered"));
    expect(radios[1]).toBeChecked();
    await user.click(within(card).getByRole("button", { name: /Send answer/ }));
    expect(env.respondQuestion).toHaveBeenCalledWith("question-req-1", {
      outcome: "answered",
      answers: [
        { question: "How should the tip be shared?", selected: ["By what each person ordered"] },
      ],
    });
  });

  it("picks options with number keys and sends with ⏎", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus env={env} />,
      theme,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveFocus();
    await user.keyboard("3");
    expect(radios[2]).toBeChecked();
    await user.keyboard("{Enter}");
    expect(env.respondQuestion).toHaveBeenCalledWith("question-req-1", {
      outcome: "answered",
      answers: [
        { question: "How should the tip be shared?", selected: ["Only among people who opt in"] },
      ],
    });
  });

  it("does not take number keys typed into the answer field", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.type(screen.getByRole("textbox", { name: "Your own answer" }), "2 ways{Enter}");
    expect(screen.getAllByRole("radio").some((radio) => (radio as HTMLInputElement).checked)).toBe(
      false,
    );
    // Enter stays with the field; ⌘⏎ sends.
    expect(env.respondQuestion).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(env.respondQuestion).toHaveBeenCalledWith("question-req-1", {
      outcome: "answered",
      answers: [{ question: "How should the tip be shared?", selected: [], text: "2 ways" }],
    });
  });

  it("leaves the answer field on esc instead of dismissing", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.type(screen.getByRole("textbox", { name: "Your own answer" }), "Half and half");
    await user.keyboard("{Escape}");
    expect(env.respondQuestion).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Dismiss/ })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Your own answer" })).toHaveValue("Half and half");
  });

  it("sends several choices for a multi-select question", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = questionItem();
    const base = item.questions[0];
    if (!base) throw new Error("fixture");
    renderInTheme(
      <QuestionCard
        item={{ ...item, questions: [{ ...base, multiSelect: true }] }}
        shownAgain={false}
        autoFocus={false}
        env={env}
      />,
      theme,
    );
    const group = screen.getByRole("group", { name: "How should the tip be shared?" });
    const boxes = within(group).getAllByRole("checkbox");
    await user.click(boxes[2] as HTMLElement);
    await user.click(boxes[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(env.respondQuestion).toHaveBeenCalledWith("question-req-1", {
      outcome: "answered",
      answers: [
        {
          question: "How should the tip be shared?",
          selected: ["Evenly, with the bill", "Only among people who opt in"],
        },
      ],
    });
  });

  it("asks for an answer before sending nothing", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick an option or type an answer.");
    expect(env.respondQuestion).not.toHaveBeenCalled();
  });

  it("dismisses with the button or esc", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const { unmount } = renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(env.respondQuestion).toHaveBeenLastCalledWith("question-req-1", {
      outcome: "dismissed",
    });
    unmount();

    renderInTheme(
      <QuestionCard item={questionItem()} shownAgain={false} autoFocus env={env} />,
      theme,
    );
    await user.keyboard("{Escape}");
    expect(env.respondQuestion).toHaveBeenCalledTimes(2);
    expect(env.respondQuestion).toHaveBeenLastCalledWith("question-req-1", {
      outcome: "dismissed",
    });
  });

  it("records the answer and shows it again, read-only", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = questionItem({
      state: "answered",
      response: {
        outcome: "answered",
        answers: [
          { question: "How should the tip be shared?", selected: ["Evenly, with the bill"] },
        ],
      },
    });
    const { rerender } = renderInTheme(
      <QuestionCard item={item} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    expect(screen.getByText("You answered: Evenly, with the bill")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the card again" }));
    expect(env.showCardAgain).toHaveBeenCalledWith("question-req-1", true);
    rerender(<QuestionCard item={item} shownAgain autoFocus={false} env={env} />);
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toBeChecked();
    expect(radios.every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: /Send answer/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide the card" })).toBeInTheDocument();
  });

  it("records free text in quotes and dismissals", () => {
    const { rerender } = renderInTheme(
      <QuestionCard
        item={questionItem({
          state: "answered",
          response: {
            outcome: "answered",
            answers: [
              { question: "How should the tip be shared?", selected: [], text: "Skip tips" },
            ],
          },
        })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText("You answered: “Skip tips”")).toBeInTheDocument();
    rerender(
      <QuestionCard
        item={questionItem({ state: "answered", response: { outcome: "dismissed" } })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
    );
    expect(screen.getByText("You dismissed the question")).toBeInTheDocument();
  });
});

describe.each(THEMES)("PlanCard (%s)", (theme) => {
  it("shows the plan, its path and where approval returns to", () => {
    renderInTheme(
      <PlanCard item={planItem()} shownAgain={false} autoFocus={false} env={makeEnv()} />,
      theme,
    );
    const card = screen.getByRole("region", { name: "Plan ready for review" });
    expect(within(card).getByText(".dawg/plans/multi-currency-totals.md")).toBeInTheDocument();
    const plan = within(card).getByRole("region", { name: "Plan" });
    expect(within(plan).getByRole("heading", { name: "Goal" })).toBeInTheDocument();
    expect(within(plan).getByText("Money")).toBeInTheDocument();
    expect(card).toHaveTextContent(
      "Approve returns to Ask first, the mode you were in before planning.",
    );
  });

  it("leaves out the mode line when the earlier mode is unknown", () => {
    renderInTheme(
      <PlanCard
        item={planItem({ modeBeforePlan: null })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.queryByText(/Approve returns to/)).toBeNull();
  });

  it("approves, or approves and accepts edits", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const { unmount } = renderInTheme(
      <PlanCard item={planItem()} shownAgain={false} autoFocus env={env} />,
      theme,
    );
    expect(screen.getByRole("button", { name: /^Approve⏎|^Approve ⏎|^Approve$/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(env.respondPlan).toHaveBeenLastCalledWith("plan-req-1", { decision: "approve" });
    unmount();

    renderInTheme(<PlanCard item={planItem()} shownAgain={false} autoFocus env={env} />, theme);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(env.respondPlan).toHaveBeenLastCalledWith("plan-req-1", {
      decision: "approve",
      mode: "acceptEdits",
    });
  });

  it("keeps planning with feedback", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    renderInTheme(
      <PlanCard item={planItem()} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    await user.click(screen.getByRole("button", { name: /Keep planning…/ }));
    const field = screen.getByRole("textbox", { name: "What should change?" });
    expect(field).toHaveFocus();
    expect(screen.getByRole("button", { name: /Send feedback/ })).toBeDisabled();
    await user.type(field, "Read rates from the ECB daily file.");
    await user.click(screen.getByRole("button", { name: /Send feedback/ }));
    expect(env.respondPlan).toHaveBeenCalledWith("plan-req-1", {
      decision: "reject",
      message: "Read rates from the ECB daily file.",
    });
  });

  it("records the decision and shows the plan again read-only", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = planItem({
      state: "answered",
      response: { decision: "approve", mode: "acceptEdits" },
    });
    const { rerender } = renderInTheme(
      <PlanCard item={item} shownAgain={false} autoFocus={false} env={env} />,
      theme,
    );
    expect(
      screen.getByText("You approved the plan · mode is now Accept edits"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the card again" }));
    expect(env.showCardAgain).toHaveBeenCalledWith("plan-req-1", true);
    rerender(<PlanCard item={item} shownAgain autoFocus={false} env={env} />);
    const card = screen.getByRole("region", { name: "Plan, answered" });
    expect(within(card).getByRole("button", { name: "Approve and accept edits" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{Enter}");
    expect(env.respondPlan).not.toHaveBeenCalled();
  });

  it("records feedback as still planning", () => {
    renderInTheme(
      <PlanCard
        item={planItem({
          state: "answered",
          response: { decision: "reject", message: "More detail" },
        })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText("You asked for changes · still planning")).toBeInTheDocument();
  });
});
