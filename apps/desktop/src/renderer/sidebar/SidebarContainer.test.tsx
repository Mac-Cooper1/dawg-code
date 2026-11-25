import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import {
  createTestStore,
  HOME,
  renderWithStore,
  resetTestViews,
  sampleSidebar,
} from "../app/testing.tsx";
import { THEMES } from "../test/render.tsx";
import { SidebarContainer } from "./SidebarContainer.tsx";

vi.mock("../state/selectors.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../app/testing.tsx")).mockedSelectors,
}));

function setup(theme: ResolvedTheme) {
  resetTestViews({ sidebar: sampleSidebar() });
  const test = createTestStore();
  renderWithStore(<SidebarContainer />, { theme, store: test.store });
  return { ...test, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}

describe.each(THEMES)("SidebarContainer (%s)", (theme) => {
  it("renders the store's sidebar at the store's width", () => {
    setup(theme);
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    expect(nav).toHaveStyle({ width: "264px" });
    expect(screen.getByRole("button", { name: /^Fix the failing split test/ })).toBeInTheDocument();
    expect(screen.getByText("Qwen3.8 27B · 8-bit")).toBeInTheDocument();
  });

  it("keeps the search text in the store", async () => {
    const { user, store, actions } = setup(theme);
    await user.type(screen.getByRole("searchbox", { name: "Search sessions" }), "py");
    expect(actions.setSearch).toHaveBeenLastCalledWith("py");
    expect(store.getState().layout.search).toBe("py");
  });

  it("wires the session actions", async () => {
    const { user, actions } = setup(theme);
    await user.click(screen.getByRole("button", { name: /^Flaky CSV import test/ }));
    expect(actions.selectSession).toHaveBeenCalledWith("csv");

    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(actions.newSession).toHaveBeenLastCalledWith(undefined);
    await user.click(screen.getByRole("button", { name: "New session in tally" }));
    expect(actions.newSession).toHaveBeenLastCalledWith({ projectDir: `${HOME}/code/tally` });

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /^Docs search page/ }),
    });
    await user.click(screen.getByRole("menuitem", { name: "Fork" }));
    expect(actions.forkSession).toHaveBeenCalledWith("docs");

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /^Docs search page/ }),
    });
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Session title" });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, " v2{Enter}");
    expect(actions.renameSession).toHaveBeenCalledWith("docs", "Docs search page v2");

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: /^Docs search page/ }),
    });
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(actions.deleteSession).toHaveBeenCalledWith("docs");
  });

  it("opens Settings on the Models page from the footer", async () => {
    const { user, actions, store } = setup(theme);
    await user.click(screen.getByRole("button", { name: /Model settings$/ }));
    expect(actions.setSettingsPage).toHaveBeenCalledWith("models");
    expect(actions.setView).toHaveBeenCalledWith("settings");
    expect(store.getState().layout).toMatchObject({ view: "settings", settingsPage: "models" });
  });
});
