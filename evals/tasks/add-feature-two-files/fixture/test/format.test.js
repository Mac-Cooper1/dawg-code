import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, parseDuration } from "../src/index.js";

test("compact format", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(formatDuration(3601), "1h1s");
  assert.equal(formatDuration(36000), "10h");
});

test("long format", () => {
  assert.equal(formatDuration(0, { long: true }), "0 seconds");
  assert.equal(formatDuration(1, { long: true }), "1 second");
  assert.equal(formatDuration(3661, { long: true }), "1 hour 1 minute 1 second");
  assert.equal(formatDuration(7320, { long: true }), "2 hours 2 minutes");
});

test("rejects bad input", () => {
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(1.5), RangeError);
});

test("round trip", () => {
  for (const n of [1, 59, 60, 61, 3599, 3600, 3661, 45296]) {
    assert.equal(parseDuration(formatDuration(n)), n);
  }
});
