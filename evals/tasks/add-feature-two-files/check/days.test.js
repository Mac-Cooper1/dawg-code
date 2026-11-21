// Hidden tests: days support plus the original behaviour.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { parseDuration, formatDuration } = await import(
  pathToFileURL(join(process.env.WORKSPACE, "src", "index.js")).href
);

const DAY = 86400;

test("parse: days", () => {
  assert.equal(parseDuration("1d"), DAY);
  assert.equal(parseDuration("3d"), 3 * DAY);
  assert.equal(parseDuration("2d3h"), 2 * DAY + 3 * 3600);
  assert.equal(parseDuration("1d 2h 3m 4s"), 93784);
  assert.equal(parseDuration("1d4s"), DAY + 4);
  assert.equal(parseDuration("0d5s"), 5);
  assert.equal(parseDuration("10d 1m"), 10 * DAY + 60);
});

test("parse: days keep the ordering and repetition rules", () => {
  for (const bad of ["1h2d", "1d1d", "5s1d", "1m 1d", "d", "1.5d", "1 d", "1w", "1D"]) {
    assert.throws(() => parseDuration(bad), Error, bad);
  }
});

test("parse: existing behaviour unchanged", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("2h 5m 10s"), 7510);
  assert.equal(parseDuration(" 1m 1s "), 61);
  assert.equal(parseDuration("90m"), 5400);
  assert.equal(parseDuration("48h"), 2 * DAY);
  for (const bad of ["", "   ", "10", "5x", "1m1h", "1h1h", "1.5h", "-1s", "h", "1 h"]) {
    assert.throws(() => parseDuration(bad), Error, bad);
  }
  assert.throws(() => parseDuration(42), TypeError);
});

test("format: compact with days", () => {
  assert.equal(formatDuration(DAY), "1d");
  assert.equal(formatDuration(93784), "1d2h3m4s");
  assert.equal(formatDuration(DAY + 3600), "1d1h");
  assert.equal(formatDuration(DAY + 1), "1d1s");
  assert.equal(formatDuration(25 * 3600), "1d1h");
  assert.equal(formatDuration(10 * DAY), "10d");
  assert.equal(formatDuration(400 * DAY + 61), "400d1m1s");
  assert.equal(formatDuration(DAY - 1), "23h59m59s");
});

test("format: long with days", () => {
  assert.equal(formatDuration(DAY, { long: true }), "1 day");
  assert.equal(formatDuration(2 * DAY, { long: true }), "2 days");
  assert.equal(formatDuration(90061, { long: true }), "1 day 1 hour 1 minute 1 second");
  assert.equal(formatDuration(3 * DAY + 120, { long: true }), "3 days 2 minutes");
  assert.equal(formatDuration(DAY - 1, { long: true }), "23 hours 59 minutes 59 seconds");
});

test("format: existing behaviour unchanged", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(formatDuration(3601), "1h1s");
  assert.equal(formatDuration(36000), "10h");
  assert.equal(formatDuration(0, { long: true }), "0 seconds");
  assert.equal(formatDuration(1, { long: true }), "1 second");
  assert.equal(formatDuration(3661, { long: true }), "1 hour 1 minute 1 second");
  assert.equal(formatDuration(7320, { long: true }), "2 hours 2 minutes");
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(1.5), RangeError);
});

test("round trip including days", () => {
  for (const n of [1, 59, 61, 3599, 3661, 45296, DAY - 1, DAY, DAY + 1, 93784, 7 * DAY + 3, 1000003]) {
    assert.equal(parseDuration(formatDuration(n)), n, String(n));
  }
});
