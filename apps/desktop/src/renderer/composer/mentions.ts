/**
 * `@` mentions in the composer's text: finding the one being typed, inserting a chosen path, and
 * turning the finished text's `@path` tokens into the prompt's `mentions`.
 *
 * A mention starts with "@" at the start of the text, after whitespace or after an opening
 * bracket or quote, so "me@example.com" is not one. The path follows: up to the next whitespace,
 * or in double quotes when it holds a space (`@"My Notes/plan.md"`). An optional line range ends
 * it: `@src/a.ts#L10` (one line) or `@src/a.ts#L10-20`.
 */
import type { FileMention } from "@dawg/protocol";

/** Characters after which "@" starts a mention (besides whitespace and the start). */
const OPENERS = new Set(["(", "[", "{", '"', "'", "`"]);

/** Punctuation that ends a sentence rather than a path: "see @a.ts, then…". */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

/** A line range at the end of a mention, or one being typed ("#", "#L", "#L1", "#L1-"). */
const RANGE_SUFFIX = /#(?:L\d*(?:-L?\d*)?)?$/;

/** A finished line range: "#L10" or "#L10-20". */
const LINE_RANGE = /^(.*)#L(\d+)(?:-L?(\d+))?$/;

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function startsMention(text: string, at: number): boolean {
  if (text[at] !== "@") return false;
  const before = text[at - 1];
  return at === 0 || isSpace(before) || OPENERS.has(before ?? "");
}

/** The `@` token the caret is in. */
export interface ActiveMention {
  /** Index of the "@". */
  start: number;
  /** Where the token ends: the next whitespace, or after the closing quote. */
  end: number;
  /** What to search for: the path typed so far, up to the caret. */
  query: string;
  /** A line range typed after the path ("#L10-20"), kept when a path replaces the token. */
  suffix: string;
  /** The path is in double quotes (it holds a space). */
  quoted: boolean;
}

/**
 * The mention the caret is in, while its path is being typed. Null when the caret is not in one,
 * or the person has moved on to its line range.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  // A quoted path may hold spaces: look back for `@"` with no closing quote before the caret.
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const quote = text.lastIndexOf('@"', caret - 1);
  if (quote >= lineStart && startsMention(text, quote)) {
    const typed = text.slice(quote + 2, caret);
    if (!typed.includes('"')) {
      if (RANGE_SUFFIX.test(typed)) return null;
      const rest = text.slice(caret);
      const closing = /^[^"\n]*"/.exec(rest);
      const end = closing ? caret + closing[0].length : caret;
      const after = /^#L\d+(?:-L?\d+)?/.exec(text.slice(end));
      return {
        start: quote,
        end: end + (after ? after[0].length : 0),
        query: typed,
        suffix: after ? after[0] : "",
        quoted: true,
      };
    }
  }

  let wordStart = caret;
  while (wordStart > 0 && !isSpace(text[wordStart - 1])) wordStart--;
  let start = -1;
  for (let i = wordStart; i < caret; i++) {
    if (startsMention(text, i)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const typed = text.slice(start + 1, caret);
  // A quoted path whose quote is closed, or a line range being typed: the path is chosen.
  if (typed.startsWith('"') || RANGE_SUFFIX.test(typed)) return null;
  let end = caret;
  while (end < text.length && !isSpace(text[end])) end++;
  const token = text.slice(start + 1, end);
  const range = RANGE_SUFFIX.exec(token);
  return {
    start,
    end,
    query: typed,
    suffix: range && range[0] !== "#" ? range[0] : "",
    quoted: false,
  };
}

function needsQuotes(relativePath: string): boolean {
  return /\s/.test(relativePath);
}

/** How a path is written after "@": as it is, or in quotes when it holds a space. */
export function mentionText(relativePath: string): string {
  return needsQuotes(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
}

/**
 * Replaces the active token with a chosen path. A finished mention is followed by a space (the
 * menu closes); `browse` (Tab on a folder) leaves the folder's path open, so the search goes on
 * inside it.
 */
export function applyMention(
  text: string,
  active: ActiveMention,
  relativePath: string,
  options: { browse?: boolean } = {},
): { text: string; caret: number } {
  const quoted = needsQuotes(relativePath);
  const before = text.slice(0, active.start);
  const after = text.slice(active.end);
  if (options.browse) {
    const open = quoted ? `@"${relativePath}` : `@${relativePath}`;
    return { text: before + open + after, caret: before.length + open.length };
  }
  const isFolder = relativePath.endsWith("/");
  const written = mentionText(relativePath) + (isFolder ? "" : active.suffix);
  if (isSpace(after[0])) {
    return { text: before + written + after, caret: before.length + written.length + 1 };
  }
  const inserted = `${written} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** A path candidate with its line range, if one was written. */
function withRange(raw: string): { path: string; startLine?: number; endLine?: number } {
  const match = LINE_RANGE.exec(raw);
  if (!match) return { path: raw };
  const first = Number(match[2]);
  const second = match[3] === undefined ? first : Number(match[3]);
  if (first < 1 || second < 1) return { path: match[1] ?? "" };
  return {
    path: match[1] ?? "",
    startLine: Math.min(first, second),
    endLine: Math.max(first, second),
  };
}

/**
 * The files a finished text mentions, in order and without repeats. `known` says which paths
 * are real: paths the `@` menu inserted or found ("src/a.ts", a folder as "src/"). Any other
 * `@word` stays plain text. The text itself is left as typed.
 */
export function resolveMentions(text: string, known: (path: string) => boolean): FileMention[] {
  const mentions: FileMention[] = [];
  const seen = new Set<string>();
  const accept = (candidate: { path: string; startLine?: number; endLine?: number }) => {
    let path = candidate.path;
    if (path === "") return false;
    if (!known(path)) {
      if (!path.endsWith("/") && known(`${path}/`)) path = `${path}/`;
      else return false;
    }
    const folder = path.endsWith("/");
    const mention: FileMention =
      folder || candidate.startLine === undefined
        ? { path }
        : { path, startLine: candidate.startLine, endLine: candidate.endLine };
    const key = `${mention.path}#${mention.startLine ?? ""}-${mention.endLine ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push(mention);
    }
    return true;
  };

  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!startsMention(text, at)) continue;
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2);
      const newline = text.indexOf("\n", at + 2);
      if (close === -1 || (newline !== -1 && newline < close)) continue;
      const path = text.slice(at + 2, close);
      const range = /^#L(\d+)(?:-L?(\d+))?/.exec(text.slice(close + 1));
      accept(range ? withRange(`${path}${range[0]}`) : { path });
      continue;
    }
    let end = at + 1;
    while (end < text.length && !isSpace(text[end])) end++;
    const raw = text.slice(at + 1, end);
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    // The whole word first ("v1."), then without the sentence's punctuation.
    if (!accept(withRange(raw)) && trimmed !== raw) accept(withRange(trimmed));
  }
  return mentions;
}
