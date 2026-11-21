// Parses compact durations such as "1d2h", "1h30m", "45s" or "2h 5m 10s" into seconds.

const UNIT_SECONDS = new Map([
  ["d", 86400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
]);

const ORDER = [...UNIT_SECONDS.keys()];

const PART = /\s*(\d+)([a-z])\s*/y;

/**
 * @param {string} text
 * @returns {number} whole seconds
 */
export function parseDuration(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new TypeError("duration must be a non-empty string");
  }
  let total = 0;
  let lastRank = -1;
  PART.lastIndex = 0;
  while (PART.lastIndex < text.length) {
    const start = PART.lastIndex;
    const match = PART.exec(text);
    if (!match) {
      throw new SyntaxError(`invalid duration "${text}" at position ${start}`);
    }
    const [, amount, unit] = match;
    const rank = ORDER.indexOf(unit);
    if (rank === -1) {
      throw new SyntaxError(`unknown unit "${unit}" in "${text}"`);
    }
    if (rank <= lastRank) {
      throw new SyntaxError(`unit "${unit}" is repeated or out of order in "${text}"`);
    }
    lastRank = rank;
    total += Number(amount) * UNIT_SECONDS.get(unit);
  }
  return total;
}
