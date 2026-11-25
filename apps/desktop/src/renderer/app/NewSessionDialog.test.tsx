import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { NewSessionOffer } from "../state/types.ts";
import { THEMES } from "../test/render.tsx";
import { NewSessionDialogContainer } from "./NewSessionDialog.tsx";
import { createTestStore, HOME, renderWithStore } from "./testing.tsx";

const OFFER: NewSessionOffer = {
  projectDir: `${HOME}/code/tally`,
  projectName: "tally",
  branches: ["main", "feature/csv"],
  current: "main",
  suggestedName: "quiet-otter",
  worktree: false,
  busy: false,
  error: null,
};

function setup(theme: "dark" | "light", offer: Partial<NewSessionOffer> = {}) {
  const test = createTestStore(() => ({ newSessionOffer: { ...OFFER, ...offer } }));
  renderWithStore(<NewSessionDialogContainer />, { theme, store: test.store });
  return test;
}

describe.each(THEMES)("NewSessionDialog (%s)", (theme) => {
  it("shows nothing without an offer", () => {
    const test = createTestStore();
    renderWithStore(<NewSessionDialogContainer />, { theme, store: test.store });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts in the project folder by default", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    const dialog = screen.getByRole("dialog", { name: "New session in tally" });
    const box = within(dialog).getByRole("checkbox", { name: /Run in a worktree/ });
    expect(box).not.toBeChecked();
    expect(within(dialog).queryByLabelText("Worktree name")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Start session/ }));
    expect(test.actions.answerNewSessionOffer).toHaveBeenCalledWith({ worktree: null });
  });

  it("makes a worktree from the chosen base, with the suggested name", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.click(screen.getByRole("checkbox", { name: /Run in a worktree/ }));
    const base = screen.getByLabelText("Start from");
    expect(base).toHaveValue("main");
    expect(
      within(base)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["main (current)", "feature/csv"]);
    await user.selectOptions(base, "feature/csv");
    const name = screen.getByLabelText("Worktree name");
    expect(name).toHaveValue("quiet-otter");
    expect(screen.getByText(/dawg\/quiet-otter/)).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "split-cents{Enter}");
    expect(test.actions.answerNewSessionOffer).toHaveBeenCalledWith({
      worktree: { name: "split-cents", base: "feature/csv" },
    });
  });

  it("checks the name before asking for the worktree", async () => {
    const user = userEvent.setup();
    const test = setup(theme, { worktree: true });
    const name = screen.getByLabelText("Worktree name");
    await user.clear(name);
    await user.type(name, "Split Cents");
    await user.tab();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(
        "Use lowercase letters, digits and dashes, starting with a letter or digit.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start session/ })).toBeDisabled();
    expect(test.actions.answerNewSessionOffer).not.toHaveBeenCalled();
  });

  it("shows why the worktree could not be made, and waits while it is made", () => {
    setup(theme, { worktree: true, error: "A branch named dawg/quiet-otter already exists." });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A branch named dawg/quiet-otter already exists.",
    );
  });

  it("cannot be left while the worktree is being made", () => {
    setup(theme, { worktree: true, busy: true });
    expect(screen.getByRole("button", { name: /Making the worktree/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("cancels with Esc", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.keyboard("{Escape}");
    expect(test.actions.answerNewSessionOffer).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
