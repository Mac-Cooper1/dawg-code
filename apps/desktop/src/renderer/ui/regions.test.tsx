import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { useRegionKeys } from "./regions.ts";

/** The window's parts, as the main window lays them out. */
function Window(props: { dock?: boolean; dialog?: boolean }) {
  useRegionKeys();
  return (
    <>
      <header>
        <button type="button">Hide the sidebar</button>
        <nav aria-label="Side panes">
          <button type="button">Changes</button>
        </nav>
      </header>
      <nav aria-label="Sessions">
        <button type="button">New session</button>
        <button type="button" data-session-row="a" tabIndex={-1}>
          Fix the split
        </button>
        <button type="button" data-session-row="b" tabIndex={0}>
          Flaky CSV import test
        </button>
      </nav>
      <main>
        <button type="button">Show the card again</button>
        <textarea aria-label="Message to dawg" />
      </main>
      {props.dock && (
        <aside aria-label="Panes">
          <div role="tablist">
            <button type="button" role="tab" aria-selected="false" tabIndex={-1}>
              Changes
            </button>
            <button type="button" role="tab" aria-selected="true">
              Terminal
            </button>
          </div>
          {/* The terminal keeps Tab for the shell. */}
          <textarea aria-label="Terminal input" />
        </aside>
      )}
      {props.dialog && (
        <div role="dialog" aria-label="Command palette">
          <input role="combobox" aria-expanded="true" aria-label="Search actions and sessions" />
        </div>
      )}
    </>
  );
}

describe.each(THEMES)("F6 between the window's parts (%s)", (theme) => {
  it("goes title bar, sidebar, message field, panes, and round again; ⇧F6 goes back", async () => {
    const user = userEvent.setup();
    renderInTheme(<Window dock />, theme);
    await user.keyboard("{F6}");
    expect(screen.getByRole("button", { name: "Hide the sidebar" })).toHaveFocus();
    await user.keyboard("{F6}");
    // The sidebar's current row, not its first control.
    expect(screen.getByRole("button", { name: "Flaky CSV import test" })).toHaveFocus();
    await user.keyboard("{F6}");
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toHaveFocus();
    await user.keyboard("{F6}");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
    await user.keyboard("{F6}");
    expect(screen.getByRole("button", { name: "Hide the sidebar" })).toHaveFocus();
    await user.keyboard("{Shift>}{F6}{/Shift}");
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
    await user.keyboard("{Shift>}{F6}{/Shift}");
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toHaveFocus();
  });

  it("leaves a part that keeps Tab for itself", async () => {
    const user = userEvent.setup();
    renderInTheme(<Window dock />, theme);
    screen.getByRole("textbox", { name: "Terminal input" }).focus();
    await user.keyboard("{F6}");
    expect(screen.getByRole("button", { name: "Hide the sidebar" })).toHaveFocus();
  });

  it("does nothing inside a dialog", async () => {
    const user = userEvent.setup();
    renderInTheme(<Window dialog />, theme);
    const search = screen.getByRole("combobox", { name: "Search actions and sessions" });
    search.focus();
    await user.keyboard("{F6}");
    expect(search).toHaveFocus();
  });
});
