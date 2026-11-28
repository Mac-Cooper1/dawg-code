/**
 * The front matter of a skill or command file, read as Claude Code documents it
 * (code.claude.com/docs/en/skills, "Frontmatter reference"): YAML between `---` lines starting
 * on the first line; booleans written as true/false, yes/no, on/off or 1/0 in any case; lists
 * as YAML lists or space- or comma-separated strings. Unknown keys are ignored there; here they
 * are also named in a note, since the report accounts for everything (principle 2).
 */
import { parse as parseYaml } from "yaml";
import { splitFrontMatter } from "../instructions/markdown.ts";

/** Every key the documentation lists, and whether a command file may use it. */
export const SKILL_KEYS = [
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
  "metadata",
  "license",
  "compatibility",
] as const;

/** Documented for skills only: "a command file accepts the same fields except name and paths". */
export const SKILL_ONLY_KEYS: ReadonlySet<string> = new Set(["name", "paths"]);

export interface ParsedFrontMatter {
  /** The fields, by key. Empty when there is no front matter or it could not be read. */
  fields: Record<string, unknown>;
  /** The text after the front matter. */
  body: string;
  /** Set when there was front matter that could not be read at all; the skill then loads with no fields, as documented. */
  error: string | null;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n")[0] ?? text).trim().replace(/\.$/, "");
}

/** Characters that start a YAML value which is not a plain scalar. */
const STRUCTURED = /^["'[{|>&*!]/;

/**
 * The raw text of each top-level `key: value` line, for values YAML would misread: an
 * `argument-hint` such as `[issue-number]` (a YAML list) or `[file] [format]` (an error), both
 * documented examples, and descriptions with a colon in them.
 */
function rawValues(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (match?.[1] && match[2] !== undefined && match[2] !== "") out.set(match[1], match[2]);
  }
  return out;
}

/**
 * The same YAML with some top-level one-line values quoted, so they read as text: those of
 * `textKeys` whatever they look like (unless already quoted), and with `allPlain` every value
 * that is not already YAML structure, so stray colons read as text too.
 */
function quoteValues(yaml: string, textKeys: ReadonlySet<string>, allPlain: boolean): string {
  return yaml
    .split("\n")
    .map((line) => {
      const match = /^([A-Za-z_][\w-]*):[ \t]+(.+?)[ \t]*$/.exec(line);
      if (!match?.[1] || match[2] === undefined) return line;
      const [key, value] = [match[1], match[2]];
      if (/^["']/.test(value)) return line;
      const quote = textKeys.has(key) || (allPlain && !STRUCTURED.test(value));
      return quote ? `${key}: ${JSON.stringify(value)}` : line;
    })
    .join("\n");
}

function asMapping(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

/** Keys whose value is display text, read as written whatever YAML makes of it. */
const TEXT_KEYS: ReadonlySet<string> = new Set(["argument-hint"]);

/**
 * Splits a file's text into front matter fields and body. Expects normalised line endings.
 * Never throws: front matter that cannot be read gives no fields and an `error`.
 */
export function parseSkillFrontMatter(text: string): ParsedFrontMatter {
  const { yaml, body } = splitFrontMatter(text);
  if (yaml === null) return { fields: {}, body, error: null };
  const raw = rawValues(yaml);
  let fields: Record<string, unknown> | null = null;
  let firstError: string | null = null;
  try {
    fields = asMapping(parseYaml(quoteValues(yaml, TEXT_KEYS, false)));
    if (fields === null) firstError = "it is not a list of fields";
  } catch (error) {
    firstError = describeError(error);
  }
  if (fields === null) {
    // Often a description with a colon in it: read each plain one-line value as text.
    try {
      fields = asMapping(parseYaml(quoteValues(yaml, TEXT_KEYS, true)));
    } catch {
      fields = null;
    }
  }
  if (fields === null) {
    return { fields: {}, body, error: `The front matter is not valid YAML (${firstError})` };
  }
  for (const key of TEXT_KEYS) {
    const written = raw.get(key);
    if (written !== undefined && typeof fields[key] !== "string") fields[key] = unquote(written);
  }
  return { fields, body, error: null };
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}

/** A field as one trimmed string, or null when absent, empty or not text. */
export function textField(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A documented boolean: true/false, yes/no, on/off or 1/0 in any case. Null when absent;
 * `undefined` when present but none of those (the caller notes it and keeps the default).
 */
export function booleanField(
  fields: Record<string, unknown>,
  key: string,
): boolean | null | undefined {
  if (!(key in fields) || fields[key] === null) return null;
  const value = fields[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(word)) return true;
    if (["false", "no", "off", "0"].includes(word)) return false;
  }
  return undefined;
}

/**
 * A list field: a YAML list, or a string of items separated by spaces or commas. A separator
 * inside brackets belongs to the item, so `Bash(git add *)` stays one rule.
 */
export function listField(fields: Record<string, unknown>, key: string): string[] {
  const value = fields[key];
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" || typeof item === "number")
      .map((item) => String(item).trim())
      .filter((item) => item !== "");
  }
  if (typeof value !== "string") return [];
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth--;
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}
