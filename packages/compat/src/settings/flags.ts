import type { PermissionMode } from "@dawg/protocol";

/**
 * Settings given on the command line, already split into values. Mirrors the documented flags:
 * `--allowedTools`, `--disallowedTools`, `--permission-mode` (and `--dangerously-skip-permissions`,
 * which the caller maps to `bypassPermissions`), `--add-dir`, plus environment variables.
 */
export interface SettingsFlags {
  /** Allow rules, one per entry. Use `parseRuleList` to turn raw flag values into these. */
  allowedTools?: readonly string[];
  /** Deny rules, one per entry. */
  disallowedTools?: readonly string[];
  permissionMode?: PermissionMode;
  /** Extra working directories, resolved against the project directory, `~` expanded. */
  addDirs?: readonly string[];
  env?: Readonly<Record<string, string>>;
  /** Added (Phase 4, sandbox): `--sandbox`, which turns the sandbox on for the session. */
  sandbox?: boolean;
}

function isSeparator(ch: string): boolean {
  return ch === "," || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Splits the values of a rule-list flag such as `--allowedTools` into single rules.
 *
 * The documented form passes each rule as its own shell word, quoted when it holds spaces:
 * `--allowedTools "Bash(git log *)" "Bash(git diff *)" Read`. A value may also hold several rules
 * separated by commas or spaces, as in `"Bash,Edit,Read"`. Separators only count outside the
 * brackets of `Tool(specifier)`, so a specifier keeps its spaces, commas and nested brackets
 * intact. A value whose brackets never close is kept whole rather than guessed at. Duplicates
 * are dropped, first occurrence kept.
 */
export function parseRuleList(values: string | readonly string[]): string[] {
  const list = typeof values === "string" ? [values] : values;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (rule: string) => {
    const trimmed = rule.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };

  for (const value of list) {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of value) {
      if (ch === "(") depth++;
      else if (ch === ")" && depth > 0) depth--;
      if (depth === 0 && isSeparator(ch)) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (depth > 0) {
      // Unbalanced: splitting would cut a specifier in an arbitrary place.
      push(value);
      continue;
    }
    parts.push(current);
    for (const part of parts) push(part);
  }
  return out;
}
