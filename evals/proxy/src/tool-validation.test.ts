import { describe, expect, test } from "vitest";
import {
  anthropicToolSchemas,
  checkToolCall,
  openAiToolSchemas,
  type ToolSchemas,
} from "./tool-validation.ts";

const editSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    replace_all: { type: "boolean" },
  },
  required: ["file_path", "old_string", "new_string"],
  additionalProperties: false,
};

const schemas: ToolSchemas = openAiToolSchemas([
  { type: "function", function: { name: "Edit", parameters: editSchema } },
  { type: "function", function: { name: "NoParams" } },
  { type: "function", function: { name: "Broken", parameters: { type: "not-a-type" } } },
  { type: "function", function: { name: "BadRef", parameters: { $ref: "#/definitions/nope" } } },
  {
    type: "function",
    function: {
      name: "Draft2020",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { items: { type: "array", prefixItems: [{ type: "number" }] } },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Draft04",
      parameters: {
        $schema: "http://json-schema.org/draft-04/schema#",
        type: "object",
        properties: { url: { type: "string", format: "uri" } },
        required: ["url"],
      },
    },
  },
]);

const call = (name: string, args: string) => ({ id: "c1", name, arguments: args });

describe("checkToolCall", () => {
  test("valid arguments", () => {
    const result = checkToolCall(
      call("Edit", '{"file_path":"a.ts","old_string":"x","new_string":"y"}'),
      schemas,
    );
    expect(result).toMatchObject({
      name: "Edit",
      arguments_valid_json: true,
      schema_valid: true,
      error: null,
    });
  });

  test("invalid JSON", () => {
    const result = checkToolCall(call("Edit", '{"file_path": "a.ts",'), schemas);
    expect(result.arguments_valid_json).toBe(false);
    expect(result.schema_valid).toBeNull();
    expect(result.error).toMatch(/^invalid JSON/);
  });

  test("schema violation", () => {
    const result = checkToolCall(call("Edit", '{"file_path":"a.ts","extra":1}'), schemas);
    expect(result.arguments_valid_json).toBe(true);
    expect(result.schema_valid).toBe(false);
    expect(result.error).toMatch(/required property 'old_string'/);
  });

  test("unknown tool gives null schema_valid", () => {
    const result = checkToolCall(call("Nope", "{}"), schemas);
    expect(result).toMatchObject({ arguments_valid_json: true, schema_valid: null });
    expect(result.error).toBe("unknown tool");
  });

  test("bad schemas never crash and give null", () => {
    for (const name of ["Broken", "BadRef"]) {
      const result = checkToolCall(call(name, "{}"), schemas);
      expect(result.arguments_valid_json).toBe(true);
      expect(result.schema_valid).toBeNull();
      expect(result.error).toMatch(/schema could not be compiled/);
    }
  });

  test("a function without parameters accepts an object", () => {
    expect(checkToolCall(call("NoParams", "{}"), schemas).schema_valid).toBe(true);
  });

  test("draft 2020-12 and draft-04 declarations", () => {
    expect(checkToolCall(call("Draft2020", '{"items":[1]}'), schemas).schema_valid).toBe(true);
    expect(checkToolCall(call("Draft2020", "{}"), schemas).schema_valid).toBe(false);
    expect(checkToolCall(call("Draft04", '{"url":"not a uri"}'), schemas).schema_valid).toBe(true);
  });

  test("anthropic tool schemas skip server tools", () => {
    const map = anthropicToolSchemas([
      { name: "Read", input_schema: { type: "object" } },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    expect([...map.keys()]).toEqual(["Read"]);
  });

  test("counts argument bytes", () => {
    expect(checkToolCall(call("Edit", '"é"'), schemas).arguments_bytes).toBe(4);
  });
});
