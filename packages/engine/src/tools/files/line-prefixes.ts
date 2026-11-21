/**
 * Recognises text copied from `Read` output together with its line-number prefixes ("12→foo",
 * or "12<tab>foo" as `cat -n` prints). Models do this often; the prefixes are never file content.
 */
import { LINE_NUMBER_SEPARATOR } from "./format.ts";

export interface StrippedPrefixes {
  text: string;
  /** The line number on the first line. */
  firstNumber: number;
  separator: string;
}

const SEPARATORS = [LINE_NUMBER_SEPARATOR, "\t"];

/**
 * Removes the prefixes when every line carries one and the numbers count up by one. A single
 * line counts only with our own separator; a tab after a number is too common in real data.
 */
export function stripLineNumberPrefixes(
  text: string,
  separators: readonly string[] = SEPARATORS,
): StrippedPrefixes | null {
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  for (const separator of separators) {
    if (separator !== LINE_NUMBER_SEPARATOR && lines.length < 2) continue;
    const pattern = new RegExp(`^ *(\\d+)${escapeRegExp(separator)}(.*)$`, "s");
    const stripped: string[] = [];
    let first = -1;
    let ok = lines.length > 0;
    for (const [i, line] of lines.entries()) {
      const m = pattern.exec(line);
      if (m === null || (i > 0 && Number(m[1]) !== first + i)) {
        ok = false;
        break;
      }
      if (i === 0) first = Number(m[1]);
      stripped.push(m[2] ?? "");
    }
    if (ok) {
      return {
        text: stripped.join("\n") + (trailingNewline ? "\n" : ""),
        firstNumber: first,
        separator,
      };
    }
  }
  return null;
}

/** Removes a prefix with `separator` from each line that has one, leaving other lines alone. */
export function stripPrefixesWhereFound(text: string, separator: string): string {
  const pattern = new RegExp(`^ *\\d+${escapeRegExp(separator)}`);
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(pattern, ""))
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
