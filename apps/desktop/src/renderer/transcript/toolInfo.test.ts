import type { CommandDisplay } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import { bashFailure, editItem, grepItem, MONEY_HUNKS, readItem, toolItem } from "./testing.ts";
import {
  commandOutput,
  defaultToolOpen,
  diffRows,
  finishedCommandOutput,
  parseReadResult,
  searchSummary,
  toolFailed,
  toolIcon,
  toolMeta,
} from "./toolInfo.ts";

describe("defaultToolOpen", () => {
  const passing = toolItem();
  const failing = bashFailure();
  const running = toolItem({ state: "running", content: null, display: null, durationMs: null });
  const read = readItem();
  const edit = editItem();
  const grep = grepItem();
  const invalid = toolItem({ toolName: "Read", state: "invalid", display: null });

  it("opens what needs a look in smart mode", () => {
    expect(defaultToolOpen(failing, "smart")).toBe(true);
    expect(defaultToolOpen(edit, "smart")).toBe(true);
    expect(defaultToolOpen(invalid, "smart")).toBe(true);
    expect(defaultToolOpen(running, "smart")).toBe(true);
    expect(defaultToolOpen(passing, "smart")).toBe(false);
    expect(defaultToolOpen(read, "smart")).toBe(false);
    expect(defaultToolOpen(grep, "smart")).toBe(false);
  });

  it("follows the all-open and all-closed settings", () => {
    for (const item of [passing, failing, running, read, edit, grep]) {
      expect(defaultToolOpen(item, "open")).toBe(true);
      expect(defaultToolOpen(item, "closed")).toBe(false);
    }
  });

  it("counts timed-out commands as failed", () => {
    const timedOut = toolItem({
      display: {
        kind: "command",
        command: "sleep 999",
        cwd: "/",
        exitCode: null,
        durationMs: 120_000,
        timedOut: true,
        interrupted: false,
        backgroundTaskId: null,
        outputPath: null,
        output: "",
        notes: ["The command did not finish within 2 min and was stopped."],
      },
    });
    expect(toolFailed(timedOut)).toBe(true);
    expect(toolMeta(timedOut)).toEqual([{ kind: "text", text: "timed out", tone: "bad" }]);
  });
});

describe("toolMeta", () => {
  it("shows exit codes, line counts, diff counts and match counts", () => {
    expect(toolMeta(toolItem())).toEqual([{ kind: "text", text: "exit 0", tone: "ok" }]);
    expect(toolMeta(bashFailure())).toEqual([{ kind: "text", text: "exit 1", tone: "bad" }]);
    expect(toolMeta(readItem())).toEqual([{ kind: "text", text: "42 lines", tone: "neutral" }]);
    expect(toolMeta(editItem())).toEqual([{ kind: "diff", additions: 3, deletions: 2 }]);
    expect(toolMeta(grepItem())).toEqual([
      { kind: "text", text: "14 matches in 6 files", tone: "neutral" },
    ]);
  });

  it("gives a short reason for calls that did not succeed", () => {
    expect(toolMeta(toolItem({ toolName: "Read", state: "error", display: null }))).toEqual([
      { kind: "text", text: "failed", tone: "bad" },
    ]);
    expect(toolMeta(toolItem({ state: "invalid", display: null }))[0]).toMatchObject({
      text: "invalid input",
    });
    expect(toolMeta(toolItem({ state: "denied", display: null }))[0]).toMatchObject({
      text: "not allowed",
    });
    expect(toolMeta(toolItem({ state: "running", display: null }))).toEqual([]);
  });

  it("picks an icon per tool", () => {
    expect(toolIcon("Bash")).toBe("terminal");
    expect(toolIcon("Read")).toBe("read");
    expect(toolIcon("Write")).toBe("edit");
    expect(toolIcon("Glob")).toBe("search");
    expect(toolIcon("WebFetch")).toBe("globe");
    expect(toolIcon("mcp__github__search")).toBe("model");
  });
});

describe("searchSummary", () => {
  const display = { kind: "search" as const, pattern: "x", resultCount: 6, truncated: false };
  it("describes each output mode", () => {
    expect(searchSummary("Glob", {}, display, "")).toBe("6 files");
    expect(searchSummary("Grep", {}, display, "")).toBe("6 files");
    expect(
      searchSummary(
        "Grep",
        { output_mode: "count" },
        display,
        "a:3\n\nTotal: 14 matches in 6 files.",
      ),
    ).toBe("14 matches in 6 files");
    expect(searchSummary("Grep", {}, { ...display, resultCount: 0 }, "")).toBe("no matches");
    expect(searchSummary("Glob", {}, { ...display, resultCount: 1 }, "")).toBe("1 file");
  });
});

describe("parseReadResult", () => {
  it("strips the tool's line-number prefixes and keeps the notes", () => {
    const text = " 9→def a():\n10→    return 1\n\nThe file has more lines.";
    expect(parseReadResult(text, null)).toEqual({
      start: 9,
      lines: ["def a():", "    return 1"],
      notes: "The file has more lines.",
    });
  });

  it("falls back to the display's start line when there are no prefixes", () => {
    const display = {
      kind: "file" as const,
      filePath: "/a",
      startLine: 5,
      lineCount: 2,
      totalLines: 10,
      truncated: true,
    };
    expect(parseReadResult("a\nb\nextra", display)).toEqual({
      start: 5,
      lines: ["a", "b"],
      notes: "",
    });
  });

  it("returns no lines for an empty file", () => {
    const display = {
      kind: "file" as const,
      filePath: "/a",
      startLine: 1,
      lineCount: 0,
      totalLines: 0,
      truncated: false,
    };
    expect(parseReadResult("The file /a exists but is empty.", display).lines).toEqual([]);
  });
});

describe("diffRows", () => {
  it("numbers lines from each hunk's start", () => {
    const rows = diffRows(MONEY_HUNKS);
    expect(rows.map((row) => [row.kind, row.number, row.sign])).toEqual([
      ["hunk", null, ""],
      ["context", 10, ""],
      ["del", 11, "-"],
      ["del", 12, "-"],
      ["add", 11, "+"],
      ["add", 12, "+"],
      ["add", 13, "+"],
    ]);
    expect(rows[0]?.text).toBe("@@ -10,6 +10,10 @@");
  });

  it("keeps a no-newline marker as a note", () => {
    const rows = diffRows([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-a", "\\ No newline at end of file", "+b"],
      },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["hunk", "del", "note", "add"]);
  });
});

describe("commandOutput", () => {
  const display: CommandDisplay = {
    kind: "command",
    command: "make",
    cwd: "/p",
    exitCode: 2,
    durationMs: 700,
    timedOut: true,
    interrupted: false,
    backgroundTaskId: null,
    outputPath: null,
    output: "Error: make stopped\n",
    notes: ["The command did not finish within 2 min and was stopped."],
  };

  it("takes the output and notes the engine reports, as they are", () => {
    const item = toolItem({
      state: "error",
      content: [{ type: "text", text: "Error: whatever the model was told" }],
      output: [{ stream: "stdout", text: "live" }],
      display,
    });
    expect(commandOutput(item)).toEqual({ output: display.output, notes: display.notes });
    expect(commandOutput(toolItem({ display: { ...display, output: "" } })).output).toBe("");
  });

  it("falls back to the model's text for commands stored before engines reported output", () => {
    const item = toolItem({
      state: "error",
      content: [{ type: "text", text: "Error: boom\n\nExit code 2" }],
      display: { ...display, timedOut: false, output: null, notes: [] },
    });
    expect(commandOutput(item)).toEqual({ output: "boom", notes: [] });
  });
});

/** Sessions stored before engines reported `output` and `notes`. */
describe("finishedCommandOutput", () => {
  const command = {
    kind: "command" as const,
    command: "uv run pytest -q -k refund",
    cwd: "/p",
    exitCode: 1,
    durationMs: 700,
    timedOut: false,
    interrupted: false,
    backgroundTaskId: null,
    outputPath: null,
    output: null,
    notes: [],
  };
  const recorded =
    "Error: F                                                        [100%]\nFAILED tests/test_money.py::test_split_evenly_refund_keeps_every_cent\n1 failed, 8 deselected in 0.18s\n\nExit code 1";

  it("removes the engine's Error: prefix and Exit code footer", () => {
    const item = toolItem({
      state: "error",
      content: [{ type: "text", text: recorded }],
      display: command,
    });
    expect(finishedCommandOutput(item)).toEqual({
      output:
        "F                                                        [100%]\nFAILED tests/test_money.py::test_split_evenly_refund_keeps_every_cent\n1 failed, 8 deselected in 0.18s",
      notes: [],
    });
  });

  it("keeps a passing command's own text, blank lines and Error: words included", () => {
    const text = "Error: is a word this tool prints\n\nall good";
    const item = toolItem({
      content: [{ type: "text", text }],
      display: { ...command, exitCode: 0 },
    });
    expect(finishedCommandOutput(item)).toEqual({ output: text, notes: [] });
  });

  it("keeps an Exit code line that is not the command's exit code", () => {
    const text = "Error: retrying\n\nExit code 3";
    const item = toolItem({ state: "error", content: [{ type: "text", text }], display: command });
    expect(finishedCommandOutput(item)).toEqual({ output: "retrying", notes: ["Exit code 3"] });
  });

  it("handles a failure with no output at all", () => {
    const item = toolItem({
      state: "error",
      content: [{ type: "text", text: "Error: Exit code 1" }],
      display: command,
    });
    expect(finishedCommandOutput(item)).toEqual({ output: "", notes: [] });
    const quiet = toolItem({
      content: [{ type: "text", text: "(no output)" }],
      display: { ...command, exitCode: 0 },
    });
    expect(finishedCommandOutput(quiet).output).toBe("");
  });

  it("removes the prefix from an interrupted command too", () => {
    const item = toolItem({
      state: "interrupted",
      content: [{ type: "text", text: "Error: collecting\n\nThe command was interrupted." }],
      display: { ...command, exitCode: null, interrupted: true },
    });
    expect(finishedCommandOutput(item)).toEqual({
      output: "collecting",
      notes: ["The command was interrupted."],
    });
  });

  it("uses the live chunks when it has them, and still reads the notes", () => {
    const item = toolItem({
      state: "error",
      output: [{ stream: "stdout", text: "\u001b[31mF\u001b[0m\n" }],
      content: [{ type: "text", text: "Error: F\n\nThe command was interrupted." }],
      display: { ...command, exitCode: null, interrupted: true },
    });
    expect(finishedCommandOutput(item)).toEqual({
      output: "\u001b[31mF\u001b[0m\n",
      notes: ["The command was interrupted."],
    });
  });
});
