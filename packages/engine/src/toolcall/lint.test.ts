import { describe, expect, test } from "vitest";
import type { JsonSchema, ToolSchema } from "../contracts/model.ts";
import { TOOLS } from "./__fixtures__/tools.ts";
import { lintToolSchema, type SchemaLintCode } from "./lint.ts";

function tool(parameters: JsonSchema, description = "Does a thing."): ToolSchema {
  return { name: "T", description, parameters };
}

/** A clean object schema around one field, so each case triggers only what it is about. */
function around(field: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { f: { description: "A field.", ...field } },
    additionalProperties: false,
  };
}

const cases: { name: string; tool: ToolSchema; findings: [SchemaLintCode, string][] }[] = [
  // General
  {
    name: "top level not an object",
    tool: tool({ type: "string" }),
    findings: [["root_not_object", ""]],
  },
  {
    name: "missing additionalProperties: false",
    tool: tool({ type: "object", properties: { f: { type: "string", description: "x" } } }),
    findings: [["missing_additional_properties_false", ""]],
  },
  {
    name: "additionalProperties allowed",
    tool: tool({ type: "object", properties: {}, additionalProperties: true }),
    findings: [["additional_properties_allowed", ""]],
  },
  {
    name: "missing descriptions",
    tool: tool(
      { type: "object", properties: { f: { type: "string" } }, additionalProperties: false },
      "",
    ),
    findings: [
      ["missing_tool_description", ""],
      ["missing_description", "/properties/f"],
    ],
  },
  {
    name: "untyped property",
    tool: tool(around({})),
    findings: [["untyped_property", "/properties/f"]],
  },
  {
    name: "required field not declared",
    tool: tool({
      type: "object",
      properties: {},
      required: ["file_path"],
      additionalProperties: false,
    }),
    findings: [["required_not_declared", ""]],
  },
  {
    name: "deep nesting",
    tool: tool(
      around({
        type: "object",
        additionalProperties: false,
        properties: {
          a: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                b: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    c: {
                      type: "object",
                      additionalProperties: false,
                      properties: { d: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ),
    findings: [["deep_nesting", "/properties/f/properties/a/items/properties/b/properties/c"]],
  },

  // llama.cpp grammar limits
  {
    name: "prefixItems",
    tool: tool(around({ type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] })),
    findings: [["prefix_items", "/properties/f"]],
  },
  {
    name: "patternProperties",
    tool: tool(
      around({
        type: "object",
        patternProperties: { "^x-": { type: "string" } },
        additionalProperties: false,
      }),
    ),
    findings: [["pattern_properties", "/properties/f"]],
  },
  {
    name: "properties mixed with anyOf",
    tool: tool({
      type: "object",
      properties: { a: { type: "string", description: "x" } },
      anyOf: [{ required: ["a"] }, { required: ["b"] }],
      additionalProperties: false,
    }),
    findings: [["properties_with_union", ""]],
  },
  {
    name: "keywords the grammar ignores",
    tool: tool(around({ type: "array", items: { type: "string" }, uniqueItems: true })),
    findings: [["unsupported_keyword", "/properties/f/uniqueItems"]],
  },
  {
    name: "not and if/then",
    // Built from text: an object literal with a `then` key looks like a promise to tooling.
    tool: tool(
      around(
        JSON.parse(
          '{"type":"string","not":{"const":"x"},"if":{"const":"a"},"then":{"minLength":1}}',
        ),
      ),
    ),
    findings: [
      ["unsupported_keyword", "/properties/f/not"],
      ["unsupported_keyword", "/properties/f/if"],
      ["unsupported_keyword", "/properties/f/then"],
    ],
  },
  {
    name: "remote $ref",
    tool: tool(around({ $ref: "https://example.com/schema.json" })),
    findings: [["remote_ref", "/properties/f/$ref"]],
  },
  {
    name: "unresolved $ref",
    tool: tool(around({ $ref: "#/$defs/missing" })),
    findings: [["unresolved_ref", "/properties/f/$ref"]],
  },
  {
    name: "nested $ref",
    tool: tool({
      ...around({ $ref: "#/$defs/outer" }),
      $defs: {
        outer: { type: "array", items: { $ref: "#/$defs/inner" } },
        inner: { type: "string" },
      },
    }),
    findings: [["nested_ref", "/properties/f/$ref"]],
  },
  {
    name: "unanchored pattern",
    tool: tool(around({ type: "string", pattern: "[a-z]+" })),
    findings: [["unanchored_pattern", "/properties/f/pattern"]],
  },
  {
    name: "pattern with lookahead",
    tool: tool(around({ type: "string", pattern: "^(?=.*\\d)[a-z0-9]+$" })),
    findings: [["unsupported_pattern", "/properties/f/pattern"]],
  },
  {
    name: "pattern with a backreference",
    tool: tool(around({ type: "string", pattern: "^(a)\\1$" })),
    findings: [["unsupported_pattern", "/properties/f/pattern"]],
  },
  {
    name: "invalid pattern",
    tool: tool(around({ type: "string", pattern: "^(abc$" })),
    findings: [["invalid_pattern", "/properties/f/pattern"]],
  },
  {
    name: "format the grammar does not know",
    tool: tool(around({ type: "string", format: "uri" })),
    findings: [["unsupported_format", "/properties/f/format"]],
  },
  {
    name: "bounds on a number",
    tool: tool(around({ type: "number", minimum: 0, maximum: 1 })),
    findings: [
      ["number_bounds", "/properties/f/minimum"],
      ["number_bounds", "/properties/f/maximum"],
    ],
  },
  {
    name: "large repetition counts",
    tool: tool(around({ type: "string", maxLength: 10000 })),
    findings: [["large_repetition", "/properties/f/maxLength"]],
  },

  // Fine
  {
    name: "supported constructs raise nothing",
    tool: tool(
      around({
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", format: "uuid" },
          day: { type: "string", format: "date" },
          code: { type: "string", pattern: "^[A-Z]{3}(?:-[0-9]+)?$" },
          n: { type: "integer", minimum: 1, maximum: 10 },
          kind: { enum: ["a", "b"] },
          tags: { type: "array", items: { type: "string" }, maxItems: 10 },
          either: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      }),
    ),
    findings: [],
  },
];

describe("lintToolSchema", () => {
  test.each(cases)("$name", ({ tool: t, findings }) => {
    const found = lintToolSchema(t).map((f) => [f.code, f.path]);
    expect(found).toEqual(findings);
  });

  test("the test tool set is clean", () => {
    for (const t of TOOLS) {
      const findings = lintToolSchema(t).filter(
        (f) => f.code !== "missing_description" && f.code !== "large_repetition",
      );
      expect(findings, t.name).toEqual([]);
    }
  });

  test("severity marks what breaks calls", () => {
    const [prefix] = lintToolSchema(tool(around({ type: "array", prefixItems: [] })));
    expect(prefix?.severity).toBe("error");
    const [format] = lintToolSchema(tool(around({ type: "string", format: "email" })));
    expect(format?.severity).toBe("warning");
    expect(format?.message).toContain('Format "email"');
  });

  test("thresholds are options", () => {
    const t = tool(around({ type: "string", maxLength: 50 }));
    expect(lintToolSchema(t)).toEqual([]);
    expect(lintToolSchema(t, { maxRepetition: 20 }).map((f) => f.code)).toEqual([
      "large_repetition",
    ]);
  });

  test("a schema that refers to itself does not loop", () => {
    const t = tool({
      type: "object",
      properties: { node: { $ref: "#/$defs/node", description: "x" } },
      $defs: {
        node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/node" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
    expect(lintToolSchema(t).map((f) => f.code)).toContain("nested_ref");
  });
});
