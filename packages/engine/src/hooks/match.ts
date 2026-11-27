/**
 * Matchers, as the hooks reference documents them (code.claude.com/docs/en/hooks, "Matcher
 * patterns"):
 *
 * | Matcher                                              | Evaluation                           |
 * | ---------------------------------------------------- | ------------------------------------ |
 * | "*", "" or omitted                                   | matches everything                   |
 * | only letters, digits, _, -, space, "," and "\|"       | exact names, listed with "\|" or "," |
 * | anything else                                        | a JavaScript regex, unanchored       |
 *
 * Events without matcher support always fire, whatever the matcher says.
 */
import { EVENTS_WITHOUT_MATCHER } from "@dawg/compat";

const EXACT_LIST = /^[A-Za-z0-9_\-, |]*$/;

/** A matcher that is not a valid regex never matches (as a broken rule should not fire). */
const compiled = new Map<string, RegExp | null>();

function regexFor(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern) ?? null;
  let re: RegExp | null;
  try {
    re = new RegExp(pattern);
  } catch {
    re = null;
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

/** Whether a group's matcher selects `value` (a tool name, a session source, a notification type). */
export function matcherMatches(event: string, matcher: string | null, value: string): boolean {
  if (EVENTS_WITHOUT_MATCHER.has(event)) return true;
  if (matcher === null) return true;
  const trimmed = matcher.trim();
  if (trimmed === "" || trimmed === "*") return true;
  if (EXACT_LIST.test(trimmed)) {
    return trimmed
      .split(/[|,]/)
      .map((name) => name.trim())
      .some((name) => name !== "" && name === value);
  }
  const re = regexFor(matcher);
  return re?.test(value) === true;
}
