/**
 * Recovering tool calls a model wrote into its reply text instead of the structured channel.
 *
 * This happens when the server's chat-template parser does not recognise the model's call markup,
 * so the markup arrives as ordinary content. The formats covered are the ones the catalog's model
 * families use (see README.md for sources):
 *
 * - Qwen3.6 / Qwen3.8: `<tool_call><function=NAME><parameter=KEY>\nVALUE\n</parameter></function></tool_call>`
 * - Laguna (and GLM-style templates): `<tool_call>NAME<arg_key>KEY</arg_key><arg_value>VALUE</arg_value></tool_call>`
 * - gpt-oss (harmony): `<|channel|>commentary to=functions.NAME <|constrain|>json<|message|>{...}<|call|>`
 * - Hermes / older Qwen: `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`
 * - Llama 3.x: `<function=NAME>{...}</function>`
 * - Mistral: `[TOOL_CALLS][{...}]` and `[TOOL_CALLS]NAME[ARGS]{...}`
 * - Any model: a fenced JSON block, or the whole reply, holding exactly `{name, arguments}` for a
 *   known tool.
 *
 * Markup inside code fences or inline code is never treated as a call: it is an example, not an
 * action. Plain JSON (fenced or bare) must name a known tool and have exactly the call's shape.
 */
import type { FinishReason, ToolSchema } from "../contracts/model.ts";
import { parseJsonPrefix, parseJsonValue, TOLERANT_NO_CLOSERS } from "./json-parse.ts";
import { resolveToolName } from "./names.ts";
import { isPlainObject } from "./values.ts";

export type ProseFormat =
  /** `<tool_call>{"name": ..., "arguments": ...}</tool_call>` */
  | "tool_call_json"
  /** `<tool_call><function=NAME><parameter=KEY>...</parameter></function></tool_call>` */
  | "tool_call_xml"
  /** `<tool_call>NAME<arg_key>KEY</arg_key><arg_value>VALUE</arg_value></tool_call>` */
  | "tool_call_arg_tags"
  /** `<function=NAME>{...}</function>` or `<function=NAME><parameter=...>` without `<tool_call>` */
  | "function_tag"
  /** `[TOOL_CALLS]` followed by a JSON list, or by `NAME[ARGS]{...}` */
  | "mistral"
  /** gpt-oss: `to=functions.NAME ... <|message|>{...}` */
  | "harmony"
  /** A fenced code block whose whole content is a call object */
  | "fenced_json"
  /** The whole reply is a call object */
  | "bare_json";

export interface RecoveredCall {
  /** The tool name as written. */
  name: string;
  /** Argument text for the normal argument parser. */
  arguments: string;
  format: ProseFormat;
  /** The call's markup ran to the end of the reply instead of ending with its closing marker. */
  unterminated: boolean;
  /** Set when the markup is clearly a call but its contents could not be read. */
  failure: string | null;
}

export interface ProseRecovery {
  calls: RecoveredCall[];
  /** The reply text with the recognised call markup removed. Unchanged when nothing was found. */
  content: string;
  /**
   * The reply was cut off by the output limit inside call markup that named no tool yet. The
   * markup has been removed from `content`; no call could be recorded for it.
   */
  unnamedTruncated: boolean;
}

interface Span {
  start: number;
  end: number;
  calls: RecoveredCall[];
}

/** Markup that runs to the end of the reply and names no tool. */
interface Dangling {
  dangling: number;
}

type Attempt = Span | Dangling | null;

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const FUNCTION_OPEN = "<function=";
const FUNCTION_CLOSE = "</function>";
const PARAM_OPEN = "<parameter=";
const PARAM_CLOSE = "</parameter>";
const MISTRAL = "[TOOL_CALLS]";
const HARMONY_TO = "to=functions.";
const HARMONY_MESSAGE = "<|message|>";
const HARMONY_ENDS = ["<|call|>", "<|end|>", "<|return|>"] as const;
const HARMONY_BREAKS = ["<|start|>", "<|end|>", "<|call|>", "<|return|>", "<|message|>"] as const;

/** A tool name as markup writes it: no spaces, no markup characters. */
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/**
 * `indexOf` that remembers its last answer for each needle. Markers are visited left to right, so
 * a reply full of repeated markup (a model stuck in a loop) is still searched in linear time.
 */
class Finder {
  readonly text: string;
  readonly memo = new Map<string, { from: number; at: number }>();

  constructor(text: string) {
    this.text = text;
  }

  next(needle: string, from: number): number {
    const m = this.memo.get(needle);
    if (m !== undefined && from >= m.from && (m.at < 0 || m.at >= from)) return m.at;
    const at = this.text.indexOf(needle, from);
    this.memo.set(needle, { from, at });
    return at;
  }
}

/** Markup cut off at the very end is short; anything longer is not a cut-off opener. */
const MAX_DANGLING = 200;

/**
 * Finds calls written as text. Call only when the reply has no structured calls. Never throws.
 */
export function recoverProseCalls(
  content: string,
  tools: readonly ToolSchema[],
  finishReason: FinishReason,
): ProseRecovery {
  const none: ProseRecovery = { calls: [], content, unnamedTruncated: false };
  if (content.trim() === "") return none;

  const bare = bareJson(content, tools);
  if (bare) return { calls: bare, content: "", unnamedTruncated: false };

  const find = new Finder(content);
  const spans: Span[] = [];
  let dangling: number | null = null;
  const scanner =
    /<tool_call>|<function=|\[TOOL_CALLS\]|to=functions\.|^[ \t]{0,3}(?:`{3,}|~{3,})|`+/gm;
  let pos = 0;
  while (pos < content.length) {
    scanner.lastIndex = pos;
    const m = scanner.exec(content);
    if (!m) break;
    const at = m.index;
    const token = m[0];
    if (token.startsWith("`") || token.startsWith("~") || /^[ \t]/.test(token)) {
      const fence = /^[ \t]{0,3}(`{3,}|~{3,})$/.exec(token);
      const atLineStart = at === 0 || content[at - 1] === "\n";
      if (fence?.[1] && atLineStart) {
        const block = readFence(content, at, fence[1], find);
        const call = fencedJson(block, tools);
        if (call) spans.push({ start: at, end: block.end, calls: call });
        pos = block.end;
      } else {
        pos = skipInlineCode(content, at, token.length, find);
      }
      continue;
    }
    const attempt = attemptAt(content, at, token, tools, spans.at(-1)?.end ?? 0, find);
    if (attempt === null) {
      pos = at + token.length;
    } else if ("dangling" in attempt) {
      dangling = attempt.dangling;
      break;
    } else {
      spans.push(attempt);
      pos = Math.max(attempt.end, at + 1);
    }
  }

  const cutDangling = dangling !== null && finishReason === "length";
  if (spans.length === 0 && !cutDangling) return none;
  const removed =
    cutDangling && dangling !== null
      ? [...spans, { start: dangling, end: content.length, calls: [] }]
      : spans;
  return {
    calls: spans.flatMap((s) => s.calls),
    content: removeSpans(content, removed),
    unnamedTruncated: cutDangling,
  };
}

function attemptAt(
  content: string,
  at: number,
  token: string,
  tools: readonly ToolSchema[],
  floor: number,
  find: Finder,
): Attempt {
  switch (token) {
    case TOOL_CALL_OPEN:
      return toolCallBlock(content, at, tools, find);
    case FUNCTION_OPEN: {
      const block = functionBlock(find, at, "none");
      if (block === null || "dangling" in block) return block;
      return { start: at, end: block.end, calls: [{ ...block.call, format: "function_tag" }] };
    }
    case MISTRAL:
      return mistral(content, at, find);
    case HARMONY_TO:
      return harmony(content, at, floor, find);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Code fences and inline code

interface FenceBlock {
  info: string;
  body: string;
  end: number;
  closed: boolean;
}

function readFence(content: string, at: number, fence: string, find: Finder): FenceBlock {
  const lineEnd = find.next("\n", at);
  if (lineEnd < 0) {
    const info = content.slice(at).trim().slice(fence.length).trim();
    return { info, body: "", end: content.length, closed: false };
  }
  const info = content.slice(at, lineEnd).trim().slice(fence.length).trim();
  const closer = fenceCloser(fence);
  closer.lastIndex = lineEnd + 1;
  const close = closer.exec(content);
  if (!close) return { info, body: content.slice(lineEnd + 1), end: content.length, closed: false };
  return {
    info,
    body: content.slice(lineEnd + 1, close.index),
    end: close.index + close[0].length,
    closed: true,
  };
}

const fenceClosers = new Map<string, RegExp>();

/** A closing fence uses the same character, at least as many times, alone on its line. */
function fenceCloser(fence: string): RegExp {
  let re = fenceClosers.get(fence);
  if (re === undefined) {
    const char = fence[0] === "`" ? "`" : "~";
    re = new RegExp(`^[ \\t]{0,3}${char}{${fence.length},}[ \\t]*$`, "gm");
    if (fence.length <= 16) fenceClosers.set(fence, re);
  }
  return re;
}

function skipInlineCode(content: string, at: number, ticks: number, find: Finder): number {
  const run = "`".repeat(ticks);
  // A code span ends at the next run of exactly as many backticks, within the same paragraph.
  const para = find.next("\n\n", at);
  let search = at + ticks;
  for (;;) {
    const next = find.next(run, search);
    if (next < 0 || (para >= 0 && next > para)) return at + ticks;
    const longer = content[next + ticks] === "`" || content[next - 1] === "`";
    if (!longer) return next + ticks;
    search = next + 1;
  }
}

const FENCE_INFO = /^(?:json|jsonc|tool_call|tool_code)?$/i;

function fencedJson(block: FenceBlock, tools: readonly ToolSchema[]): RecoveredCall[] | null {
  if (!FENCE_INFO.test(block.info)) return null;
  return strictCallJson(block.body, tools, "fenced_json", !block.closed);
}

function bareJson(content: string, tools: readonly ToolSchema[]): RecoveredCall[] | null {
  const t = content.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  return strictCallJson(t, tools, "bare_json", false);
}

/**
 * JSON with no markup around it is only a call when it has exactly a call's shape and every name
 * is a real tool; otherwise it is left as text (it is most likely an example or data).
 */
function strictCallJson(
  text: string,
  tools: readonly ToolSchema[],
  format: ProseFormat,
  unterminated: boolean,
): RecoveredCall[] | null {
  const parsed = parseJsonValue(text, TOLERANT_NO_CLOSERS);
  if (!parsed.ok) return null;
  const calls = callsFromJson(parsed.value, true);
  if (calls === null) return null;
  if (!calls.every((c) => resolveToolName(c.name, tools).found)) return null;
  return calls.map((c) => ({ ...c, format, unterminated, failure: null }));
}

// ---------------------------------------------------------------------------------------------
// JSON call objects

const ARG_KEYS = ["arguments", "parameters", "input"] as const;

/**
 * Reads `{name, arguments}` (or `parameters` / `input`), also inside the OpenAI wrapper
 * `{type: "function", function: {...}}`, or a list of them. With `exact`, no other keys are
 * allowed apart from `id` and `type`.
 */
function callsFromJson(
  value: unknown,
  exact: boolean,
): { name: string; arguments: string }[] | null {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) return null;
  const calls: { name: string; arguments: string }[] = [];
  for (const item of items) {
    const call = callFromObject(item, exact);
    if (call === null) return null;
    calls.push(call);
  }
  return calls;
}

function callFromObject(o: unknown, exact: boolean): { name: string; arguments: string } | null {
  if (!isPlainObject(o)) return null;
  let target = o;
  if (isPlainObject(o.function) && typeof o.function.name === "string") {
    if (exact && Object.keys(o).some((k) => k !== "function" && k !== "id" && k !== "type"))
      return null;
    target = o.function;
  }
  const name = target.name;
  if (typeof name !== "string" || !NAME.test(name.trim())) return null;
  const argKeys = ARG_KEYS.filter((k) => Object.hasOwn(target, k));
  if (argKeys.length > 1) return null;
  const argKey = argKeys[0];
  if (exact) {
    const allowed = new Set<string>(["name", "id", "type", ...(argKey ? [argKey] : [])]);
    if (Object.keys(target).some((k) => !allowed.has(k))) return null;
  }
  const args = argKey === undefined ? undefined : target[argKey];
  let text: string;
  if (args === undefined || args === null) text = "";
  else if (typeof args === "string") text = args;
  else if (isPlainObject(args)) text = JSON.stringify(args);
  else return null;
  return { name: name.trim(), arguments: text };
}

const QUOTED_NAME = /"name"\s*:\s*"([A-Za-z_][A-Za-z0-9_.:-]*)"/;

// ---------------------------------------------------------------------------------------------
// <tool_call> ... </tool_call>

function toolCallBlock(
  content: string,
  at: number,
  tools: readonly ToolSchema[],
  find: Finder,
): Attempt {
  const innerStart = at + TOOL_CALL_OPEN.length;
  const close = find.next(TOOL_CALL_CLOSE, innerStart);
  const nextOpen = find.next(TOOL_CALL_OPEN, innerStart);
  let innerEnd: number;
  let end: number;
  let unterminated = false;
  if (close >= 0 && (nextOpen < 0 || close < nextOpen)) {
    innerEnd = close;
    end = close + TOOL_CALL_CLOSE.length;
  } else if (nextOpen >= 0) {
    // The closing tag is missing, but another call follows, so this one was not cut off.
    innerEnd = nextOpen;
    end = nextOpen;
  } else {
    innerEnd = content.length;
    end = content.length;
    unterminated = true;
  }
  const inner = content.slice(innerStart, innerEnd);
  const t = inner.trim();

  if (t === "") return unterminated ? { dangling: at } : null;

  if (t.startsWith("{") || t.startsWith("[")) {
    const parsed = parseJsonValue(t, TOLERANT_NO_CLOSERS);
    if (parsed.ok) {
      const calls = callsFromJson(parsed.value, false);
      if (calls === null) return null;
      return {
        start: at,
        end,
        calls: calls.map((c) => ({ ...c, format: "tool_call_json", unterminated, failure: null })),
      };
    }
    const name = QUOTED_NAME.exec(t)?.[1];
    if (name === undefined) return unterminated ? { dangling: at } : null;
    return {
      start: at,
      end,
      calls: [
        {
          name,
          arguments: "",
          format: "tool_call_json",
          unterminated,
          failure: `the JSON inside <tool_call> is not valid: ${parsed.detail}`,
        },
      ],
    };
  }

  if (t.startsWith(FUNCTION_OPEN)) {
    const offset = inner.indexOf(FUNCTION_OPEN);
    const block = functionBlock(new Finder(inner), offset, unterminated ? "open" : "closed");
    if (block === null) return null;
    if ("dangling" in block) return { dangling: at };
    return { start: at, end, calls: [{ ...block.call, format: "tool_call_xml", unterminated }] };
  }

  return argTagsBlock(t, at, end, unterminated, tools);
}

/** Laguna and GLM-style: `NAME<arg_key>K</arg_key><arg_value>V</arg_value>...` */
function argTagsBlock(
  t: string,
  at: number,
  end: number,
  unterminated: boolean,
  tools: readonly ToolSchema[],
): Attempt {
  const name = /^[^\s<]+/.exec(t)?.[0] ?? "";
  if (!NAME.test(name)) return null;
  const find = new Finder(t);
  let pos = skipSpace(t, name.length);
  if (pos >= t.length) {
    // A bare name could be prose ("<tool_call>maybe</tool_call>"); only a real tool counts.
    if (!resolveToolName(name, tools).found) return null;
    return { start: at, end, calls: [call(name, "", "tool_call_arg_tags", unterminated, null)] };
  }
  if (!t.startsWith(KEY_OPEN, pos)) return null;

  const args: Record<string, string> = {};
  let failure: string | null = null;
  while (pos < t.length) {
    if (!t.startsWith(KEY_OPEN, pos)) {
      failure = "there is text between the arguments that is not an <arg_key> tag";
      break;
    }
    const keyEnd = find.next(KEY_CLOSE, pos);
    if (keyEnd < 0) {
      failure = "an <arg_key> tag is not closed with </arg_key>";
      break;
    }
    const key = t.slice(pos + KEY_OPEN.length, keyEnd).trim();
    pos = skipSpace(t, keyEnd + KEY_CLOSE.length);
    if (!t.startsWith(VALUE_OPEN, pos)) {
      failure = `the argument ${JSON.stringify(key)} has no <arg_value>`;
      break;
    }
    const valueEnd = find.next(VALUE_CLOSE, pos);
    if (valueEnd < 0) {
      failure = `the value of ${JSON.stringify(key)} is not closed with </arg_value>`;
      break;
    }
    if (Object.hasOwn(args, key)) {
      failure = `the argument ${JSON.stringify(key)} appears more than once`;
      break;
    }
    defineArg(args, key, t.slice(pos + VALUE_OPEN.length, valueEnd));
    pos = skipSpace(t, valueEnd + VALUE_CLOSE.length);
  }
  const text = failure ? "" : JSON.stringify(args);
  return {
    start: at,
    end,
    calls: [call(name, text, "tool_call_arg_tags", unterminated, failure)],
  };
}

const KEY_OPEN = "<arg_key>";
const KEY_CLOSE = "</arg_key>";
const VALUE_OPEN = "<arg_value>";
const VALUE_CLOSE = "</arg_value>";

function skipSpace(text: string, pos: number): number {
  let p = pos;
  while (p < text.length && /\s/.test(text[p] ?? "")) p++;
  return p;
}

function call(
  name: string,
  args: string,
  format: ProseFormat,
  unterminated: boolean,
  failure: string | null,
): RecoveredCall {
  return { name, arguments: args, format, unterminated, failure };
}

function defineArg(args: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(args, key, { value, enumerable: true, writable: true, configurable: true });
}

// ---------------------------------------------------------------------------------------------
// <function=NAME> ... </function>

type FunctionBlock = { call: Omit<RecoveredCall, "format">; end: number } | Dangling | null;

/**
 * Reads `<function=NAME>` followed by either a JSON object (Llama 3.x) or `<parameter=KEY>` tags
 * (Qwen). `outer` says what encloses it: nothing, or a `<tool_call>` that was closed (which ends
 * the block even if `</function>` is missing) or that ran to the end of the reply.
 */
function functionBlock(find: Finder, at: number, outer: "none" | "closed" | "open"): FunctionBlock {
  const text = find.text;
  const head = /^<function=([^>\n]*)>/.exec(text.slice(at, at + MAX_DANGLING));
  if (!head) {
    // `<function=Na` at the very end: cut off before the name was complete.
    const rest = text.length - at <= MAX_DANGLING ? text.slice(at) : "";
    return /^<function=[^>\n]*$/.test(rest) ? { dangling: at } : null;
  }
  const name = (head[1] ?? "").trim();
  if (!NAME.test(name)) return null;
  const bodyStart = at + head[0].length;
  const close = find.next(FUNCTION_CLOSE, bodyStart);
  const closed = close >= 0;
  const bodyEnd = closed ? close : text.length;
  const end = closed ? close + FUNCTION_CLOSE.length : text.length;
  const unterminated = !closed && outer !== "closed";
  const rawBody = text.slice(bodyStart, bodyEnd);
  const body = rawBody.trim();

  if (body === "" || body.startsWith("{")) {
    return { call: { name, arguments: body, unterminated, failure: null }, end };
  }
  if (!body.startsWith(PARAM_OPEN)) {
    // Without an enclosing <tool_call>, this is most likely prose about the syntax.
    if (outer === "none") return null;
    return {
      call: {
        name,
        arguments: "",
        unterminated,
        failure: "its body is neither a JSON object nor <parameter=...> tags",
      },
      end,
    };
  }
  const parsed = readParameters(rawBody, !unterminated);
  return {
    call: {
      name,
      arguments: parsed.failure ? "" : JSON.stringify(parsed.args),
      unterminated,
      failure: parsed.failure,
    },
    end,
  };
}

/**
 * Qwen's parameter tags. The template writes `<parameter=KEY>\nVALUE\n</parameter>`, so exactly
 * one newline is taken off each end of the value and nothing more: file contents keep their own
 * leading and trailing whitespace. A missing `</parameter>` is accepted when the next parameter
 * or the end of the function follows, as Qwen's own parser does, but never at the end of the
 * reply, where the value may have been cut short.
 */
function readParameters(
  body: string,
  ended: boolean,
): { args: Record<string, string>; failure: string | null } {
  const args: Record<string, string> = {};
  const find = new Finder(body);
  let pos = 0;
  for (;;) {
    pos = skipSpace(body, pos);
    if (pos >= body.length) return { args, failure: null };
    if (!body.startsWith(PARAM_OPEN, pos)) {
      return {
        args,
        failure: "there is text between the parameters that is not a <parameter=...> tag",
      };
    }
    const nameEnd = find.next(">", pos);
    if (nameEnd < 0) return { args, failure: "a <parameter=...> tag is not closed with >" };
    const key = body.slice(pos + PARAM_OPEN.length, nameEnd).trim();
    const valueStart = nameEnd + 1;
    const close = find.next(PARAM_CLOSE, valueStart);
    const next = find.next(PARAM_OPEN, valueStart);
    let value: string;
    if (close >= 0 && (next < 0 || close < next)) {
      value = body.slice(valueStart, close);
      pos = close + PARAM_CLOSE.length;
    } else if (next >= 0) {
      value = body.slice(valueStart, next);
      pos = next;
    } else if (ended) {
      value = body.slice(valueStart);
      pos = body.length;
    } else {
      return {
        args,
        failure: `the parameter ${JSON.stringify(key)} is not closed with </parameter>`,
      };
    }
    if (Object.hasOwn(args, key)) {
      return { args, failure: `the parameter ${JSON.stringify(key)} appears more than once` };
    }
    if (value.startsWith("\n")) value = value.slice(1);
    if (value.endsWith("\n")) value = value.slice(0, -1);
    defineArg(args, key, value);
  }
}

// ---------------------------------------------------------------------------------------------
// Mistral: [TOOL_CALLS]

function mistral(content: string, at: number, find: Finder): Attempt {
  let pos = at + MISTRAL.length;
  while (/\s/.test(content[pos] ?? "")) pos++;
  if (pos >= content.length) return { dangling: at };
  const c = content[pos];

  if (c === "[" || c === "{") {
    const parsed = parseJsonPrefix(content, pos, TOLERANT_NO_CLOSERS);
    if (parsed.ok) {
      const calls = callsFromJson(parsed.value, false);
      if (calls === null) return null;
      return {
        start: at,
        end: parsed.end,
        calls: calls.map((x) => call(x.name, x.arguments, "mistral", false, null)),
      };
    }
    const name = QUOTED_NAME.exec(content.slice(pos, pos + MAX_DANGLING))?.[1];
    const reachesEnd = parsed.kind === "truncated";
    if (name === undefined) return reachesEnd ? { dangling: at } : null;
    return {
      start: at,
      end: reachesEnd ? content.length : parsed.position,
      calls: [
        call(name, "", "mistral", reachesEnd, `the call list is not valid JSON: ${parsed.detail}`),
      ],
    };
  }

  // Newer templates: NAME[ARGS]{...}, optionally NAME[CALL_ID]id[ARGS]{...}
  const head = /^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\[CALL_ID\][A-Za-z0-9_-]*)?\[ARGS\]/.exec(
    content.slice(pos, pos + 300),
  );
  if (!head) {
    // Cut off in the name or a marker: `Gl`, `Glob[AR`, `Glob[CALL_ID]a1`.
    const rest = content.length - pos <= MAX_DANGLING ? content.slice(pos) : "\n";
    return /^[A-Za-z0-9_.:-]*(\[[A-Z_]*\]?[A-Za-z0-9_-]*)?$/.test(rest) ? { dangling: at } : null;
  }
  const name = head[1] ?? "";
  const argsStart = pos + head[0].length;
  const parsed = parseJsonPrefix(content, argsStart, TOLERANT_NO_CLOSERS);
  if (parsed.ok) {
    return {
      start: at,
      end: parsed.end,
      calls: [call(name, content.slice(argsStart, parsed.end), "mistral", false, null)],
    };
  }
  // Hand the raw text to the argument parser, which knows which repairs are safe.
  const next = find.next(MISTRAL, argsStart);
  const end = next >= 0 ? next : content.length;
  return {
    start: at,
    end,
    calls: [call(name, content.slice(argsStart, end), "mistral", next < 0, null)],
  };
}

// ---------------------------------------------------------------------------------------------
// gpt-oss harmony

/**
 * The header is `<|start|>assistant<|channel|>commentary to=functions.NAME <|constrain|>json` or
 * with `to=` before `<|channel|>`; either way it ends at `<|message|>`, and the call's JSON runs
 * to `<|call|>` (often missing, since it is the stop token).
 */
function harmony(content: string, at: number, floor: number, find: Finder): Attempt {
  const head = /^to=functions\.([A-Za-z0-9_.:-]+)/.exec(content.slice(at, at + MAX_DANGLING));
  if (!head) return null;
  const name = head[1] ?? "";
  const start = harmonyHeaderStart(content, at, floor);
  const headerStart = at + head[0].length;
  const message = find.next(HARMONY_MESSAGE, at);
  if (message < 0) {
    // Cut off inside the header. Plain prose mentioning "to=functions." has no harmony tokens.
    const header = content.slice(headerStart, headerStart + MAX_DANGLING + 1);
    const harmonyLike = start < at || header.includes("<|");
    const cut = header.length <= MAX_DANGLING && !HARMONY_BREAKS.some((b) => header.includes(b));
    return harmonyLike && cut ? { dangling: start } : null;
  }
  if (message - headerStart > MAX_DANGLING) return null;
  const header = content.slice(headerStart, message);
  if (HARMONY_BREAKS.some((b) => header.includes(b))) return null;

  const bodyStart = message + HARMONY_MESSAGE.length;
  let bodyEnd = content.length;
  let end = content.length;
  for (const marker of [...HARMONY_ENDS, "<|start|>"]) {
    const i = find.next(marker, bodyStart);
    if (i >= 0 && i < bodyEnd) {
      bodyEnd = i;
      end = marker === "<|start|>" ? i : i + marker.length;
    }
  }
  const unterminated = bodyEnd === content.length;
  return {
    start,
    end,
    calls: [call(name, content.slice(bodyStart, bodyEnd), "harmony", unterminated, null)],
  };
}

/** Where this message's header begins: the `<|start|>` or `<|channel|>` written before `to=`. */
function harmonyHeaderStart(content: string, at: number, floor: number): number {
  const from = Math.max(floor, at - 200);
  const lookBack = content.slice(from, at);
  let cut = 0;
  for (const b of ["<|end|>", "<|call|>", "<|return|>", "<|message|>"]) {
    const i = lookBack.lastIndexOf(b);
    if (i >= 0) cut = Math.max(cut, i + b.length);
  }
  const region = lookBack.slice(cut);
  const hits = [region.indexOf("<|start|>"), region.indexOf("<|channel|>")].filter((i) => i >= 0);
  return hits.length === 0 ? at : from + cut + Math.min(...hits);
}

// ---------------------------------------------------------------------------------------------

/** Cuts the spans out, joining what is left with at most one blank line where text was removed. */
function removeSpans(content: string, spans: readonly { start: number; end: number }[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start > pos) pieces.push(content.slice(pos, s.start));
    pos = Math.max(pos, s.end);
  }
  if (pos < content.length) pieces.push(content.slice(pos));
  return pieces
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join("\n\n");
}
