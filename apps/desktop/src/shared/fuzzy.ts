/**
 * Fuzzy matching of paths for `@` mentions, shared by main's file index and the browser fakes so
 * both rank alike. Pure and allocation-light: each path is prepared once, and a search reuses one
 * set of typed arrays for every candidate.
 *
 * A query matches a path when its characters appear in order (case-insensitively). Among the ways
 * to place them, the best is found by dynamic programming over the path, scoring:
 * - every matched character;
 * - bonuses where a match starts a word: the start of the path, after "/", after "-", "_", "."
 *   or a space, at a camelCase hump or where digits begin (the first query character counts
 *   double, as people type the start of a name);
 * - consecutive matches, which keep the bonus their run started with;
 * - matches inside the basename, and matching case;
 * - a basename that is the whole query (with or without its extension), or starts with it;
 * and penalising gaps between matches (opening one costs more than widening it), the path's
 * length and its depth. The positions of the best placement are the highlights.
 *
 * Speed (about 100,000 paths per keystroke): a bitmask of the characters each path holds rejects
 * most paths without reading them; the table only covers the stretch where each query character
 * can go, and only the places where it occurs; and `FuzzyIndex` narrows a query that extends the
 * previous one to the paths that matched that one.
 */

/** A path prepared once for repeated matching. */
export interface FuzzyTarget {
  /** As shown: "/"-separated, a directory ending with "/". */
  readonly text: string;
  /** `text` lower-cased one character at a time, so positions line up with `text`. */
  readonly lower: string;
  /** Where the basename starts: after the last "/" that is not the trailing one. */
  readonly baseStart: number;
  /** How many folders deep: "a.ts" is 0, "src/a.ts" and "src/lib/" are 1. */
  readonly depth: number;
  readonly directory: boolean;
  /** Which kinds of character the path holds (see `maskOf`). */
  readonly mask: number;
  /** The word-start bonus at each position, as character codes. */
  readonly bonuses: string;
}

export interface FuzzyMatch<T extends FuzzyTarget = FuzzyTarget> {
  target: T;
  score: number;
  /** Indexes into `target.text` of the matched characters, ascending. */
  positions: number[];
}

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_START = 10;
const BONUS_SEPARATOR = 10;
const BONUS_WORD = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 5;
const FIRST_CHAR_MULTIPLIER = 2;
const BONUS_BASENAME = 4;
const BONUS_CASE = 1;
const BONUS_EXACT_BASENAME = 24;
const BONUS_BASENAME_PREFIX = 8;
const PENALTY_DEPTH = 1;
const PENALTY_LENGTH = 1 / 16;
const PENALTY_DIRECTORY = 2;

/** Below any reachable score. */
const NEG = -(1 << 28);

const SLASH = 0x2f;
const DOT = 0x2e;

/** Lower-cases character by character, so every index of the result matches the input's. */
function lowerAligned(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  // A few characters ("İ") lower-case to two; keep those as they are.
  let out = "";
  for (const char of text) {
    const low = char.toLowerCase();
    out += low.length === char.length ? low : char;
  }
  return out;
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

function isUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isLetter(code: number): boolean {
  return isLower(code) || isUpper(code) || code > 0x7f;
}

/** "-", "_", ".", space and other ASCII punctuation (but not "/", which scores on its own). */
function isDelimiter(code: number): boolean {
  return code < 0x80 && !isLetter(code) && !isDigit(code) && code !== SLASH;
}

/** How much a match at `j` is worth beyond the match itself: does a word start there? */
function bonusAt(text: string, j: number): number {
  if (j === 0) return BONUS_START;
  const previous = text.charCodeAt(j - 1);
  if (previous === SLASH) return BONUS_SEPARATOR;
  const current = text.charCodeAt(j);
  if (isDelimiter(previous)) return isDelimiter(current) ? 0 : BONUS_WORD;
  if (isLower(previous) && isUpper(current)) return BONUS_CAMEL;
  if (isLetter(previous) && isDigit(current)) return BONUS_CAMEL;
  return 0;
}

/**
 * One bit per kind of (lower-case) character: a–z, any digit, "/", ".", "-" or "_", anything
 * else. A path can match only if it has every bit the query has.
 */
function maskBit(code: number): number {
  if (isLower(code)) return 1 << (code - 0x61);
  if (isDigit(code)) return 1 << 26;
  if (code === SLASH) return 1 << 27;
  if (code === DOT) return 1 << 28;
  if (code === 0x2d || code === 0x5f) return 1 << 29;
  return 1 << 30;
}

function maskOf(lower: string): number {
  let mask = 0;
  for (let i = 0; i < lower.length; i++) mask |= maskBit(lower.charCodeAt(i));
  return mask;
}

export function prepareTarget(text: string): FuzzyTarget {
  const directory = text.endsWith("/");
  const end = directory ? text.length - 1 : text.length;
  const slash = text.lastIndexOf("/", end - 1);
  let depth = 0;
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === SLASH) depth++;
  const lower = lowerAligned(text);
  const codes = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) codes[i] = bonusAt(text, i);
  return {
    text,
    lower,
    baseStart: slash + 1,
    depth,
    directory,
    mask: maskOf(lower),
    bonuses: String.fromCharCode(...codes),
  };
}

interface PreparedQuery {
  raw: string;
  lower: string;
  length: number;
  mask: number;
}

/** Spaces are dropped (a mention never holds one unquoted); "./" at the start means the top. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, "").replace(/^(\.\/)+/, "");
}

function prepareQuery(query: string): PreparedQuery | null {
  const raw = normalizeQuery(query);
  if (raw === "") return null;
  const lower = lowerAligned(raw);
  return { raw, lower, length: raw.length, mask: maskOf(lower) };
}

/**
 * Reusable buffers, grown as needed. Each query row keeps a list of the places its character can
 * go: position, best score there, the bonus its run started with, and where it came from.
 */
class Workspace {
  minPos = new Int32Array(64);
  maxPos = new Int32Array(64);
  pos = new Int32Array(1024);
  score = new Int32Array(1024);
  run = new Int32Array(1024);
  from = new Int32Array(1024);

  ensure(queryLength: number, cells: number): void {
    if (this.minPos.length < queryLength) {
      this.minPos = new Int32Array(queryLength * 2);
      this.maxPos = new Int32Array(queryLength * 2);
    }
    if (this.pos.length < cells) {
      const size = Math.max(cells, this.pos.length * 2);
      this.pos = new Int32Array(size);
      this.score = new Int32Array(size);
      this.run = new Int32Array(size);
      this.from = new Int32Array(size);
    }
  }
}

const shared = new Workspace();

/**
 * Scores one target, or returns null when the query is not a subsequence of it. With `positions`,
 * also fills them with the best placement.
 */
function scoreTarget(
  query: PreparedQuery,
  target: FuzzyTarget,
  ws: Workspace,
  positions: number[] | null,
): number | null {
  const m = query.length;
  const { text, lower, bonuses } = target;
  const n = lower.length;
  if (m > n || (target.mask & query.mask) !== query.mask) return null;
  const q = query.lower;
  if (m === 1) return scoreOneCharacter(query, target, positions);
  ws.ensure(m, m * n);
  const { minPos, maxPos } = ws;

  // Earliest and latest place each query character can take: the table only spans those.
  let j = 0;
  for (let i = 0; i < m; i++) {
    const code = q.charCodeAt(i);
    while (j < n && lower.charCodeAt(j) !== code) j++;
    if (j === n) return null;
    minPos[i] = j;
    j++;
  }
  j = n - 1;
  for (let i = m - 1; i >= 0; i--) {
    const code = q.charCodeAt(i);
    while (lower.charCodeAt(j) !== code) j--;
    maxPos[i] = j;
    j--;
  }

  const { pos, score, run, from } = ws;
  const baseStart = target.baseStart;
  let cursor = 0;
  let prevStart = 0;
  let prevEnd = 0;
  for (let i = 0; i < m; i++) {
    const lo = minPos[i] ?? 0;
    const hi = maxPos[i] ?? 0;
    const code = q.charCodeAt(i);
    const exact = query.raw.charCodeAt(i);
    const rowStart = cursor;
    // Over the previous row's places: the best start for a gap ending before k.
    let p = prevStart;
    let gapKey = NEG;
    let gapFrom = -1;
    for (let k = lo; k <= hi; k++) {
      if (lower.charCodeAt(k) !== code) continue;
      const bonus = bonuses.charCodeAt(k);
      const extra =
        (text.charCodeAt(k) === exact ? BONUS_CASE : 0) + (k >= baseStart ? BONUS_BASENAME : 0);
      if (i === 0) {
        pos[cursor] = k;
        score[cursor] = SCORE_MATCH + bonus * FIRST_CHAR_MULTIPLIER + extra;
        run[cursor] = bonus;
        from[cursor] = -1;
        cursor++;
        continue;
      }
      while (p < prevEnd && (pos[p] ?? 0) <= k - 2) {
        // Placed at k' ≤ k-2: a gap to k costs GAP_START + GAP_EXTENSION * (k - 2 - k').
        const key = (score[p] ?? 0) - GAP_EXTENSION * (pos[p] ?? 0);
        if (key >= gapKey) {
          gapKey = key;
          gapFrom = p;
        }
        p++;
      }
      let best = NEG;
      let chunk = bonus;
      let source = -1;
      if (p < prevEnd && pos[p] === k - 1) {
        const started = Math.max(run[p] ?? 0, bonus);
        best = (score[p] ?? 0) + SCORE_MATCH + Math.max(started, BONUS_CONSECUTIVE);
        chunk = started;
        source = p;
      }
      if (gapFrom !== -1) {
        const viaGap = gapKey + GAP_START + GAP_EXTENSION * (k - 2) + SCORE_MATCH + bonus;
        if (viaGap > best) {
          best = viaGap;
          chunk = bonus;
          source = gapFrom;
        }
      }
      if (source === -1) continue;
      pos[cursor] = k;
      score[cursor] = best + extra;
      run[cursor] = chunk;
      from[cursor] = source;
      cursor++;
    }
    if (cursor === rowStart) return null;
    prevStart = rowStart;
    prevEnd = cursor;
  }

  let best = NEG;
  let end = -1;
  for (let c = prevStart; c < prevEnd; c++) {
    const value = score[c] ?? NEG;
    if (value > best) {
      best = value;
      end = c;
    }
  }
  if (end === -1) return null;

  if (positions) {
    positions.length = m;
    let c = end;
    for (let i = m - 1; i >= 0; i--) {
      positions[i] = pos[c] ?? 0;
      c = from[c] ?? -1;
    }
  }
  return best + wholeBonus(query, target) - penalty(target);
}

/** A one-character query needs no table: the best single place, in one pass. */
function scoreOneCharacter(
  query: PreparedQuery,
  target: FuzzyTarget,
  positions: number[] | null,
): number | null {
  const { text, lower, bonuses, baseStart } = target;
  const code = query.lower.charCodeAt(0);
  const exact = query.raw.charCodeAt(0);
  let best = NEG;
  let at = -1;
  for (let k = lower.indexOf(query.lower); k !== -1 && k < lower.length; k++) {
    if (lower.charCodeAt(k) !== code) continue;
    const value =
      SCORE_MATCH +
      bonuses.charCodeAt(k) * FIRST_CHAR_MULTIPLIER +
      (text.charCodeAt(k) === exact ? BONUS_CASE : 0) +
      (k >= baseStart ? BONUS_BASENAME : 0);
    if (value > best) {
      best = value;
      at = k;
    }
  }
  if (at === -1) return null;
  if (positions) {
    positions.length = 1;
    positions[0] = at;
  }
  return best + wholeBonus(query, target) - penalty(target);
}

/** Bonuses that need the whole basename: it is the query, or starts with it. */
function wholeBonus(query: PreparedQuery, target: FuzzyTarget): number {
  const { lower, baseStart } = target;
  const end = target.directory ? lower.length - 1 : lower.length;
  const baseLength = end - baseStart;
  const m = query.length;
  if (m > baseLength || !lower.startsWith(query.lower, baseStart)) return 0;
  if (m === baseLength) return BONUS_EXACT_BASENAME;
  // "money" for "money.py", but not for "money.test.py".
  if (lower.charCodeAt(baseStart + m) === DOT && lower.indexOf(".", baseStart + m + 1) === -1) {
    return BONUS_EXACT_BASENAME;
  }
  return BONUS_BASENAME_PREFIX;
}

function penalty(target: FuzzyTarget): number {
  return (
    target.depth * PENALTY_DEPTH +
    target.text.length * PENALTY_LENGTH +
    (target.directory ? PENALTY_DIRECTORY : 0)
  );
}

/** One target's score and highlights, or null when it does not match. */
export function fuzzyMatch<T extends FuzzyTarget>(query: string, target: T): FuzzyMatch<T> | null {
  const prepared = prepareQuery(query);
  if (!prepared) return null;
  const positions: number[] = [];
  const score = scoreTarget(prepared, target, shared, positions);
  return score === null ? null : { target, score, positions };
}

/** Better first: higher score, then shorter, then alphabetical. */
function better(a: FuzzyTarget, aScore: number, b: FuzzyTarget, bScore: number): boolean {
  if (aScore !== bScore) return aScore > bScore;
  if (a.text.length !== b.text.length) return a.text.length < b.text.length;
  return a.text < b.text;
}

/**
 * Scores `candidates` (indexes into `targets`; all of them when null), keeping the best `limit`.
 * Also returns every index that matched, for narrowing the next query.
 */
function searchTargets<T extends FuzzyTarget>(
  query: PreparedQuery,
  targets: readonly T[],
  candidates: Int32Array | null,
  limit: number,
): { matches: FuzzyMatch<T>[]; matched: Int32Array } {
  const ws = shared;
  const total = candidates ? candidates.length : targets.length;
  const matched = new Int32Array(total);
  let matchedCount = 0;

  // A min-heap of the best `limit` so far: the root is the worst kept.
  const heapIndex: number[] = [];
  const heapScore: number[] = [];
  const worse = (x: number, y: number) =>
    better(
      targets[heapIndex[y] ?? 0] as T,
      heapScore[y] ?? 0,
      targets[heapIndex[x] ?? 0] as T,
      heapScore[x] ?? 0,
    );
  const swap = (x: number, y: number) => {
    const index = heapIndex[x] ?? 0;
    const score = heapScore[x] ?? 0;
    heapIndex[x] = heapIndex[y] ?? 0;
    heapScore[x] = heapScore[y] ?? 0;
    heapIndex[y] = index;
    heapScore[y] = score;
  };
  const siftUp = (start: number) => {
    let at = start;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!worse(at, parent)) break;
      swap(at, parent);
      at = parent;
    }
  };
  const siftDown = (start: number) => {
    let at = start;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let worst = at;
      if (left < heapIndex.length && worse(left, worst)) worst = left;
      if (right < heapIndex.length && worse(right, worst)) worst = right;
      if (worst === at) return;
      swap(at, worst);
      at = worst;
    }
  };

  for (let c = 0; c < total; c++) {
    const index = candidates ? (candidates[c] ?? 0) : c;
    const target = targets[index] as T;
    const score = scoreTarget(query, target, ws, null);
    if (score === null) continue;
    matched[matchedCount++] = index;
    if (limit <= 0) continue;
    if (heapIndex.length < limit) {
      heapIndex.push(index);
      heapScore.push(score);
      siftUp(heapIndex.length - 1);
    } else if (better(target, score, targets[heapIndex[0] ?? 0] as T, heapScore[0] ?? 0)) {
      heapIndex[0] = index;
      heapScore[0] = score;
      siftDown(0);
    }
  }

  const kept = heapIndex.map((index, at) => ({
    target: targets[index] as T,
    score: heapScore[at] ?? 0,
  }));
  kept.sort((a, b) => (better(a.target, a.score, b.target, b.score) ? -1 : 1));
  const matches = kept.map(({ target, score }) => {
    const positions: number[] = [];
    scoreTarget(query, target, ws, positions);
    return { target, score, positions };
  });
  return { matches, matched: matched.slice(0, matchedCount) };
}

/**
 * The best `limit` matches among `targets`, best first, with highlights. An empty query matches
 * nothing (the caller decides what to show then).
 */
export function fuzzySearch<T extends FuzzyTarget>(
  query: string,
  targets: readonly T[],
  limit: number,
): FuzzyMatch<T>[] {
  const prepared = prepareQuery(query);
  if (!prepared) return [];
  return searchTargets(prepared, targets, null, limit).matches;
}

/** How many earlier queries' matches a `FuzzyIndex` keeps for narrowing. */
const NARROWING_MEMORY = 8;

/**
 * Searches a fixed list of targets, remembering which targets the last few queries matched: a
 * query that extends one of them ("mon" after "mo") only looks at those, so typing stays fast on
 * large lists, and going back (Backspace) finds the earlier answer's candidates again.
 */
export class FuzzyIndex<T extends FuzzyTarget> {
  readonly targets: readonly T[];
  /** How many targets the last search scored (all of them, or an earlier query's matches). */
  lastScored = 0;
  /** Lower-cased query → the indexes it matched, most recent last. */
  #memory = new Map<string, Int32Array>();

  constructor(targets: readonly T[]) {
    this.targets = targets;
  }

  search(query: string, limit: number): FuzzyMatch<T>[] {
    const prepared = prepareQuery(query);
    if (!prepared) return [];
    // Every target that matches a query also matches each of its prefixes.
    let candidates: Int32Array | null = null;
    let longest = -1;
    for (const [earlier, matched] of this.#memory) {
      if (earlier.length > longest && prepared.lower.startsWith(earlier)) {
        candidates = matched;
        longest = earlier.length;
      }
    }
    const { matches, matched } = searchTargets(prepared, this.targets, candidates, limit);
    this.lastScored = candidates ? candidates.length : this.targets.length;
    this.#memory.delete(prepared.lower);
    this.#memory.set(prepared.lower, matched);
    while (this.#memory.size > NARROWING_MEMORY) {
      const oldest = this.#memory.keys().next().value;
      if (oldest === undefined) break;
      this.#memory.delete(oldest);
    }
    return matches;
  }
}
