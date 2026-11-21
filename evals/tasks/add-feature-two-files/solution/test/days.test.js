import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, parseDuration } from "../src/index.js";

test("parses days", () => {
  assert.equal(parseDuration("1d"), 86400);
  assert.equal(parseDuration("2d3h"), 183600);
  assert.equal(parseDuration("1d 30m"), 88200);
  assert.throws(() => parseDuration("1h2d"), SyntaxError);
  assert.throws(() => parseDuration("1d1d"), SyntaxError);
});

test("formats days", () => {
  assert.equal(formatDuration(93784), "1d2h3m4s");
  assert.equal(formatDuration(86400), "1d");
  assert.equal(formatDuration(93784, { long: true }), "1 day 2 hours 3 minutes 4 seconds");
  assert.equal(formatDuration(172800, { long: true }), "2 days");
});
