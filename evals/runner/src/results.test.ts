import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "./__fixtures__/paths.ts";
import { readResultFiles, resultFileName, sanitizeEndpoint } from "./results.ts";

test("result file names: UTC date, agent, model slug", () => {
  const d = new Date("2026-11-20T23:30:00-05:00");
  expect(resultFileName(d, "claude-code", "Qwen/Qwen3.8-27B")).toBe(
    "2026-11-21-claude-code-qwen-qwen3.8-27b.jsonl",
  );
  expect(resultFileName(d, "reference", "none")).toBe("2026-11-21-reference-none.jsonl");
});

test("endpoints are written without credentials, query or fragment", () => {
  expect(sanitizeEndpoint("https://user:sk-123@api.example:8443/v1?key=sk-456#x")).toBe(
    "https://api.example:8443/v1",
  );
  expect(sanitizeEndpoint("not a url")).toBe("<invalid url>");
});

test("unreadable rows are reported with file and line, not thrown", () => {
  const { dir, cleanup } = tempDir();
  try {
    const p = join(dir, "r.jsonl");
    writeFileSync(p, '{"schema":1}\nnot json\n\n');
    const { rows, errors } = readResultFiles([p]);
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/r\.jsonl:1: /);
    expect(errors[1]).toMatch(/r\.jsonl:2: /);
  } finally {
    cleanup();
  }
});
