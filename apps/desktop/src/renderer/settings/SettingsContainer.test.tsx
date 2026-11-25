import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { mockModelsState } from "../../shared/mock-models.ts";
import { createTestStore, renderWithStore } from "../app/testing.tsx";
import { THEMES } from "../test/render.tsx";
import { SettingsContainer } from "./SettingsContainer.tsx";

function setup(theme: ResolvedTheme) {
  const test = createTestStore((state) => ({
    layout: { ...state.layout, view: "settings" },
    modelsState: mockModelsState(),
  }));
  test.store.setState({ resolvedTheme: theme });
  renderWithStore(<SettingsContainer />, { theme, store: test.store });
  return { ...test, user: userEvent.setup() };
}

describe.each(THEMES)("SettingsContainer (%s)", (theme) => {
  it("shows the store's settings and saves changes through the actions", async () => {
    const { user, actions, store } = setup(theme);
    expect(screen.getByRole("radio", { name: "Match macOS" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(actions.setAppearance).toHaveBeenCalledWith("dark");
    expect(store.getState().settings.appearance).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "All closed" }));
    expect(actions.setToolCallDisplay).toHaveBeenCalledWith("closed");
    expect(store.getState().settings.toolCalls).toBe("closed");
  });

  it("shows the theme switch for the theme on screen", async () => {
    const { user, actions } = setup(theme);
    const next = theme === "dark" ? "light" : "dark";
    await user.click(screen.getByRole("button", { name: `Switch to ${next} appearance` }));
    expect(actions.setAppearance).toHaveBeenCalledWith(next);
  });

  it("shows Settings → Models from the store, with its actions and notices", async () => {
    const { user, actions, store } = setup(theme);
    store.setState({ notices: [{ id: "n1", text: "Could not delete the model.", tone: "error" }] });
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(actions.setSettingsPage).toHaveBeenCalledWith("models");
    expect(screen.getByRole("heading", { level: 1, name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not delete the model.");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(actions.stopModel).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(actions.dismissNotice).toHaveBeenCalledWith("n1");
  });

  it("moves between pages and back to the sessions", async () => {
    const { user, actions, store } = setup(theme);
    await user.click(screen.getByRole("button", { name: "Shortcuts" }));
    expect(actions.setSettingsPage).toHaveBeenCalledWith("shortcuts");
    expect(screen.getByRole("heading", { level: 1, name: "Shortcuts" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(actions.setView).toHaveBeenCalledWith("sessions");
    expect(store.getState().layout.view).toBe("sessions");
  });
});
