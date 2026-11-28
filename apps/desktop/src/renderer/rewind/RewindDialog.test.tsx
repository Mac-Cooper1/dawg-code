import type { Checkpoint } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createTestStore, HOME, renderWithStore } from "../app/testing.tsx";
import type { RewindDialog } from "../state/types.ts";
import { THEMES } from "../test/render.tsx";
import {
  actionsFor,
  checkpointTime,
  RewindDialogContainer,
  SHELL_CAVEAT,
} from "./RewindDialog.tsx";

const CWD = `${HOME}/code/tally`;
const NOW = Date.now();

const EDITED: Checkpoint = {
  id: "turn-9",
  turnId: "turn-9",
  time: NOW - 60_000,
  prompt: "Round the split to whole cents",
  tracked: true,
  files: [{ path: `${CWD}/src/split.py`, change: "modified", agents: [] }],
  restore: [
    { path: `${CWD}/src/split.py`, action: "write", changedOutside: true },
    { path: `${CWD}/notes.md`, action: "delete", changedOutside: false },
  ],
};

const ASKED: Checkpoint = {
  id: "turn-2",
  turnId: "turn-2",
  time: NOW - 120_000,
  prompt: "Why does the split test fail?",
  tracked: true,
  files: [],
  restore: [],
};

const OLD: Checkpoint = {
  id: "turn-1",
  turnId: "turn-1",
  time: NOW - 180_000,
  prompt: "Hello",
  tracked: false,
  files: [],
  restore: [],
};

function dialog(patch: Partial<RewindDialog> = {}): RewindDialog {
  return {
    sessionId: "fix",
    phase: "ready",
    checkpoints: [EDITED, ASKED, OLD],
    retention: 100,
    error: null,
    conflict: null,
    ...patch,
  };
}

function setup(theme: "dark" | "light", patch: Partial<RewindDialog> = {}) {
  const test = createTestStore((state) => ({
    rewind: dialog(patch),
    sessions: {
      ...state.sessions,
    },
  }));
  renderWithStore(<RewindDialogContainer />, { theme, store: test.store });
  return test;
}

describe("actionsFor", () => {
  it("offers the file actions only with files to put back, in Claude Code's order", () => {
    expect(actionsFor(EDITED).map((a) => a.label)).toEqual([
      "Restore files and conversation",
      "Restore conversation",
      "Restore files",
      "Summarise from here",
    ]);
    expect(actionsFor(ASKED).map((a) => a.action)).toEqual(["conversation", "summarize"]);
  });

  it("shows today's times as a clock time", () => {
    expect(checkpointTime(NOW - 60_000, NOW)).toMatch(/\d/);
    expect(checkpointTime(NOW - 3 * 86_400_000, NOW)).not.toBe("");
  });
});

describe.each(THEMES)("RewindDialog (%s)", (theme) => {
  it("shows nothing while closed", () => {
    const test = createTestStore();
    renderWithStore(<RewindDialogContainer />, { theme, store: test.store });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists the messages newest first, with their times and files, and the shell caveat", () => {
    setup(theme);
    const dialogEl = screen.getByRole("dialog", { name: "Rewind" });
    const list = within(dialogEl).getByRole("listbox", { name: "Your messages, newest first" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Round the split to whole cents"),
      expect.stringContaining("Why does the split test fail?"),
      expect.stringContaining("Hello"),
    ]);
    expect(options[0]).toHaveTextContent("Changed 1 file: ~/code/tally/src/split.py");
    expect(options[1]).toHaveTextContent("No file changes");
    expect(options[2]).toHaveTextContent("Its file changes are no longer kept");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(list).toHaveFocus();
    expect(within(dialogEl).getByText(SHELL_CAVEAT)).toBeInTheDocument();
  });

  it("labels the files a subagent changed, in the list and in what a restore puts back", async () => {
    const user = userEvent.setup();
    const agent = {
      agentId: "agent-1",
      sessionId: "fix-agent-1",
      agentType: "general-purpose",
      description: "Tidy the notes",
    };
    const byAgent: Checkpoint = {
      ...EDITED,
      files: [
        { path: `${CWD}/src/split.py`, change: "modified", agents: [] },
        { path: `${CWD}/notes.md`, change: "created", agents: [agent] },
      ],
    };
    setup(theme, { checkpoints: [byAgent, ASKED, OLD] });
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveTextContent(
      "Changed 2 files: ~/code/tally/src/split.py, ~/code/tally/notes.md by agent-1 (general-purpose)",
    );
    await user.keyboard("{Enter}");
    const preview = screen.getByRole("list", { name: "Files a restore changes" });
    const items = within(preview).getAllByRole("listitem");
    expect(items[1]).toHaveTextContent("changed by agent-1 (general-purpose)");
    expect(items[0]).not.toHaveTextContent("changed by");
  });

  it("moves with the arrow keys, chooses with Enter, and picks an action by number", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{Enter}");
    const group = screen.getByRole("group", { name: /Before/ });
    expect(group).toHaveTextContent("Round the split to whole cents");
    // The restore preview names each file, marked when it changed outside dawg.
    const preview = within(group).getByRole("list", { name: "Files a restore changes" });
    expect(preview).toHaveTextContent("Put back~/code/tally/src/split.py");
    expect(preview).toHaveTextContent("changed outside dawg since");
    expect(preview).toHaveTextContent("Remove~/code/tally/notes.md");
    expect(
      within(group).getByRole("button", { name: /Restore files and conversation/ }),
    ).toHaveFocus();
    await user.keyboard("2");
    expect(test.actions.rewind).toHaveBeenCalledWith("turn-9", "conversation", {});
  });

  it("offers only what applies when the turn changed no files", async () => {
    const user = userEvent.setup();
    setup(theme);
    await user.click(screen.getByText("Why does the split test fail?"));
    const choices = screen.getByRole("list", { name: "What to restore" });
    expect(
      within(choices)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1Restore conversation", "2Summarise from here"]);
  });

  it("summarises with the instructions given", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.keyboard("{Enter}");
    await user.type(
      screen.getByRole("textbox", { name: /What the summary should concentrate on/ }),
      "the rounding{Enter}",
    );
    expect(test.actions.rewind).toHaveBeenCalledWith("turn-9", "summarize", {
      instructions: "the rounding",
    });
  });

  it("goes back a step with Esc, then closes", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(test.actions.closeRewind).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(test.actions.closeRewind).toHaveBeenCalled();
  });

  it("asks before overwriting files changed outside dawg", async () => {
    const user = userEvent.setup();
    const test = setup(theme, {
      phase: "conflicts",
      conflict: {
        checkpointId: "turn-9",
        action: "both",
        instructions: null,
        files: [`${CWD}/src/split.py`],
      },
    });
    const files = screen.getByRole("list", { name: "Files changed outside dawg" });
    expect(files).toHaveTextContent("~/code/tally/src/split.py");
    await user.click(screen.getByRole("button", { name: "Overwrite them" }));
    expect(test.actions.rewind).toHaveBeenCalledWith("turn-9", "both", { overwrite: true });
    await user.keyboard("{Escape}");
    expect(test.actions.dismissRewindConflict).toHaveBeenCalled();
  });

  it("opens the Changes pane from the caveat", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.click(screen.getByRole("button", { name: "Open Changes" }));
    expect(test.actions.closeRewind).toHaveBeenCalled();
    expect(test.actions.openPane).toHaveBeenCalledWith("changes");
  });

  it("says so while it reads, and offers to try again when it could not", async () => {
    const user = userEvent.setup();
    const test = setup(theme, { phase: "failed", error: "The engine stopped." });
    expect(screen.getByRole("alert")).toHaveTextContent("The engine stopped.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(test.actions.openRewind).toHaveBeenCalledWith("fix");
  });

  it("disables the actions while it rewinds", async () => {
    const user = userEvent.setup();
    const test = setup(theme);
    await user.keyboard("{Enter}");
    test.store.setState({ rewind: dialog({ phase: "working" }) });
    expect(await screen.findByText("Rewinding…")).toBeInTheDocument();
    for (const button of within(screen.getByRole("list", { name: "What to restore" })).getAllByRole(
      "button",
    )) {
      expect(button).toBeDisabled();
    }
  });
});
