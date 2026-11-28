/**
 * A subagent's transcript in place of its session's: the same transcript component, read-only
 * (no composer), titled with the agent, and Esc or "Back to the session" returning to the
 * session with focus on the card that opened it.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  applyReplay,
  createStream,
  makeSubagent,
  makeSummary,
  openSession,
  type Stream,
} from "../state/__fixtures__/streams.ts";
import { emptyEngineSlice, reduceAll } from "../state/reducer.ts";
import type { AppState } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { SessionArea } from "./SessionArea.tsx";
import { SubagentPanel } from "./SubagentPanel.tsx";
import { createTestStore, renderWithStore } from "./testing.tsx";

const ID = "s1";
const CHILD = "s1-agent-1";

function turn(s: Stream, turnId: string, text: string): void {
  s.emit("session.status", { status: "working", waitingOn: null, message: null });
  s.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text }], mentions: [] },
    command: null,
  });
}

function setup(theme: "dark" | "light") {
  const parent = createStream(ID);
  turn(parent, "t1", "Where is the config loaded?");
  parent.emit("message.started", { turnId: "t1", messageId: "m1" });
  parent.emit("message.finished", {
    turnId: "t1",
    messageId: "m1",
    text: "",
    reasoning: null,
    toolCalls: [{ toolCallId: "c1", toolName: "Agent" }],
  });
  parent.emit("tool.started", {
    turnId: "t1",
    messageId: "m1",
    toolCallId: "c1",
    toolName: "Agent",
    input: { description: "Find the config loader", prompt: "Find it", subagent_type: "Explore" },
  });
  parent.emit("subagent.updated", { agent: makeSubagent("agent-1", { sessionId: CHILD }) });

  const child = createStream(CHILD);
  turn(child, "ct1", "Find where the config is loaded");
  child.emit("message.started", { turnId: "ct1", messageId: "cm1" });
  child.emit("message.finished", {
    turnId: "ct1",
    messageId: "cm1",
    text: "It is `loadConfig` in src/config.ts.",
    reasoning: null,
    toolCalls: [],
  });
  const childSlice = applyReplay(
    reduceAll(emptyEngineSlice(), [
      { type: "summaries", sessions: [makeSummary(CHILD, { title: "Find the config loader" })] },
    ]),
    CHILD,
    child.events,
  );

  const slice = applyReplay(openSession(makeSummary(ID)), ID, parent.events);
  const test = createTestStore(
    (state): Partial<AppState> => ({
      ...slice,
      layout: { ...state.layout, selectedSessionId: ID },
      ui: { ...state.ui, openSubagent: { sessionId: ID, agentId: "agent-1" } },
      subagentTranscripts: {
        [CHILD]: { parentSessionId: ID, agentId: "agent-1", slice: childSlice, error: null },
      },
    }),
  );
  renderWithStore(
    <main>
      <SessionArea sessionId={ID} />
    </main>,
    { theme, store: test.store },
  );
  return test;
}

describe.each(THEMES)("a subagent's transcript (%s)", (theme) => {
  it("shows the agent's transcript read-only, titled with the agent", async () => {
    setup(theme);
    expect(
      screen.getByRole("heading", { level: 2, name: "Explore agent: Find the config loader" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^Running · Read src\/config\.ts · 2 tool uses · read-only/),
    ).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Transcript" });
    expect(log.closest("[data-session]")).toHaveAttribute("data-session", CHILD);
    expect(within(log).getByText("Find where the config is loaded")).toBeInTheDocument();
    expect(within(log).getByText("loadConfig")).toBeInTheDocument();
    // No composer: nothing can be sent to an agent from here.
    expect(screen.queryByRole("textbox", { name: "Message to dawg" })).toBeNull();
    // The way back has focus.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Back to the session/ })).toHaveFocus(),
    );
  });

  it("goes back with Esc, to the card that opened it", async () => {
    const { actions } = setup(theme);
    act(() => {
      fireEvent.keyDown(screen.getByRole("button", { name: /^Back to the session/ }), {
        key: "Escape",
      });
    });
    expect(actions.closeSubagent).toHaveBeenCalledTimes(1);
    const log = await screen.findByRole("log", { name: "Transcript" });
    expect(log.closest("[data-session]")).toHaveAttribute("data-session", ID);
    const open = within(log).getByRole("button", {
      name: "Open the transcript of Explore agent: Find the config loader",
    });
    await waitFor(() => expect(open).toHaveFocus());

    // And opens it again from there.
    fireEvent.click(open);
    expect(actions.openSubagent).toHaveBeenCalledWith(ID, "agent-1");
  });

  it("goes back with the button", () => {
    const { actions } = setup(theme);
    fireEvent.click(screen.getByRole("button", { name: /^Back to the session/ }));
    expect(actions.closeSubagent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Message to dawg" })).toBeInTheDocument();
  });
});

describe.each(THEMES)("SubagentPanel (%s)", (theme) => {
  it("says why the agent's transcript could not be read, and tries again", () => {
    const onRetry = vi.fn();
    renderInTheme(
      <SubagentPanel
        view={{
          sessionId: ID,
          agent: makeSubagent("agent-1"),
          title: "Explore agent: Find the config loader",
          transcript: null,
          error: "Could not read the agent's transcript: the engine restarted.",
        }}
        homeDir="/Users/you"
        onClose={vi.fn()}
        onRetry={onRetry}
        onSetItemOpen={vi.fn()}
        onOpenLink={vi.fn()}
      />,
      theme,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not read the agent's transcript: the engine restarted.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
