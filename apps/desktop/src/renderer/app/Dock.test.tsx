import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "../../shared/bridge.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { Dock } from "./Dock.tsx";
import { sampleTitleBar } from "./testing.tsx";

function setup(theme: "dark" | "light", pane: Pane = "changes") {
  const props = {
    pane,
    view: sampleTitleBar(),
    width: 560,
    onSelectPane: vi.fn(),
    onClose: vi.fn(),
  };
  renderInTheme(<Dock {...props} />, theme);
  return props;
}

describe.each(THEMES)("Dock (%s)", (theme) => {
  it("is a labelled region with a tab per pane and the title bar's counts", () => {
    setup(theme);
    expect(screen.getByRole("complementary", { name: "Side panes" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Changes3, 3 files changed",
      "Files",
      "Terminal",
      "Plan",
      "Tasks1/3, 1 of 3 done",
    ]);
    expect(screen.getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the selected pane's empty state", () => {
    setup(theme, "terminal");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Terminal");
    expect(panel).toHaveTextContent(
      "Your own shell in the session’s folder. dawg never types here. It arrives in a later build.",
    );
  });

  it("describes every pane", () => {
    for (const [pane, line] of [
      ["changes", "Every file this session changed, as a diff you can comment on."],
      ["files", "The project’s files and an editor"],
      ["plan", "The plan you approved, read-only."],
      ["tasks", "dawg’s task list and background commands"],
    ] as const) {
      const { unmount } = renderInTheme(
        <Dock
          pane={pane}
          view={sampleTitleBar()}
          width={560}
          onSelectPane={vi.fn()}
          onClose={vi.fn()}
        />,
        theme,
      );
      expect(screen.getByRole("tabpanel")).toHaveTextContent(line);
      unmount();
    }
  });

  it("switches panes by click and by arrow keys", async () => {
    const props = setup(theme);
    await userEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(props.onSelectPane).toHaveBeenLastCalledWith("plan");

    screen.getByRole("tab", { name: /^Changes/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveFocus();
    expect(props.onSelectPane).toHaveBeenLastCalledWith("files");
  });

  it("closes", async () => {
    const props = setup(theme);
    await userEvent.click(screen.getByRole("button", { name: "Close the panes" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
