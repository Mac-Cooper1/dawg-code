import { join } from "node:path";
import { expect, test } from "vitest";
import { RECORDS } from "./__fixtures__/paths.ts";
import { computeMetrics, emptyMetrics, parseRecords, readRecordFile } from "./metrics.ts";

test("metrics from a mixed record file", () => {
  const parsed = readRecordFile(join(RECORDS, "mixed.jsonl"));
  expect(parsed.invalidLines).toBe(2);
  expect(parsed.records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  // Unknown fields survive parsing.
  expect(parsed.records[1]?.future_field).toEqual({ anything: true });

  const m = computeMetrics(parsed);
  expect(m).toEqual({
    requests: 3, // the GET /v1/models record (api "other") is not a model request
    prefix_tokens: 1000, // first generation request with usage
    prompt_tokens: 2100,
    completion_tokens: 80,
    tool_calls: 5,
    malformed_tool_calls: 2, // one invalid JSON, one schema_valid === false; null is not malformed
    cache_reuse_ratio: 1000 / 2100, // sum(cache_n) / sum(cache_n + prompt_n)
    failed_edits: null,
    invalid_records: 2,
  });
});

test("cache reuse is null when no record has timings (hosted endpoints)", () => {
  const m = computeMetrics(readRecordFile(join(RECORDS, "no-timings.jsonl")));
  expect(m.cache_reuse_ratio).toBeNull();
  expect(m.requests).toBe(2);
  expect(m.prefix_tokens).toBe(5000);
  expect(m.prompt_tokens).toBe(10200);
  expect(m.completion_tokens).toBe(100);
  expect(m.malformed_tool_calls).toBe(0);
});

test("prefix tokens skip a first request without usage", () => {
  const text = [
    { seq: 1, api: "openai.chat", status: 500, usage: null },
    { seq: 2, api: "openai.chat", status: 200, usage: { prompt_tokens: 42, completion_tokens: 1 } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  expect(computeMetrics(parseRecords(text)).prefix_tokens).toBe(42);
});

test("no records, or a missing file, give empty metrics", () => {
  expect(computeMetrics(parseRecords(""))).toEqual(emptyMetrics());
  expect(computeMetrics(readRecordFile("/nonexistent/proxy.jsonl"))).toEqual(emptyMetrics());
});

test("zero-token timings do not divide by zero", () => {
  const text = JSON.stringify({ seq: 1, api: "openai.chat", timings: { cache_n: 0, prompt_n: 0 } });
  expect(computeMetrics(parseRecords(text)).cache_reuse_ratio).toBeNull();
});
