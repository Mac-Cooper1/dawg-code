/**
 * A linter for tool input schemas, run when tools are loaded.
 *
 * The llama.cpp rules come from its grammar documentation at the pinned runtime commit
 * (grammars/README.md, "JSON Schemas → GBNF", at b1b770d90d94cad9e9ea5b993bdbc383a522fb28) and the
 * converter it describes (common/json-schema-to-grammar.cpp). A construct the converter ignores
 * makes the grammar looser than the schema, so the model can be steered into calls validation
 * then rejects; one it cannot convert can fail the whole request. The general rules are about
 * how well models fill a schema in at all.
 */
import type { ToolSchema } from "../contracts/model.ts";
import { resolvePointer } from "./schema.ts";
import { isPlainObject } from "./values.ts";

export type SchemaLintCode =
  | "root_not_object"
  | "missing_additional_properties_false"
  | "additional_properties_allowed"
  | "missing_tool_description"
  | "missing_description"
  | "untyped_property"
  | "required_not_declared"
  | "deep_nesting"
  | "prefix_items"
  | "pattern_properties"
  | "properties_with_union"
  | "unsupported_keyword"
  | "remote_ref"
  | "unresolved_ref"
  | "nested_ref"
  | "unanchored_pattern"
  | "unsupported_pattern"
  | "invalid_pattern"
  | "unsupported_format"
  | "number_bounds"
  | "large_repetition";

export interface SchemaLintFinding {
  /** "error": calls will fail or the grammar cannot be built. "warning": weaker or slower. */
  severity: "error" | "warning";
  code: SchemaLintCode;
  /** JSON Pointer into `parameters` ("" for the root). */
  path: string;
  message: string;
}

export interface SchemaLintOptions {
  /** Object/array nesting deeper than this is flagged. Default 4. */
  maxDepth?: number;
  /** Length and item-count bounds above this are flagged as slow to sample. Default 100. */
  maxRepetition?: number;
}

/** Keywords llama.cpp's converter does not implement; the grammar silently ignores them. */
const IGNORED_KEYWORDS: readonly string[] = [
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "$anchor",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "multipleOf",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "minProperties",
  "maxProperties",
];

/** String formats the converter turns into grammar rules; any other is treated as a plain string. */
const GRAMMAR_FORMATS = new Set(["date", "time", "date-time", "uuid"]);

const CHILD_MAPS = ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"];
const CHILD_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const CHILD_SINGLE = ["items", "additionalProperties", "not", "if", "then", "else", "contains"];

function pointer(parts: readonly (string | number)[]): string {
  return parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** Lints one tool. Findings come in schema order and are deterministic. */
export function lintToolSchema(
  tool: ToolSchema,
  options: SchemaLintOptions = {},
): SchemaLintFinding[] {
  const maxDepth = options.maxDepth ?? 4;
  const maxRepetition = options.maxRepetition ?? 100;
  const root = tool.parameters;
  const findings: SchemaLintFinding[] = [];
  const add = (
    severity: SchemaLintFinding["severity"],
    code: SchemaLintCode,
    path: readonly (string | number)[],
    message: string,
  ) => findings.push({ severity, code, path: pointer(path), message });

  if (tool.description.trim() === "") {
    add(
      "warning",
      "missing_tool_description",
      [],
      `${tool.name} has no description, so the model has to guess what it does.`,
    );
  }
  if (root.type !== "object") {
    add(
      "error",
      "root_not_object",
      [],
      'The top level must be `type: "object"`: tool arguments are always a JSON object.',
    );
  }
  if (isPlainObject(root.properties)) {
    for (const [name, prop] of Object.entries(root.properties)) {
      if (
        isPlainObject(prop) &&
        typeof prop.description !== "string" &&
        typeof prop.$ref !== "string"
      ) {
        add(
          "warning",
          "missing_description",
          ["properties", name],
          `Field \`${name}\` has no description; models fill described fields far more reliably.`,
        );
      }
    }
  }

  const visit = (node: unknown, path: (string | number)[], depth: number, seen: Set<unknown>) => {
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    checkNode(node, path, depth);
    for (const key of CHILD_MAPS) {
      const map = node[key];
      if (!isPlainObject(map)) continue;
      const nested = key === "properties" || key === "patternProperties";
      for (const [name, child] of Object.entries(map))
        visit(child, [...path, key, name], nested ? depth + 1 : depth, seen);
    }
    for (const key of CHILD_LISTS) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      for (const [i, child] of list.entries()) {
        visit(child, [...path, key, i], key === "prefixItems" ? depth + 1 : depth, seen);
      }
    }
    for (const key of CHILD_SINGLE) {
      const child = node[key];
      if (Array.isArray(child) && key === "items") {
        for (const [i, c] of child.entries()) visit(c, [...path, key, i], depth + 1, seen);
      } else {
        visit(
          child,
          [...path, key],
          key === "items" || key === "additionalProperties" ? depth + 1 : depth,
          seen,
        );
      }
    }
  };

  const checkNode = (node: Record<string, unknown>, path: (string | number)[], depth: number) => {
    const isObject =
      node.type === "object" ||
      (Array.isArray(node.type) && node.type.includes("object")) ||
      isPlainObject(node.properties);
    const types = Array.isArray(node.type)
      ? node.type
      : typeof node.type === "string"
        ? [node.type]
        : [];

    if (depth > maxDepth && (isObject || types.includes("array"))) {
      add(
        "warning",
        "deep_nesting",
        path,
        `Nested ${depth} levels deep; models lose track of deeply nested arguments. Flatten it where possible.`,
      );
    }

    if (isObject) {
      const ap = node.additionalProperties;
      if (ap === undefined) {
        add(
          "warning",
          "missing_additional_properties_false",
          path,
          "Object without `additionalProperties: false`. Declare it so unknown fields are refused rather than passed to the tool.",
        );
      } else if (ap !== false) {
        add(
          "warning",
          "additional_properties_allowed",
          path,
          "Extra fields are allowed here. llama.cpp's grammar then accepts any key, which is slow and invites invented fields (and, per its docs, unescaped newlines in them).",
        );
      }
      if (Array.isArray(node.required) && isPlainObject(node.properties)) {
        for (const r of node.required) {
          if (typeof r === "string" && !Object.hasOwn(node.properties, r) && ap === false) {
            add(
              "error",
              "required_not_declared",
              path,
              `\`${r}\` is required but not declared in \`properties\`, and extra fields are not allowed, so no call can be valid.`,
            );
          }
        }
      }
      if (
        isPlainObject(node.properties) &&
        (Array.isArray(node.anyOf) || Array.isArray(node.oneOf))
      ) {
        add(
          "error",
          "properties_with_union",
          path,
          "`properties` mixed with `anyOf`/`oneOf` in one schema is not supported by llama.cpp's grammar (ggml-org/llama.cpp#7703). Move the properties into each branch.",
        );
      }
    }

    if (isPlainObject(node.properties)) {
      for (const [name, prop] of Object.entries(node.properties)) {
        if (isPlainObject(prop) && !constrainsShape(prop)) {
          add(
            "warning",
            "untyped_property",
            [...path, "properties", name],
            `Field \`${name}\` has no type, so any JSON value is accepted; models guess its shape. Give it a type.`,
          );
        }
      }
    }

    if (Array.isArray(node.prefixItems)) {
      add(
        "error",
        "prefix_items",
        path,
        "`prefixItems` is broken in llama.cpp's grammar conversion. Use an object with named fields instead of a tuple.",
      );
    }
    if (isPlainObject(node.patternProperties)) {
      add(
        "error",
        "pattern_properties",
        path,
        "`patternProperties` is not supported by llama.cpp's grammar: keys it describes can never be generated. Declare the fields in `properties`.",
      );
    }
    for (const kw of IGNORED_KEYWORDS) {
      if (Object.hasOwn(node, kw)) {
        add(
          "warning",
          "unsupported_keyword",
          [...path, kw],
          `\`${kw}\` is not enforced by llama.cpp's grammar, so the model can produce values that validation then rejects. Describe the rule in the field's description too, or drop it.`,
        );
      }
    }

    if (typeof node.$ref === "string") checkRef(node.$ref, path);

    if (typeof node.pattern === "string") checkPattern(node.pattern, [...path, "pattern"]);

    if (typeof node.format === "string" && !GRAMMAR_FORMATS.has(node.format)) {
      add(
        "warning",
        "unsupported_format",
        [...path, "format"],
        `Format "${node.format}" is not enforced by llama.cpp's grammar (it supports date, time, date-time and uuid); the model may send any string.`,
      );
    }

    const isNumber = types.includes("number") && !types.includes("integer");
    if (isNumber) {
      for (const kw of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
        if (Object.hasOwn(node, kw)) {
          add(
            "warning",
            "number_bounds",
            [...path, kw],
            `\`${kw}\` is only enforced by llama.cpp's grammar for \`type: "integer"\`, not "number".`,
          );
        }
      }
    }

    for (const kw of ["minLength", "maxLength", "minItems", "maxItems"]) {
      const v = node[kw];
      if (typeof v === "number" && v > maxRepetition) {
        add(
          "warning",
          "large_repetition",
          [...path, kw],
          `\`${kw}: ${v}\` becomes a repetition count in llama.cpp's grammar, and large counts make sampling slow. Prefer a smaller bound or none.`,
        );
      }
    }
  };

  const checkRef = (ref: string, path: (string | number)[]) => {
    if (!ref.startsWith("#")) {
      add(
        "error",
        "remote_ref",
        [...path, "$ref"],
        `\`$ref\` "${ref}" points outside the schema; llama.cpp's grammar converter cannot fetch it. Inline it under \`$defs\`.`,
      );
      return;
    }
    const target = resolvePointer(root, ref);
    if (target === undefined) {
      add(
        "error",
        "unresolved_ref",
        [...path, "$ref"],
        `\`$ref\` "${ref}" does not resolve; llama.cpp fails to build the grammar.`,
      );
      return;
    }
    if (isPlainObject(target) && containsRef(target, new Set())) {
      add(
        "warning",
        "nested_ref",
        [...path, "$ref"],
        `\`$ref\` "${ref}" leads to a definition that itself uses \`$ref\`; nested references are broken in llama.cpp (ggml-org/llama.cpp#8073). Inline the inner definition.`,
      );
    }
  };

  const checkPattern = (pattern: string, path: (string | number)[]) => {
    try {
      new RegExp(pattern, "u");
    } catch {
      add(
        "error",
        "invalid_pattern",
        path,
        `Pattern ${JSON.stringify(pattern)} is not a valid regular expression; llama.cpp fails to build the grammar.`,
      );
      return;
    }
    if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) {
      add(
        "warning",
        "unanchored_pattern",
        path,
        `Pattern ${JSON.stringify(pattern)} does not start with ^ and end with $; llama.cpp's grammar then accepts any string here.`,
      );
      return;
    }
    const problem = unsupportedPatternFeature(pattern.slice(1, -1));
    if (problem !== null) {
      add(
        "warning",
        "unsupported_pattern",
        path,
        `Pattern ${JSON.stringify(pattern)} uses ${problem}, which llama.cpp's grammar converter does not support; it then accepts any string here.`,
      );
    }
  };

  visit(root, [], 0, new Set());
  return findings;
}

/** Keywords that pin down a value's shape; a property with none of them accepts anything. */
function constrainsShape(node: Record<string, unknown>): boolean {
  return ["type", "enum", "const", "$ref", "anyOf", "oneOf", "allOf", "properties", "items"].some(
    (k) => Object.hasOwn(node, k),
  );
}

function containsRef(node: unknown, seen: Set<unknown>): boolean {
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => containsRef(n, seen));
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") return true;
  return Object.values(obj).some((v) => containsRef(v, seen));
}

/**
 * The converter accepts only `(?:` among `(?` groups, and no anchors or backreferences inside the
 * pattern. Returns a description of the first unsupported feature, or null.
 */
function unsupportedPatternFeature(body: string): string | null {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[i + 1] ?? "";
      if (/[1-9]/.test(next)) return "a backreference";
      if (next === "b" || next === "B") return "a word-boundary assertion";
      if (next === "k") return "a named backreference";
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && body[i + 1] === "?" && body[i + 2] !== ":")
      return "a (?…) group other than (?:…)";
    if (c === "^" || c === "$") return "an anchor inside the pattern";
  }
  return null;
}
