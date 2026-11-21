/**
 * A JSON parser that can also accept the specific mistakes local models make in tool-call
 * arguments, and reports which ones it accepted.
 *
 * It is a hand-written recursive-descent parser rather than a pre-pass in front of `JSON.parse`,
 * because the safety rule needs to know *where* the text stopped: a call cut off inside a string,
 * number or key must be refused, while one that only lacks its closing braces after a complete
 * value may be closed. Pattern-based fixers cannot tell those apart.
 */
import { describeValueKind, isPlainObject, sameJson, setOwn } from "./values.ts";

/** A repair the parser applied to make the text usable. */
export type RepairKind =
  /** Empty text (or `null`) taken as no arguments. */
  | "empty_arguments"
  /** Markdown code fences around the object removed. */
  | "code_fence"
  /** Prose before or after the object removed. */
  | "surrounding_text"
  /** The whole object had been sent as a JSON string, and was decoded. */
  | "double_encoded"
  /** A comma before a closing `}` or `]` removed. */
  | "trailing_comma"
  /** Closing `}` or `]` added at the end, right after a complete value. */
  | "missing_closer"
  /** Surplus closing `}` or `]` after the object removed. */
  | "extra_closer"
  /** Single-quoted strings or keys read as strings. */
  | "single_quotes"
  /** Python's `True`, `False` and `None` read as `true`, `false` and `null`. */
  | "python_literals"
  /** Bare identifier keys (`{file_path: ...}`) read as strings. */
  | "unquoted_keys"
  /** Raw newlines, tabs or other control characters inside a string kept as they are. */
  | "control_characters"
  /** `\'` read as `'`; any other unknown escape kept as a literal backslash. */
  | "invalid_escape";

export type ParseFailureKind =
  /** The text stops part-way: inside a string, number or key, or right after `{`, `,` or `:`. */
  | "truncated"
  /** Not JSON, and not one of the mistakes that can safely be repaired. */
  | "syntax"
  /** Valid, but not an object. */
  | "not_object"
  /** More than one top-level object, usually two calls run together. */
  | "multiple_objects"
  /** The same field twice with different values. */
  | "duplicate_key";

export interface ParseFailure {
  kind: ParseFailureKind;
  /** A short clause for the model, such as `it ends in the middle of a string`. */
  detail: string;
  /** The text around the problem, when there is a position to show. */
  near: string | null;
}

export type ArgumentsParse =
  | {
      ok: true;
      value: Record<string, unknown>;
      /** True when any repair was needed. */
      repaired: boolean;
      /** The repairs applied, in a fixed order. Empty when `repaired` is false. */
      repairs: RepairKind[];
    }
  | { ok: false; failure: ParseFailure };

export interface ParseMode {
  /** Accept the repairable mistakes listed in `RepairKind`, other than closers. */
  readonly tolerant: boolean;
  /** Close containers still open at the end of the text, but only right after a complete value. */
  readonly closers: boolean;
}

export const STRICT: ParseMode = { tolerant: false, closers: false };
export const TOLERANT: ParseMode = { tolerant: true, closers: true };
/** For text known to be complete, such as JSON held inside a string that was properly closed. */
export const TOLERANT_NO_CLOSERS: ParseMode = { tolerant: true, closers: false };

const REPAIR_ORDER: readonly RepairKind[] = [
  "empty_arguments",
  "code_fence",
  "surrounding_text",
  "double_encoded",
  "trailing_comma",
  "missing_closer",
  "extra_closer",
  "single_quotes",
  "python_literals",
  "unquoted_keys",
  "control_characters",
  "invalid_escape",
];

export function sortRepairs(repairs: Iterable<RepairKind>): RepairKind[] {
  const set = new Set(repairs);
  return REPAIR_ORDER.filter((r) => set.has(r));
}

/** Deeper than any real tool input; keeps hostile input from overflowing the stack. */
const MAX_DEPTH = 200;

type StopKind = "truncated" | "syntax" | "duplicate_key";

/**
 * Thrown inside the parser to unwind to the top, and always caught there. Deliberately not an
 * `Error`: capturing a stack trace for every failed attempt made scanning a long, repetitive reply
 * measurably slow, and the trace is never used.
 */
class Stop {
  readonly kind: StopKind;
  readonly position: number;
  readonly message: string;
  constructor(kind: StopKind, position: number, detail: string) {
    this.kind = kind;
    this.position = position;
    this.message = detail;
  }
}

const WORDS: ReadonlyMap<string, { value: unknown; python: boolean }> = new Map([
  ["true", { value: true, python: false }],
  ["false", { value: false, python: false }],
  ["null", { value: null, python: false }],
  ["True", { value: true, python: true }],
  ["False", { value: false, python: true }],
  ["None", { value: null, python: true }],
]);

function isWs(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z_$]$/.test(c);
}

function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z0-9_$]$/.test(c);
}

class Parser {
  readonly text: string;
  readonly mode: ParseMode;
  readonly repairs = new Set<RepairKind>();
  pos = 0;
  /** Open containers. A number at the end of the text is only complete at the top level. */
  open = 0;

  constructor(text: string, mode: ParseMode) {
    this.text = text;
    this.mode = mode;
  }

  get eof(): boolean {
    return this.pos >= this.text.length;
  }

  peek(): string | undefined {
    return this.text[this.pos];
  }

  skipWs(): void {
    while (isWs(this.text[this.pos])) this.pos++;
  }

  truncated(detail: string): Stop {
    return new Stop("truncated", this.pos, detail);
  }

  syntax(detail: string, position = this.pos): Stop {
    return new Stop("syntax", position, detail);
  }

  unexpected(): Stop {
    return this.syntax(`unexpected character ${JSON.stringify(this.peek() ?? "")}`);
  }

  parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw this.syntax("the value is nested too deeply");
    this.skipWs();
    const c = this.peek();
    if (c === undefined) throw this.truncated("it ends where a value should start");
    if (c === "{" || c === "[") {
      this.open++;
      const v = c === "{" ? this.parseObject(depth + 1) : this.parseArray(depth + 1);
      this.open--;
      return v;
    }
    if (c === '"') return this.parseString('"');
    if (c === "'") {
      if (!this.mode.tolerant) throw this.unexpected();
      this.repairs.add("single_quotes");
      return this.parseString("'");
    }
    if (c === "-" || isDigit(c)) return this.parseNumber();
    if (isIdentStart(c)) return this.parseWord();
    throw this.unexpected();
  }

  parseObject(depth: number): Record<string, unknown> {
    this.pos++; // {
    const obj: Record<string, unknown> = {};
    this.skipWs();
    if (this.eof) throw this.truncated("it ends right after an opening {");
    if (this.peek() === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      const keyStart = this.pos;
      const key = this.parseKey();
      this.skipWs();
      if (this.eof) throw this.truncated("it ends right after a field name");
      if (this.peek() !== ":") throw this.syntax('expected ":" after a field name');
      this.pos++;
      this.skipWs();
      if (this.eof) throw this.truncated('it ends right after a ":"');
      const value = this.parseValue(depth);
      if (Object.hasOwn(obj, key)) {
        if (!sameJson(obj[key], value)) {
          throw new Stop(
            "duplicate_key",
            keyStart,
            `the field ${JSON.stringify(key)} appears more than once with different values`,
          );
        }
      } else {
        setOwn(obj, key, value);
      }
      this.skipWs();
      if (this.eof) {
        if (!this.mode.closers) throw this.truncated("it ends before the closing }");
        this.repairs.add("missing_closer");
        return obj;
      }
      const c = this.peek();
      if (c === "}") {
        this.pos++;
        return obj;
      }
      if (c !== ",") throw this.syntax('expected "," or "}" after a value');
      this.pos++;
      this.skipWs();
      if (this.eof) throw this.truncated('it ends right after a ","');
      if (this.peek() === "}") {
        if (!this.mode.tolerant) throw this.syntax('unexpected "," before "}"');
        this.repairs.add("trailing_comma");
        this.pos++;
        return obj;
      }
    }
  }

  parseArray(depth: number): unknown[] {
    this.pos++; // [
    const arr: unknown[] = [];
    this.skipWs();
    if (this.eof) throw this.truncated("it ends right after an opening [");
    if (this.peek() === "]") {
      this.pos++;
      return arr;
    }
    for (;;) {
      arr.push(this.parseValue(depth));
      this.skipWs();
      if (this.eof) {
        if (!this.mode.closers) throw this.truncated("it ends before the closing ]");
        this.repairs.add("missing_closer");
        return arr;
      }
      const c = this.peek();
      if (c === "]") {
        this.pos++;
        return arr;
      }
      if (c !== ",") throw this.syntax('expected "," or "]" after a value');
      this.pos++;
      this.skipWs();
      if (this.eof) throw this.truncated('it ends right after a ","');
      if (this.peek() === "]") {
        if (!this.mode.tolerant) throw this.syntax('unexpected "," before "]"');
        this.repairs.add("trailing_comma");
        this.pos++;
        return arr;
      }
    }
  }

  parseKey(): string {
    const c = this.peek();
    if (c === '"') return this.parseString('"');
    if (c === "'" && this.mode.tolerant) {
      this.repairs.add("single_quotes");
      return this.parseString("'");
    }
    if (isIdentStart(c) && this.mode.tolerant) {
      const start = this.pos;
      while (isIdentPart(this.peek())) this.pos++;
      if (this.eof) throw this.truncated("it ends in the middle of a field name");
      this.repairs.add("unquoted_keys");
      return this.text.slice(start, this.pos);
    }
    throw this.syntax("expected a field name in double quotes");
  }

  parseString(quote: '"' | "'"): string {
    const text = this.text;
    this.pos++; // opening quote
    let out = "";
    let runStart = this.pos;
    for (;;) {
      if (this.pos >= text.length) throw this.truncated("it ends in the middle of a string");
      const c = text.charCodeAt(this.pos);
      if (c === quote.charCodeAt(0)) {
        out += text.slice(runStart, this.pos);
        this.pos++;
        return out;
      }
      if (c === 0x5c) {
        out += text.slice(runStart, this.pos);
        out += this.parseEscape(quote);
        runStart = this.pos;
        continue;
      }
      if (c < 0x20) {
        if (!this.mode.tolerant) {
          throw this.syntax("a raw control character (such as a newline) is inside a string");
        }
        this.repairs.add("control_characters");
      }
      this.pos++;
    }
  }

  /** Called with `pos` on the backslash; leaves `pos` after the escape. */
  parseEscape(quote: '"' | "'"): string {
    const text = this.text;
    const start = this.pos;
    this.pos++;
    if (this.pos >= text.length) {
      throw this.truncated("it ends in the middle of an escape sequence");
    }
    const e = text[this.pos] as string;
    this.pos++;
    switch (e) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = text.slice(this.pos, this.pos + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.pos += 4;
          return String.fromCharCode(Number.parseInt(hex, 16));
        }
        if (/^[0-9a-fA-F]*$/.test(hex) && this.pos + hex.length >= text.length) {
          throw this.truncated("it ends in the middle of an escape sequence");
        }
        return this.literalBackslash(start, e);
      }
      case "'":
        if (quote === "'") return "'";
        if (!this.mode.tolerant) throw this.syntax("invalid escape \\' in a string", start);
        this.repairs.add("invalid_escape");
        return "'";
      default:
        return this.literalBackslash(start, e);
    }
  }

  /**
   * An escape JSON does not have. Most often a regular expression (`\d`) or a Windows path
   * (`C:\Users`): the backslash was meant literally, so it is kept and the next character is read
   * again as ordinary text.
   */
  literalBackslash(start: number, e: string): string {
    if (!this.mode.tolerant) {
      throw this.syntax(`invalid escape ${JSON.stringify(`\\${e}`)} in a string`, start);
    }
    this.repairs.add("invalid_escape");
    this.pos = start + 1;
    return "\\";
  }

  parseNumber(): number {
    const text = this.text;
    const start = this.pos;
    const cut = () => this.truncated("it ends in the middle of a number");
    if (text[this.pos] === "-") this.pos++;
    if (this.pos >= text.length) throw cut();
    if (text[this.pos] === "0") {
      this.pos++;
    } else if (isDigit(text[this.pos])) {
      while (isDigit(text[this.pos])) this.pos++;
    } else {
      throw this.unexpected();
    }
    if (text[this.pos] === ".") {
      this.pos++;
      if (this.pos >= text.length) throw cut();
      if (!isDigit(text[this.pos])) throw this.unexpected();
      while (isDigit(text[this.pos])) this.pos++;
    }
    if (text[this.pos] === "e" || text[this.pos] === "E") {
      this.pos++;
      if (text[this.pos] === "+" || text[this.pos] === "-") this.pos++;
      if (this.pos >= text.length) throw cut();
      if (!isDigit(text[this.pos])) throw this.unexpected();
      while (isDigit(text[this.pos])) this.pos++;
    }
    // Inside an object or array, a number that runs to the very end may have been cut short
    // ("10" of "100"). A complete object never ends with a number, so this refuses nothing valid.
    if (this.pos >= text.length && this.open > 0) throw cut();
    const value = Number(text.slice(start, this.pos));
    if (!Number.isFinite(value)) throw this.syntax("a number is too large", start);
    return value;
  }

  parseWord(): unknown {
    const text = this.text;
    const start = this.pos;
    while (isIdentPart(text[this.pos])) this.pos++;
    const word = text.slice(start, this.pos);
    const known = WORDS.get(word);
    if (known === undefined) {
      if (this.pos >= text.length && [...WORDS.keys()].some((w) => w.startsWith(word))) {
        throw this.truncated("it ends in the middle of a value");
      }
      throw this.syntax(`unexpected word ${JSON.stringify(word)}`, start);
    }
    if (known.python) {
      if (!this.mode.tolerant) throw this.syntax(`unexpected word ${JSON.stringify(word)}`, start);
      this.repairs.add("python_literals");
    }
    return known.value;
  }
}

export type ValueFailure = { ok: false; kind: StopKind; detail: string; position: number };

export type ValueParse = { ok: true; value: unknown; repairs: Set<RepairKind> } | ValueFailure;

/** Parses `text` as exactly one JSON value (surrounding whitespace allowed). Never throws. */
export function parseJsonValue(text: string, mode: ParseMode): ValueParse {
  const p = new Parser(text, mode);
  try {
    const value = p.parseValue(0);
    p.skipWs();
    if (!p.eof) {
      return {
        ok: false,
        kind: "syntax",
        detail: "unexpected text after the JSON value",
        position: p.pos,
      };
    }
    return { ok: true, value, repairs: p.repairs };
  } catch (err) {
    return stopToFailure(err);
  }
}

export type PrefixParse =
  | { ok: true; value: unknown; end: number; repairs: Set<RepairKind> }
  | ValueFailure;

/**
 * Parses one JSON value starting at `start` and stops right after it, leaving whatever follows.
 * Never throws.
 */
export function parseJsonPrefix(text: string, start: number, mode: ParseMode): PrefixParse {
  const p = new Parser(text, mode);
  p.pos = start;
  try {
    const value = p.parseValue(0);
    return { ok: true, value, end: p.pos, repairs: p.repairs };
  } catch (err) {
    return stopToFailure(err);
  }
}

function stopToFailure(err: unknown): ValueFailure {
  if (err instanceof Stop) {
    return { ok: false, kind: err.kind, detail: err.message, position: err.position };
  }
  // Only a bug could get here (the depth guard keeps the stack bounded), but parsing must never
  // throw, so report it as unreadable.
  return { ok: false, kind: "syntax", detail: "the text could not be read as JSON", position: 0 };
}

/**
 * The text around `position`, on one line, for showing the model where its JSON went wrong. Only
 * line breaks and tabs are escaped: escaping quotes too would make JSON unreadable.
 */
export function snippetAround(text: string, position: number): string {
  const from = Math.max(0, position - 24);
  const to = Math.min(text.length, position + 24);
  const body = text
    .slice(from, to)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

function toFailure(text: string, f: ValueFailure): ParseFailure {
  return { kind: f.kind, detail: f.detail, near: snippetAround(text, f.position) };
}

const FENCE_LINES = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
const HAS_FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/m;

/**
 * Parses tool-call arguments: strict JSON first, then with the tolerated repairs, then a single
 * object taken out of surrounding prose or code fences. Never throws, for any input.
 */
export function parseToolArguments(text: string): ArgumentsParse {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "null") {
    return { ok: true, value: {}, repaired: true, repairs: ["empty_arguments"] };
  }

  const strict = parseJsonValue(trimmed, STRICT);
  if (strict.ok) return finishTopLevel(strict.value, new Set());

  const tolerant = parseJsonValue(trimmed, TOLERANT);
  if (tolerant.ok) return finishTopLevel(tolerant.value, tolerant.repairs);

  // Not one clean value. Look for a single object inside fences or prose. Starting at the first
  // "{" is deliberately simple: prose that itself contains braces is not worth guessing about.
  const start = trimmed.indexOf("{");
  if (start < 0) return { ok: false, failure: toFailure(trimmed, tolerant) };
  const prefix = parseJsonPrefix(trimmed, start, TOLERANT);
  if (!prefix.ok) return { ok: false, failure: toFailure(trimmed, prefix) };

  const before = trimmed.slice(0, start);
  const after = trimmed.slice(prefix.end);
  if (after.includes("{")) {
    return {
      ok: false,
      failure: {
        kind: "multiple_objects",
        detail: "they contain more than one JSON object",
        near: snippetAround(trimmed, prefix.end),
      },
    };
  }
  const repairs = new Set<RepairKind>(prefix.repairs);
  if (before.trim() === "" && /^[\s}\]]+$/.test(after)) {
    repairs.add("extra_closer");
  } else {
    const stray = `${before}\n${after}`;
    if (HAS_FENCE_LINE.test(stray)) repairs.add("code_fence");
    if (stray.replace(FENCE_LINES, "").trim() !== "") repairs.add("surrounding_text");
  }
  return finishTopLevel(prefix.value, repairs);
}

function finishTopLevel(value: unknown, repairs: Set<RepairKind>): ArgumentsParse {
  if (isPlainObject(value)) {
    const list = sortRepairs(repairs);
    return { ok: true, value, repaired: list.length > 0, repairs: list };
  }
  if (typeof value === "string") {
    // The whole object sent as a JSON string: decode it once. A string that does not hold an
    // object is refused rather than guessed at.
    const inner = parseJsonValue(value, TOLERANT_NO_CLOSERS);
    if (inner.ok && isPlainObject(inner.value)) {
      const all = new Set<RepairKind>([...repairs, "double_encoded", ...inner.repairs]);
      return { ok: true, value: inner.value, repaired: true, repairs: sortRepairs(all) };
    }
  }
  return {
    ok: false,
    failure: {
      kind: "not_object",
      detail: `they are ${describeValueKind(value)}`,
      near: null,
    },
  };
}
