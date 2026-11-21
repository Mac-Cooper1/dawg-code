/**
 * Indentation: how a file indents (tabs, or so many spaces per level), and how to carry the
 * model's indentation over to the file's when the two differ.
 */

export interface IndentStyle {
  kind: "tab" | "space";
  /** Spaces per level for "space"; 1 for "tab". */
  unit: number;
}

/** Leading spaces and tabs. */
export function leadingIndent(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(0, i);
}

/**
 * Guesses the indentation style of some lines: tabs if more lines start with a tab than with
 * spaces; otherwise spaces, with the most common step between neighbouring indents as the unit.
 */
export function detectIndentStyle(
  lines: readonly string[],
  options: { preferSmallUnit?: boolean } = {},
): IndentStyle | null {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = leadingIndent(line);
    if (indent.startsWith("\t")) {
      tabs++;
      continue;
    }
    if (indent.length > 0) spaces++;
    const width = indent.length;
    const step = Math.abs(width - previous);
    if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabs === 0 && spaces === 0) return null;
  if (tabs > spaces) return { kind: "tab", unit: 1 };
  let unit = 0;
  let best = 0;
  for (const [step, count] of steps) {
    if (step > 8) continue;
    if (count > best || (count === best && step < unit)) {
      unit = step;
      best = count;
    }
  }
  if (unit === 0) unit = 4;
  // A short snippet may show only one deep level ("        x"); models indent by 4 or 2.
  if (options.preferSmallUnit && unit > 4) unit = unit % 4 === 0 ? 4 : unit % 2 === 0 ? 2 : unit;
  return { kind: "space", unit };
}

interface Level {
  level: number;
  /** Spaces left over after whole levels, kept for alignment. */
  remainder: number;
}

function levelOf(indent: string, style: IndentStyle): Level {
  if (style.kind === "tab") {
    let tabs = 0;
    while (tabs < indent.length && indent[tabs] === "\t") tabs++;
    return { level: tabs, remainder: indent.length - tabs };
  }
  let width = 0;
  for (const ch of indent) width += ch === "\t" ? style.unit : 1;
  return { level: Math.floor(width / style.unit), remainder: width % style.unit };
}

function render(level: number, remainder: number, style: IndentStyle): string {
  const base = style.kind === "tab" ? "\t".repeat(level) : " ".repeat(level * style.unit);
  return base + " ".repeat(remainder);
}

export interface IndentMapping {
  /** Converts an indent written by the model to the file's indentation. */
  map(modelIndent: string): string;
  /** How the mapping was found, for notes and tests. */
  kind: "same" | "prefix-added" | "prefix-removed" | "levels";
  /** False when the pairs disagree with each other, so the mapping is a best guess. */
  consistent: boolean;
}

/**
 * Builds the mapping from pairs of (model indent, file indent) for lines that matched. The
 * simplest explanation that fits every pair wins: no change; a constant prefix the model left
 * out or added; or a change of unit (tabs for spaces, two spaces for four) with a shift in level.
 */
export function buildIndentMapping(
  pairs: ReadonlyArray<readonly [string, string]>,
  fileStyle: IndentStyle | null,
  modelStyle: IndentStyle | null,
): IndentMapping {
  if (pairs.every(([m, f]) => m === f)) {
    return { map: (indent) => indent, kind: "same", consistent: true };
  }
  const fStyle = fileStyle ?? { kind: "space", unit: 4 };
  const mStyle = modelStyle ?? fStyle;
  // A different unit (tabs for spaces, two spaces for four) needs levels; a constant prefix
  // would leave new lines in the model's unit.
  const unitsDiffer =
    fileStyle !== null &&
    modelStyle !== null &&
    (fileStyle.kind !== modelStyle.kind || fileStyle.unit !== modelStyle.unit);
  const added = unitsDiffer ? null : constantPrefix(pairs);
  if (added !== null) {
    return { map: (indent) => added + indent, kind: "prefix-added", consistent: true };
  }
  const removed = unitsDiffer ? null : constantPrefix(pairs.map(([m, f]) => [f, m] as const));

  const deltas = new Map<number, number>();
  for (const [m, f] of pairs) {
    const delta = levelOf(f, fStyle).level - levelOf(m, mStyle).level;
    deltas.set(delta, (deltas.get(delta) ?? 0) + 1);
  }
  let delta = 0;
  let best = -1;
  for (const [d, count] of deltas) {
    if (count > best || (count === best && Math.abs(d) < Math.abs(delta))) {
      delta = d;
      best = count;
    }
  }
  const byLevels = (indent: string): string => {
    const { level, remainder } = levelOf(indent, mStyle);
    return render(Math.max(0, level + delta), remainder, fStyle);
  };
  if (removed !== null) {
    return {
      map: (indent) =>
        indent.startsWith(removed) ? indent.slice(removed.length) : byLevels(indent),
      kind: "prefix-removed",
      consistent: true,
    };
  }
  const consistent = pairs.every(([m, f]) => byLevels(m) === f);
  return { map: byLevels, kind: "levels", consistent };
}

/** The prefix P with `long === P + short` for every pair, or null if there is none. */
function constantPrefix(pairs: ReadonlyArray<readonly [string, string]>): string | null {
  let prefix: string | null = null;
  for (const [short, long] of pairs) {
    if (!long.endsWith(short)) return null;
    const p = long.slice(0, long.length - short.length);
    if (prefix === null) prefix = p;
    else if (prefix !== p) return null;
  }
  return prefix === null || prefix === "" ? null : prefix;
}

export function describeIndentStyle(style: IndentStyle | null): string {
  if (style === null) return "no indentation";
  if (style.kind === "tab") return "tabs";
  return `${style.unit} spaces per level`;
}
