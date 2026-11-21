/**
 * Finding `old_string` in a file and building the replacement.
 *
 * Matching is a cascade of steps, each more tolerant than the last, and the first step that finds
 * anything decides: one match is applied; several are ambiguous unless `replace_all` is set.
 *
 *   exact               the string as given
 *   line-endings        line by line, so "\n" in old_string matches "\r\n" in the file
 *   trailing-whitespace also ignoring whitespace at the ends of lines
 *   indentation         also ignoring whitespace at the starts of lines
 *   look-alikes         also treating curly quotes, odd spaces and dashes as their ASCII forms
 *   inner-whitespace    also treating any run of whitespace inside a line as one space
 *
 * If no step matches, the cascade is tried once more on old_string with line-number prefixes
 * copied from Read output removed, and then with literal "\n" escapes turned into line breaks.
 *
 * Whatever step matches, the change is applied to the file's own text: lines the model did not
 * change keep their exact bytes, changed lines keep the file's indentation style, trailing
 * whitespace and look-alike characters where the model left them alone, and line endings, byte
 * order mark and final newline are never touched outside the change.
 */
import { diffArrays } from "diff";
import {
  type LineEnding,
  lineEndingStats,
  splitLines,
  splitModelLines,
  stripLineNumberPrefixes,
  stripPrefixesWhereFound,
} from "../files/index.ts";
import {
  buildIndentMapping,
  detectIndentStyle,
  type IndentStyle,
  leadingIndent,
} from "./indent.ts";
import { mergeLine } from "./merge.ts";
import {
  LOOK_ALIKES,
  type NormalizedLine,
  type NormalizeOptions,
  normalizeLine,
  rawEnd,
  rawIndex,
} from "./normalize.ts";
import { similarity } from "./similarity.ts";

export type MatchStep =
  | "exact"
  | "line-endings"
  | "trailing-whitespace"
  | "indentation"
  | "look-alikes"
  | "inner-whitespace";

/** How old_string was cleaned up before it matched. */
export type Preprocess = "none" | "line-numbers" | "escapes";

const LINE_STEPS: ReadonlyArray<{ step: MatchStep; options: NormalizeOptions }> = [
  { step: "line-endings", options: {} },
  { step: "trailing-whitespace", options: { trimEnd: true } },
  { step: "indentation", options: { trimEnd: true, trimStart: true } },
  { step: "look-alikes", options: { trimEnd: true, trimStart: true, lookAlikes: true } },
  {
    step: "inner-whitespace",
    options: { trimEnd: true, trimStart: true, lookAlikes: true, collapseSpaces: true },
  },
];

/** A file's text, split once for all the steps. */
export class FileText {
  readonly text: string;
  readonly lines: string[];
  readonly terminators: string[];
  readonly offsets: number[];
  readonly eol: LineEnding;
  #indentStyle: IndentStyle | null | undefined;
  readonly #normalized = new Map<MatchStep, NormalizedLine[]>();

  constructor(text: string) {
    this.text = text;
    const split = splitLines(text);
    this.lines = split.lines;
    this.terminators = split.terminators;
    this.offsets = split.offsets;
    this.eol = lineEndingStats(text).dominant;
  }

  get indentStyle(): IndentStyle | null {
    if (this.#indentStyle === undefined) this.#indentStyle = detectIndentStyle(this.lines);
    return this.#indentStyle;
  }

  normalized(step: MatchStep, options: NormalizeOptions): NormalizedLine[] {
    let lines = this.#normalized.get(step);
    if (lines === undefined) {
      lines = this.lines.map((l) => normalizeLine(l, options));
      this.#normalized.set(step, lines);
    }
    return lines;
  }

  /** 0-based line containing `offset`. */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.offsets[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

interface Region {
  /** Offsets in the file text: the match covers text[start, end). */
  start: number;
  end: number;
  /** 0-based line where the match starts. */
  line: number;
}

interface LineRegion extends Region {
  /** Lines of old_string this region covers (one fewer than old_string has when `eofNewline`). */
  lineCount: number;
  startCol: number;
  endCol: number;
  /** old_string ended with a line break where the file ends without one. */
  eofNewline: boolean;
}

/** What differed between old_string and the file where it matched, for the note to the model. */
export interface Differences {
  trailingWhitespace: boolean;
  indentation: boolean;
  /** False when old_string's lines were not indented consistently relative to each other. */
  indentationConsistent: boolean;
  fileIndent: IndentStyle | null;
  modelIndent: IndentStyle | null;
  /** Characters in the file that old_string had as plain ASCII look-alikes. */
  lookAlikes: string[];
  innerWhitespace: boolean;
  missingFinalNewline: boolean;
}

export interface PlannedEdit {
  start: number;
  end: number;
  replacement: string;
  /** 0-based line where the replaced text started. */
  line: number;
}

export type MatchPlan =
  | {
      kind: "matched";
      step: MatchStep;
      preprocess: Preprocess;
      /** In file order, not overlapping. */
      edits: PlannedEdit[];
      newText: string;
      differences: Differences;
    }
  | {
      kind: "ambiguous";
      step: MatchStep;
      preprocess: Preprocess;
      /** 1-based start lines of every match, in order. */
      lines: number[];
    }
  | { kind: "none" };

interface Attempt {
  preprocess: Preprocess;
  oldString: string;
  newString: string;
  /** For line-number prefixes: the line old_string said it started on (1-based). */
  claimedLine?: number;
}

export function planEdit(
  file: FileText,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): MatchPlan {
  const attempts: Attempt[] = [{ preprocess: "none", oldString, newString }];
  const prefixed = stripLineNumberPrefixes(oldString);
  if (prefixed !== null) {
    attempts.push({
      preprocess: "line-numbers",
      oldString: prefixed.text,
      newString: stripPrefixesWhereFound(newString, prefixed.separator),
      claimedLine: prefixed.firstNumber,
    });
  }
  if (!oldString.includes("\n") && /\\[nt]/.test(oldString)) {
    attempts.push({
      preprocess: "escapes",
      oldString: unescapeLiterals(oldString),
      newString: unescapeLiterals(newString),
    });
  }
  for (const attempt of attempts) {
    if (attempt.oldString === "" || attempt.oldString === attempt.newString) continue;
    const plan = runCascade(file, attempt, replaceAll);
    if (plan.kind !== "none") return plan;
  }
  return { kind: "none" };
}

function runCascade(file: FileText, attempt: Attempt, replaceAll: boolean): MatchPlan {
  const { oldString, newString } = attempt;
  const exact = findExact(file, oldString, replaceAll);
  if (exact.length > 0) return finish(file, attempt, "exact", exact, replaceAll, null);

  // A whitespace-only old_string would match almost anywhere once whitespace is ignored.
  const blank = oldString.trim() === "";
  const oLines = splitModelLines(oldString);
  for (const { step, options } of LINE_STEPS) {
    if (step === "line-endings" && oLines.length === 1) continue;
    if (blank && step !== "line-endings") break;
    const regions = findLineRegions(file, file.normalized(step, options), oLines, options);
    if (regions.length > 0) {
      const nLines = splitModelLines(newString);
      return finish(file, attempt, step, regions, replaceAll, { oLines, nLines });
    }
  }
  return { kind: "none" };
}

function finish(
  file: FileText,
  attempt: Attempt,
  step: MatchStep,
  regions: Region[],
  replaceAll: boolean,
  lineMode: { oLines: string[]; nLines: string[] } | null,
): MatchPlan {
  let chosen = regions;
  if (regions.length > 1 && !replaceAll && attempt.claimedLine !== undefined) {
    const claimed = regions.filter((r) => r.line + 1 === attempt.claimedLine);
    if (claimed.length === 1) chosen = claimed;
  }
  if (chosen.length > 1 && !replaceAll) {
    return {
      kind: "ambiguous",
      step,
      preprocess: attempt.preprocess,
      lines: chosen.map((r) => r.line + 1),
    };
  }
  const selected = nonOverlapping(chosen);
  const differences = emptyDifferences(file.indentStyle);
  const edits: PlannedEdit[] = selected.map((region) => {
    if (lineMode === null) {
      return {
        start: region.start,
        end: region.end,
        replacement: fitLineEndings(attempt.newString, attempt.oldString, file.eol),
        line: region.line,
      };
    }
    const replacement = rebase(
      file,
      region as LineRegion,
      lineMode.oLines,
      lineMode.nLines,
      differences,
    );
    return { start: region.start, end: region.end, replacement, line: region.line };
  });
  differences.innerWhitespace = step === "inner-whitespace";
  let newText = "";
  let pos = 0;
  for (const edit of edits) {
    newText += file.text.slice(pos, edit.start) + edit.replacement;
    pos = edit.end;
  }
  newText += file.text.slice(pos);
  return { kind: "matched", step, preprocess: attempt.preprocess, edits, newText, differences };
}

function emptyDifferences(fileIndent: IndentStyle | null): Differences {
  return {
    trailingWhitespace: false,
    indentation: false,
    indentationConsistent: true,
    fileIndent,
    modelIndent: null,
    lookAlikes: [],
    innerWhitespace: false,
    missingFinalNewline: false,
  };
}

/** Leftmost first, skipping any that overlap one already taken. */
function nonOverlapping<T extends Region>(regions: T[]): T[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: T[] = [];
  let end = -1;
  for (const r of sorted) {
    if (r.start >= end) {
      out.push(r);
      end = Math.max(r.end, r.start + 1);
    }
  }
  return out;
}

/**
 * Every occurrence, overlapping ones included: "aa" occurs twice in "aaa". Without replace_all
 * only the count and positions for a message are needed, so the search stops early.
 */
function findExact(file: FileText, needle: string, replaceAll: boolean): Region[] {
  const out: Region[] = [];
  const cap = replaceAll ? Number.POSITIVE_INFINITY : 1000;
  let i = file.text.indexOf(needle);
  while (i !== -1 && out.length < cap) {
    out.push({ start: i, end: i + needle.length, line: file.lineAt(i) });
    i = file.text.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * The model cannot be relied on to type "\r\n", so new text takes the file's line ending,
 * unless old_string itself used "\r\n" and matched exactly.
 */
function fitLineEndings(newString: string, oldString: string, eol: LineEnding): string {
  if (oldString.includes("\r\n")) return newString;
  return newString.replace(/\r?\n/g, eol);
}

function findLineRegions(
  file: FileText,
  normFile: NormalizedLine[],
  oLines: string[],
  options: NormalizeOptions,
): LineRegion[] {
  const normOld = oLines.map((l) => normalizeLine(l, options));
  const m = oLines.length;
  const n = file.lines.length;
  const out: LineRegion[] = [];

  if (m === 1) {
    const needle = (normOld[0] as NormalizedLine).text;
    if (needle === "") return out;
    for (let i = 0; i < n; i++) {
      const f = normFile[i] as NormalizedLine;
      let idx = f.text.indexOf(needle);
      while (idx !== -1) {
        const startCol = idx === 0 && options.trimStart ? 0 : rawIndex(f, idx);
        const reachesEnd = idx + needle.length === f.text.length;
        const endCol = reachesEnd && options.trimEnd ? f.rawLength : rawEnd(f, idx + needle.length);
        out.push(lineRegion(file, i, 1, startCol, endCol, false));
        idx = f.text.indexOf(needle, idx + 1);
      }
    }
    return out;
  }

  const first = (normOld[0] as NormalizedLine).text;
  const last = (normOld[m - 1] as NormalizedLine).text;
  const lastIsEmpty = oLines[m - 1] === "";
  const fileEndsWithoutNewline = (file.lines[n - 1] as string) !== "";
  for (let i = 0; i + m - 1 <= n; i++) {
    const eof = i + m - 1 === n;
    if (eof && !(lastIsEmpty && fileEndsWithoutNewline)) break;
    const f0 = normFile[i] as NormalizedLine;
    if (!f0.text.endsWith(first)) continue;
    let inner = true;
    for (let k = 1; k < m - 1; k++) {
      if ((normFile[i + k] as NormalizedLine).text !== (normOld[k] as NormalizedLine).text) {
        inner = false;
        break;
      }
    }
    if (!inner) continue;

    let startCol: number;
    if (first === "") startCol = f0.rawLength;
    else {
      const idx = f0.text.length - first.length;
      startCol = idx === 0 && options.trimStart ? 0 : rawIndex(f0, idx);
    }
    if (eof) {
      // old_string ends with a line break; the file ends without one. Match up to the end.
      const lastLine = n - 1;
      out.push(lineRegion(file, i, m - 1, startCol, (file.lines[lastLine] as string).length, true));
      continue;
    }
    const fl = normFile[i + m - 1] as NormalizedLine;
    if (!fl.text.startsWith(last)) continue;
    let endCol: number;
    if (last === "") endCol = 0;
    else if (last.length === fl.text.length) endCol = fl.rawLength;
    else endCol = rawEnd(fl, last.length);
    out.push(lineRegion(file, i, m, startCol, endCol, false));
  }
  return out;
}

function lineRegion(
  file: FileText,
  firstLine: number,
  lineCount: number,
  startCol: number,
  endCol: number,
  eofNewline: boolean,
): LineRegion {
  const lastLine = firstLine + lineCount - 1;
  return {
    start: (file.offsets[firstLine] as number) + startCol,
    end: (file.offsets[lastLine] as number) + endCol,
    line: firstLine,
    lineCount,
    startCol,
    endCol,
    eofNewline,
  };
}

// ---------------------------------------------------------------------------------------------
// Applying the change to the file's own text
// ---------------------------------------------------------------------------------------------

interface Parts {
  indent: string;
  body: string;
  trailing: string;
}

function parts(line: string): Parts {
  const indent = leadingIndent(line);
  const rest = line.slice(indent.length);
  const trailing = /\s*$/.exec(rest)?.[0] ?? "";
  return { indent, body: rest.slice(0, rest.length - trailing.length), trailing };
}

/**
 * Builds the replacement for one region. Lines of old_string are aligned with lines of
 * new_string; lines the model kept are copied from the file, changed lines are merged onto the
 * file's line, and new lines are re-indented to the file's style.
 */
function rebase(
  file: FileText,
  region: LineRegion,
  allOld: string[],
  allNew: string[],
  differences: Differences,
): string {
  let oLines = allOld;
  let nLines = allNew;
  if (region.eofNewline) {
    oLines = allOld.slice(0, -1);
    if (nLines.length > 1 && nLines[nLines.length - 1] === "") nLines = nLines.slice(0, -1);
    differences.missingFinalNewline = true;
  }
  const m = region.lineCount;
  const fileLines: string[] = [];
  const joints: string[] = [];
  for (let k = 0; k < m; k++) {
    const line = file.lines[region.line + k] as string;
    const from = k === 0 ? region.startCol : 0;
    const to = k === m - 1 ? region.endCol : line.length;
    fileLines.push(line.slice(from, to));
    if (k < m - 1) joints.push(file.terminators[region.line + k] as string);
  }
  const partialStart = region.startCol > 0;

  const pairs: Array<[string, string]> = [];
  for (let k = 0; k < m; k++) {
    if (k === 0 && partialStart) continue;
    const f = parts(fileLines[k] as string);
    const o = parts(oLines[k] as string);
    if (f.body === "" || o.body === "") continue;
    if (
      f.trailing !== o.trailing &&
      !(k === m - 1 && region.endCol < (file.lines[region.line + k] as string).length)
    ) {
      differences.trailingWhitespace = true;
    }
    if (f.indent !== o.indent) differences.indentation = true;
    pairs.push([o.indent, f.indent]);
    for (const ch of f.body) {
      if (LOOK_ALIKES.has(ch) && !o.body.includes(ch) && !differences.lookAlikes.includes(ch)) {
        differences.lookAlikes.push(ch);
      }
    }
  }
  const modelIndent = detectIndentStyle([...oLines, ...nLines], { preferSmallUnit: true });
  const mapping = buildIndentMapping(pairs, file.indentStyle, modelIndent);
  if (differences.indentation) differences.modelIndent = modelIndent;
  // An inconsistent mapping only matters if some line's indentation came from it.
  const mapIndent = (indent: string): string => {
    if (!mapping.consistent && indent !== mapping.map(indent)) {
      differences.indentationConsistent = false;
    }
    return mapping.map(indent);
  };

  const out: Array<{ text: string; from: number | null }> = [];
  const changes = diffArrays(oLines, nLines);
  let oi = 0;
  let ni = 0;
  for (let c = 0; c < changes.length; c++) {
    const change = changes[c] as (typeof changes)[number];
    if (!change.added && !change.removed) {
      for (let j = 0; j < change.count; j++) {
        out.push({ text: fileLines[oi] as string, from: oi });
        oi++;
        ni++;
      }
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (c < changes.length) {
      const block = changes[c] as (typeof changes)[number];
      if (!block.added && !block.removed) break;
      for (let j = 0; j < block.count; j++) {
        if (block.removed) removed.push(oi++);
        else added.push(ni++);
      }
      c++;
    }
    c--;
    const pairing = pairLines(
      removed.map((k) => oLines[k] as string),
      added.map((k) => nLines[k] as string),
    );
    added.forEach((nIndex, a) => {
      const p = pairing[a] ?? -1;
      const newLine = nLines[nIndex] as string;
      if (p >= 0) {
        const k = removed[p] as number;
        out.push({
          text: mergeOneLine(
            fileLines[k] as string,
            oLines[k] as string,
            newLine,
            k === 0 && partialStart,
            mapIndent,
          ),
          from: k,
        });
      } else {
        out.push({ text: reindentNewLine(newLine, mapIndent), from: null });
      }
    });
  }

  let text = "";
  for (let l = 0; l < out.length; l++) {
    const current = out[l] as { text: string; from: number | null };
    if (l > 0) {
      const previous = out[l - 1] as { text: string; from: number | null };
      const consecutive = previous.from !== null && current.from === previous.from + 1;
      text += consecutive ? (joints[previous.from as number] as string) : file.eol;
    }
    text += current.text;
  }
  return text;
}

/** A changed line: the model's edit carried onto the file's version of the line. */
function mergeOneLine(
  fileLine: string,
  oldLine: string,
  newLine: string,
  partialStart: boolean,
  mapIndent: (indent: string) => string,
): string {
  const f = parts(fileLine);
  const o = parts(oldLine);
  const n = parts(newLine);
  const indent = n.indent === o.indent ? f.indent : partialStart ? n.indent : mapIndent(n.indent);
  const trailing = n.trailing === o.trailing ? f.trailing : n.trailing;
  let body: string;
  if (n.body === o.body) body = f.body;
  else if (f.body === o.body) body = n.body;
  else body = mergeLine(o.body, f.body, n.body) ?? n.body;
  return indent + body + trailing;
}

function reindentNewLine(line: string, mapIndent: (indent: string) => string): string {
  const n = parts(line);
  if (n.body === "" && n.trailing === "") return n.indent === "" ? "" : mapIndent(n.indent);
  return mapIndent(n.indent) + n.body + n.trailing;
}

/**
 * Pairs removed lines with added lines in one changed block, keeping order. Blocks of equal size
 * pair line for line; otherwise each added line takes the most similar removed line after the
 * previous pair, if it is similar enough.
 */
function pairLines(removed: string[], added: string[]): number[] {
  if (removed.length === added.length) return added.map((_, i) => i);
  const out = added.map(() => -1);
  let start = 0;
  for (let a = 0; a < added.length; a++) {
    let best = -1;
    let bestScore = 0.5;
    for (let r = start; r < removed.length; r++) {
      const score = similarity((removed[r] as string).trim(), (added[a] as string).trim());
      if (score > bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (best >= 0) {
      out[a] = best;
      start = best + 1;
    }
  }
  return out;
}

/** Undoes JSON-style escapes a model wrote literally: "\n", "\t", "\"" and "\\". */
export function unescapeLiterals(text: string): string {
  return text.replace(/\\([nrt"\\])/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );
}
