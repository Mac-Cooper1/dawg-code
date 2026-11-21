import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../src/index.js";

test("parses single units", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2m"), 120);
  assert.equal(parseDuration("3h"), 10800);
});

test("parses combinations with optional spaces", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("2h 5m 10s"), 7510);
  assert.equal(parseDuration(" 1m 1s "), 61);
});

test("amounts are not capped", () => {
  assert.equal(parseDuration("90m"), 5400);
  assert.equal(parseDuration("48h"), 172800);
});

test("rejects bad input", () => {
  for (const bad of ["", "   ", "10", "5x", "1m1h", "1h1h", "1.5h", "-1s", "h", "1 h"]) {
    assert.throws(() => parseDuration(bad), Error, bad);
  }
  assert.throws(() => parseDuration(42), TypeError);
});
