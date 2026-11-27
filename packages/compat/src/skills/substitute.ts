/**
 * What a skill or command's body becomes when it runs, as Claude Code documents it
 * (code.claude.com/docs/en/skills, "Available string substitutions" and "Inject dynamic
 * context"). Pure text work: running the `!` commands and reading the `@` files is the engine's.
 *
 * - `$ARGUMENTS` is everything typed after the name; `$ARGUMENTS[N]` and its shorthand `$N` one
 *   argument (from 0, split like a shell line); `$name` a named argument from `arguments`.
 * - An indexed placeholder with no argument stays as written; a named one becomes empty.
 * - `\$` before a placeholder keeps it literal; before anything else it is left alone.
 * - When no placeholder takes an argument, the arguments are appended as `ARGUMENTS: <value>`.
 * - Argument values are inserted as they are (a `$1` inside one is not expanded), then the
 *   `${CLAUDE_*}` variables are replaced, inside inserted values too.
 * - `` !`command` `` (at the start of a line or after a blank) and a fenced block opened with
 *   ```` ```! ```` are commands whose output replaces them. Output is not scanned again.
 */
import { fencedLines, findImports } from "../instructions/markdown.ts";

/** One part of a body: text, or a command whose output takes its place. */
export type BodySegment =
  | { type: "text"; text: string }
  | {
      type: "command";
      command: string;
      /** True for a ```` ```! ```` block, false for an inline `` !`...` ``. */
      block: boolean;
    };

/** The values `${CLAUDE_*}` (and dawg's `${DAWG_*}` twins) stand for. */
export interface SkillVariables {
  /** The folder holding `SKILL.md` (or the command file). */
  skillDir: string;
  projectDir: string;
  sessionId: string;
  /** The session's effort level, or "" when the model's default applies. */
  effort: string;
}

export interface SkillArguments {
  /** Everything typed after the name, trimmed. */
  raw: string;
  /** Names from the `arguments` field, by position. */
  names: readonly string[];
}

/**
 * Splits arguments like a shell line: quotes group words (`"hello world"` is one argument) and a
 * backslash escapes the next character. An unclosed quote runs to the end.
 */
export function splitSkillArguments(raw: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < raw.length) current += raw[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < raw.length) {
      current += raw[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

const BLOCK_OPEN = /^ {0,3}(`{3,})!\s*$/;

/**
 * Splits a body into text and the commands whose output replaces them. Joining the parts with
 * each command's output in its place gives back the body's layout exactly. Inline commands
 * inside ordinary fenced code are left as text.
 */
export function parseInjections(body: string): BodySegment[] {
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  const segments: BodySegment[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") segments.push({ type: "text", text: buffer });
    buffer = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const newline = i + 1 < lines.length ? "\n" : "";
    const open = BLOCK_OPEN.exec(line);
    if (open?.[1]) {
      const fence = open[1];
      let end = i + 1;
      while (end < lines.length && (lines[end] ?? "").trim() !== fence) end++;
      if (end < lines.length) {
        flush();
        segments.push({
          type: "command",
          command: lines.slice(i + 1, end).join("\n"),
          block: true,
        });
        i = end;
        if (i + 1 < lines.length) buffer = "\n";
        continue;
      }
    }
    if (fenced[i] || !line.includes("!`")) {
      buffer += line + newline;
      continue;
    }
    const pattern = /(^|\s)!`([^`\n]+)`/g;
    let last = 0;
    for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
      const start = match.index + (match[1]?.length ?? 0);
      buffer += line.slice(last, start);
      flush();
      segments.push({ type: "command", command: (match[2] ?? "").trim(), block: false });
      last = start + match[0].length - (match[1]?.length ?? 0);
    }
    buffer += line.slice(last) + newline;
  }
  flush();
  return segments;
}

/**
 * Replaces the argument placeholders in one piece of text. `used` is true when a placeholder
 * took an argument, so the caller knows whether to append them.
 */
export function substituteArguments(
  text: string,
  args: SkillArguments,
): { text: string; used: boolean } {
  const words = splitSkillArguments(args.raw);
  const names = new Set(args.names);
  let used = false;
  const pattern = /(\\?)\$(?:ARGUMENTS\[(\d+)\]|(ARGUMENTS)\b|(\d+)|([A-Za-z_][A-Za-z0-9_]*))/g;
  const out = text.replace(
    pattern,
    (whole, backslash: string, indexed?: string, all?: string, digits?: string, name?: string) => {
      const placeholder = whole.slice(backslash.length);
      const isPlaceholder =
        indexed !== undefined || all !== undefined || digits !== undefined || names.has(name ?? "");
      if (!isPlaceholder) return whole;
      // `\$1.00`: a literal dollar.
      if (backslash !== "") return placeholder;
      if (all !== undefined) {
        used = true;
        return args.raw;
      }
      const index = indexed ?? digits;
      if (index !== undefined) {
        const value = words[Number(index)];
        if (value === undefined) return whole;
        used = true;
        return value;
      }
      const position = args.names.indexOf(name ?? "");
      const value = words[position];
      if (value !== undefined) used = true;
      return value ?? "";
    },
  );
  return { text: out, used };
}

/** Replaces `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}` and their `DAWG_` twins. */
export function substituteVariables(text: string, vars: SkillVariables): string {
  const values: Record<string, string> = {
    SKILL_DIR: vars.skillDir,
    PROJECT_DIR: vars.projectDir,
    SESSION_ID: vars.sessionId,
    EFFORT: vars.effort,
  };
  return text.replace(
    /\$\{(?:CLAUDE|DAWG)_([A-Z_]+)\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
}

export interface ExpandedBody {
  /** The body's parts with placeholders and variables replaced; commands not yet run. */
  segments: BodySegment[];
  /** `ARGUMENTS: <value>` to append when no placeholder took the arguments; null otherwise. */
  appendix: string | null;
}

/** Substitutes a whole body, part by part, so text inserted from arguments is never run. */
export function expandSkillBody(
  body: string,
  args: SkillArguments,
  vars: SkillVariables,
): ExpandedBody {
  let used = false;
  const segments = parseInjections(body).map((segment): BodySegment => {
    const source = segment.type === "text" ? segment.text : segment.command;
    const substituted = substituteArguments(source, args);
    if (substituted.used) used = true;
    const text = substituteVariables(substituted.text, vars);
    return segment.type === "text" ? { type: "text", text } : { ...segment, command: text };
  });
  const raw = args.raw.trim();
  return { segments, appendix: raw !== "" && !used ? `ARGUMENTS: ${raw}` : null };
}

/**
 * The files a rendered text names with `@path` (outside code), as the person's prompt does:
 * the `@` starts a word, the path runs to the next blank. As written; the caller resolves them.
 */
export function fileReferences(text: string): string[] {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    for (const token of findImports(line)) {
      const path = token.path.replace(/[.,;:!?)\]]+$/, "");
      if (path !== "" && !out.includes(path)) out.push(path);
    }
  });
  return out;
}
