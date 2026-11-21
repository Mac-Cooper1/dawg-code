import { describe, expect, test } from "vitest";
import { type ParseFailureKind, parseToolArguments, type RepairKind } from "./json-parse.ts";

interface Repairable {
  name: string;
  input: string;
  value: Record<string, unknown>;
  repairs: RepairKind[];
}

const NL = "\n";

const valid: { name: string; input: string }[] = [
  { name: "simple object", input: '{"file_path": "/src/app.ts"}' },
  { name: "empty object", input: "{}" },
  { name: "surrounding whitespace", input: '  \n{"a": 1}\n  ' },
  { name: "nested values", input: '{"a": [1, 2, {"b": null}], "c": true, "d": false}' },
  {
    name: "every escape",
    input: '{"content": "l1\\nl2\\ttab \\"q\\" \\\\ \\/ \\b\\f\\r \\u00e9 \\ud83d\\ude00"}',
  },
  { name: "numbers", input: '{"a": -0.5e-3, "b": 0, "c": 12, "d": 1E+2, "e": -7}' },
  { name: "pretty printed", input: '{\n  "todos": [\n    {"content": "x"}\n  ]\n}' },
  { name: "identical duplicate field", input: '{"a": 1, "a": 1}' },
  { name: "apostrophes inside strings", input: `{"command": "echo 'it''s'"}` },
  { name: "braces inside strings", input: '{"content": "function f() { return [1]; }"}' },
];

describe("valid JSON passes through unrepaired", () => {
  test.each(valid)("$name", ({ input }) => {
    const r = parseToolArguments(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(false);
    expect(r.repairs).toEqual([]);
    expect(r.value).toEqual(JSON.parse(input));
  });
});

const repairable: Repairable[] = [
  // Empty input
  { name: "empty string", input: "", value: {}, repairs: ["empty_arguments"] },
  { name: "whitespace only", input: "  \n ", value: {}, repairs: ["empty_arguments"] },
  { name: "null", input: "null", value: {}, repairs: ["empty_arguments"] },

  // Trailing commas
  {
    name: "trailing comma in object",
    input: '{"file_path": "/a.ts",}',
    value: { file_path: "/a.ts" },
    repairs: ["trailing_comma"],
  },
  {
    name: "trailing commas at every level",
    input: '{"todos": [{"content": "a", "status": "pending",},],}',
    value: { todos: [{ content: "a", status: "pending" }] },
    repairs: ["trailing_comma"],
  },
  {
    name: "trailing comma before whitespace and brace",
    input: '{\n  "command": "ls",\n}',
    value: { command: "ls" },
    repairs: ["trailing_comma"],
  },

  // Missing closers, only after a complete value
  {
    name: "final brace missing after a string",
    input: '{"file_path": "/a.ts"',
    value: { file_path: "/a.ts" },
    repairs: ["missing_closer"],
  },
  {
    name: "final brace missing after a literal",
    input: '{"file_path": "/a.ts", "replace_all": true',
    value: { file_path: "/a.ts", replace_all: true },
    repairs: ["missing_closer"],
  },
  {
    name: "array and object left open after a complete item",
    input: '{"todos": [{"content": "a", "status": "pending"}',
    value: { todos: [{ content: "a", status: "pending" }] },
    repairs: ["missing_closer"],
  },
  {
    name: "one of two closing braces missing",
    input: '{"filters": {"safe": true}',
    value: { filters: { safe: true } },
    repairs: ["missing_closer"],
  },
  {
    name: "missing closer then trailing whitespace",
    input: '{"command": "ls"\n',
    value: { command: "ls" },
    repairs: ["missing_closer"],
  },

  // Surplus closers
  {
    name: "extra closing brace",
    input: '{"command": "ls"}}',
    value: { command: "ls" },
    repairs: ["extra_closer"],
  },
  {
    name: "extra closing bracket and brace",
    input: '{"a": [1]}]}',
    value: { a: [1] },
    repairs: ["extra_closer"],
  },

  // Fences and stray text
  {
    name: "json code fence",
    input: '```json\n{"pattern": "*.ts"}\n```',
    value: { pattern: "*.ts" },
    repairs: ["code_fence"],
  },
  {
    name: "bare code fence",
    input: '```\n{"pattern": "*.ts"}\n```',
    value: { pattern: "*.ts" },
    repairs: ["code_fence"],
  },
  {
    name: "tilde fence",
    input: '~~~json\n{"pattern": "*.ts"}\n~~~',
    value: { pattern: "*.ts" },
    repairs: ["code_fence"],
  },
  {
    name: "prose before",
    input: 'Here are the arguments: {"command": "npm test"}',
    value: { command: "npm test" },
    repairs: ["surrounding_text"],
  },
  {
    name: "prose after",
    input: '{"command": "npm test"} I hope this helps!',
    value: { command: "npm test" },
    repairs: ["surrounding_text"],
  },
  {
    name: "xml-ish wrapper",
    input: '<arguments>{"command": "ls"}</arguments>',
    value: { command: "ls" },
    repairs: ["surrounding_text"],
  },
  {
    name: "prose and fence",
    input: 'Sure!\n```json\n{"command": "ls"}\n```\nDone.',
    value: { command: "ls" },
    repairs: ["code_fence", "surrounding_text"],
  },
  {
    name: "quoted object without escaping",
    input: '"{"command": "ls"}"',
    value: { command: "ls" },
    repairs: ["surrounding_text"],
  },

  // Double encoding
  {
    name: "object sent as a JSON string",
    input: '"{\\"file_path\\": \\"/a.ts\\", \\"limit\\": 20}"',
    value: { file_path: "/a.ts", limit: 20 },
    repairs: ["double_encoded"],
  },
  {
    name: "double-encoded with its own trailing comma",
    input: '"{\\"command\\": \\"ls\\",}"',
    value: { command: "ls" },
    repairs: ["double_encoded", "trailing_comma"],
  },

  // Python habits
  {
    name: "single-quoted keys and values",
    input: "{'file_path': '/a.ts'}",
    value: { file_path: "/a.ts" },
    repairs: ["single_quotes"],
  },
  {
    name: "single-quoted value holding a double quote",
    input: `{"content": 'say "hi"'}`,
    value: { content: 'say "hi"' },
    repairs: ["single_quotes"],
  },
  {
    name: "escaped apostrophe in a single-quoted string",
    input: "{'content': 'don\\'t'}",
    value: { content: "don't" },
    repairs: ["single_quotes"],
  },
  {
    name: "Python True",
    input: '{"file_path": "/a", "old_string": "x", "new_string": "y", "replace_all": True}',
    value: { file_path: "/a", old_string: "x", new_string: "y", replace_all: true },
    repairs: ["python_literals"],
  },
  {
    name: "Python None and False",
    input: '{"a": None, "b": False}',
    value: { a: null, b: false },
    repairs: ["python_literals"],
  },
  {
    name: "a Python dict repr",
    input: "{'command': 'ls -la', 'run_in_background': False,}",
    value: { command: "ls -la", run_in_background: false },
    repairs: ["trailing_comma", "single_quotes", "python_literals"],
  },
  {
    name: "unquoted keys",
    input: '{file_path: "/a.ts", limit: 10}',
    value: { file_path: "/a.ts", limit: 10 },
    repairs: ["unquoted_keys"],
  },

  // Raw control characters and bad escapes
  {
    name: "raw newline in a string",
    input: `{"content": "line 1${NL}line 2${NL}"}`,
    value: { content: "line 1\nline 2\n" },
    repairs: ["control_characters"],
  },
  {
    name: "raw tab in a string",
    input: '{"content": "a\tb"}',
    value: { content: "a\tb" },
    repairs: ["control_characters"],
  },
  {
    name: "raw CRLF in a string",
    input: '{"content": "a\r\nb"}',
    value: { content: "a\r\nb" },
    repairs: ["control_characters"],
  },
  {
    name: "regex escapes",
    input: '{"pattern": "\\d+\\.ts$"}',
    value: { pattern: "\\d+\\.ts$" },
    repairs: ["invalid_escape"],
  },
  {
    name: "windows path with \\u not followed by hex",
    input: '{"file_path": "C:\\users\\Me"}',
    value: { file_path: "C:\\users\\Me" },
    repairs: ["invalid_escape"],
  },
  {
    name: "escaped apostrophe in a double-quoted string",
    input: '{"content": "it\\\'s"}',
    value: { content: "it's" },
    repairs: ["invalid_escape"],
  },
];

describe("repairs", () => {
  test.each(repairable)("$name", ({ input, value, repairs }) => {
    const r = parseToolArguments(input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(value);
    expect(r.repairs).toEqual(repairs);
    expect(r.repaired).toBe(true);
  });
});

const refused: { name: string; input: string; kind: ParseFailureKind; detail?: string }[] = [
  // Cut off: never repairable, whatever is missing
  {
    name: "inside a string value",
    input: '{"file_path": "/a.ts", "content": "half a fi',
    kind: "truncated",
    detail: "in the middle of a string",
  },
  {
    name: "inside a string with escapes",
    input: '{"content": "say \\"hi',
    kind: "truncated",
  },
  { name: "right after a field name", input: '{"file_path"', kind: "truncated" },
  { name: "right after a colon", input: '{"file_path":', kind: "truncated" },
  { name: "after a colon and space", input: '{"file_path": ', kind: "truncated" },
  { name: "inside a key", input: '{"file_pa', kind: "truncated" },
  { name: "inside an unquoted key", input: "{file_pa", kind: "truncated" },
  {
    name: "inside a number",
    input: '{"limit": 10',
    kind: "truncated",
    detail: "in the middle of a number",
  },
  { name: "after a minus sign", input: '{"limit": -', kind: "truncated" },
  { name: "after a decimal point", input: '{"x": 1.', kind: "truncated" },
  { name: "after an exponent", input: '{"x": 1e', kind: "truncated" },
  { name: "inside true", input: '{"replace_all": tr', kind: "truncated" },
  { name: "inside null", input: '{"a": n', kind: "truncated" },
  { name: "inside None", input: '{"a": No', kind: "truncated" },
  { name: "after a comma", input: '{"a": "b",', kind: "truncated" },
  { name: "after a comma in an array", input: '{"a": [1,', kind: "truncated" },
  { name: "after an opening brace", input: "{", kind: "truncated" },
  { name: "after a nested opening brace", input: '{"a": {', kind: "truncated" },
  { name: "after an opening bracket", input: '{"a": [', kind: "truncated" },
  { name: "inside an escape", input: '{"a": "x\\', kind: "truncated" },
  { name: "inside a unicode escape", input: '{"a": "\\u00', kind: "truncated" },
  { name: "inside a single-quoted string", input: "{'a': 'unfinish", kind: "truncated" },
  { name: "fenced and cut off", input: '```json\n{"a": "b', kind: "truncated" },

  // Not JSON
  { name: "missing comma", input: '{"a": 1 "b": 2}', kind: "syntax" },
  { name: "missing colon", input: '{"a" 1}', kind: "syntax" },
  { name: "undefined", input: '{"a": undefined}', kind: "syntax" },
  { name: "NaN", input: '{"a": NaN}', kind: "syntax" },
  { name: "leading decimal point", input: '{"a": .5}', kind: "syntax" },
  { name: "leading zero", input: '{"a": 01}', kind: "syntax" },
  { name: "plus sign", input: '{"a": +1}', kind: "syntax" },
  { name: "unescaped quote inside a string", input: '{"content": "say "hi""}', kind: "syntax" },
  { name: "prose only", input: "I will read the file now.", kind: "syntax" },
  { name: "key=value pairs", input: "file_path=/a.ts", kind: "syntax" },
  { name: "huge number", input: '{"a": 1e999}', kind: "syntax" },
  { name: "lone comma", input: "{,}", kind: "syntax" },
  {
    name: "deep nesting",
    input: `{"a": ${"[".repeat(300)}${"]".repeat(300)}}`,
    kind: "syntax",
    detail: "nested too deeply",
  },

  // Valid but unusable
  { name: "array", input: "[1, 2]", kind: "not_object", detail: "an array" },
  { name: "string", input: '"just text"', kind: "not_object", detail: "a string" },
  { name: "number", input: "42", kind: "not_object", detail: "an integer" },
  { name: "boolean", input: "true", kind: "not_object" },
  { name: "array of the right object", input: '[{"command": "ls"}]', kind: "not_object" },
  { name: "two objects run together", input: '{"a": 1}{"b": 2}', kind: "multiple_objects" },
  { name: "two objects on two lines", input: '{"a": 1}\n{"b": 2}', kind: "multiple_objects" },
  {
    name: "conflicting duplicate fields",
    input: '{"a": 1, "a": 2}',
    kind: "duplicate_key",
    detail: '"a" appears more than once',
  },
];

describe("refusals", () => {
  test.each(refused)("$name", ({ input, kind, detail }) => {
    const r = parseToolArguments(input);
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (r.ok) return;
    expect(r.failure.kind).toBe(kind);
    if (detail !== undefined) expect(r.failure.detail).toContain(detail);
  });
});

describe("details", () => {
  test("a failure shows where it happened", () => {
    const r = parseToolArguments('{"file_path": "/a.ts", "limit": 20 "offset": 3}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.near).toContain('20 "offset');
  });

  test("a key named __proto__ is an ordinary field", () => {
    const r = parseToolArguments('{"__proto__": {"polluted": true}, "a": 1}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(Object.keys(r.value)).toEqual(["__proto__", "a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test.each([
    ["open brackets", "[".repeat(100_000)],
    ["open objects", '{"a":'.repeat(50_000)],
    ["backslashes", `{"a": "${"\\".repeat(100_000)}`],
    ["quotes", '"'.repeat(100_000)],
    ["braces in prose", `text ${"{ x } ".repeat(20_000)}`],
  ])("degenerate input fails quickly: %s", (_, input) => {
    const start = performance.now();
    expect(parseToolArguments(input).ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("large content parses quickly", () => {
    const content = "x".repeat(2_000_000);
    const start = performance.now();
    const r = parseToolArguments(JSON.stringify({ file_path: "/a", content }));
    expect(r.ok && r.value.content === content).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
