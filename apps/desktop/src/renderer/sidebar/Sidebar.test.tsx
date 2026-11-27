import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { SAMPLE_FOOTER, sampleSidebar } from "../app/testing.tsx";
import type { ModelFooterView, SidebarGroup, SidebarMark } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import styles from "./Sidebar.module.css";
import { SIDEBAR_SEARCH_ID, Sidebar, type SidebarProps } from "./Sidebar.tsx";
import { MARK_CLASS } from "./StatusMark.tsx";

/** A CSS-module class name, which TypeScript sees as possibly undefined. */
function cls(name: string | undefined): string {
  if (!name) throw new Error("missing CSS module class");
  return name;
}

type Handlers = Omit<SidebarProps, "groups" | "search" | "footer" | "width">;

function handlers(): Handlers {
  return {
    onSearch: vi.fn(),
    onNewSession: vi.fn(),
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onFork: vi.fn(),
    onMarkUnread: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onOpenModelSettings: vi.fn(),
  };
}

/** Keeps the search text, as the store would. */
function Harness(props: Handlers & { groups: SidebarGroup[]; footer: ModelFooterView }) {
  const [search, setSearch] = useState("");
  return (
    <Sidebar
      {...props}
      search={search}
      width={264}
      onSearch={(query) => {
        setSearch(query);
        props.onSearch(query);
      }}
    />
  );
}

function setup(
  theme: ResolvedTheme,
  options: { groups?: SidebarGroup[]; footer?: ModelFooterView } = {},
) {
  const on = handlers();
  renderInTheme(
    <Harness
      {...on}
      groups={options.groups ?? sampleSidebar()}
      footer={options.footer ?? SAMPLE_FOOTER}
    />,
    theme,
  );
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  return { on, user };
}

const row = (name: RegExp | string) => screen.getByRole("button", { name });

describe.each(THEMES)("Sidebar (%s)", (theme) => {
  it("is a navigation landmark with sessions grouped by project", () => {
    setup(theme);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["tally", "dawg-site", "notes-cli"]);
    expect(screen.getByText("~/code/tally")).toBeInTheDocument();
    const tally = screen.getByRole("list", { name: "tally" });
    expect(within(tally).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(screen.getByRole("list", { name: "dawg-site" })).getAllByRole("listitem"),
    ).toHaveLength(2);
  });

  it("names each row with its title, status and time", () => {
    setup(theme);
    expect(
      row("Fix the failing split test, Working: editing money.py, in a worktree, now"),
    ).toBeInTheDocument();
    expect(row("Receipt PDF layout, Done, unread, Done, not opened yet, 1h")).toBeInTheDocument();
    expect(row("Fix broken links in docs, Idle, Yesterday")).toBeInTheDocument();
    expect(screen.getByText("Working: editing money.py")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("draws each status mark in its own shape, with a hidden label", () => {
    setup(theme);
    const expected: [string, SidebarMark, string][] = [
      ["Fix the failing split test", "working", "Working"],
      ["Flaky CSV import test", "needs-you", "Needs you"],
      ["Receipt PDF layout", "unread", "Done, unread"],
      ["Docs search page", "queued", "Queued"],
      ["Bump to Python 3.13", "error", "Error"],
    ];
    for (const [title, mark, label] of expected) {
      const button = row(new RegExp(`^${title.replace(/\./g, "\\.")}`));
      const shape = button.querySelector("[data-mark]");
      expect(shape).toHaveAttribute("data-mark", mark);
      expect(shape).toHaveClass(cls(styles.mark), cls(MARK_CLASS[mark]));
      expect(shape).toHaveAttribute("aria-hidden", "true");
      expect(within(button).getByText(label, { exact: true })).toHaveClass("vh");
    }
    // Shapes differ: every mark class is distinct.
    const classes = Object.values(MARK_CLASS).filter(Boolean);
    expect(new Set(classes).size).toBe(classes.length);

    const idle = row(/^Fix broken links in docs/);
    expect(idle.querySelector("[data-mark]")).toBeNull();
    expect(within(idle).getByText("Idle")).toHaveClass("vh");
  });

  it("marks the selected row and selects on click", async () => {
    const { on, user } = setup(theme);
    expect(row(/^Fix the failing split test/)).toHaveAttribute("aria-current", "true");
    expect(row(/^Flaky CSV import test/)).not.toHaveAttribute("aria-current");
    await user.click(row(/^Flaky CSV import test/));
    expect(on.onSelect).toHaveBeenCalledWith("csv");
  });

  it("keeps one row in the tab order and moves between rows with the arrows", async () => {
    const { on, user } = setup(theme);
    screen.getByRole("searchbox", { name: "Search sessions" }).focus();
    await user.tab();
    // The project's "New session in tally" button, then the selected row and its actions.
    expect(screen.getByRole("button", { name: "New session in tally" })).toHaveFocus();
    await user.tab();
    expect(row(/^Fix the failing split test/)).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Actions for Fix the failing split test" }),
    ).toHaveFocus();
    // The other rows are reached with the arrows, across projects, not with Tab.
    await user.tab();
    expect(screen.getByRole("button", { name: "New session in dawg-site" })).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(row(/^Fix the failing split test/)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Flaky CSV import test/)).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(row(/^Docs search page/)).toHaveFocus();
    await user.keyboard("{End}");
    expect(row(/^Bump to Python 3.13/)).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}");
    expect(row(/^Flaky CSV import test/)).toHaveFocus();
    // The row with focus is now the one Tab comes back to.
    expect(row(/^Flaky CSV import test/)).toHaveAttribute("tabindex", "0");
    expect(row(/^Fix the failing split test/)).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{Enter}");
    expect(on.onSelect).toHaveBeenCalledWith("csv");
  });

  it("moves focus to the list's current row when the focused row goes away", async () => {
    const groups = sampleSidebar();
    const on = handlers();
    const props = { ...on, search: "", footer: SAMPLE_FOOTER, width: 264 };
    const { rerender } = renderInTheme(<Sidebar {...props} groups={groups} />, theme);
    const user = userEvent.setup();
    row(/^Fix the failing split test/).focus();
    await user.keyboard("{ArrowDown}");
    expect(row(/^Flaky CSV import test/)).toHaveFocus();
    // The session is deleted: its row leaves, and the selected row takes focus.
    const without = groups.map((group) => ({
      ...group,
      rows: group.rows.filter((candidate) => candidate.sessionId !== "csv"),
    }));
    rerender(<Sidebar {...props} groups={without} />);
    await waitFor(() => expect(row(/^Fix the failing split test/)).toHaveFocus());
  });

  it("starts new sessions, in a project or after choosing a folder", async () => {
    const { on, user } = setup(theme);
    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(on.onNewSession).toHaveBeenLastCalledWith();
    await user.click(screen.getByRole("button", { name: "New session in dawg-site" }));
    expect(on.onNewSession).toHaveBeenLastCalledWith("/Users/me/code/dawg-site");
  });

  it("binds the search field and clears it with Esc", async () => {
    const { on, user } = setup(theme);
    const search = screen.getByRole("searchbox", { name: "Search sessions" });
    expect(search).toHaveAttribute("id", SIDEBAR_SEARCH_ID);
    await user.type(search, "csv");
    expect(on.onSearch).toHaveBeenLastCalledWith("csv");
    expect(search).toHaveValue("csv");
    await user.keyboard("{Escape}");
    expect(on.onSearch).toHaveBeenLastCalledWith("");
    expect(search).toHaveValue("");
  });

  it("says when nothing matches or there are no sessions", () => {
    const { unmount } = renderInTheme(
      <Sidebar {...handlers()} groups={[]} search="zebra" footer={SAMPLE_FOOTER} width={264} />,
      theme,
    );
    expect(screen.getByText("No sessions match “zebra”.")).toBeInTheDocument();
    unmount();
    renderInTheme(
      <Sidebar {...handlers()} groups={[]} search="" footer={SAMPLE_FOOTER} width={264} />,
      theme,
    );
    expect(screen.getByText("No sessions yet. Start one with New session.")).toBeInTheDocument();
  });

  it("offers the row actions in a context menu", async () => {
    const { on, user } = setup(theme);
    await user.pointer({ keys: "[MouseRight]", target: row(/^Flaky CSV import test/) });
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Rename", "Fork", "Mark as unread", "Archive", "Delete…"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Fork" }));
    expect(on.onFork).toHaveBeenCalledWith("csv");

    await user.pointer({ keys: "[MouseRight]", target: row(/^Receipt PDF layout/) });
    await user.click(screen.getByRole("menuitem", { name: "Mark as unread" }));
    expect(on.onMarkUnread).toHaveBeenCalledWith("pdf");

    await user.pointer({ keys: "[MouseRight]", target: row(/^Bump to Python/) });
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(on.onArchive).toHaveBeenCalledWith("py");
  });

  it("offers the same actions behind the … button, by keyboard too", async () => {
    const { on, user } = setup(theme);
    const more = screen.getByRole("button", { name: "Actions for Docs search page" });
    more.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(5);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(on.onArchive).toHaveBeenCalledWith("docs");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("asks before deleting, naming the session, and deletes only when confirmed", async () => {
    const { on, user } = setup(theme);
    await user.pointer({ keys: "[MouseRight]", target: row(/^Receipt PDF layout/) });
    const item = screen.getByRole("menuitem", { name: "Delete…" });
    expect(item.className).toMatch(/danger/);
    await user.click(item);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Receipt PDF layout”?" });
    expect(dialog).toHaveAccessibleDescription(
      "The session and its transcript are deleted for good. This cannot be undone.",
    );
    // Cancel has focus: Enter or Esc keeps the session.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(on.onDelete).not.toHaveBeenCalled();
    expect(row(/^Receipt PDF layout/)).toHaveFocus();

    const more = screen.getByRole("button", { name: "Actions for Receipt PDF layout" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const again = await screen.findByRole("alertdialog");
    await user.click(within(again).getByRole("button", { name: "Delete" }));
    expect(on.onDelete).toHaveBeenCalledExactlyOnceWith("pdf");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("says that a running turn stops when the session is deleted", async () => {
    const { user } = setup(theme);
    await user.click(
      screen.getByRole("button", { name: "Actions for Fix the failing split test" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(dialog).toHaveTextContent("dawg is working in it: the running turn stops first.");
  });

  it("renames inline: Enter saves", async () => {
    const { on, user } = setup(theme);
    await user.pointer({ keys: "[MouseRight]", target: row(/^Flaky CSV import test/) });
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Session title" });
    expect(field).toHaveValue("Flaky CSV import test");
    await waitFor(() => expect(field).toHaveFocus());
    await user.clear(field);
    await user.type(field, "Fix the CSV import race{Enter}");
    expect(on.onRename).toHaveBeenCalledWith("csv", "Fix the CSV import race");
    expect(screen.queryByRole("textbox", { name: "Session title" })).not.toBeInTheDocument();
    expect(row(/^Flaky CSV import test/)).toHaveFocus();
  });

  it("renames inline: Esc cancels without saving", async () => {
    const { on, user } = setup(theme);
    screen.getByRole("button", { name: "Actions for Receipt PDF layout" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Session title" });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, " v2{Escape}");
    expect(on.onRename).not.toHaveBeenCalled();
    expect(row(/^Receipt PDF layout/)).toHaveFocus();
  });

  it("shows the running model in the footer and opens model settings", async () => {
    const { on, user } = setup(theme);
    const footer = screen.getByRole("button", {
      name: "Qwen3.8 27B · 8-bit, Ready · 1 running, 1 queued. Model settings",
    });
    expect(footer).toHaveTextContent("Qwen3.8 27B · 8-bit");
    expect(footer).toHaveTextContent("Ready · 1 running, 1 queued");
    expect(footer.querySelector("[data-ready]")).toHaveAttribute("data-ready", "true");
    await user.click(footer);
    expect(on.onOpenModelSettings).toHaveBeenCalledOnce();
  });

  it("greys the footer's dot while the model is not ready", () => {
    setup(theme, {
      footer: { label: "Qwen3.8 27B · 8-bit", state: "loading", detail: "Loading into memory" },
    });
    const footer = screen.getByRole("button", { name: /Model settings$/ });
    expect(footer.querySelector("[data-ready]")).toHaveAttribute("data-ready", "false");
  });
});
