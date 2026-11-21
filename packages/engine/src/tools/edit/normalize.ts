/**
 * Line normalisation for the tolerant matching steps. Each normalised line remembers where each
 * of its characters came from, so a match found in normalised text maps back to exact columns
 * of the original line.
 */

export interface NormalizeOptions {
  /** Drop whitespace at the start of the line. */
  trimStart?: boolean;
  /** Drop whitespace at the end of the line. */
  trimEnd?: boolean;
  /** Replace look-alike characters (curly quotes, odd spaces, dashes) with plain ASCII. */
  lookAlikes?: boolean;
  /** Turn each run of whitespace inside the line into one space. */
  collapseSpaces?: boolean;
}

export interface NormalizedLine {
  text: string;
  /** For each character of `text`, its index in the original line. Null means `offset + i`. */
  map: number[] | null;
  offset: number;
  /** Length of the original line. */
  rawLength: number;
}

/** Index in the original line of character `i` of the normalised text. */
export function rawIndex(line: NormalizedLine, i: number): number {
  return line.map === null ? line.offset + i : (line.map[i] ?? line.rawLength);
}

/** Index in the original line just after the character `i - 1` of the normalised text. */
export function rawEnd(line: NormalizedLine, i: number): number {
  if (i <= 0) return rawIndex(line, 0);
  return rawIndex(line, i - 1) + 1;
}

const WHITESPACE = /\s/;
const BOM = String.fromCharCode(0xfeff);

export function isSpace(ch: string): boolean {
  return WHITESPACE.test(ch) || ch === BOM;
}

/**
 * Characters models often write in place of what is in the file, or the reverse, with the
 * plain ASCII a model would type. Listed by code point because several are invisible and the
 * formatter turns escapes into literal characters. Zero-width characters map to nothing.
 */
const LOOK_ALIKE_GROUPS: ReadonlyArray<readonly [string, readonly number[]]> = [
  // Curly single quotes, primes, modifier apostrophe, fullwidth apostrophe
  ["'", [0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x02bc, 0xff07]],
  // Curly double quotes, double prime, guillemets, fullwidth quote
  ['"', [0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb, 0xff02]],
  // Hyphens, figure dash, en and em dashes, horizontal bar, minus signs
  ["-", [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe63, 0xff0d]],
  // No-break, ogham, en, em, thin, hair and other fixed-width spaces, ideographic space
  [
    " ",
    [
      0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
      0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
    ],
  ],
  // Zero-width space, non-joiner and joiner, word joiner, byte order mark
  ["", [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]],
  // Ellipsis and bullet
  ["...", [0x2026]],
  ["*", [0x2022]],
];

export const LOOK_ALIKES: ReadonlyMap<string, string> = new Map(
  LOOK_ALIKE_GROUPS.flatMap(([ascii, codes]) =>
    codes.map((code) => [String.fromCharCode(code), ascii] as const),
  ),
);

/** Short names for the look-alikes, for notes to the model. */
export function describeLookAlike(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const target = LOOK_ALIKES.get(ch);
  if (target === "") return `an invisible zero-width character (${hex})`;
  if (target === " ") return `a non-breaking or other special space (${hex})`;
  return `${ch} (${hex})`;
}

export function normalizeLine(line: string, options: NormalizeOptions): NormalizedLine {
  if (!options.lookAlikes && !options.collapseSpaces) {
    let start = 0;
    let end = line.length;
    if (options.trimStart) while (start < end && isSpace(line[start] as string)) start++;
    if (options.trimEnd) while (end > start && isSpace(line[end - 1] as string)) end--;
    return { text: line.slice(start, end), map: null, offset: start, rawLength: line.length };
  }

  let chars: string[] = [];
  let src: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    const mapped = options.lookAlikes ? LOOK_ALIKES.get(ch) : undefined;
    if (mapped === undefined) {
      chars.push(ch);
      src.push(i);
    } else {
      for (const c of mapped) {
        chars.push(c);
        src.push(i);
      }
    }
  }

  let start = 0;
  let end = chars.length;
  if (options.trimStart) while (start < end && isSpace(chars[start] as string)) start++;
  if (options.trimEnd) while (end > start && isSpace(chars[end - 1] as string)) end--;
  chars = chars.slice(start, end);
  src = src.slice(start, end);

  if (options.collapseSpaces) {
    const outChars: string[] = [];
    const outSrc: number[] = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i] as string;
      if (isSpace(ch)) {
        if (outChars[outChars.length - 1] === " ") continue;
        outChars.push(" ");
      } else {
        outChars.push(ch);
      }
      outSrc.push(src[i] as number);
    }
    chars = outChars;
    src = outSrc;
  }
  return { text: chars.join(""), map: src, offset: 0, rawLength: line.length };
}
