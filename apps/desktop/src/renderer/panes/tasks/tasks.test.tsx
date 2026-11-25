import type { BackgroundTask, TaskItem } from "@dawg/protocol";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestStore, renderWithStore } from "../../app/testing.tsx";
import {
  makeBackgroundTask,
  makeSummary,
  openSession,
  T0,
} from "../../state/__fixtures__/streams.ts";
import { THEMES } from "../../test/render.tsx";
import { TasksPane } from "./index.tsx";
import { TAIL_BYTES } from "./useBackgroundOutput.ts";

afterEach(() => {
  vi.useRealTimers();
});

function setup(
  theme: "dark" | "light",
  options: { tasks?: TaskItem[]; background?: BackgroundTask[] },
) {
  const slice = openSession(makeSummary("s1"), {
    tasks: options.tasks ?? [],
    background: options.background ?? [],
  });
  const test = createTestStore(() => slice);
  renderWithStore(<TasksPane sessionId="s1" />, { theme, store: test.store });
  return test;
}

const SERVER = makeBackgroundTask("bg1", { startedAt: T0 });
const SYNC = makeBackgroundTask("bg2", {
  command: "uv sync",
  description: null,
  status: "completed",
  exitCode: 0,
  startedAt: T0,
  endedAt: T0 + 3_200,
});
const TESTS = makeBackgroundTask("bg3", {
  command: "pytest -q",
  description: "Run the tests",
  status: "failed",
  exitCode: 1,
  endedAt: T0 + 48_000,
});
const STOPPED = makeBackgroundTask("bg4", {
  command: "tail -f log.txt",
  description: null,
  status: "stopped",
  signal: "SIGTERM",
  stopReason: "time_limit",
  endedAt: T0 + 600_000,
});

describe.each(THEMES)("TasksPane (%s)", (theme) => {
  it("says what shows here when there is nothing yet", () => {
    setup(theme, {});
    expect(screen.getByRole("heading", { name: "No tasks yet" })).toBeInTheDocument();
  });

  it("lists the tasks and every background command with how it went", () => {
    vi.useFakeTimers({ now: T0 + 12_000, toFake: ["Date", "setInterval", "clearInterval"] });
    setup(theme, {
      tasks: [
        { content: "Add tests", status: "completed" },
        { content: "Fix the split", status: "in_progress", activeForm: "Fixing the split" },
        { content: "Run the suite", status: "pending" },
      ],
      background: [SERVER, SYNC, TESTS, STOPPED],
    });
    expect(screen.getByRole("heading", { name: "Task list · 1 of 3 done" })).toBeInTheDocument();
    expect(screen.getByText("Fixing the split")).toBeInTheDocument();

    const list = screen.getByRole("list", { name: "Background commands" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "npm run dev",
      "uv sync",
      "pytest -q",
      "tail -f log.txt",
    ]);
    expect(rows[0]).toHaveTextContent("Start the dev server · Running for 12 s");
    expect(rows[1]).toHaveTextContent("Done · exit code 0 · ran 3.2 s");
    expect(rows[2]).toHaveTextContent("Run the tests · Failed · exit code 1 · ran 48 s");
    expect(rows[3]).toHaveTextContent("Stopped: it ran past its time limit · ran 10 min");
    // Only the running command can be stopped.
    expect(screen.getAllByRole("button", { name: /^Stop / })).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(rows[0]).toHaveTextContent("Running for 14 s");
  });

  it("shows a command's output and follows it while it runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const test = setup(theme, { background: [SERVER] });
    test.actions.readBackgroundOutput
      .mockResolvedValueOnce({ text: "listening\n", nextOffset: 10, totalBytes: 10, done: false })
      .mockResolvedValueOnce({ text: "GET /\n", nextOffset: 16, totalBytes: 16, done: false })
      .mockResolvedValue({ text: "", nextOffset: 16, totalBytes: 16, done: true });

    const show = screen.getByRole("button", { name: "Show the output of npm run dev" });
    fireEvent.click(show);
    expect(show).toHaveAttribute("aria-expanded", "true");
    const log = screen.getByRole("log", { name: "Output of npm run dev" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(log.textContent).toBe("listening\n");
    expect(test.actions.readBackgroundOutput).toHaveBeenLastCalledWith("s1", "bg1", 0);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(log.textContent).toBe("listening\nGET /\n");
    expect(test.actions.readBackgroundOutput).toHaveBeenLastCalledWith("s1", "bg1", 10);

    // Everything read and the command ended: no more reads.
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const calls = test.actions.readBackgroundOutput.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(test.actions.readBackgroundOutput.mock.calls.length).toBe(calls);

    fireEvent.click(screen.getByRole("button", { name: "Hide the output of npm run dev" }));
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });

  it("starts long output at its end", async () => {
    const test = setup(theme, { background: [SYNC] });
    const total = TAIL_BYTES * 3;
    test.actions.readBackgroundOutput
      .mockResolvedValueOnce({ text: "start", nextOffset: 5, totalBytes: total, done: false })
      .mockResolvedValueOnce({
        text: "the end\n",
        nextOffset: total,
        totalBytes: total,
        done: true,
      });
    fireEvent.click(screen.getByRole("button", { name: "Show the output of uv sync" }));
    const log = await screen.findByRole("log");
    await vi.waitFor(() => expect(log).toHaveTextContent("the end"));
    expect(log).not.toHaveTextContent("start");
    expect(screen.getByText("Showing the end of the output.")).toBeInTheDocument();
    expect(test.actions.readBackgroundOutput).toHaveBeenLastCalledWith(
      "s1",
      "bg2",
      total - TAIL_BYTES,
    );
  });

  it("says when the output cannot be read", async () => {
    const test = setup(theme, { background: [SYNC] });
    test.actions.readBackgroundOutput.mockResolvedValue({ error: "The engine restarted." });
    fireEvent.click(screen.getByRole("button", { name: "Show the output of uv sync" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read the output. The engine restarted.",
    );
  });

  it("stops a running command once confirmed", async () => {
    const test = setup(theme, { background: [SERVER] });
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Stop “npm run dev”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(test.actions.stopBackground).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    const again = await screen.findByRole("alertdialog");
    fireEvent.click(within(again).getByRole("button", { name: "Stop the command" }));
    expect(test.actions.stopBackground).toHaveBeenCalledWith("s1", "bg1");
  });
});
