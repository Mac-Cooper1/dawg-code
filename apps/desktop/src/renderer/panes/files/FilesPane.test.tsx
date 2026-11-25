import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../code/editors.tsx",
  async () => (await import("../../code/testing.tsx")).editorStandIns,
);

import { createTestStore, renderWithStore } from "../../app/testing.tsx";
import { createMemoryBridge, setBridgeForTests } from "../../bridge/index.ts";
import { closeAllDocuments } from "../../code/documents.ts";
import { editItem, sessionView } from "../../code/testing.tsx";
import { THEMES } from "../../test/render.tsx";
import { FilesPane } from "./index.tsx";
import { requestOpenFile, resetFiles } from "./store.ts";

const PROJECT = "/Users/you/code/tally";
const MONEY = `${PROJECT}/src/tally/money.py`;

afterEach(() => {
  setBridgeForTests(null);
  resetFiles();
  closeAllDocuments();
});

function setup(theme: "dark" | "light") {
  const bridge = createMemoryBridge({ storage: null });
  setBridgeForTests(bridge);
  const { store } = createTestStore(() => ({
    homeDir: "/Users/you",
    sessions: { s1: sessionView("s1", PROJECT) },
    transcripts: {
      s1: [
        editItem(MONEY, [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
        ]),
        editItem(`${PROJECT}/tests/test_money.py`, [], { created: true }),
      ],
    },
  }));
  const view = renderWithStore(<FilesPane sessionId="s1" />, { theme, store });
  return { fake: bridge.fakeWorkspace, store, view };
}

function tree() {
  return screen.findByRole("tree", { name: "Files" });
}

function item(name: string | RegExp) {
  return screen.getByRole("treeitem", { name });
}

async function openMoney() {
  await tree();
  await userEvent.click(
    await screen.findByRole("treeitem", { name: "src, holds files dawg edited" }),
  );
  await userEvent.click(
    await screen.findByRole("treeitem", { name: "tally, holds files dawg edited" }),
  );
  await userEvent.click(await screen.findByRole("treeitem", { name: "money.py, edited by dawg" }));
  return screen.findByRole("textbox", { name: "Edit src/tally/money.py" });
}

describe.each(THEMES)("Files pane (%s)", (theme) => {
  it("shows the session's folder as a tree: directories first, ignored ones dimmed, dawg's files marked", async () => {
    setup(theme);
    await tree();
    await screen.findByRole("treeitem", { name: "README.md" });
    const names = screen.getAllByRole("treeitem").map((row) => row.getAttribute("aria-label"));
    expect(names).toEqual([
      "tally",
      "assets",
      "data",
      "notes",
      "src, holds files dawg edited",
      "tests, holds files dawg edited",
      ".venv, ignored by git",
      ".gitignore",
      "pyproject.toml",
      "README.md",
      "build.log, ignored by git",
    ]);
    expect(item("tally")).toHaveAttribute("aria-expanded", "true");
    expect(item(".venv, ignored by git").className).toMatch(/ignored/);
    await userEvent.click(item("tests, holds files dawg edited"));
    expect(
      await screen.findByRole("treeitem", { name: "test_money.py, created by dawg" }),
    ).toHaveAttribute("aria-level", "3");
  });

  it("moves through the tree with the keyboard", async () => {
    setup(theme);
    await tree();
    await screen.findByRole("treeitem", { name: "README.md" });
    item("tally").focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(item("src, holds files dawg edited")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(
      await screen.findByRole("treeitem", { name: "tally, holds files dawg edited" }),
    ).toBeInTheDocument();
    // Into the folder, then open it (its dot goes: its files show their own marks).
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    const folder = screen.getAllByRole("treeitem", { name: "tally" })[1];
    expect(folder).toHaveFocus();
    expect(folder).toHaveAttribute("aria-expanded", "true");
    // Close it, then up to its parent.
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(item("src")).toHaveFocus();
    await userEvent.keyboard("{End}{Enter}");
    expect(await screen.findByRole("textbox", { name: "Edit build.log" })).toBeInTheDocument();
  });

  it("opens a file, marks unsaved edits and saves with ⌘S", async () => {
    const { fake } = setup(theme);
    const editor = await openMoney();
    expect(screen.getByText("Edited by dawg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save/ })).toBeDisabled();
    await userEvent.type(editor, "# mine");
    expect(screen.getByRole("button", { name: "money.py, unsaved changes" })).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.keyboard("{Meta>}s{/Meta}");
    await waitFor(() => expect(fake.read(MONEY)).toMatch(/# mine$/));
    expect(screen.getByRole("button", { name: "money.py" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save/ })).toBeDisabled();
  });

  it("reloads a clean file that changed on disk, and asks when it has unsaved edits", async () => {
    const { fake } = setup(theme);
    const editor = await openMoney();
    act(() => fake.writeExternally(MONEY, "theirs\n"));
    await waitFor(() => expect(editor).toHaveValue("theirs\n"));

    await userEvent.type(editor, "mine");
    act(() => fake.writeExternally(MONEY, "theirs again\n"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("money.py changed on disk since you opened it.");
    await userEvent.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(editor).toHaveValue("theirs again\n"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Reload or Overwrite when a save finds the file changed on disk", async () => {
    const { fake } = setup(theme);
    const editor = await openMoney();
    await userEvent.type(editor, "mine");
    // Changed without the watcher noticing: only the save finds out.
    fake.writeExternally(MONEY, "theirs\n", { notify: false });
    await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("money.py changed on disk since you opened it.");
    expect(fake.read(MONEY)).toBe("theirs\n");
    await userEvent.click(within(alert).getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(fake.read(MONEY)).toMatch(/mine$/));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("says when a file is binary or too large instead of opening it", async () => {
    setup(theme);
    await tree();
    await userEvent.click(await screen.findByRole("treeitem", { name: "assets" }));
    await userEvent.click(await screen.findByRole("treeitem", { name: "logo.png" }));
    expect(await screen.findByText("logo.png is a binary file")).toBeInTheDocument();
    await userEvent.click(item("data"));
    await userEvent.click(await screen.findByRole("treeitem", { name: "dump.sql" }));
    expect(await screen.findByText("dump.sql is too large to open here")).toBeInTheDocument();
    expect(screen.getByText(/It is 12 MB/)).toBeInTheDocument();
  });

  it("asks before closing a file with unsaved edits", async () => {
    setup(theme);
    const editor = await openMoney();
    await userEvent.type(editor, "mine");
    await userEvent.click(screen.getByRole("button", { name: "Close money.py" }));
    const dialog = screen.getByRole("alertdialog", { name: "Close money.py without saving?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Close without saving" }));
    expect(
      screen.queryByRole("textbox", { name: "Edit src/tally/money.py" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No file open" })).toBeInTheDocument();
  });

  it("keeps open files and unsaved edits while the pane is hidden", async () => {
    const { view, store } = setup(theme);
    const editor = await openMoney();
    await userEvent.type(editor, "mine");
    view.unmount();
    renderWithStore(<FilesPane sessionId="s1" />, { theme, store });
    const again = await screen.findByRole("textbox", { name: "Edit src/tally/money.py" });
    expect((again as HTMLTextAreaElement).value).toMatch(/mine$/);
    expect(screen.getByRole("button", { name: "money.py, unsaved changes" })).toBeInTheDocument();
  });

  it("opens a file another pane asked for, showing it in the tree", async () => {
    setup(theme);
    await tree();
    act(() => requestOpenFile("s1", `${PROJECT}/tests/test_money.py`));
    expect(
      await screen.findByRole("textbox", { name: "Edit tests/test_money.py" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("treeitem", { name: "test_money.py, created by dawg" }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
