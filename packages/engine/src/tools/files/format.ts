/**
 * How file text is shown to the model. `Read` output and the snippets `Edit` returns use the same
 * line format, so the model learns one shape.
 */

/** Separates the line number from the line's text in numbered output. */
export const LINE_NUMBER_SEPARATOR = "→";

export interface NumberedLines {
  text: string;
  /** How many lines were longer than the limit and were cut. */
  cut: number;
}

/**
 * Formats lines as `<number>→<text>`, numbers right-aligned to the widest one shown. Lines
 * longer than `maxLineChars` are cut, with a marker saying how long they really are.
 */
export function formatNumberedLines(
  lines: readonly string[],
  firstLineNumber: number,
  maxLineChars: number,
): NumberedLines {
  const width = String(firstLineNumber + Math.max(lines.length - 1, 0)).length;
  let cut = 0;
  const out = lines.map((line, i) => {
    const shown = cutLine(line, maxLineChars);
    if (shown !== line) cut++;
    return `${String(firstLineNumber + i).padStart(width)}${LINE_NUMBER_SEPARATOR}${shown}`;
  });
  return { text: out.join("\n"), cut };
}

export function cutLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return cutLineFromPrefix(line.slice(0, maxChars), line.length);
}

/** Like `cutLine`, given only the first characters of the line and its full length. */
export function cutLineFromPrefix(prefix: string, fullLength: number): string {
  let end = prefix.length;
  // Do not split a surrogate pair.
  const code = prefix.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${prefix.slice(0, end)}… [line cut: ${fullLength} characters in total]`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Lists numbers as "3, 10 and 22", keeping at most `max` of them. */
export function listNumbers(values: readonly number[], max = 10): string {
  const shown = values.slice(0, max).map(String);
  const rest = values.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** "1 line", "3 lines" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
