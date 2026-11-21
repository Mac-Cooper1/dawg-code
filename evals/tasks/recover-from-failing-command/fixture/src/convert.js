import { UNITS } from "./generated/units.js";

const BY_SYMBOL = new Map(UNITS.map((u) => [u.symbol, u]));

/** @param {string} symbol */
export function unit(symbol) {
  const found = BY_SYMBOL.get(symbol);
  if (!found) throw new RangeError(`unknown unit "${symbol}"`);
  return found;
}

/**
 * Convert `value` from one unit to another of the same dimension.
 * @param {number} value
 * @param {string} from
 * @param {string} to
 */
export function convert(value, from, to) {
  const a = unit(from);
  const b = unit(to);
  if (a.dimension !== b.dimension) {
    throw new TypeError(`cannot convert ${a.dimension} (${from}) to ${b.dimension} (${to})`);
  }
  return (value * a.factor) / b.factor;
}

/** Symbols of every unit of a dimension, sorted. */
export function symbolsFor(dimension) {
  return UNITS.filter((u) => u.dimension === dimension)
    .map((u) => u.symbol)
    .sort();
}

export function dimensions() {
  return [...new Set(UNITS.map((u) => u.dimension))].sort();
}
