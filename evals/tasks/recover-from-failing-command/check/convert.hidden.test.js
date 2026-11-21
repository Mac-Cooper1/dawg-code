import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Hidden copy of test/convert.test.js plus extra cases, run against $CLONE.
const { convert, dimensions, symbolsFor } = await import(
  pathToFileURL(join(process.env.CLONE, "src", "convert.js")).href
);

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test("length", () => {
  close(convert(1, "km", "m"), 1000);
  close(convert(1, "mi", "km"), 1.609344);
  close(convert(1, "ft", "m"), 0.3048);
  close(convert(3, "ft", "yd"), 1);
  close(convert(12, "in", "ft"), 1);
});

test("mass", () => {
  close(convert(1, "lb", "kg"), 0.45359237);
  close(convert(1, "st", "lb"), 14);
  close(convert(16, "oz", "lb"), 1);
});

test("time and volume", () => {
  close(convert(1, "d", "min"), 1440);
  close(convert(1, "gal", "ml"), 3785.411784);
});

test("errors", () => {
  assert.throws(() => convert(1, "m", "kg"), TypeError);
  assert.throws(() => convert(1, "furlong", "m"), RangeError);
});

test("listing", () => {
  assert.deepEqual(dimensions(), ["length", "mass", "time", "volume"]);
  assert.deepEqual(symbolsFor("time"), ["d", "h", "min", "s"]);
});

test("extra: every length unit agrees with the international inch", () => {
  close(convert(1, "ft", "in"), 12);
  close(convert(1, "yd", "in"), 36);
  close(convert(1, "mi", "ft"), 5280);
  close(convert(100, "cm", "in"), 100 / 2.54);
});

test("extra: other dimensions untouched", () => {
  close(convert(2, "h", "s"), 7200);
  close(convert(1, "kg", "oz"), 1 / 0.028349523125);
  close(convert(1, "l", "gal"), 1 / 3.785411784);
});
