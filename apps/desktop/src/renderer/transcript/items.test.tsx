import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { AssistantText } from "./AssistantText.tsx";
import { CommandOutput } from "./CommandOutput.tsx";
import { CompactionView } from "./CompactionView.tsx";
import { ErrorCard } from "./ErrorCard.tsx";
import { NoteView } from "./NoteView.tsx";
import { PromptProgress } from "./PromptProgress.tsx";
import { Reasoning } from "./Reasoning.tsx";
import { TasksCard } from "./TasksCard.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { TurnSummaryView } from "./TurnSummaryView.tsx";
import {
  assistantItem,
  bashFailure,
  CWD,
  commandOutputItem,
  compactionItem,
  editItem,
  errorItem,
  grepItem,
  makeEnv,
  noteItem,
  readItem,
  reasoningItem,
  summaryItem,
  tasksItem,
  toolItem,
  userItem,
} from "./testing.ts";
import { UserMessage } from "./UserMessage.tsx";

afterEach(() => {
  vi.useRealTimers();
});

describe.each(THEMES)("UserMessage (%s)", (theme) => {
  it("shows the text with line breaks and `code` spans", () => {
    const { container } = renderInTheme(
      <UserMessage
        item={userItem({ text: "Fix `split_evenly`\nwithout changing the test." })}
        env={makeEnv()}
      />,
      theme,
    );
    const message = screen.getByRole("article", { name: "Your message" });
    expect(message).toHaveTextContent("Fix split_evenly without changing the test.");
    expect(container.querySelector("code")).toHaveTextContent("split_evenly");
    expect(container.querySelector("p")?.textContent).toContain("\nwithout");
  });

  it("shows images, mentioned files and slash commands", () => {
    renderInTheme(
      <UserMessage
        item={userItem({
          text: "expanded command prompt",
          command: { name: "review", args: "src/money.py" },
          images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
          mentions: [{ path: `${CWD}/src/tally/money.py`, startLine: 10, endLine: 19 }],
        })}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText("/review src/money.py")).toBeInTheDocument();
    expect(screen.queryByText("expanded command prompt")).toBeNull();
    expect(screen.getByRole("img", { name: "Attachment 1" })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    );
    const mentions = screen.getByRole("list", { name: "Mentioned files" });
    expect(within(mentions).getByText("src/tally/money.py:10–19")).toBeInTheDocument();
  });
});

describe.each(THEMES)("AssistantText (%s)", (theme) => {
  it("renders Markdown, with a caret only while streaming", () => {
    const env = makeEnv();
    const { container, rerender } = renderInTheme(
      <AssistantText
        item={assistantItem({ text: "Working in **cents", streaming: true })}
        env={env}
      />,
      theme,
    );
    expect(container.querySelector("strong")).toHaveTextContent("cents");
    expect(container.querySelector("[data-caret]")).not.toBeNull();
    rerender(<AssistantText item={assistantItem({ text: "Working in **cents**." })} env={env} />);
    expect(container.querySelector("[data-caret]")).toBeNull();
  });

  it("renders nothing for an empty finished reply", () => {
    const { container } = renderInTheme(
      <AssistantText item={assistantItem({ text: "" })} env={makeEnv()} />,
      theme,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe.each(THEMES)("Reasoning (%s)", (theme) => {
  it("is folded to its duration and opens on request", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = reasoningItem();
    const { rerender } = renderInTheme(<Reasoning item={item} open={false} env={env} />, theme);
    const toggle = screen.getByRole("button", { name: "Thought for 5 s" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(item.text)).toBeNull();
    await user.click(toggle);
    expect(env.setItemOpen).toHaveBeenCalledWith(item.id, true);
    rerender(<Reasoning item={item} open env={env} />);
    expect(screen.getByText(item.text)).toBeInTheDocument();
  });

  it("says Thinking… with a spinner while streaming", () => {
    renderInTheme(
      <Reasoning
        item={reasoningItem({ streaming: true, durationMs: null })}
        open={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByRole("button", { name: "Thinking…" })).toBeInTheDocument();
  });
});

describe.each(THEMES)("ToolCard (%s)", (theme) => {
  it("shows a passing command on one line with its exit code and duration", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = toolItem();
    renderInTheme(<ToolCard item={item} open={false} env={env} />, theme);
    const header = screen.getByRole("button", { name: "Ran uv run pytest -q, exit 0, 0.8 s" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(within(header).getByText("exit 0").className).toMatch(/ok/);
    await user.click(header);
    expect(env.setItemOpen).toHaveBeenCalledWith(item.id, true);
  });

  it("shows a failed command's output with colours as styled spans", () => {
    const { container } = renderInTheme(
      <ToolCard item={bashFailure()} open env={makeEnv()} />,
      theme,
    );
    expect(screen.getByText("exit 1").className).toMatch(/bad/);
    const output = container.querySelector("pre");
    expect(output?.textContent).not.toContain("\u001b");
    expect(output?.textContent).toContain("E       AssertionError");
    // What the model was told is not shown as output: no "Error: " prefix, no "Exit code" footer.
    expect(output?.textContent?.startsWith("===== FAILURES")).toBe(true);
    expect(output?.textContent).not.toContain("Exit code");
    const red = Array.from(output?.querySelectorAll("span") ?? []).find((span) =>
      span.textContent?.includes("AssertionError"),
    );
    expect(red?.className).toMatch(/fgRed/);
    const bold = Array.from(output?.querySelectorAll("span") ?? []).find((span) =>
      span.textContent?.includes("FAILURES"),
    );
    expect(bold?.className).toMatch(/bold/);
  });

  it("prefers the live output of a finished command", () => {
    const item = bashFailure({
      output: [
        { stream: "stdout", text: "F" },
        { stream: "stderr", text: "\nError: exactly what the command printed\n" },
      ],
    });
    const { container } = renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    const output = container.querySelector("pre");
    expect(output?.textContent).toBe("F\nError: exactly what the command printed\n");
  });

  it("shows the engine's notes muted under the output", () => {
    const item = toolItem({
      state: "error",
      input: { command: "uv run pytest" },
      content: [
        {
          type: "text",
          text: "Error: collected 50 items\n\nThe command did not finish within 2 min and was stopped.\nThe output was 41,200 characters, so only its beginning and end are shown. The full output is saved in /tmp/out.txt.",
        },
      ],
      display: {
        kind: "command",
        command: "uv run pytest",
        cwd: CWD,
        exitCode: null,
        durationMs: 120_000,
        timedOut: true,
        interrupted: false,
        backgroundTaskId: null,
        outputPath: "/tmp/out.txt",
      },
    });
    const { container } = renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByText("timed out").className).toMatch(/bad/);
    expect(container.querySelector("pre")?.textContent).toBe("collected 50 items");
    const note = screen.getByText("The command did not finish within 2 min and was stopped.");
    expect(note.parentElement?.className).toMatch(/notes/);
    expect(screen.getByText(/^The output was 41,200 characters/)).toBeInTheDocument();
  });

  it("streams live output, a status line and the elapsed time while running", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(10_000);
    const item = toolItem({
      state: "running",
      input: { command: "uv run pytest --count 50 -q" },
      output: [
        { stream: "stdout", text: "....." },
        { stream: "stdout", text: "\u001b[31mF\u001b[0m..." },
      ],
      statusLine: "34 of 50 runs · 1 failure so far",
      content: null,
      display: null,
      startedAt: 4_000,
      durationMs: null,
    });
    const { container } = renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(
      screen.getByRole("button", { name: "Running uv run pytest --count 50 -q, 6 s" }),
    ).toBeInTheDocument();
    expect(container.querySelector("pre")).toHaveTextContent(".....F...");
    expect(screen.getByText("34 of 50 runs · 1 failure so far")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole("button", { name: /^Running .*, 9 s$/ })).toBeInTheDocument();
  });

  it("says where a command ran when it was outside the session's folder", () => {
    const item = toolItem({
      display: {
        kind: "command",
        command: "ls",
        cwd: "/Users/me/code/other",
        exitCode: 0,
        durationMs: 10,
        timedOut: false,
        interrupted: false,
        backgroundTaskId: null,
        outputPath: null,
      },
    });
    renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByText("~/code/other")).toBeInTheDocument();
  });

  it("shows a read file's numbered lines without the tool's prefixes", async () => {
    const user = userEvent.setup();
    const { container } = renderInTheme(<ToolCard item={readItem()} open env={makeEnv()} />, theme);
    expect(
      screen.getByRole("button", { name: "Read src/tally/money.py, 42 lines" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Showing lines 1–15 of 42")).toBeInTheDocument();
    expect(screen.getByText("line 15 of money.py")).toBeInTheDocument();
    expect(screen.queryByText("line 16 of money.py")).toBeNull();
    expect(container.textContent).not.toContain("→");
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("line 42 of money.py")).toBeInTheDocument();
    expect(screen.getByText("Showing lines 1–42 of 42")).toBeInTheDocument();
  });

  it("shows an edit's diff with line numbers and +/− counts", () => {
    const { container } = renderInTheme(<ToolCard item={editItem()} open env={makeEnv()} />, theme);
    const header = screen.getByRole("button", { name: "Edited src/tally/money.py, +3 −2" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    const rows = Array.from(container.querySelectorAll("[data-kind]"));
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
      "hunk",
      "context",
      "del",
      "del",
      "add",
      "add",
      "add",
    ]);
    expect(rows[0]).toHaveTextContent("@@ -10,6 +10,10 @@");
    expect(rows[2]?.textContent).toMatch(/^11-/);
    expect(rows[4]?.textContent).toMatch(/^11\+/);
    expect(rows[6]?.textContent).toMatch(/^13\+/);
    expect(screen.queryByRole("button", { name: "Open in Changes" })).toBeNull();
  });

  it("links an edit to the Changes pane when it exists", async () => {
    const user = userEvent.setup();
    const openInChanges = vi.fn();
    renderInTheme(<ToolCard item={editItem()} open env={makeEnv({ openInChanges })} />, theme);
    await user.click(screen.getByRole("button", { name: "Open in Changes" }));
    expect(openInChanges).toHaveBeenCalledWith(`${CWD}/src/tally/money.py`);
  });

  it("summarises a search and shows its results", () => {
    renderInTheme(<ToolCard item={grepItem()} open env={makeEnv()} />, theme);
    expect(
      screen.getByRole("button", { name: "Searched currency, 14 matches in 6 files" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/src\/f\.py:9:currency/)).toBeInTheDocument();
  });

  it("shows other tools' input as JSON and their result", () => {
    const item = toolItem({
      toolName: "WebFetch",
      input: { url: "https://example.com/docs", prompt: "Summarise" },
      content: [{ type: "text", text: "The page explains rates." }],
      display: null,
    });
    const { container } = renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByRole("button", { name: "Fetched example.com/docs" })).toBeInTheDocument();
    expect(container).toHaveTextContent('"url": "https://example.com/docs"');
    expect(screen.getByText("The page explains rates.")).toBeInTheDocument();
  });

  it("shows the error text of a failed call with a short red reason", () => {
    const item = toolItem({
      toolName: "Read",
      input: { file_path: `${CWD}/missing.py` },
      state: "error",
      content: [{ type: "text", text: "The file does not exist." }],
      display: null,
    });
    renderInTheme(<ToolCard item={item} open env={makeEnv()} />, theme);
    expect(screen.getByText("failed").className).toMatch(/bad/);
    expect(screen.getByText("The file does not exist.")).toBeInTheDocument();
  });
});

describe.each(THEMES)("TasksCard (%s)", (theme) => {
  it("lists every task while the turn runs", () => {
    renderInTheme(<TasksCard item={tasksItem()} running open={false} env={makeEnv()} />, theme);
    const card = screen.getByRole("region", { name: "Tasks" });
    expect(card).toHaveTextContent("1 of 3 done");
    const items = within(card).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-status"))).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(items[0]).toHaveTextContent("Done: Add tests for refunds");
    expect(items[1]).toHaveTextContent("In progress: Making split_evenly handle negative totals");
    expect(items[2]).toHaveTextContent("To do: Run the whole test suite");
  });

  it("folds to one line once the turn has finished", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = tasksItem({
      tasks: tasksItem().tasks.map((task) => ({ ...task, status: "completed" as const })),
    });
    const { rerender } = renderInTheme(
      <TasksCard item={item} running={false} open={false} env={env} />,
      theme,
    );
    const toggle = screen.getByRole("button", { name: "Tasks, 3 of 3 done" });
    expect(screen.queryByRole("listitem")).toBeNull();
    await user.click(toggle);
    expect(env.setItemOpen).toHaveBeenCalledWith(item.id, true);
    rerender(<TasksCard item={item} running={false} open env={env} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});

describe.each(THEMES)("dividers (%s)", (theme) => {
  it("shows notes, in red for errors", () => {
    renderInTheme(
      <>
        <NoteView item={noteItem()} />
        <NoteView
          item={noteItem({ id: "n2", text: "The model stopped responding", tone: "error" })}
        />
      </>,
      theme,
    );
    expect(
      screen.getByText("Interrupted by you · the transcript keeps every finished call"),
    ).toBeInTheDocument();
    expect(screen.getByText("The model stopped responding").parentElement?.className).toMatch(
      /error/,
    );
  });

  it("shows compaction running, finished and failed", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const { rerender } = renderInTheme(
      <CompactionView
        item={compactionItem({ state: "running", contextAfter: null, summary: null })}
        open={false}
        env={env}
      />,
      theme,
    );
    expect(screen.getByText("Compacting the conversation…")).toBeInTheDocument();

    const done = compactionItem();
    rerender(<CompactionView item={done} open={false} env={env} />);
    const toggle = screen.getByRole("button", {
      name: "Conversation compacted · 74.2K → 21.6K tokens",
    });
    await user.click(toggle);
    expect(env.setItemOpen).toHaveBeenCalledWith(done.id, true);
    rerender(<CompactionView item={done} open env={env} />);
    expect(screen.getByText("Done so far:")).toBeInTheDocument();

    rerender(<CompactionView item={compactionItem({ trigger: "auto" })} open={false} env={env} />);
    expect(
      screen.getByRole("button", { name: "Compacted automatically · 74.2K → 21.6K tokens" }),
    ).toBeInTheDocument();

    rerender(
      <CompactionView
        item={compactionItem({
          state: "failed",
          contextAfter: null,
          summary: null,
          error: {
            kind: "model_error",
            message: "The model refused.",
            detail: null,
            retryable: false,
          },
        })}
        open={false}
        env={env}
      />,
    );
    expect(
      screen.getByText("Compaction failed: The model refused.").parentElement?.className,
    ).toMatch(/error/);
  });

  it("shows the turn summary, leaving out unknown parts", () => {
    const { rerender } = renderInTheme(<TurnSummaryView item={summaryItem()} />, theme);
    expect(
      screen.getByText("48 s · 6 model requests · 92% of the prompt read from cache"),
    ).toBeInTheDocument();
    rerender(
      <TurnSummaryView
        item={summaryItem({
          modelRequests: null,
          cachedPercent: null,
          stopReason: "turn_limit",
          durationMs: 72_000,
        })}
      />,
    );
    expect(screen.getByText("1 min 12 s · stopped at the turn limit")).toBeInTheDocument();
  });
});

describe.each(THEMES)("ErrorCard (%s)", (theme) => {
  it("shows the message, a retryable hint and the detail on request", async () => {
    const user = userEvent.setup();
    const env = makeEnv();
    const item = errorItem();
    const { rerender } = renderInTheme(<ErrorCard item={item} open={false} env={env} />, theme);
    const card = screen.getByRole("region", { name: "The model is unavailable" });
    expect(card).toHaveTextContent("The model stopped responding.");
    expect(within(card).getByText("Retryable")).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show details" }));
    expect(env.setItemOpen).toHaveBeenCalledWith(item.id, true);
    rerender(<ErrorCard item={item} open env={env} />);
    expect(screen.getByText("connect ECONNREFUSED 127.0.0.1:8080")).toBeInTheDocument();
  });

  it("leaves out the hint and the toggle when they do not apply", () => {
    renderInTheme(
      <ErrorCard
        item={errorItem({
          error: { kind: "internal", message: "Oops.", detail: null, retryable: false },
        })}
        open={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.queryByText("Retryable")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe.each(THEMES)("CommandOutput (%s)", (theme) => {
  it("shows the command and its Markdown answer", () => {
    renderInTheme(<CommandOutput item={commandOutputItem()} env={makeEnv()} />, theme);
    expect(screen.getByText("/help")).toBeInTheDocument();
    const output = screen.getByRole("region", { name: "Output of /help" });
    expect(within(output).getByRole("heading", { name: "Commands" })).toBeInTheDocument();
    expect(within(output).getByText("/compact")).toBeInTheDocument();
  });
});

describe.each(THEMES)("PromptProgress (%s)", (theme) => {
  it("shows how much of the prompt has been read, cached part included", () => {
    renderInTheme(
      <PromptProgress
        progress={{
          turnId: "turn-2",
          total: 24_410,
          cached: 14_080,
          processed: 18_240,
          tokensPerSecond: 1_240,
          secondsLeft: 4.2,
        }}
      />,
      theme,
    );
    expect(
      screen.getByText("Reading the conversation · 18,240 of 24,410 tokens"),
    ).toBeInTheDocument();
    expect(screen.getByText("about 4 s")).toBeInTheDocument();
    expect(screen.getByText("14,080 from cache")).toBeInTheDocument();
    expect(screen.getByText(/4,160 read at 1,240 tokens\/s/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Reading the conversation" });
    expect(bar).toHaveAttribute("aria-valuenow", "18240");
    const [cached, read] = Array.from(bar.children) as HTMLElement[];
    expect(cached?.style.width).toBe("57.7%");
    expect(read?.style.width).toBe("17%");
  });
});
