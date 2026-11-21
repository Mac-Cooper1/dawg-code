/**
 * Tool schemas as the model sees them, in one canonical byte form.
 *
 * The prompt cache needs the same tool to serialise to the same bytes every time, even when the
 * schema object was built with its keywords in another order (spreads, conditional keys). So
 * schema keywords are put in a fixed order. Two things keep their given order on purpose:
 * - the names inside `properties` (and the other maps keyed by name), because the order of a
 *   tool's fields is the order the model reads them and, with grammar-constrained decoding, the
 *   order it writes them (`old_string` before `new_string`);
 * - arrays (`required`, `enum`, `anyOf`, ...), which are ordered values.
 * Data values (`enum`, `const`, `default`, `examples`) are copied as they are.
 */
import type { JsonSchema } from "../contracts/model.ts";

const KEYWORD_ORDER = [
  "$schema",
  "$id",
  "$ref",
  "title",
  "type",
  "description",
  "enum",
  "const",
  "default",
  "properties",
  "required",
  "additionalProperties",
  "patternProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$defs",
  "definitions",
  "examples",
];
const RANK = new Map(KEYWORD_ORDER.map((key, index) => [key, index]));

/** Keywords whose value maps names to subschemas; the names keep their order. */
const NAME_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
/** Keywords whose value is data, copied as it is. */
const DATA = new Set(["enum", "const", "default", "examples"]);

function compareKeys(a: string, b: string): number {
  const ra = RANK.get(a);
  const rb = RANK.get(b);
  if (ra !== undefined && rb !== undefined) return ra - rb;
  if (ra !== undefined) return -1;
  if (rb !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep copy through JSON semantics: `undefined` and functions are dropped, as JSON would. */
function copyData(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalSubschema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSubschema);
  if (isPlainObject(value)) return canonicalizeSchema(value);
  return copyData(value);
}

export function canonicalizeSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(schema).sort(compareKeys);
  for (const key of keys) {
    const value = schema[key];
    if (value === undefined || typeof value === "function") continue;
    if (DATA.has(key)) {
      out[key] = copyData(value);
    } else if (NAME_MAPS.has(key) && isPlainObject(value)) {
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        if (sub !== undefined) map[name] = canonicalSubschema(sub);
      }
      out[key] = map;
    } else {
      out[key] = canonicalSubschema(value);
    }
  }
  return out;
}
