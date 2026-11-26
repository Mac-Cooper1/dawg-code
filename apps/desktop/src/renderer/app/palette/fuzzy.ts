/**
 * Fuzzy matching for the command palette. Each word of the query must be found: in the title as
 * a substring or as letters in order ("frk" finds "Fork the session"), or as a substring of the
 * other words that describe the row (keywords, a project's name). Matches at the start of a word
 * and in the title score higher.
 */

export interface Searchable {
  /** Matched fuzzily. */
  title: string;
  /** Matched as substrings: keywords, the group, a project name and path. */
  extra: string;
}

const WORD_BREAK = /[\s\-_/.,:;·…()[\]“”"'’]/;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'");
}

function atWordStart(text: string, index: number): boolean {
  return index === 0 || WORD_BREAK.test(text.charAt(index - 1));
}

/**
 * The best place `word` occurs in `text`: a whole word beats the start of one ("mode" is closer
 * to "Permission mode" than to "Model"), which beats the middle of one.
 */
function substringScore(word: string, text: string): number | null {
  let best: number | null = null;
  for (let index = text.indexOf(word); index !== -1; index = text.indexOf(word, index + 1)) {
    const end = index + word.length;
    const start = atWordStart(text, index);
    const whole = start && (end === text.length || WORD_BREAK.test(text.charAt(end)));
    const score =
      100 + (index === 0 ? 40 : start ? 25 : 0) + (whole ? 25 : 0) - Math.min(index, 40) * 0.25;
    if (best === null || score > best) best = score;
  }
  return best;
}

/** Shorter words match as substrings only: two scattered letters would match nearly anything. */
const MIN_LETTERS_IN_ORDER = 3;

/** `word`'s letters in order from `start`, preferring word starts and runs. */
function lettersFrom(word: string, text: string, start: number): number | null {
  let score = 0;
  let from = start;
  let previous = start - 2;
  for (const char of word) {
    const found = text.indexOf(char, from);
    if (found === -1) return null;
    score += atWordStart(text, found) ? 6 : 1;
    if (found === previous + 1) score += 3;
    score -= Math.min(found - from, 12) * 0.25;
    previous = found;
    from = found + 1;
  }
  return score;
}

/**
 * `word`'s letters in order in `text`, starting at the start of a word ("frk" finds "Fork the
 * session", "nsw" finds "New session in a worktree"). Always below a substring match.
 */
function lettersInOrderScore(word: string, text: string): number | null {
  if (word.length < MIN_LETTERS_IN_ORDER) return null;
  let best: number | null = null;
  const first = word.charAt(0);
  for (let index = text.indexOf(first); index !== -1; index = text.indexOf(first, index + 1)) {
    if (!atWordStart(text, index)) continue;
    const score = lettersFrom(word, text, index);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best === null ? null : Math.max(1, Math.min(best, 80));
}

/** Prepared text, so a keystroke does not lower-case every row again. */
export interface Prepared {
  title: string;
  extra: string;
}

export function prepare(item: Searchable): Prepared {
  return { title: normalise(item.title), extra: normalise(item.extra) };
}

/** Splits a query into its words. Empty when there is nothing to match. */
export function queryWords(query: string): string[] {
  return normalise(query).trim().split(/\s+/).filter(Boolean);
}

/** Null when some word of the query is not found; otherwise higher is a better match. */
export function matchScore(words: readonly string[], item: Prepared): number | null {
  if (words.length === 0) return 0;
  let total = 0;
  for (const word of words) {
    const inTitle = substringScore(word, item.title) ?? lettersInOrderScore(word, item.title);
    const inExtra = substringScore(word, item.extra);
    const best = Math.max(inTitle ?? -1, inExtra === null ? -1 : inExtra * 0.7);
    if (best < 0) return null;
    total += best;
  }
  // The query as typed, in the title: a phrase beats words found apart.
  if (words.length > 1 && item.title.includes(words.join(" "))) total += 40;
  // Of two equal matches, the shorter title is closer to what was typed.
  return total - item.title.length * 0.05;
}
