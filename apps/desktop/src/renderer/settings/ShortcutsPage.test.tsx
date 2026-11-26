import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { COMMANDS } from "../app/commands/registry.ts";
import { COMMAND_GROUPS } from "../app/commands/types.ts";
import { type PlatformOs, PlatformProvider } from "../app/platform.tsx";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { keymap, ShortcutsPage } from "./ShortcutsPage.tsx";

function setup(theme: ResolvedTheme, os: PlatformOs = "darwin") {
  renderInTheme(
    <PlatformProvider os={os}>
      <ShortcutsPage />
    </PlatformProvider>,
    theme,
  );
  return { user: userEvent.setup() };
}

/**
 * An action's row. Found by its title's text: the keymap is long, and working out every row's
 * accessible name for a role query is slow in jsdom.
 */
function row(action: string): HTMLTableRowElement {
  const found = screen.getByText(action, { exact: true }).closest("tr");
  if (!found) throw new Error(`no row for ${action}`);
  return found;
}

/** The keycaps of an action's row, as shown. */
function caps(action: string): string[] {
  return [...row(action).querySelectorAll("kbd")].map((cap) => cap.textContent ?? "");
}

/** The actions listed, by their titles. */
function actions(): string[] {
  return [...document.querySelectorAll("tbody th[scope='row']")].map(
    (header) => header.firstElementChild?.textContent ?? "",
  );
}

describe.each(THEMES)("ShortcutsPage (%s)", (theme) => {
  it("lists every shortcut from the registry, grouped as in the palette", () => {
    setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "Shortcuts" })).toBeInTheDocument();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(
      COMMAND_GROUPS.filter((group) =>
        COMMANDS.some((command) => command.group === group && command.shortcut),
      ),
    );
    expect(actions()).toHaveLength(COMMANDS.filter((command) => command.shortcut).length);
    expect(screen.getByRole("table", { name: "Composer" })).toBeInTheDocument();
    const header = within(row("Next session")).getByRole("rowheader");
    expect(header).toHaveAccessibleName("Next session");
  });

  it("shows keycaps and reads them out, with where a shortcut works", () => {
    setup(theme);
    expect(caps("Next session")).toEqual(["⇧", "⌘", "]"]);
    expect(caps("Show the command palette")).toEqual(["⌘", "K"]);
    expect(screen.getByText("Shift Command Right Bracket")).toBeInTheDocument();
    expect(row("Cycle the permission mode")).toHaveTextContent("In the message field");
    expect(caps("Cycle the permission mode")).toEqual(["⇧", "Tab"]);
    // Alternatives are both shown.
    expect(caps("Move through the list")).toEqual(["↑", "↓"]);
    expect(row("Move through the list")).toHaveTextContent("or");
  });

  it("filters by action, key or place", async () => {
    const { user } = setup(theme);
    const filter = screen.getByRole("searchbox", { name: "Filter shortcuts" });
    // Pasted: one change each, rather than a keystroke per letter.
    await user.click(filter);
    await user.paste("terminal");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Panes",
    ]);
    expect(actions()).toContain("Send Esc to the shell, not to dawg");

    await user.clear(filter);
    await user.paste("⌘K");
    expect(actions()).toEqual(["Show the command palette"]);

    await user.clear(filter);
    await user.paste("nothing like this");
    expect(screen.getByRole("status")).toHaveTextContent("No shortcuts match “nothing like this”.");
    await user.keyboard("{Escape}");
    expect(filter).toHaveValue("");
    expect(document.querySelectorAll("table").length).toBeGreaterThan(1);
  });

  it("writes Ctrl shortcuts off macOS", () => {
    setup(theme, "linux");
    expect(caps("Next session")).toEqual(["Ctrl", "Shift", "]"]);
    expect(caps("Stop the running turn")).toEqual(["Esc"]);
  });

  it("is a read-only list", () => {
    setup(theme);
    expect(screen.getByText("Shortcuts cannot be changed yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("the keymap", () => {
  it("leaves out actions without a shortcut", () => {
    const titles = keymap("", "darwin").flatMap((group) =>
      group.commands.map((command) => command.title),
    );
    expect(titles).not.toContain("Fork the session");
    expect(titles).toContain("Send the message");
  });
});
