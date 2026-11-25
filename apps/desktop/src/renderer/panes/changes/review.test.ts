import { afterEach, describe, expect, it } from "vitest";
import type { AgentEdit } from "../../code/session.ts";
import { selectSessionActivity, touchedFiles } from "../../code/session.ts";
import { editItem, sessionView } from "../../code/testing.tsx";
import { initialAppState } from "../../state/store.ts";
import type { AppStore } from "../../state/types.ts";
import {
  addComment,
  clearComments,
  commentsOf,
  lineLabel,
  removeComment,
  resetReview,
  reviewMessage,
  reviewStore,
} from "./review.ts";
import { editedFiles, textBeforeEdits } from "./sessionEdits.ts";

const CWD = "/Users/me/code/tally";

afterEach(() => resetReview());

describe("review comments", () => {
  it("collect per session and can be removed or cleared", () => {
    addComment("s1", {
      path: `${CWD}/a.py`,
      side: "modified",
      startLine: 3,
      endLine: 3,
      text: "x",
      quote: [],
    });
    addComment("s2", {
      path: `${CWD}/b.py`,
      side: "modified",
      startLine: 1,
      endLine: 2,
      text: "y",
      quote: [],
    });
    const [first] = commentsOf(reviewStore.getState(), "s1");
    expect(first?.text).toBe("x");
    removeComment("s1", first?.id ?? "");
    expect(commentsOf(reviewStore.getState(), "s1")).toEqual([]);
    clearComments("s2");
    expect(commentsOf(reviewStore.getState(), "s2")).toEqual([]);
  });

  it("become one message with path:line references, quoting the lines", () => {
    const message = reviewMessage(
      [
        {
          id: "1",
          path: `${CWD}/src/tally/money.py`,
          side: "modified",
          startLine: 14,
          endLine: 16,
          text: "  Use ROUND_HALF_UP here.  ",
          quote: ["a", "b", "c"],
        },
        {
          id: "2",
          path: `${CWD}/README.md`,
          side: "original",
          startLine: 9,
          endLine: 9,
          text: "Keep this example.",
          quote: Array.from({ length: 8 }, (_, i) => `line ${i}`),
        },
      ],
      CWD,
      "/Users/me",
    );
    expect(message).toBe(
      [
        "Comments on the changes:",
        "",
        "src/tally/money.py:14-16\n> a\n> b\n> c\nUse ROUND_HALF_UP here.",
        "",
        "README.md:9 (the lines as they were before the change)\n> line 0\n> line 1\n> line 2\n> line 3\n> line 4\n> line 5\n> …\nKeep this example.",
      ].join("\n"),
    );
    expect(lineLabel({ startLine: 4, endLine: 4 })).toBe("4");
  });
});

const hunk = (oldStart: number, newStart: number, lines: string[]) => ({
  oldStart,
  oldLines: lines.filter((line) => !line.startsWith("+")).length,
  newStart,
  newLines: lines.filter((line) => !line.startsWith("-")).length,
  lines,
});

function edit(path: string, hunks: AgentEdit["hunks"], created = false): AgentEdit {
  const item = editItem(path, hunks, { created });
  const display = item.display;
  if (display?.kind !== "diff") throw new Error("not a diff");
  return {
    toolCallId: item.toolCallId,
    path,
    created,
    hunks,
    additions: display.additions,
    deletions: display.deletions,
  };
}

describe("the session's own edits (outside git)", () => {
  const first = edit(`${CWD}/a.py`, [hunk(1, 1, [" a", "-b", "+B", " c"])]);
  const second = edit(`${CWD}/a.py`, [hunk(3, 3, [" c", "+d"])]);
  const created = edit(`${CWD}/new.py`, [hunk(0, 1, ["+x", "+y"])], true);

  it("lists each edited file once, adding up its counts", () => {
    expect(editedFiles([first, created, second])).toEqual([
      {
        path: `${CWD}/a.py`,
        oldPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        binary: false,
      },
      {
        path: `${CWD}/new.py`,
        oldPath: null,
        status: "added",
        additions: 2,
        deletions: 0,
        binary: false,
      },
    ]);
  });

  it("rebuilds the text from before the edits, newest first", () => {
    expect(textBeforeEdits("a\nB\nc\nd\n", [first, second])).toBe("a\nb\nc\n");
    expect(textBeforeEdits("x\ny\n", [created])).toBe("");
  });

  it("gives up when the file changed in other ways since", () => {
    expect(textBeforeEdits("something else entirely\n", [first, second])).toBeNull();
    expect(textBeforeEdits("x\ny\nz\n", [created])).toBeNull();
  });

  it("reads dawg's edits from the transcript, stable while nothing changes", () => {
    const base = initialAppState("/Users/me");
    const items = [
      editItem(`${CWD}/a.py`, first.hunks),
      editItem(`${CWD}/new.py`, created.hunks, { created: true }),
      editItem(`${CWD}/failed.py`, first.hunks, { state: "error" }),
      { ...editItem(`${CWD}/running.py`, first.hunks), state: "running" as const },
    ];
    const state = {
      ...base,
      sessions: { s1: sessionView("s1", CWD) },
      transcripts: { s1: items },
    } as unknown as AppStore;
    const activity = selectSessionActivity(state, "s1");
    expect(activity.finishedTools).toBe(3);
    expect(activity.edits.map((one) => one.path)).toEqual([`${CWD}/a.py`, `${CWD}/new.py`]);
    // A new array with the same edits keeps the same result.
    const again = { ...state, transcripts: { s1: [...items] } } as AppStore;
    expect(selectSessionActivity(again, "s1")).toBe(activity);
    expect(touchedFiles(activity.edits)).toEqual(
      new Map([
        [`${CWD}/a.py`, "edited"],
        [`${CWD}/new.py`, "created"],
      ]),
    );
  });
});
