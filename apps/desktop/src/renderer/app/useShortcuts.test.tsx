import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sessionsStore } from "./commands/testing.ts";
import { paletteFor } from "./palette/controller.ts";
import type { PlatformOs } from "./platform.tsx";
import { renderWithStore } from "./testing.tsx";
import { useGlobalShortcuts } from "./useShortcuts.ts";

function Harness() {
  useGlobalShortcuts();
  return (
    <>
      <textarea aria-label="Message to dawg" />
      <p>Some transcript text</p>
      <div className="xterm">
        <textarea aria-label="Terminal input" />
      </div>
      <div role="dialog" aria-label="Another dialog">
        <button type="button">Inside</button>
      </div>
    </>
  );
}

function setup(os: PlatformOs = "darwin", options: Parameters<typeof sessionsStore>[0] = {}) {
  const test = sessionsStore(options);
  renderWithStore(<Harness />, { theme: "dark", store: test.store, os });
  return { ...test, palette: paletteFor(test.store) };
}

describe("window shortcuts", () => {
  it("opens the command palette with ⌘K, also while typing", () => {
    const { palette } = setup();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to dawg" }), {
      key: "k",
      metaKey: true,
    });
    expect(palette.isOpen).toBe(true);
  });

  it("takes Ctrl for ⌘ off macOS, and only there", () => {
    const mac = setup("darwin");
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(mac.palette.isOpen).toBe(false);
  });

  it("uses Ctrl as the command key elsewhere", () => {
    const other = setup("linux");
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(other.palette.isOpen).toBe(false);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(other.palette.isOpen).toBe(true);
  });

  it("leaves keys an IME is composing with alone", () => {
    const { palette, actions } = setup();
    const field = screen.getByRole("textbox", { name: "Message to dawg" });
    fireEvent.keyDown(field, { key: "k", metaKey: true, isComposing: true });
    fireEvent.keyDown(field, { key: "n", metaKey: true, keyCode: 229 });
    expect(palette.isOpen).toBe(false);
    expect(actions.newSession).not.toHaveBeenCalled();
  });

  it("stays out of the way of a key something else handled", () => {
    const { palette } = setup();
    const field = screen.getByRole("textbox", { name: "Message to dawg" });
    field.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    fireEvent.keyDown(field, { key: "k", metaKey: true });
    expect(palette.isOpen).toBe(false);
  });

  it("leaves a dialog's keys to the dialog", () => {
    const { actions } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "n", metaKey: true });
    expect(actions.newSession).not.toHaveBeenCalled();
  });

  it("gives the terminal its Ctrl-keys, but ⌘-keys still work there on macOS", () => {
    const other = setup("linux");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), {
      key: "b",
      ctrlKey: true,
    });
    expect(other.actions.setSidebarOpen).not.toHaveBeenCalled();
  });

  it("runs ⌘ shortcuts from the terminal on macOS", () => {
    const mac = setup("darwin");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), {
      key: "b",
      metaKey: true,
    });
    expect(mac.actions.setSidebarOpen).toHaveBeenCalledWith(false);
  });

  it("stops a working session with Esc, from the message field too", () => {
    const { actions } = setup("darwin", { open: { fix: { activeTurnId: "t1" } } });
    const event = fireEvent.keyDown(screen.getByRole("textbox", { name: "Message to dawg" }), {
      key: "Escape",
    });
    expect(actions.interrupt).toHaveBeenCalledWith("fix");
    // Handled: the press does not go on to do anything else.
    expect(event).toBe(false);
  });

  it("leaves Esc to the page when nothing is running", () => {
    const { actions } = setup();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
    expect(actions.interrupt).not.toHaveBeenCalled();
  });

  it("clears a text selection with Esc before stopping anything", () => {
    const { actions } = setup("darwin", { open: { fix: { activeTurnId: "t1" } } });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Some transcript text"));
    act(() => window.getSelection()?.addRange(range));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
    expect(actions.interrupt).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(actions.interrupt).toHaveBeenCalledWith("fix");
  });

  it("finds keys that ⇧ and ⌥ change, and the panes by number", () => {
    const { actions } = setup();
    fireEvent.keyDown(document.body, {
      key: "}",
      code: "BracketRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(actions.selectSession).toHaveBeenLastCalledWith("csv");
    fireEvent.keyDown(document.body, { key: "¡", code: "Digit1", metaKey: true, altKey: true });
    expect(actions.openPane).toHaveBeenLastCalledWith("changes");
  });

  it("does not run what does not apply, and lets the key through", () => {
    const { actions } = setup("darwin", {
      patch: (state) => ({ layout: { ...state.layout, view: "settings" } }),
    });
    expect(fireEvent.keyDown(document.body, { key: "b", metaKey: true })).toBe(true);
    expect(actions.setSidebarOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    expect(actions.setView).toHaveBeenLastCalledWith("settings");
  });
});
