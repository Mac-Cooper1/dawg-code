import { describe, expect, test } from "vitest";
import type { ToolSchema } from "../contracts/model.ts";
import {
  Bash,
  Edit,
  EnterPlanMode,
  Grep,
  Read,
  Search,
  TodoWrite,
  Write,
} from "./__fixtures__/tools.ts";
import type { CoercionKind } from "./coerce.ts";
import { validateToolInput } from "./validate.ts";

interface Coerced {
  name: string;
  tool: ToolSchema;
  input: Record<string, unknown>;
  value: Record<string, unknown>;
  coercions: [CoercionKind, string][];
}

const todo = { content: "Write tests", activeForm: "Writing tests" };

const coerced: Coerced[] = [
  // Numbers and booleans sent as strings
  {
    name: "integer as a string",
    tool: Read,
    input: { file_path: "/a", limit: "10" },
    value: { file_path: "/a", limit: 10 },
    coercions: [["integer_from_string", "limit"]],
  },
  {
    name: "integer as a string with spaces",
    tool: Read,
    input: { file_path: "/a", offset: " 5 " },
    value: { file_path: "/a", offset: 5 },
    coercions: [["integer_from_string", "offset"]],
  },
  {
    name: "integer as a string with a zero fraction",
    tool: Read,
    input: { file_path: "/a", limit: "20.0" },
    value: { file_path: "/a", limit: 20 },
    coercions: [["integer_from_string", "limit"]],
  },
  {
    name: "integer as a string in exponent form",
    tool: Read,
    input: { file_path: "/a", limit: "1e3" },
    value: { file_path: "/a", limit: 1000 },
    coercions: [["integer_from_string", "limit"]],
  },
  {
    name: "milliseconds as a string",
    tool: Bash,
    input: { command: "sleep 1", timeout: "30000" },
    value: { command: "sleep 1", timeout: 30000 },
    coercions: [["integer_from_string", "timeout"]],
  },
  {
    name: "fraction as a string",
    tool: Search,
    input: { query: "q", ratio: "0.25" },
    value: { query: "q", ratio: 0.25 },
    coercions: [["number_from_string", "ratio"]],
  },
  {
    name: "boolean as a string",
    tool: Edit,
    input: { file_path: "/a", old_string: "x", new_string: "y", replace_all: "true" },
    value: { file_path: "/a", old_string: "x", new_string: "y", replace_all: true },
    coercions: [["boolean_from_string", "replace_all"]],
  },
  {
    name: "boolean as a Python-cased string",
    tool: Bash,
    input: { command: "make", run_in_background: "False" },
    value: { command: "make", run_in_background: false },
    coercions: [["boolean_from_string", "run_in_background"]],
  },
  {
    name: "boolean as a string under a dashed key",
    tool: Grep,
    input: { pattern: "x", "-i": "TRUE" },
    value: { pattern: "x", "-i": true },
    coercions: [["boolean_from_string", "-i"]],
  },
  {
    name: "integer as a string in a nullable union",
    tool: Search,
    input: { query: "q", max_results: "5" },
    value: { query: "q", max_results: 5 },
    coercions: [["integer_from_string", "max_results"]],
  },

  // Arrays and objects sent as JSON text
  {
    name: "array as a JSON string",
    tool: Search,
    input: { query: "q", domains: '["a.com", "b.com"]' },
    value: { query: "q", domains: ["a.com", "b.com"] },
    coercions: [["array_from_json_string", "domains"]],
  },
  {
    name: "array as a Python list string",
    tool: Search,
    input: { query: "q", domains: "['a.com']" },
    value: { query: "q", domains: ["a.com"] },
    coercions: [["array_from_json_string", "domains"]],
  },
  {
    name: "list of objects as a JSON string",
    tool: TodoWrite,
    input: { todos: JSON.stringify([{ ...todo, status: "pending" }]) },
    value: { todos: [{ ...todo, status: "pending" }] },
    coercions: [["array_from_json_string", "todos"]],
  },
  {
    name: "object as a JSON string",
    tool: Search,
    input: { query: "q", filters: '{"safe": true}' },
    value: { query: "q", filters: { safe: true } },
    coercions: [["object_from_json_string", "filters"]],
  },
  {
    name: "object as a JSON string, then its field coerced",
    tool: Search,
    input: { query: "q", filters: '{"safe": "true"}' },
    value: { query: "q", filters: { safe: true } },
    coercions: [
      ["object_from_json_string", "filters"],
      ["boolean_from_string", "filters.safe"],
    ],
  },

  // One value where a list of that type was meant
  {
    name: "a string for a list of strings",
    tool: Search,
    input: { query: "q", domains: "example.com" },
    value: { query: "q", domains: ["example.com"] },
    coercions: [["wrapped_in_array", "domains"]],
  },
  {
    name: "an integer for a list of integers",
    tool: Search,
    input: { query: "q", years: 2024 },
    value: { query: "q", years: [2024] },
    coercions: [["wrapped_in_array", "years"]],
  },

  // null for optional fields
  {
    name: "null for an optional field is dropped",
    tool: Read,
    input: { file_path: "/a", offset: null, limit: null },
    value: { file_path: "/a" },
    coercions: [
      ["dropped_null", "offset"],
      ["dropped_null", "limit"],
    ],
  },
  {
    name: "null is kept where the schema allows it",
    tool: Search,
    input: { query: "q", max_results: null, region: null },
    value: { query: "q", max_results: null, region: null },
    coercions: [],
  },

  // Field names off by case or punctuation
  {
    name: "camelCase field",
    tool: Read,
    input: { filePath: "/a" },
    value: { file_path: "/a" },
    coercions: [["renamed_field", "file_path"]],
  },
  {
    name: "PascalCase field",
    tool: Read,
    input: { FilePath: "/a" },
    value: { file_path: "/a" },
    coercions: [["renamed_field", "file_path"]],
  },
  {
    name: "kebab-case field",
    tool: Read,
    input: { "file-path": "/a" },
    value: { file_path: "/a" },
    coercions: [["renamed_field", "file_path"]],
  },
  {
    name: "upper-case field",
    tool: Read,
    input: { FILE_PATH: "/a" },
    value: { file_path: "/a" },
    coercions: [["renamed_field", "file_path"]],
  },
  {
    name: "every field camelCase, order kept",
    tool: Edit,
    input: { filePath: "/a", oldString: "x", newString: "y", replaceAll: true },
    value: { file_path: "/a", old_string: "x", new_string: "y", replace_all: true },
    coercions: [
      ["renamed_field", "file_path"],
      ["renamed_field", "old_string"],
      ["renamed_field", "new_string"],
      ["renamed_field", "replace_all"],
    ],
  },
  {
    name: "variant repeating the real field's value is dropped",
    tool: Read,
    input: { file_path: "/a", filePath: "/a" },
    value: { file_path: "/a" },
    coercions: [["dropped_duplicate_field", "filePath"]],
  },
  {
    name: "nested field renamed",
    tool: TodoWrite,
    input: { todos: [{ content: "x", status: "pending", active_form: "Doing x" }] },
    value: { todos: [{ content: "x", status: "pending", activeForm: "Doing x" }] },
    coercions: [["renamed_field", "todos[0].activeForm"]],
  },

  // Enum values off by case or punctuation
  {
    name: "enum value in another case",
    tool: Grep,
    input: { pattern: "x", output_mode: "Content" },
    value: { pattern: "x", output_mode: "content" },
    coercions: [["enum_case", "output_mode"]],
  },
  {
    name: "enum value with spaces for underscores",
    tool: TodoWrite,
    input: { todos: [{ ...todo, status: "In Progress" }] },
    value: { todos: [{ ...todo, status: "in_progress" }] },
    coercions: [["enum_case", "todos[0].status"]],
  },

  // Already valid
  {
    name: "integer sent as a float with no fraction needs nothing",
    tool: Read,
    input: { file_path: "/a", limit: 5.0 },
    value: { file_path: "/a", limit: 5 },
    coercions: [],
  },
  {
    name: "numeric-looking string for a string field stays a string",
    tool: Grep,
    input: { pattern: "404" },
    value: { pattern: "404" },
    coercions: [],
  },
  {
    name: "JSON-looking string for a string field stays a string",
    tool: Write,
    input: { file_path: "/a.json", content: '{"a": 1}' },
    value: { file_path: "/a.json", content: '{"a": 1}' },
    coercions: [],
  },
];

describe("coercions", () => {
  test.each(coerced)("$name", ({ tool, input, value, coercions }) => {
    const r = validateToolInput(tool, input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(value);
    expect(Object.keys(r.value)).toEqual(Object.keys(value));
    expect(r.coercions.map((c) => [c.kind, c.path])).toEqual(coercions);
  });

  test("the input is not modified", () => {
    const input = { filePath: "/a", limit: "3" };
    validateToolInput(Read, input);
    expect(input).toEqual({ filePath: "/a", limit: "3" });
  });
});

interface Refused {
  name: string;
  tool: ToolSchema;
  input: Record<string, unknown>;
  /** [path, problem substring] for every expected issue, in order. */
  issues: [string, string][];
}

const refused: Refused[] = [
  // Strings that are not cleanly numbers
  {
    name: "word for an integer",
    tool: Read,
    input: { file_path: "/a", limit: "ten" },
    issues: [["limit", 'expected an integer, got the string "ten"']],
  },
  {
    name: "fraction for an integer",
    tool: Read,
    input: { file_path: "/a", limit: "10.5" },
    issues: [["limit", "expected an integer"]],
  },
  {
    name: "float for an integer",
    tool: Read,
    input: { file_path: "/a", limit: 10.5 },
    issues: [["limit", "expected an integer, got 10.5"]],
  },
  {
    name: "thousands separator",
    tool: Read,
    input: { file_path: "/a", limit: "1,000" },
    issues: [["limit", "expected an integer"]],
  },
  {
    name: "hex",
    tool: Read,
    input: { file_path: "/a", limit: "0x10" },
    issues: [["limit", "expected an integer"]],
  },
  {
    name: "empty string for an integer",
    tool: Read,
    input: { file_path: "/a", limit: "" },
    issues: [["limit", 'got the string ""']],
  },
  {
    name: "integer beyond safe precision",
    tool: Read,
    input: { file_path: "/a", limit: "12345678901234567890" },
    issues: [["limit", "expected an integer"]],
  },
  {
    name: "number with a unit",
    tool: Bash,
    input: { command: "x", timeout: "30s" },
    issues: [["timeout", "expected an integer"]],
  },

  // Booleans
  {
    name: "yes for a boolean",
    tool: Edit,
    input: { file_path: "/a", old_string: "x", new_string: "y", replace_all: "yes" },
    issues: [["replace_all", "expected a boolean"]],
  },
  {
    name: "1 for a boolean",
    tool: Edit,
    input: { file_path: "/a", old_string: "x", new_string: "y", replace_all: 1 },
    issues: [["replace_all", "expected a boolean, got 1"]],
  },

  // Never turned into strings: the text could differ from what the model meant
  {
    name: "number for a string",
    tool: Edit,
    input: { file_path: "/a", old_string: 1.5, new_string: "y" },
    issues: [["old_string", "expected a string, got 1.5"]],
  },
  {
    name: "boolean for a string",
    tool: Write,
    input: { file_path: "/a", content: true },
    issues: [["content", "expected a string, got true"]],
  },
  {
    name: "null for a required field",
    tool: Write,
    input: { file_path: "/a", content: null },
    issues: [["content", "expected a string, got null"]],
  },
  {
    name: "one-item array for a string",
    tool: Read,
    input: { file_path: ["/a"] },
    issues: [["file_path", "expected a string, got an array of 1 item"]],
  },

  // Not wrapped into lists
  {
    name: "single object for a list of objects",
    tool: TodoWrite,
    input: { todos: { ...todo, status: "pending" } },
    issues: [["todos", "expected an array, got an object"]],
  },
  {
    name: "broken JSON list in a string",
    tool: Search,
    input: { query: "q", domains: '["a.com", ' },
    issues: [["domains", "expected an array"]],
  },
  {
    name: "string for an integer list item",
    tool: Search,
    input: { query: "q", years: "twenty" },
    issues: [["years", "expected an array"]],
  },
  {
    name: "non-JSON string for an object",
    tool: Search,
    input: { query: "q", filters: "safe=true" },
    issues: [["filters", "expected an object"]],
  },

  // Unknown and missing fields
  {
    name: "synonym field name",
    tool: Read,
    input: { path: "/a" },
    issues: [
      ["file_path", "required but missing"],
      ["path", "is not a field of Read; did you mean `file_path`?"],
    ],
  },
  {
    name: "variant with a different value from the real field",
    tool: Read,
    input: { file_path: "/a", filePath: "/b" },
    issues: [["filePath", "differs from `file_path` only in case or punctuation"]],
  },
  {
    name: "two variants with different values",
    tool: Read,
    input: { filePath: "/a", FilePath: "/b" },
    issues: [
      ["file_path", "required but missing"],
      ["filePath", "differs from `file_path`"],
      ["FilePath", "differs from `file_path`"],
    ],
  },
  {
    name: "unknown field holding null",
    tool: Read,
    input: { file_path: "/a", encoding: null },
    issues: [["encoding", "is not a field of Read"]],
  },
  {
    name: "field for a tool that takes none",
    tool: EnterPlanMode,
    input: { reason: "big change" },
    issues: [["reason", "which takes no fields"]],
  },
  {
    name: "unknown nested field lists the allowed ones",
    tool: TodoWrite,
    input: { todos: [{ ...todo, status: "pending", priority: "high" }] },
    issues: [["todos[0].priority", "(its fields: content, status, activeForm)"]],
  },
  {
    name: "missing nested field",
    tool: TodoWrite,
    input: { todos: [{ content: "x", status: "pending" }] },
    issues: [["todos[0].activeForm", "required but missing"]],
  },
  {
    name: "nothing at all for a tool with required fields",
    tool: Edit,
    input: {},
    issues: [
      ["file_path", "required but missing"],
      ["old_string", "required but missing"],
      ["new_string", "required but missing"],
    ],
  },

  // Other rules
  {
    name: "value outside an enum",
    tool: TodoWrite,
    input: { todos: [{ ...todo, status: "done" }] },
    issues: [["todos[0].status", 'must be one of "pending", "in_progress", "completed"']],
  },
  {
    name: "below a minimum",
    tool: Read,
    input: { file_path: "/a", offset: 0 },
    issues: [["offset", "must be at least 1; got 0"]],
  },
  {
    name: "above a maximum",
    tool: Bash,
    input: { command: "x", timeout: 700000 },
    issues: [["timeout", "must be at most 600000"]],
  },
  {
    name: "empty string below minLength",
    tool: TodoWrite,
    input: { todos: [{ ...todo, content: "", status: "pending" }] },
    issues: [["todos[0].content", "must be at least 1 characters long"]],
  },
  {
    name: "wrong type in a nullable union",
    tool: Search,
    input: { query: "q", max_results: "many" },
    issues: [["max_results", 'must be integer or null; got the string "many"']],
  },
];

describe("refusals", () => {
  test.each(refused)("$name", ({ tool, input, issues }) => {
    const r = validateToolInput(tool, input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toEqual(issues.map(([p]) => p));
    for (const [i, [, problem]] of issues.entries()) {
      expect(r.issues[i]?.problem).toContain(problem);
    }
  });
});

describe("schemas", () => {
  test("a schema Ajv cannot compile is reported, not thrown", () => {
    const broken: ToolSchema = {
      name: "Broken",
      description: "x",
      parameters: { type: "object", properties: { a: { $ref: "#/nowhere" } } },
    };
    const r = validateToolInput(broken, { a: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]?.problem).toContain("input schema cannot be used");
  });

  test("$schema and $id do not get in the way", () => {
    const tool: ToolSchema = {
      name: "Meta",
      description: "x",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "https://example.com/tool",
        type: "object",
        properties: { n: { $ref: "#/definitions/count" } },
        definitions: { count: { type: "integer" } },
        additionalProperties: false,
      },
    };
    const copy: ToolSchema = { ...tool, parameters: { ...tool.parameters } };
    expect(validateToolInput(tool, { n: "3" })).toMatchObject({ ok: true, value: { n: 3 } });
    expect(validateToolInput(copy, { n: 4 })).toMatchObject({ ok: true, value: { n: 4 } });
  });
});
