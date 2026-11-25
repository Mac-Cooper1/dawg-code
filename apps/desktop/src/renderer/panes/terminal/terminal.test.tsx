import { act, fireEvent, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../../shared/bridge.ts";
import { createTestStore, renderWithStore } from "../../app/testing.tsx";
import { setBridgeForTests } from "../../bridge/index.ts";
import { createFakeBridge, type FakeBridge } from "../../state/__fixtures__/fake-bridge.ts";
import { makeSummary, openSession, PROJECT } from "../../state/__fixtures__/streams.ts";
import { THEMES } from "../../test/render.tsx";
import { fenceForComposer, TerminalPane } from "./index.tsx";
import { terminalTheme } from "./theme.ts";
import {
  type TerminalSize,
  type TerminalTheme,
  type TerminalView,
  TerminalViewContext,
} from "./view.ts";

/** A screen that records what the pane and the manager do with it. */
class FakeView implements TerminalView {
  written = "";
  container: HTMLElement | null = null;
  selection = "";
  theme: TerminalTheme;
  focused = false;
  disposed = false;
  attachCount = 0;
  current: TerminalSize = { cols: 80, rows: 24 };
  /** What the next `fit` finds. */
  fits: TerminalSize | null = { cols: 100, rows: 30 };
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly selectionListeners = new Set<() => void>();
  private readonly element = document.createElement("div");

  constructor(theme: TerminalTheme) {
    this.theme = theme;
    this.element.dataset.testid = "screen";
  }
  attach(container: HTMLElement) {
    this.container = container;
    this.attachCount += 1;
    container.appendChild(this.element);
  }
  detach() {
    this.element.remove();
    this.container = null;
  }
  write(data: string) {
    this.written += data;
    this.element.textContent = this.written;
  }
  fit() {
    const next = this.fits;
    if (!next || (next.cols === this.current.cols && next.rows === this.current.rows)) return null;
    this.current = next;
    return next;
  }
  size() {
    return this.current;
  }
  setTheme(theme: TerminalTheme) {
    this.theme = theme;
  }
  getSelection() {
    return this.selection;
  }
  async copySelection() {
    return this.selection !== "";
  }
  focus() {
    this.focused = true;
  }
  onInput(listener: (data: string) => void) {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }
  onSelectionChange(listener: () => void) {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }
  dispose() {
    this.disposed = true;
    this.element.remove();
  }
  /** The person types. */
  type(data: string) {
    for (const listener of this.inputListeners) listener(data);
  }
  /** The person selects text. */
  select(text: string) {
    this.selection = text;
    for (const listener of this.selectionListeners) listener();
  }
}

let bridge: FakeBridge | null = null;

afterEach(() => {
  setBridgeForTests(null);
  bridge?.close();
  bridge = null;
});

async function setup(theme: ResolvedTheme, prepare?: (bridge: FakeBridge) => Promise<void> | void) {
  bridge = createFakeBridge({ engine: { serve() {} } });
  await prepare?.(bridge);
  setBridgeForTests(bridge);
  const views: FakeView[] = [];
  const createView = async (options: { theme: TerminalTheme }) => {
    const view = new FakeView(options.theme);
    views.push(view);
    return view;
  };
  const test = createTestStore(() => openSession(makeSummary("s1")));
  test.store.setState({ resolvedTheme: theme });
  const ui = (): ReactElement => (
    <TerminalViewContext.Provider value={createView}>
      <TerminalPane sessionId="s1" />
    </TerminalViewContext.Provider>
  );
  const rendered = renderWithStore(ui(), { theme, store: test.store });
  return { ...test, bridge, views, ui, rendered };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openOne(harness: Awaited<ReturnType<typeof setup>>) {
  fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
  await settle();
  const terminal = [...harness.bridge.terminals.values()].at(-1);
  if (!terminal) throw new Error("No terminal opened");
  return terminal;
}

describe.each(THEMES)("TerminalPane (%s)", (theme) => {
  it("starts no shell until asked", async () => {
    const harness = await setup(theme);
    await settle();
    expect(screen.getByRole("heading", { name: "No terminal open" })).toBeInTheDocument();
    expect(harness.bridge.terminalsOpened).toEqual([]);
    expect(harness.views).toEqual([]);
  });

  it("opens a shell in the session's folder after tracking the session", async () => {
    const harness = await setup(theme);
    const terminal = await openOne(harness);
    expect(harness.actions.trackSession).toHaveBeenCalledWith("s1");
    expect(harness.bridge.terminalsOpened).toEqual([
      { sessionId: "s1", cwd: PROJECT, cols: 80, rows: 24 },
    ]);
    const tab = screen.getByRole("button", { name: "zsh" });
    expect(tab).toHaveAttribute("aria-pressed", "true");
    const view = harness.views[0];
    expect(view?.container).toBe(screen.getByRole("region", { name: "Terminal zsh" }));
    expect(view?.focused).toBe(true);
    // Fitted to the pane: the shell hears the new size.
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(30);
    expect(view?.theme).toEqual(terminalTheme(theme));

    act(() => harness.bridge.terminalOutput(terminal.terminalId, "~/code/tally $ "));
    expect(view?.written).toBe("~/code/tally $ ");
    view?.type("ls\r");
    expect(terminal.input).toEqual(["ls\r"]);
  });

  it("redraws the session's open terminals from their backlog", async () => {
    const harness = await setup(theme, async (fake) => {
      const open = await fake.terminal.open({ sessionId: "s1", cwd: PROJECT, cols: 80, rows: 24 });
      fake.terminalOutput(open.terminalId, "$ npm test\r\n12 passed\r\n");
    });
    await settle();
    expect(screen.getByRole("button", { name: "zsh" })).toBeInTheDocument();
    expect(harness.views[0]?.written).toBe("$ npm test\r\n12 passed\r\n");
    // Showing a terminal again does not take focus from where the person was.
    expect(harness.views[0]?.focused).toBe(false);
  });

  it("keeps a terminal while the pane is closed, and shows it again", async () => {
    const harness = await setup(theme);
    const terminal = await openOne(harness);
    harness.rendered.unmount();
    act(() => harness.bridge.terminalOutput(terminal.terminalId, "done\r\n"));
    renderWithStore(harness.ui(), { theme, store: harness.store });
    await settle();
    expect(harness.views).toHaveLength(1);
    expect(harness.views[0]?.written).toBe("done\r\n");
    expect(harness.views[0]?.attachCount).toBe(2);
    expect(harness.bridge.terminalsClosed).toEqual([]);
  });

  it("says when a shell ended, and closes its tab", async () => {
    const harness = await setup(theme);
    const terminal = await openOne(harness);
    act(() => harness.bridge.endTerminal(terminal.terminalId, 1));
    expect(screen.getByRole("button", { name: "zsh, ended" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("This shell ended with exit code 1.");
    // Typing into an ended shell sends nothing.
    harness.views[0]?.type("x");
    expect(terminal.input).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Close the tab" }));
    await settle();
    expect(harness.bridge.terminalsClosed).toEqual([terminal.terminalId]);
    expect(harness.views[0]?.disposed).toBe(true);
    expect(screen.getByRole("heading", { name: "No terminal open" })).toBeInTheDocument();
  });

  it("keeps a tab per terminal", async () => {
    const harness = await setup(theme);
    const first = await openOne(harness);
    const second = await openOne(harness);
    expect(screen.getByRole("button", { name: "zsh 2" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "zsh" }));
    expect(screen.getByRole("button", { name: "zsh" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close zsh" }));
    await settle();
    expect(harness.bridge.terminalsClosed).toEqual([first.terminalId]);
    expect(screen.getByRole("button", { name: "zsh" })).toHaveAttribute("aria-pressed", "true");
    expect(harness.bridge.terminals.has(second.terminalId)).toBe(true);
  });

  it("sends the selection to the composer", async () => {
    const harness = await setup(theme);
    await openOne(harness);
    const send = screen.getByRole("button", { name: "Send selection to the composer" });
    expect(send).toBeDisabled();
    act(() => harness.views[0]?.select("FAILED test_split.py::test_refund\n"));
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(harness.actions.setDraft).toHaveBeenCalledWith(
      "s1",
      "```\nFAILED test_split.py::test_refund\n```\n",
    );
  });

  it("keeps Esc for the shell", async () => {
    const harness = await setup(theme);
    await openOne(harness);
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    const screenElement = screen.getByTestId("screen");
    fireEvent.keyDown(screenElement, { key: "Escape" });
    fireEvent.keyDown(screenElement, { key: "k", metaKey: true });
    window.removeEventListener("keydown", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(harness.views).toHaveLength(1);
  });

  it("follows the app's theme", async () => {
    const harness = await setup(theme);
    await openOne(harness);
    const other: ResolvedTheme = theme === "dark" ? "light" : "dark";
    act(() => harness.store.setState({ resolvedTheme: other }));
    expect(harness.views[0]?.theme).toEqual(terminalTheme(other));
  });

  it("says why a terminal could not open", async () => {
    const harness = await setup(theme, (fake) => {
      fake.terminal.open = async () => {
        throw new Error("The folder is not one of the session's directories");
      };
    });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not open a terminal: The folder is not one of the session's directories.",
    );
    expect(harness.views).toEqual([]);
  });
});

describe("fenceForComposer", () => {
  it("fences terminal text with a fence longer than any it holds", () => {
    expect(fenceForComposer("ls\n\n")).toBe("```\nls\n```\n");
    expect(fenceForComposer("a ``` b")).toBe("````\na ``` b\n````\n");
  });
});

describe("terminalTheme", () => {
  it("maps the tokens to terminal colours in both themes", () => {
    const dark = terminalTheme("dark");
    expect(dark).toMatchObject({ background: "#0e0f11", foreground: "#d9dbdf", red: "#ff7b72" });
    const light = terminalTheme("light");
    expect(light).toMatchObject({ background: "#fbfbf9", foreground: "#25272b", red: "#c2261e" });
    expect(light.black).toBe("#17181a");
    expect(dark.magenta).toMatch(/^#[0-9a-f]{6}$/);
  });
});
