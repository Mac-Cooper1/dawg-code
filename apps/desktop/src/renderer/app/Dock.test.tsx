import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Each pane is tested in its own folder; here a stand-in shows which one the dock rendered.
vi.mock("../panes/index.ts", () => {
  const stand = (pane: string) => (props: { sessionId: string }) => (
    <p>
      {pane} pane for {props.sessionId}
    </p>
  );
  return {
    PANE_COMPONENTS: {
      changes: stand("changes"),
      files: stand("files"),
      terminal: stand("terminal"),
      plan: stand("plan"),
      tasks: stand("tasks"),
    },
  };
});

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

  it("shows the selected pane's own component, for the selected session", () => {
    setup(theme, "terminal");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("terminal pane for fix");
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

  it("hands focus to the message field when it closes with focus inside", async () => {
    const props = {
      pane: "changes" as Pane,
      view: sampleTitleBar(),
      width: 560,
      onSelectPane: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = renderInTheme(
      <>
        <textarea aria-label="Message to dawg" />
        <Dock {...props} />
      </>,
      theme,
    );
    screen.getByRole("button", { name: "Close the panes" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(props.onClose).toHaveBeenCalledOnce();
    rerender(<textarea aria-label="Message to dawg" />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message to dawg" })).toHaveFocus(),
    );
  });
});
