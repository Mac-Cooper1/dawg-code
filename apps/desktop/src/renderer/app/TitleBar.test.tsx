import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import type { TitleBarView } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { type PlatformOs, PlatformProvider } from "./platform.tsx";
import { TitleBar, type TitleBarProps } from "./TitleBar.tsx";
import { sampleTitleBar } from "./testing.tsx";

function setup(
  theme: ResolvedTheme,
  options: { view?: Partial<TitleBarView>; props?: Partial<TitleBarProps>; os?: PlatformOs } = {},
) {
  const props: TitleBarProps = {
    view: sampleTitleBar(options.view),
    theme,
    sidebarOpen: true,
    dockOpen: false,
    dockPane: "changes",
    onToggleSidebar: vi.fn(),
    onTogglePane: vi.fn(),
    onSetAppearance: vi.fn(),
    ...options.props,
  };
  renderInTheme(
    <PlatformProvider os={options.os ?? "darwin"}>
      <TitleBar {...props} />
    </PlatformProvider>,
    theme,
  );
  return props;
}

describe.each(THEMES)("TitleBar (%s)", (theme) => {
  it("shows the session title with its project and worktree chips", () => {
    setup(theme);
    expect(screen.getByRole("heading", { name: "Fix the failing split test" })).toBeInTheDocument();
    expect(screen.getByText("tally")).toBeInTheDocument();
    expect(screen.getByText("worktree · split-cents")).toBeInTheDocument();
  });

  it("leaves out the worktree chip when the session has none", () => {
    setup(theme, { view: { worktreeLabel: null } });
    expect(screen.queryByText(/worktree/)).not.toBeInTheDocument();
  });

  it("toggles the sidebar and names the button after what it does", async () => {
    const props = setup(theme);
    await userEvent.click(screen.getByRole("button", { name: "Hide the sidebar" }));
    expect(props.onToggleSidebar).toHaveBeenCalledOnce();
  });

  it("offers to show a hidden sidebar", () => {
    setup(theme, { props: { sidebarOpen: false } });
    expect(screen.getByRole("button", { name: "Show the sidebar" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("opens the dock on each pane, with the change totals and the task count", async () => {
    const props = setup(theme);
    const panes = within(screen.getByRole("navigation", { name: "Side panes" }));
    const changes = panes.getByRole("button", { name: /^Changes/ });
    expect(changes).toHaveTextContent("+11");
    expect(changes).toHaveTextContent("−2");
    expect(changes).toHaveAccessibleName("Changes, 11 lines added, 2 removed");
    expect(panes.getByRole("button", { name: "Tasks, 1 of 3 done" })).toHaveTextContent("1/3");

    for (const [name, pane] of [
      ["Changes", "changes"],
      ["Files", "files"],
      ["Terminal", "terminal"],
      ["Plan", "plan"],
      ["Tasks", "tasks"],
    ] as const) {
      await userEvent.click(panes.getByRole("button", { name: new RegExp(`^${name}`) }));
      expect(props.onTogglePane).toHaveBeenLastCalledWith(pane);
    }
  });

  it("highlights the pane the dock shows", () => {
    setup(theme, { props: { dockOpen: true, dockPane: "files" } });
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Changes/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows no pane buttons and no changes without a session", () => {
    setup(theme, {
      view: { sessionId: null, title: "dawg-code", projectName: null, worktreeLabel: null },
    });
    expect(screen.queryByRole("navigation", { name: "Side panes" })).not.toBeInTheDocument();
  });

  it("switches to the opposite appearance and shows where it goes", async () => {
    const props = setup(theme);
    const next = theme === "dark" ? "light" : "dark";
    const button = screen.getByRole("button", { name: `Switch to ${next} appearance` });
    // The sun (with its centre circle) while dark, the moon while light.
    expect(button.querySelector("circle") !== null).toBe(theme === "dark");
    await userEvent.click(button);
    expect(props.onSetAppearance).toHaveBeenCalledWith(next);
  });

  it("leaves room for the traffic lights only in Electron on macOS", () => {
    setup(theme, { os: "darwin" });
    expect(screen.getByRole("banner")).toHaveAttribute("data-traffic-lights", "true");
  });

  it("has no traffic-light inset in a browser", () => {
    setup(theme, { os: "browser" });
    expect(screen.getByRole("banner")).not.toHaveAttribute("data-traffic-lights");
  });
});
