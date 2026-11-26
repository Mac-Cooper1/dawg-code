import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ResolvedTheme } from "../../../shared/bridge.ts";
import { SIDEBAR_SEARCH_ID } from "../../sidebar/Sidebar.tsx";
import { THEMES } from "../../test/render.tsx";
import { type SessionsStoreOptions, sessionsStore } from "../commands/testing.ts";
import type { PlatformOs } from "../platform.tsx";
import { renderWithStore } from "../testing.tsx";
import { useGlobalShortcuts } from "../useShortcuts.ts";
import { CommandPalette } from "./CommandPalette.tsx";

/** The window's shortcuts, a message field and the sidebar's search field around the palette. */
function Harness() {
  useGlobalShortcuts();
  return (
    <>
      <textarea aria-label="Message to dawg" />
      <input id={SIDEBAR_SEARCH_ID} type="search" aria-label="Search sessions" />
      <CommandPalette />
    </>
  );
}

function setup(theme: ResolvedTheme, options: SessionsStoreOptions & { os?: PlatformOs } = {}) {
  const test = sessionsStore(options);
  renderWithStore(<Harness />, { theme, store: test.store, os: options.os ?? "darwin" });
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const field = screen.getByRole("textbox", { name: "Message to dawg" });
  return { ...test, user, field };
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Meta>}k{/Meta}");
  return screen.getByRole("dialog", { name: "Command palette" });
}

function search() {
  return screen.getByRole("combobox", { name: "Search actions and sessions" });
}

/** The option the search field points at. */
function activeOption(): HTMLElement {
  const id = search().getAttribute("aria-activedescendant");
  const option = id ? document.getElementById(id) : null;
  if (!option) throw new Error("no active option");
  expect(option).toHaveAttribute("aria-selected", "true");
  return option;
}

describe.each(THEMES)("CommandPalette (%s)", (theme) => {
  it("opens with ⌘K over sessions and actions, and closes with Esc, giving focus back", async () => {
    const { user, field } = setup(theme);
    await user.click(field);
    const dialog = await openPalette(user);
    expect(search()).toHaveFocus();
    const list = screen.getByRole("listbox", { name: "Actions and sessions" });
    expect(search()).toHaveAttribute("aria-controls", list.id);
    const recent = within(list).getByRole("group", { name: "Recent sessions" });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("Flaky CSV import test"),
      expect.stringContaining("Docs search page"),
      expect.stringContaining("Fix broken links in docs"),
    ]);
    expect(within(list).getByRole("group", { name: "This session" })).toBeInTheDocument();
    expect(activeOption()).toHaveAccessibleName(/^Flaky CSV import test, Idle, tally/);

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("takes Esc for itself, so closing it does not stop a working session", async () => {
    const { user, actions, field } = setup(theme, { open: { fix: { activeTurnId: "t1" } } });
    await user.click(field);
    await openPalette(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(field).toHaveFocus());
    expect(actions.interrupt).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(actions.interrupt).toHaveBeenCalledWith("fix");
  });

  it("closes with ⌘K too", async () => {
    const { user } = setup(theme);
    const dialog = await openPalette(user);
    await user.keyboard("{Meta>}k{/Meta}");
    expect(dialog).not.toBeInTheDocument();
  });

  it("shows each action's shortcut, and reads it out", async () => {
    const { user } = setup(theme);
    await openPalette(user);
    const sidebar = screen.getByRole("option", { name: /^Show or hide the sidebar/ });
    expect(within(sidebar).getByText("⌘B").tagName).toBe("KBD");
    expect(sidebar).toHaveAccessibleName("Show or hide the sidebar, Command B");
    expect(
      screen.getByRole("option", { name: /^Permission mode: Ask first, in use/ }),
    ).toBeTruthy();
  });

  it("filters as you type and says when nothing matches", async () => {
    const { user } = setup(theme);
    await openPalette(user);
    await user.type(search(), "fork");
    expect(activeOption()).toHaveAccessibleName("Fork the session");
    await user.clear(search());
    await user.type(search(), "zebra crossing");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No actions or sessions match “zebra crossing”.",
    );
  });

  it("moves with the arrows, Home, End, Page Up and Page Down", async () => {
    const { user } = setup(theme);
    await openPalette(user);
    const options = screen.getAllByRole("option");
    const at = (index: number) => options[index]?.id;
    expect(activeOption().id).toBe(at(0));
    await user.keyboard("{ArrowDown}");
    expect(activeOption().id).toBe(at(1));
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(activeOption().id).toBe(at(options.length - 1));
    await user.keyboard("{Home}");
    expect(activeOption().id).toBe(at(0));
    await user.keyboard("{PageDown}");
    expect(activeOption().id).toBe(at(8));
    await user.keyboard("{PageUp}{PageUp}");
    expect(activeOption().id).toBe(at(0));
    await user.keyboard("{End}");
    expect(activeOption().id).toBe(at(options.length - 1));
  });

  it("runs the chosen action with ⏎ and remembers it", async () => {
    const { user, actions } = setup(theme);
    const dialog = await openPalette(user);
    await user.type(search(), "fork{Enter}");
    expect(actions.forkSession).toHaveBeenCalledWith("fix");
    expect(dialog).not.toBeInTheDocument();

    await openPalette(user);
    const recent = screen.getByRole("group", { name: "Recently used" });
    expect(within(recent).getByRole("option", { name: "Fork the session" })).toBeInTheDocument();
  });

  it("leaves ⏎ to an IME that is composing", async () => {
    const { user, actions } = setup(theme);
    await openPalette(user);
    await user.type(search(), "fork");
    fireEvent.keyDown(search(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(search(), { key: "Enter", keyCode: 229 });
    expect(actions.forkSession).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(actions.forkSession).toHaveBeenCalledWith("fix");
  });

  it("runs an action with the mouse", async () => {
    const { user, actions } = setup(theme);
    await openPalette(user);
    const light = screen.getByRole("option", { name: /^Appearance: Light/ });
    await user.pointer({ target: light });
    expect(activeOption()).toBe(light);
    await user.click(light);
    expect(actions.setAppearance).toHaveBeenCalledWith("light");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("opens a session", async () => {
    const { user, actions, field } = setup(theme);
    await openPalette(user);
    await user.type(search(), "dawg-site broken{Enter}");
    expect(actions.selectSession).toHaveBeenCalledWith("links");
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("explains an action that cannot run, and does not run it", async () => {
    const { user, actions } = setup(theme);
    await openPalette(user);
    await user.type(search(), "stop the");
    const stop = screen.getByRole("option", { name: /^Stop the running turn/ });
    expect(stop).toHaveAttribute("aria-disabled", "true");
    expect(stop).toHaveAccessibleName(
      "Stop the running turn, unavailable: Nothing is running, Escape",
    );
    expect(stop).toHaveTextContent("Nothing is running");
    await user.click(stop);
    expect(actions.interrupt).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("renames the session in the palette", async () => {
    const { user, actions } = setup(theme);
    await openPalette(user);
    await user.type(search(), "rename{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Rename “Fix the failing split test”" });
    const title = within(dialog).getByRole("textbox", { name: "Session title" });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveValue("Fix the failing split test");
    await user.clear(title);
    await user.type(title, "Split cents properly{Enter}");
    expect(actions.renameSession).toHaveBeenCalledWith("fix", "Split cents properly");
    expect(dialog).not.toBeInTheDocument();
  });

  it("asks before deleting the session", async () => {
    const { user, actions } = setup(theme, { open: { fix: { activeTurnId: "t1" } } });
    await openPalette(user);
    await user.type(search(), "delete the{Enter}");
    const confirm = await screen.findByRole("alertdialog", {
      name: "Delete “Fix the failing split test”?",
    });
    expect(confirm).toHaveTextContent("This cannot be undone.");
    expect(confirm).toHaveTextContent("the running turn stops first");
    await waitFor(() =>
      expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(actions.deleteSession).toHaveBeenCalledWith("fix");
  });

  it("searches the sessions in the sidebar", async () => {
    const { user, actions } = setup(theme);
    await openPalette(user);
    await user.type(search(), "search sessions{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Search sessions" })).toHaveFocus(),
    );
    expect(actions.setView).not.toHaveBeenCalled();
  });

  it("opens from Settings with what applies there", async () => {
    const { user, actions } = setup(theme, {
      patch: (state) => ({ layout: { ...state.layout, view: "settings" } }),
    });
    await openPalette(user);
    expect(screen.queryByRole("group", { name: "This session" })).not.toBeInTheDocument();
    await user.type(search(), "back to{Enter}");
    expect(actions.setView).toHaveBeenCalledWith("sessions");
  });

  it("opens on first run with Settings, appearance and help", async () => {
    const { user } = setup(theme, { patch: () => ({ onboarding: { step: "welcome" } }) });
    await openPalette(user);
    const headings = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-labelledby"))
      .map((id) => (id ? document.getElementById(id)?.textContent : null));
    expect(headings).toEqual(["View", "Settings", "Help"]);
  });

  it("writes Ctrl shortcuts off macOS", async () => {
    const { user } = setup(theme, { os: "linux" });
    await user.keyboard("{Control>}k{/Control}");
    const sidebar = screen.getByRole("option", { name: /^Show or hide the sidebar/ });
    expect(within(sidebar).getByText("Ctrl+B")).toBeInTheDocument();
  });
});
