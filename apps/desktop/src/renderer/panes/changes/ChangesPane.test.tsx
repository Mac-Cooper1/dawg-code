import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../code/editors.tsx",
  async () => (await import("../../code/testing.tsx")).editorStandIns,
);

import { createTestStore, renderWithStore } from "../../app/testing.tsx";
import {
  BROWSER_NON_GIT_PROJECT,
  createMemoryBridge,
  setBridgeForTests,
} from "../../bridge/index.ts";
import { closeAllDocuments } from "../../code/documents.ts";
import { editItem, sessionView } from "../../code/testing.tsx";
import type { TranscriptItem } from "../../state/types.ts";
import { THEMES } from "../../test/render.tsx";
import { filesStore, resetFiles, sessionOf } from "../files/store.ts";
import { ChangesPane } from "./index.tsx";
import { resetReview } from "./review.ts";

const PROJECT = "/Users/you/code/tally";
const TREE = `${PROJECT}/.dawg/worktrees/split-cents`;

afterEach(() => {
  setBridgeForTests(null);
  resetReview();
  resetFiles();
  closeAllDocuments();
});

interface SetupOptions {
  cwd?: string;
  transcript?: TranscriptItem[];
  /** A decision card waits in the session. */
  waiting?: boolean;
  draft?: string;
}

function setup(theme: "dark" | "light", options: SetupOptions = {}) {
  const cwd = options.cwd ?? TREE;
  const bridge = createMemoryBridge({ storage: null });
  setBridgeForTests(bridge);
  const track = vi.spyOn(bridge.workspace, "track");
  const { store, actions } = createTestStore((base) => ({
    homeDir: "/Users/you",
    sessions: { s1: sessionView("s1", cwd, { projectDir: PROJECT }) },
    transcripts: { s1: options.transcript ?? [] },
    pending: options.waiting
      ? { s1: [{ kind: "permission" as const, requestId: "r1", turnId: "t1" }] }
      : base.pending,
    ui: { ...base.ui, drafts: options.draft ? { s1: options.draft } : base.ui.drafts },
  }));
  renderWithStore(<ChangesPane sessionId="s1" />, { theme, store });
  return { bridge, fake: bridge.fakeWorkspace, store, actions, track, user: userEvent.setup() };
}

async function changedFiles() {
  return screen.findByRole("list", { name: "Changed files" });
}

async function pick(name: RegExp) {
  const list = await changedFiles();
  await userEvent.click(within(list).getByRole("button", { name }));
}

describe.each(THEMES)("Changes pane (%s)", (theme) => {
  it("tracks the session's folders and lists what changed, compared with the base", async () => {
    const { track } = setup(theme);
    const list = await changedFiles();
    expect(track).toHaveBeenCalledWith({
      sessionId: "s1",
      cwd: TREE,
      projectDir: PROJECT,
      additionalDirectories: [],
    });
    expect(screen.getByText("compared with main")).toBeInTheDocument();
    const names = within(list)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toContain("src/tally/money.py, modified, 8 lines added, 2 removed");
    expect(names).toContain("src/tally/legacy.py, deleted, 0 lines added, 5 removed");
    expect(names).toContain("notes/todo.md, new, not yet in git, 1 line added, 0 removed");
    expect(names).toContain("assets/logo.png, modified, binary");
  });

  it("shows the selected file's two versions and moves between its changes", async () => {
    setup(theme);
    await pick(/^README\.md/);
    const diff = await screen.findByRole("region", { name: "Changes to README.md" });
    await waitFor(() =>
      expect(within(diff).getByTestId("modified")).toHaveTextContent("Refunds split the same way"),
    );
    expect(within(diff).getByTestId("original")).not.toHaveTextContent("Refunds");
    expect(screen.getByText("Change 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous change" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(screen.getByText("Change 2 of 2")).toBeInTheDocument();
    // The change starts with a removed line, shown on the base side.
    expect(within(diff).getByTestId("reveal")).toHaveTextContent("original:11");
  });

  it("comments on selected lines and sends the comments to dawg as one message", async () => {
    const { actions } = setup(theme);
    await pick(/^src\/tally\/money\.py/);
    await screen.findByRole("region", { name: "Changes to src/tally/money.py" });
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Select modified lines 2–3" }));
    await userEvent.click(screen.getByRole("button", { name: "Comment on lines 2–3" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Comment for dawg" }),
      "Name the constant.",
    );
    await userEvent.click(screen.getByRole("button", { name: /Add comment/ }));

    const waiting = screen.getByRole("list", { name: "Comments to send" });
    expect(within(waiting).getByText("src/tally/money.py:2-3")).toBeInTheDocument();
    expect(screen.getByTestId("marks")).toHaveTextContent("modified:2-3");
    expect(screen.getByText(/1 comment waiting/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Send to dawg" }));
    expect(actions.submit).toHaveBeenCalledWith(
      "s1",
      'A comment on the changes:\n\nsrc/tally/money.py:2-3\n> \n> CENT = Decimal("0.01")\nName the constant.',
    );
    expect(screen.queryByRole("list", { name: "Comments to send" })).not.toBeInTheDocument();
    expect(screen.getByText("Comment sent to dawg.")).toBeInTheDocument();
  });

  it("puts the comments in the message box when a decision card is waiting", async () => {
    const { actions } = setup(theme, { waiting: true, draft: "Half a thought" });
    await pick(/^src\/tally\/money\.py/);
    await screen.findByRole("region", { name: "Changes to src/tally/money.py" });
    await userEvent.click(screen.getByRole("button", { name: "Press + beside original line 1" }));
    expect(
      screen.getByRole("form", { name: "Comment on money.py, line 1 (before the change)" }),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Comment for dawg" }),
      "Why?{Meta>}{Enter}{/Meta}",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send to dawg" }));
    expect(actions.submit).not.toHaveBeenCalled();
    expect(actions.setDraft).toHaveBeenCalledWith(
      "s1",
      "Half a thought\n\nA comment on the changes:\n\nsrc/tally/money.py:1 (the lines as they were before the change)\n> from decimal import Decimal, ROUND_HALF_UP\nWhy?",
    );
    expect(screen.getByText(/the comments are in the message box/)).toBeInTheDocument();
  });

  it("Esc closes the comment form without reaching the window", async () => {
    setup(theme);
    await pick(/^src\/tally\/money\.py/);
    await screen.findByRole("region", { name: "Changes to src/tally/money.py" });
    await userEvent.click(screen.getByRole("button", { name: "Press + beside original line 1" }));
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Comment for dawg" })).not.toBeInTheDocument();
  });

  it("reverts a file only after asking", async () => {
    const { fake } = setup(theme);
    await pick(/^README\.md/);
    await screen.findByRole("region", { name: "Changes to README.md" });
    await userEvent.click(screen.getByRole("button", { name: "Revert file" }));
    const dialog = screen.getByRole("alertdialog", { name: "Revert README.md?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fake.read(`${TREE}/README.md`)).toContain("Refunds split the same way");

    await userEvent.click(screen.getByRole("button", { name: "Revert file" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Revert file" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^README\.md/ })).not.toBeInTheDocument(),
    );
    expect(fake.read(`${TREE}/README.md`)).not.toContain("Refunds");
  });

  it("reverts one change only after asking", async () => {
    setup(theme);
    await pick(/^README\.md/);
    await screen.findByText("Change 1 of 2");
    await userEvent.click(screen.getByRole("button", { name: "Revert change" }));
    const dialog = screen.getByRole("alertdialog", { name: "Revert this change?" });
    expect(dialog).toHaveTextContent("Change 1 of README.md goes back to how it was in main.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revert change" }));
    expect(await screen.findByText("Change 1 of 1")).toBeInTheDocument();
  });

  it("says when a file is binary or too large to compare", async () => {
    setup(theme);
    await pick(/^assets\/logo\.png/);
    expect(await screen.findByText("logo.png is a binary file")).toBeInTheDocument();
    await pick(/^data\/dump\.sql/);
    expect(await screen.findByText("dump.sql is too large to compare here")).toBeInTheDocument();
  });

  it("follows files changing on disk", async () => {
    const { fake } = setup(theme);
    const list = await changedFiles();
    fake.writeExternally(`${TREE}/scratch.txt`, "new\n");
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /^scratch\.txt, new/ })).toBeInTheDocument(),
    );
  });

  it("opens a file in the Files pane", async () => {
    const { actions } = setup(theme);
    await pick(/^README\.md/);
    await userEvent.click(await screen.findByRole("button", { name: "Open in Files" }));
    expect(sessionOf(filesStore.getState(), "s1").pendingOpen).toBe(`${TREE}/README.md`);
    expect(actions.openPane).toHaveBeenCalledWith("files");
  });

  it("says when nothing changed", async () => {
    const bridge = createMemoryBridge({ storage: null });
    const made = await bridge.worktrees.create({
      projectDir: PROJECT,
      name: "clean",
      base: "main",
    });
    setBridgeForTests(bridge);
    const { store } = createTestStore(() => ({
      sessions: { s1: sessionView("s1", made.path, { projectDir: PROJECT }) },
    }));
    renderWithStore(<ChangesPane sessionId="s1" />, { theme, store });
    expect(await screen.findByRole("heading", { name: "No changes yet" })).toBeInTheDocument();
  });
});

describe.each(THEMES)("Changes pane outside git (%s)", (theme) => {
  const cwd = BROWSER_NON_GIT_PROJECT;
  const cli = `${cwd}/src/notes_cli/cli.py`;
  const cliEdit = editItem(cli, [
    {
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 2,
      lines: [" def main() -> None:", '-    print("notes")', '+    print("notes", sys.argv[1:])'],
    },
  ]);
  const staleEdit = editItem(`${cwd}/pyproject.toml`, [
    {
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 1,
      lines: ['-requires-python = ">=3.11"', '+requires-python = ">=3.12"'],
    },
  ]);

  it("lists dawg's edits and shows a file as it was before them", async () => {
    setup(theme, { cwd, transcript: [cliEdit, staleEdit] });
    const list = await changedFiles();
    expect(screen.getByText("dawg’s edits in this session")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: /^src\/notes_cli\/cli\.py/ }));
    const diff = await screen.findByRole("region", { name: "Changes to src/notes_cli/cli.py" });
    await waitFor(() =>
      expect(within(diff).getByTestId("original")).toHaveTextContent('print("notes")'),
    );
    expect(within(diff).getByTestId("modified")).toHaveTextContent("sys.argv[1:]");
    // There is no base to revert to outside git.
    expect(screen.queryByRole("button", { name: "Revert file" })).not.toBeInTheDocument();
  });

  it("shows the edits as dawg made them when the file changed since", async () => {
    setup(theme, { cwd, transcript: [cliEdit, staleEdit] });
    const list = await changedFiles();
    await userEvent.click(within(list).getByRole("button", { name: /^pyproject\.toml/ }));
    expect(
      await screen.findByText(/pyproject\.toml has changed since dawg edited it/),
    ).toBeInTheDocument();
  });

  it("says so when dawg has not edited anything yet", async () => {
    setup(theme, { cwd });
    expect(await screen.findByRole("heading", { name: "No edits yet" })).toBeInTheDocument();
  });
});
