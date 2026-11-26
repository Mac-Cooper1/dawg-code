import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { NewSessionWorktree, ResolvedTheme } from "../../shared/bridge.ts";
import { createTestStore, renderWithStore } from "../app/testing.tsx";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { GeneralPage } from "./GeneralPage.tsx";
import { SettingsContainer } from "./SettingsContainer.tsx";

interface Options {
  notifications?: boolean;
  dockBadge?: boolean;
  newSessionWorktree?: NewSessionWorktree;
}

/** Holds the choices as the store does. */
function Harness(props: Required<Options> & { on: ReturnType<typeof handlers> }) {
  const [notifications, setNotifications] = useState(props.notifications);
  const [dockBadge, setDockBadge] = useState(props.dockBadge);
  const [newSessionWorktree, setNewSessionWorktree] = useState(props.newSessionWorktree);
  return (
    <GeneralPage
      appearance="system"
      system="dark"
      toolCalls="smart"
      notifications={notifications}
      dockBadge={dockBadge}
      newSessionWorktree={newSessionWorktree}
      onSetAppearance={() => {}}
      onSetToolCallDisplay={() => {}}
      onSetNotifications={(on) => {
        setNotifications(on);
        props.on.onSetNotifications(on);
      }}
      onSetDockBadge={(on) => {
        setDockBadge(on);
        props.on.onSetDockBadge(on);
      }}
      onSetNewSessionWorktree={(value) => {
        setNewSessionWorktree(value);
        props.on.onSetNewSessionWorktree(value);
      }}
    />
  );
}

function handlers() {
  return {
    onSetNotifications: vi.fn<(on: boolean) => void>(),
    onSetDockBadge: vi.fn<(on: boolean) => void>(),
    onSetNewSessionWorktree: vi.fn<(value: NewSessionWorktree) => void>(),
  };
}

function setup(theme: ResolvedTheme, options: Options = {}) {
  const on = handlers();
  renderInTheme(
    <Harness
      notifications={options.notifications ?? true}
      dockBadge={options.dockBadge ?? true}
      newSessionWorktree={options.newSessionWorktree ?? "ask"}
      on={on}
    />,
    theme,
  );
  return { on, user: userEvent.setup() };
}

const NOTIFY = "Notify me when a session needs me or finishes";
const BADGE = "Show a count on the Dock icon";

describe.each(THEMES)("GeneralPage (%s)", (theme) => {
  it("shows the notification switches, named and described, as the settings say", () => {
    setup(theme, { notifications: true, dockBadge: false });
    expect(screen.getByRole("heading", { level: 2, name: "Notifications" })).toBeInTheDocument();
    const notify = screen.getByRole("switch", { name: NOTIFY });
    expect(notify).toBeChecked();
    expect(notify).toHaveAccessibleDescription(
      "Only while dawg is in the background. Click one to open its session.",
    );
    const badge = screen.getByRole("switch", { name: BADGE });
    expect(badge).not.toBeChecked();
    expect(badge).toHaveAccessibleDescription("How many sessions are waiting on you.");
  });

  it("turns notifications and the badge off and on, by click, by its text and by keyboard", async () => {
    const { on, user } = setup(theme);
    await user.click(screen.getByRole("switch", { name: NOTIFY }));
    expect(on.onSetNotifications).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("switch", { name: NOTIFY })).not.toBeChecked();

    // The text is part of the control.
    await user.click(screen.getByText(NOTIFY));
    expect(on.onSetNotifications).toHaveBeenLastCalledWith(true);

    // Tab reaches the badge switch next; Space flips it.
    screen.getByRole("switch", { name: NOTIFY }).focus();
    await user.tab();
    expect(screen.getByRole("switch", { name: BADGE })).toHaveFocus();
    await user.keyboard(" ");
    expect(on.onSetDockBadge).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("switch", { name: BADGE })).not.toBeChecked();
    expect(on.onSetNotifications).toHaveBeenCalledTimes(2);
  });

  it("offers where new sessions run, the current choice checked", () => {
    setup(theme, { newSessionWorktree: "worktree" });
    const group = screen.getByRole("radiogroup", { name: "New sessions" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(within(group).getByRole("radio", { name: "Ask each time" })).toHaveAccessibleDescription(
      "Choose the project folder or a new worktree when you start a session",
    );
    expect(
      within(group).getByRole("radio", { name: "In the project folder" }),
    ).toHaveAccessibleDescription("Start at once, in your own checkout");
    expect(
      within(group).getByRole("radio", { name: "In a new worktree" }),
    ).toHaveAccessibleDescription(
      "Start at once on a new branch from the current one, apart from your work and other sessions",
    );
    expect(screen.getByText(/not a git repository has no worktrees/)).toBeInTheDocument();
  });

  it("chooses where new sessions run by click and by arrow keys", async () => {
    const { on, user } = setup(theme, { newSessionWorktree: "ask" });
    await user.click(screen.getByRole("radio", { name: "In the project folder" }));
    expect(on.onSetNewSessionWorktree).toHaveBeenLastCalledWith("folder");
    expect(screen.getByRole("radio", { name: "In the project folder" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Held down, as a person would: Radix chooses when focus arrives while an arrow is pressed.
    await user.keyboard("{ArrowDown>}");
    await waitFor(() => expect(on.onSetNewSessionWorktree).toHaveBeenLastCalledWith("worktree"));
    await user.keyboard("{/ArrowDown}");
    expect(screen.getByRole("radio", { name: "In a new worktree" })).toHaveFocus();
  });
});

describe.each(THEMES)("GeneralPage in SettingsContainer (%s)", (theme) => {
  it("shows the store's settings and saves changes through the actions", async () => {
    const test = createTestStore((state) => ({
      layout: { ...state.layout, view: "settings" },
      settings: { ...state.settings, dockBadge: false, newSessionWorktree: "folder" },
    }));
    test.store.setState({ resolvedTheme: theme });
    renderWithStore(<SettingsContainer />, { theme, store: test.store });
    const user = userEvent.setup();

    expect(screen.getByRole("switch", { name: NOTIFY })).toBeChecked();
    expect(screen.getByRole("switch", { name: BADGE })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "In the project folder" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByRole("switch", { name: NOTIFY }));
    expect(test.actions.setNotifications).toHaveBeenCalledWith(false);
    expect(test.store.getState().settings.notifications).toBe(false);
    await user.click(screen.getByRole("switch", { name: BADGE }));
    expect(test.actions.setDockBadge).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch", { name: BADGE })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "In a new worktree" }));
    expect(test.actions.setNewSessionWorktree).toHaveBeenCalledWith("worktree");
    expect(test.store.getState().settings.newSessionWorktree).toBe("worktree");
  });
});
