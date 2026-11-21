import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FIXTURES } from "./__fixtures__/paths.ts";
import { median, renderReport } from "./report.ts";
import { readResultFiles } from "./results.ts";

const DIR = join(FIXTURES, "report");
const FILES = [
  join(DIR, "2026-11-20-opencode-qwen3.8-27b.jsonl"),
  join(DIR, "2026-11-20-claude-code-qwen3.8-27b.jsonl"),
];

describe("renderReport", () => {
  test("matches the committed scoreboard snapshot", () => {
    const { rows, errors } = readResultFiles(FILES);
    expect(errors).toEqual([]);
    const md = renderReport({ rows, sources: FILES });
    expect(md).toBe(readFileSync(join(DIR, "expected.md"), "utf8"));
  });

  test("is independent of row and file order", () => {
    const { rows } = readResultFiles(FILES);
    const a = renderReport({ rows, sources: FILES });
    const b = renderReport({ rows: [...rows].reverse(), sources: [...FILES].reverse() });
    expect(b).toBe(a);
  });

  test("no rows", () => {
    expect(renderReport({ rows: [] })).toBe("# Eval scoreboard\n\nNo results.\n");
  });
});

test("median", () => {
  expect(median([])).toBeNull();
  expect(median([3])).toBe(3);
  expect(median([5, 1, 3])).toBe(3);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});
