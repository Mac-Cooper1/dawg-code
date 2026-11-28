/** Background agents in the Tasks pane: listed with their state, opened, and stopped. */
import type { SubagentInfo } from "@dawg/protocol";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createTestStore, renderWithStore } from "../../app/testing.tsx";
import {
  applyLive,
  createStream,
  makeBackgroundTask,
  makeSubagent,
  makeSummary,
  openSession,
  T0,
} from "../../state/__fixtures__/streams.ts";
import { THEMES } from "../../test/render.tsx";
import { TasksPane } from "./index.tsx";

function setup(theme: "dark" | "light", agents: SubagentInfo[], background = false) {
  const stream = createStream("s1");
  for (const agent of agents) stream.emit("subagent.updated", { agent });
  const slice = applyLive(
    openSession(makeSummary("s1"), {
      background: background ? [makeBackgroundTask("bg1", { startedAt: T0 })] : [],
    }),
    stream.events,
  );
  const test = createTestStore(() => slice);
  renderWithStore(<TasksPane sessionId="s1" />, { theme, store: test.store });
  return test;
}

const QUEUED = makeSubagent("agent-1", {
  background: true,
  status: "queued",
  queuePosition: 1,
  toolUses: 0,
  activity: null,
});
const RUNNING = makeSubagent("agent-2", {
  background: true,
  agentType: "general-purpose",
  description: "Update the changelog",
});
const DONE = makeSubagent("agent-3", {
  background: true,
  agentType: "Plan",
  description: "Plan the migration",
  status: "completed",
  endedAt: T0 + 30_000,
  toolUses: 4,
  result: "The plan.",
});
const FOREGROUND = makeSubagent("agent-4", { description: "Look at the tests" });

describe.each(THEMES)("TasksPane, background agents (%s)", (theme) => {
  it("lists background agents next to the commands, with their state", () => {
    setup(theme, [QUEUED, RUNNING, DONE, FOREGROUND], true);
    expect(screen.getByRole("list", { name: "Background commands" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Background agents" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Explore agent: Find the config loader",
      "General-purpose agent: Update the changelog",
      "Plan agent: Plan the migration",
    ]);
    expect(
      within(rows[0] as HTMLElement).getByText("Queued · next in line for the model"),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).getByText("Running · Read src/config.ts · 2 tool uses"),
    ).toBeInTheDocument();
    expect(
      within(rows[2] as HTMLElement).getByText(/^Done · 4 tool uses · 30/),
    ).toBeInTheDocument();
    // Stop only for what still works: the queued and the running one.
    expect(within(list).getAllByRole("button", { name: /^Stop / })).toHaveLength(2);
    expect(
      within(list).queryByRole("button", { name: "Stop Plan agent: Plan the migration" }),
    ).toBeNull();
  });

  it("shows an agent alone, without an empty commands list hiding it", () => {
    setup(theme, [RUNNING]);
    expect(screen.queryByRole("heading", { name: "No tasks yet" })).toBeNull();
    expect(screen.getByRole("list", { name: "Background agents" })).toBeInTheDocument();
  });

  it("opens an agent's transcript", () => {
    const test = setup(theme, [DONE]);
    fireEvent.click(
      screen.getByRole("button", { name: "Open the transcript of Plan agent: Plan the migration" }),
    );
    expect(test.actions.openSubagent).toHaveBeenCalledWith("s1", "agent-3");
  });

  it("stops a queued agent once confirmed", async () => {
    const test = setup(theme, [QUEUED]);
    const stop = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Stop Explore agent: Find the config loader" }),
      );
    stop();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Stop “Explore agent: Find the config loader”?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(test.actions.stopSubagent).not.toHaveBeenCalled();

    stop();
    const again = await screen.findByRole("alertdialog");
    fireEvent.click(within(again).getByRole("button", { name: "Stop the agent" }));
    expect(test.actions.stopSubagent).toHaveBeenCalledWith("s1", "agent-1");
  });
});
