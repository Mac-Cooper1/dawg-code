import { mkdir } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { fakeCompactor } from "./__fixtures__/fakes.ts";
import { type Harness, historyProblems, startHarness, textOf } from "./__fixtures__/harness.ts";
import { TRIM_SUMMARY } from "./session.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function notes(view: readonly Message[]): string[] {
  return view.filter((m) => m.role === "user" && m.kind === "note").map(textOf);
}

/** Text of each message of request `n`, in order. */
function sent(harness: Harness, n: number): string[] {
  return (harness.mock.messages(n) as { content: unknown }[]).map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
}

describe("notes appended at safe points", () => {
  it("tells the model when a background command has finished", async () => {
    h = await startHarness({
      script: [
        toolCall("Bash", { command: "echo from-the-background", run_in_background: true }),
        text("started it"),
        text("noted"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("start it"));
    const deadline = Date.now() + 10_000;
    while (session.backgroundTasks().some((t) => t.status === "running")) {
      if (Date.now() > deadline) throw new Error("the background command did not finish");
      await new Promise((r) => setTimeout(r, 20));
    }
    await session.run(ask("anything new?"));
    const request = sent(h, 2);
    const note = request.findIndex((m) => m.includes("background_task_finished"));
    expect(note).toBeGreaterThan(-1);
    expect(request[note]).toContain("echo from-the-background");
    // At the start of the turn: before the new prompt, after the previous answer.
    expect(request[note + 1]).toContain("anything new?");
    expect(historyProblems(session.view)).toEqual([]);
  });

  it("adds a nested instruction file the first time a file under it is read", async () => {
    h = await startHarness({
      files: {
        "pkg/CLAUDE.md": "Use tabs in pkg.\n",
        "pkg/a.txt": "a\n",
        "pkg/b.txt": "b\n",
      },
      script: [
        toolCall("Read", { file_path: "pkg/a.txt" }),
        toolCall("Read", { file_path: "pkg/b.txt" }),
        text("done"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("read both"));
    const second = sent(h, 1);
    const noteAt = second.findIndex((m) => m.includes("instructions_added"));
    expect(noteAt).toBeGreaterThan(-1);
    expect(second[noteAt]).toContain("Use tabs in pkg.");
    expect(second[noteAt]).toContain(path.join(h.project, "pkg", "CLAUDE.md"));
    // After the result of the call that made it relevant, never between a call and its result.
    expect((h.mock.messages(1) as { role: string }[])[noteAt - 1]?.role).toBe("tool");
    const third = sent(h, 2).filter((m) => m.includes("instructions_added"));
    expect(third).toHaveLength(1);
    expect(historyProblems(session.view)).toEqual([]);
  });

  it("notes a date change, a mode change and an added directory before the next prompt", async () => {
    h = await startHarness({ script: [text("one"), text("two")] });
    const extra = path.join(h.root, "more");
    await mkdir(extra);
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("first"));
    h.advanceClock(24 * 60 * 60 * 1000);
    session.setMode("plan");
    session.setMode("acceptEdits");
    await session.addDirectory(extra);
    await session.run(ask("second"));
    const added = notes(session.view);
    expect(added.filter((n) => n.includes("date_changed"))).toHaveLength(1);
    // Two switches, one note: only the mode the model needs to know now.
    expect(added.filter((n) => n.includes("mode_changed"))).toEqual([
      expect.stringContaining("acceptEdits"),
    ]);
    expect(added.filter((n) => n.includes("directory_added"))).toEqual([
      expect.stringContaining(extra),
    ]);
    expect(session.snapshot().additionalDirectories).toEqual([extra]);
  });

  it("shortens one oversized result before it considers compacting", async () => {
    const compactor = fakeCompactor({ trim: true });
    h = await startHarness({
      engine: { compactor },
      mock: { contextWindow: 16_000 },
      files: { "big.txt": `${"y".repeat(80)}\n`.repeat(750) },
      script: [toolCall("Read", { file_path: "big.txt" }), text("summarised")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("read it"));
    expect(compactor.calls).toHaveLength(0);
    expect(h.ofType(session.id, "compaction.finished")[0]?.payload.summary).toBe(TRIM_SUMMARY);
    const results = session.view.filter((m) => m.role === "tool");
    expect(textOf(results[0])).toBe("[trimmed]");
    expect(historyProblems(session.view)).toEqual([]);
  });
});
