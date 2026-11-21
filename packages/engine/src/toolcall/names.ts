/**
 * Matching the names a model wrote against the real tool and field names.
 *
 * The rule is the same for both: a name that differs from exactly one real name only in letter
 * case or punctuation is taken as that name. Anything looser (synonyms, `read_file` for `Read`)
 * is only offered as a suggestion in the error, never applied.
 */
import type { ToolSchema } from "../contracts/model.ts";

/** Letter case and punctuation removed: `file_path`, `filePath` and `File-Path` all match. */
export function looseName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * gpt-oss addresses function tools as `functions.<name>`; when its output is parsed by something
 * other than its own template the prefix can survive into the tool name.
 */
const NAMESPACE_PREFIX = /^functions\./;

export type ToolNameMatch =
  | { found: true; tool: ToolSchema; correctedFrom: string | null }
  | { found: false; suggestion: string | null };

export function resolveToolName(name: string, tools: readonly ToolSchema[]): ToolNameMatch {
  const exact = tools.find((t) => t.name === name);
  if (exact) return { found: true, tool: exact, correctedFrom: null };

  const stripped = name.trim().replace(NAMESPACE_PREFIX, "");
  const loose = looseName(stripped);
  if (loose !== "") {
    const matches = tools.filter((t) => looseName(t.name) === loose);
    if (matches.length === 1 && matches[0]) {
      return { found: true, tool: matches[0], correctedFrom: name };
    }
  }
  return {
    found: false,
    suggestion: suggestName(
      loose,
      tools.map((t) => t.name),
    ),
  };
}

/**
 * A hint for the error text only. `read_file` contains `read`, so `Read` is suggested; the call is
 * still refused, because guessing which tool a model meant could run the wrong one.
 */
export function suggestName(loose: string, names: readonly string[]): string | null {
  if (loose.length < 3) return null;
  const hits = names.filter((n) => {
    const l = looseName(n);
    if (l.length < 3) return false;
    return loose.includes(l) || l.includes(loose) || editDistance(loose, l) <= 2;
  });
  return hits.length === 1 && hits[0] !== undefined ? hits[0] : null;
}

/** Levenshtein distance, cut off early because only small distances matter here. */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}
