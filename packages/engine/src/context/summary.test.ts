import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { isNoteText } from "../prompt/index.ts";
import { createTestToolContext } from "../testing/context.ts";
import { readTool } from "../tools/index.ts";
import { filesNote, summaryNote, summaryRequestBody } from "./summary.ts";

function textOf(message: { content: { type: string; text?: string }[] } | null): string {
  return message?.content.map((p) => p.text ?? "").join("") ?? "";
}

describe("the summary request", () => {
  test("asks for every section, most important first", () => {
    const body = summaryRequestBody(null, false);
    const order = [
      "## Goal",
      "## User instructions",
      "## Current state",
      "## Next steps",
      "## Decisions",
      "## Files",
      "## Key facts",
    ].map((heading) => body.indexOf(heading));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("Do not call any tools");
    expect(body).not.toContain("concentrate on");
  });

  test("adds the focus and the retry line only when needed", () => {
    expect(summaryRequestBody("  the auth bug ", false)).toContain(
      "concentrate on: the auth bug\n",
    );
    expect(summaryRequestBody(" ", false)).not.toContain("concentrate on");
    expect(summaryRequestBody(null, true)).toContain("did not contain the summary");
  });
});

describe("the notes compaction writes", () => {
  test("the summary note carries the summary and the tasks", () => {
    const text = textOf(
      summaryNote("## Goal\nShip it.", [{ content: "Write docs", status: "pending" }], false),
    );
    expect(isNoteText(text)).toBe(true);
    expect(text).toContain("## Goal\nShip it.");
    expect(text).toContain("- pending: Write docs");
    expect(text).not.toContain("follow it unchanged");
  });

  test("files are numbered exactly as Read numbers them", async () => {
    const t = await createTestToolContext();
    try {
      const content = "line one\n\tindented\n\nlast\n";
      const file = path.join(t.ctx.cwd, "f.txt");
      await writeFile(file, content);
      const read = textOf(await readTool.execute({ file_path: file }, t.ctx));
      const note = textOf(filesNote({ shown: [{ path: file, content }], omitted: [] }));
      expect(isNoteText(note)).toBe(true);
      expect(note).toContain(`<file path="${file}">\n${read}\n</file>`);
    } finally {
      await t.cleanup();
    }
  });

  test("an empty plan writes no note, and omitted files are named", () => {
    expect(filesNote({ shown: [], omitted: [] })).toBeNull();
    const text = textOf(filesNote({ shown: [], omitted: ["/a/big.json"] }));
    expect(text).toContain("Read them again if you need them: /a/big.json");
  });
});
