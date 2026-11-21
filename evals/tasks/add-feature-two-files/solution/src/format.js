// Formats a number of seconds as "1d2h", "1h30m" or, with { long: true }, "1 hour 30 minutes".

const COMPACT = [
  ["d", 86400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

const LONG_NAMES = {
  d: ["day", "days"],
  h: ["hour", "hours"],
  m: ["minute", "minutes"],
  s: ["second", "seconds"],
};

/**
 * @param {number} seconds non-negative integer
 * @param {{ long?: boolean }} [options]
 * @returns {string}
 */
export function formatDuration(seconds, { long = false } = {}) {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new RangeError("seconds must be a non-negative integer");
  }
  if (seconds === 0) {
    return long ? "0 seconds" : "0s";
  }
  const parts = [];
  let rest = seconds;
  for (const [unit, size] of COMPACT) {
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    if (amount === 0) continue;
    if (long) {
      const [one, many] = LONG_NAMES[unit];
      parts.push(`${amount} ${amount === 1 ? one : many}`);
    } else {
      parts.push(`${amount}${unit}`);
    }
  }
  return parts.join(long ? " " : "");
}
