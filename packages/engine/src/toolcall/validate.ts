/**
 * Validation of parsed arguments against a tool's JSON Schema: safe coercions first, then Ajv,
 * then Ajv's errors turned into short per-field problems the model can act on.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { JsonSchema, ToolSchema } from "../contracts/model.ts";
import { type Coercion, coerceToSchema, formatPath, type PathSegment } from "./coerce.ts";
import { looseName, suggestName } from "./names.ts";
import { describeExpected, describeSchema, propertiesOf, type SchemaNode } from "./schema.ts";
import { isPlainObject } from "./values.ts";

export interface ValidationIssue {
  /** Readable path of the field, such as `todos[0].status`; empty for the arguments as a whole. */
  path: string;
  /** What is wrong, without the path: `expected an integer, got the string "ten"`. */
  problem: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown>; coercions: Coercion[] }
  | { ok: false; issues: ValidationIssue[]; coercions: Coercion[] };

const AJV_OPTIONS = {
  strict: false,
  allErrors: true,
  verbose: true,
  validateSchema: false,
  logger: false,
} as const;

let sharedAjv: Ajv2020 | null = null;
const compiled = new WeakMap<object, ValidateFunction | string>();

/** Compiles once per schema object. Returns the compile error text when the schema is unusable. */
function validatorFor(schema: JsonSchema): ValidateFunction | string {
  const cached = compiled.get(schema);
  if (cached !== undefined) return cached;
  // `$schema` would make Ajv look up a meta-schema, and a top-level `$id` would clash when two
  // tools (or two copies of one tool) share it. Neither changes what is valid.
  const { $schema: _s, $id: _i, ...body } = schema;
  let result: ValidateFunction | string;
  try {
    sharedAjv ??= new Ajv2020(AJV_OPTIONS);
    result = sharedAjv.compile(body);
  } catch {
    try {
      result = new Ajv2020(AJV_OPTIONS).compile(body);
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
    }
  }
  compiled.set(schema, result);
  return result;
}

/** Coerces and validates `input` against the tool's schema. Pure apart from a compile cache. */
export function validateToolInput(
  tool: ToolSchema,
  input: Record<string, unknown>,
): ValidationResult {
  const root = tool.parameters;
  const validate = validatorFor(root);
  if (typeof validate === "string") {
    return {
      ok: false,
      coercions: [],
      issues: [{ path: "", problem: `the tool's input schema cannot be used (${validate})` }],
    };
  }
  const { value, coercions } = coerceToSchema(root, input);
  if (validate(value)) return { ok: true, value, coercions };
  return { ok: false, issues: describeErrors(validate.errors ?? [], tool), coercions };
}

function decodePointer(pointer: string): PathSegment[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^(0|[1-9]\d*)$/.test(s) ? Number(s) : s));
}

export function describeErrors(
  errors: readonly ErrorObject[],
  tool: ToolSchema,
): ValidationIssue[] {
  // A failed anyOf/oneOf also reports every branch's own failure; only the summary is useful.
  const unions = errors.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf");
  const kept = errors.filter(
    (e) => !unions.some((u) => u !== e && e.schemaPath.startsWith(`${u.schemaPath}/`)),
  );
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const e of kept) {
    const issue = describeError(e, tool);
    const key = `${issue.path}\n${issue.problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}

/** `the string "ten"`, `5.5`, `an array of 3 items`: what the model sent, briefly. */
export function previewValue(v: unknown): string {
  if (typeof v === "string") {
    if (v.length <= 40) return `the string ${JSON.stringify(v)}`;
    return `the string ${JSON.stringify(v.slice(0, 40)).slice(0, -1)}…" (${v.length} characters)`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v))
    return v.length === 1 ? "an array of 1 item" : `an array of ${v.length} items`;
  return "an object";
}

function describeError(e: ErrorObject, tool: ToolSchema): ValidationIssue {
  const base = decodePointer(e.instancePath);
  const at = formatPath(base);
  const p = e.params as Record<string, unknown>;
  const got = previewValue(e.data);
  switch (e.keyword) {
    case "required":
      return {
        path: formatPath([...base, String(p.missingProperty)]),
        problem: "required but missing",
      };
    case "additionalProperties": {
      const key = String(p.additionalProperty);
      return {
        path: formatPath([...base, key]),
        problem: unknownFieldProblem(key, e.parentSchema, base.length === 0 ? tool.name : null),
      };
    }
    case "type": {
      const types = String(p.type).split(",");
      return { path: at, problem: `expected ${describeExpected(types)}, got ${got}` };
    }
    case "enum": {
      const allowed = Array.isArray(p.allowedValues) ? p.allowedValues : [];
      return {
        path: at,
        problem: `must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}; got ${got}`,
      };
    }
    case "const":
      return { path: at, problem: `must be exactly ${JSON.stringify(p.allowedValue)}; got ${got}` };
    case "minimum":
      return { path: at, problem: `must be at least ${p.limit}; got ${got}` };
    case "maximum":
      return { path: at, problem: `must be at most ${p.limit}; got ${got}` };
    case "exclusiveMinimum":
      return { path: at, problem: `must be greater than ${p.limit}; got ${got}` };
    case "exclusiveMaximum":
      return { path: at, problem: `must be less than ${p.limit}; got ${got}` };
    case "multipleOf":
      return { path: at, problem: `must be a multiple of ${p.multipleOf}; got ${got}` };
    case "minLength":
      return { path: at, problem: `must be at least ${p.limit} characters long; got ${got}` };
    case "maxLength":
      return { path: at, problem: `must be at most ${p.limit} characters long; got ${got}` };
    case "minItems":
      return { path: at, problem: `must have at least ${p.limit} items; got ${got}` };
    case "maxItems":
      return { path: at, problem: `must have at most ${p.limit} items; got ${got}` };
    case "minProperties":
      return { path: at, problem: `must have at least ${p.limit} fields` };
    case "maxProperties":
      return { path: at, problem: `must have at most ${p.limit} fields` };
    case "uniqueItems":
      return { path: at, problem: `must not repeat items (items ${p.j} and ${p.i} are the same)` };
    case "pattern":
      return { path: at, problem: `must match the pattern ${String(p.pattern)}; got ${got}` };
    case "format":
      return { path: at, problem: `must be a valid ${String(p.format)}; got ${got}` };
    case "anyOf":
      return { path: at, problem: `must be ${unionShapes(e, tool)}; got ${got}` };
    case "oneOf":
      return Array.isArray(p.passingSchemas)
        ? {
            path: at,
            problem: "matches more than one of the allowed forms; it must match exactly one",
          }
        : { path: at, problem: `must be ${unionShapes(e, tool)}; got ${got}` };
    default:
      return { path: at, problem: e.message ?? `fails the "${e.keyword}" rule` };
  }
}

function unionShapes(e: ErrorObject, tool: ToolSchema): string {
  const parent = e.parentSchema;
  if (!isPlainObject(parent)) return "one of the allowed forms";
  return describeSchema(tool.parameters, parent as SchemaNode);
}

function unknownFieldProblem(key: string, parent: unknown, toolName: string | null): string {
  const props = isPlainObject(parent) ? Object.keys(propertiesOf(parent as SchemaNode)) : [];
  const where = toolName === null ? "this object" : toolName;
  const loose = looseName(key);
  const twin = props.find((name) => looseName(name) === loose);
  if (twin !== undefined) {
    return `is not a field of ${where}; it differs from \`${twin}\` only in case or punctuation, but another value for \`${twin}\` was also sent. Send the value once, as \`${twin}\``;
  }
  const suggestion = suggestName(loose, props);
  if (suggestion !== null) return `is not a field of ${where}; did you mean \`${suggestion}\`?`;
  if (props.length === 0) return `is not a field of ${where}, which takes no fields`;
  if (toolName !== null) return `is not a field of ${where}`;
  return `is not a field of ${where} (its fields: ${props.join(", ")})`;
}
