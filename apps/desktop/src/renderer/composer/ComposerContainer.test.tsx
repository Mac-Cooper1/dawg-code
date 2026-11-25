import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import {
  createTestStore,
  renderWithStore,
  resetTestViews,
  sampleComposer,
} from "../app/testing.tsx";
import type { ComposerView, ConnectionState } from "../state/types.ts";
import { THEMES } from "../test/render.tsx";
import { ComposerContainer } from "./ComposerContainer.tsx";

vi.mock("../state/selectors.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../app/testing.tsx")).mockedSelectors,
}));

const READY: ConnectionState = { phase: "ready", engine: { name: "mock", version: "1" } };

function setup(
  theme: ResolvedTheme,
  options: { view?: Partial<ComposerView>; connection?: ConnectionState } = {},
) {
  resetTestViews({ composer: { fix: sampleComposer(options.view) } });
  const test = createTestStore(() => ({ connection: options.connection ?? READY }));
  renderWithStore(<ComposerContainer sessionId="fix" />, { theme, store: test.store });
  return { ...test, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}

describe.each(THEMES)("ComposerContainer (%s)", (theme) => {
  it("renders nothing for a session the store does not know", () => {
    resetTestViews();
    const { store } = createTestStore();
    const { container } = renderWithStore(<ComposerContainer sessionId="nope" />, {
      theme,
      store,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the draft in the store and submits it for the session", async () => {
    const { user, actions, store } = setup(theme);
    const textbox = screen.getByRole("textbox", { name: "Message to dawg" });
    await user.type(textbox, "Run the tests");
    expect(store.getState().ui.drafts.fix).toBe("Run the tests");
    expect(textbox).toHaveValue("Run the tests");
    await user.keyboard("{Enter}");
    expect(actions.submit).toHaveBeenCalledWith("fix", "Run the tests");
  });

  it("wires Stop, Shift+Tab and the pickers to the session", async () => {
    const { user, actions } = setup(theme, {
      view: {
        working: true,
        queue: [{ id: "q1", text: "next", state: "held" }],
      },
    });
    await user.click(screen.getByRole("button", { name: "Stop, or press Esc" }));
    expect(actions.interrupt).toHaveBeenCalledWith("fix");

    await user.click(screen.getByRole("textbox", { name: "Message to dawg" }));
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(actions.cycleMode).toHaveBeenCalledWith("fix");

    await user.click(screen.getByRole("button", { name: "Send now" }));
    expect(actions.sendQueuedNow).toHaveBeenCalledWith("fix", "q1");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(actions.removeQueued).toHaveBeenCalledWith("fix", "q1");

    await user.click(screen.getByRole("button", { name: /^Permission mode/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^Bypass/ }));
    expect(actions.setMode).toHaveBeenCalledWith("fix", "bypassPermissions");

    await user.click(screen.getByRole("button", { name: /^Model:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^Qwen3.8 27B \(6-bit\)/ }));
    expect(actions.setModel).toHaveBeenCalledWith("fix", "qwen3.8-27b-q6");

    await user.click(screen.getByRole("button", { name: /^Effort/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /^medium/ }));
    expect(actions.setEffort).toHaveBeenCalledWith("fix", "medium");

    await user.click(screen.getByRole("button", { name: /^Context used/ }));
    await user.click(screen.getByRole("button", { name: /Compact now/ }));
    expect(actions.compact).toHaveBeenCalledWith("fix");
  });

  it("opens Settings → Models from the model menu", async () => {
    const { user, actions, store } = setup(theme);
    await user.click(screen.getByRole("button", { name: /^Model:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Manage models…" }));
    expect(actions.setSettingsPage).toHaveBeenCalledWith("models");
    expect(store.getState().layout).toMatchObject({ view: "settings", settingsPage: "models" });
  });

  it("cannot send until the engine is ready", async () => {
    const { user, actions } = setup(theme, { connection: { phase: "connecting" } });
    await user.type(screen.getByRole("textbox", { name: "Message to dawg" }), "hi{Enter}");
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it("is disabled when the connection failed", () => {
    setup(theme, { connection: { phase: "failed", message: "Protocol mismatch" } });
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toBeDisabled();
  });
});
