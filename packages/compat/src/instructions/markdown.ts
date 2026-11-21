/**
 * Small, forgiving Markdown helpers for instruction files: fenced-code detection, code spans,
 * block-level HTML comments, `@path` import tokens and YAML front matter. This is not a full
 * Markdown parser; it covers what the documented behaviour depends on.
 */

/** Normalises line endings and drops a byte-order mark so content compares byte for byte. */
export function normaliseText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, "\n");
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** For each line, whether it belongs to a fenced code block (fence lines included). */
export function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence === null) {
      const match = FENCE_OPEN.exec(line);
      const marker = match?.[1];
      // A backtick fence may not have backticks in its info string.
      if (
        marker &&
        !(marker[0] === "`" && line.slice(line.indexOf(marker) + marker.length).includes("`"))
      ) {
        fence = marker;
        out.push(true);
      } else {
        out.push(false);
      }
    } else {
      out.push(true);
      const trimmed = line.trim();
      const char = fence[0] ?? "`";
      const indent = line.length - line.trimStart().length;
      if (indent <= 3 && trimmed.length >= fence.length && [...trimmed].every((c) => c === char)) {
        fence = null;
      }
    }
  }
  return out;
}

/**
 * Removes block-level HTML comments (`<!-- ... -->` starting a line) outside fenced code. A
 * comment that never closes is left in place rather than swallowing the rest of the file.
 */
export function stripBlockComments(text: string): string {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (fenced[i] || !/^ {0,3}<!--/.test(line)) {
      out.push(line);
      i++;
      continue;
    }
    // Find the closing marker, possibly on a later line.
    const startCol = line.indexOf("<!--");
    let j = i;
    let closeAt = line.indexOf("-->", startCol + 4);
    while (closeAt === -1 && j + 1 < lines.length) {
      j++;
      closeAt = (lines[j] ?? "").indexOf("-->");
    }
    if (closeAt === -1) {
      out.push(line);
      i++;
      continue;
    }
    const rest = (lines[j] ?? "").slice(closeAt + 3);
    if (rest.trim() !== "") out.push(rest);
    i = j + 1;
  }
  return out.join("\n");
}

/** One `@path` reference found on a line. */
export interface ImportToken {
  /** The path as written, with `\ ` unescaped to a space. */
  path: string;
}

/** Character ranges of inline code spans in one line, as [start, end) pairs. */
function codeSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let runEnd = i;
    while (line[runEnd] === "`") runEnd++;
    const run = line.slice(i, runEnd);
    // The span closes at the next run of exactly the same length.
    let search = runEnd;
    let close = -1;
    while (search < line.length) {
      const at = line.indexOf(run, search);
      if (at === -1) break;
      let after = at + run.length;
      if (line[after] !== "`" && (at === 0 || line[at - 1] !== "`")) {
        close = at;
        break;
      }
      while (line[after] === "`") after++;
      search = after;
    }
    if (close === -1) {
      i = runEnd;
      continue;
    }
    spans.push([i, close + run.length]);
    i = close + run.length;
  }
  return spans;
}

/**
 * Finds `@path` imports on one line that is not inside fenced code. The `@` must start the line
 * or follow whitespace (so e-mail addresses are not imports), the path runs to the next
 * unescaped whitespace, and a quoted path is not an import, as documented.
 */
export function findImports(line: string): ImportToken[] {
  const spans = codeSpans(line);
  const inSpan = (pos: number) => spans.some(([s, e]) => pos >= s && pos < e);
  const out: ImportToken[] = [];
  const pattern = /(^|\s)@((?:\\ |\S)+)/g;
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    const at = match.index + (match[1]?.length ?? 0);
    if (inSpan(at)) continue;
    const raw = match[2] ?? "";
    if (raw.startsWith('"') || raw.startsWith("'")) continue;
    out.push({ path: raw.replace(/\\ /g, " ") });
  }
  return out;
}

/** Splits text into lines and reports which ones may carry imports (not fenced code). */
export function importableLines(text: string): { lines: string[]; fenced: boolean[] } {
  const lines = text.split("\n");
  return { lines, fenced: fencedLines(lines) };
}

export interface FrontMatter {
  /** The raw YAML between the markers, or null when the file has none. */
  yaml: string | null;
  /** The text after the front matter. */
  body: string;
}

/** Splits leading `---` front matter from the body. Expects normalised line endings. */
export function splitFrontMatter(text: string): FrontMatter {
  if (!text.startsWith("---\n") && text !== "---") return { yaml: null, body: text };
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trimEnd() === "---") {
      return { yaml: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { yaml: null, body: text };
}

/** Splits a comma-separated pattern list, ignoring commas inside `{...}` brace groups. */
export function splitPatternList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    else if (ch === "}" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((p) => p.trim()).filter((p) => p !== "");
}
