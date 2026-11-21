import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolCallRecord } from "./record.ts";

/** A tool call reconstructed from a response, before validation. */
export interface RawToolCall {
  id: string | null;
  name: string;
  arguments: string;
}

type Validator = ((data: unknown) => boolean) & { errors?: unknown };

interface CompiledSchema {
  validate: Validator | null;
  compileError: string | null;
  errorsText: (errors: unknown) => string;
}

const AJV_OPTIONS = {
  strict: false,
  allErrors: true,
  logger: false,
  addUsedSchema: false,
  validateFormats: false,
} as const;

let ajvDraft7: Ajv | undefined;
let ajv2019: Ajv2019 | undefined;
let ajv2020: Ajv2020 | undefined;

function ajvFor(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const declared = typeof schema.$schema === "string" ? schema.$schema : "";
  if (declared.includes("2020-12")) {
    ajv2020 ??= new Ajv2020(AJV_OPTIONS);
    return ajv2020;
  }
  if (declared.includes("2019-09")) {
    ajv2019 ??= new Ajv2019(AJV_OPTIONS);
    return ajv2019;
  }
  ajvDraft7 ??= new Ajv(AJV_OPTIONS);
  return ajvDraft7;
}

const MAX_CACHE = 500;
const cache = new Map<string, CompiledSchema>();

function compile(schema: unknown): CompiledSchema {
  let key: string;
  try {
    key = JSON.stringify(schema) ?? "undefined";
  } catch (err) {
    return {
      validate: null,
      compileError: `schema is not serialisable: ${String(err)}`,
      errorsText,
    };
  }
  const hit = cache.get(key);
  if (hit) return hit;
  let result: CompiledSchema;
  if (typeof schema === "boolean") {
    const ajv = ajvFor({});
    result = { validate: ajv.compile(schema) as Validator, compileError: null, errorsText };
  } else if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    result = { validate: null, compileError: "schema is not an object", errorsText };
  } else {
    const obj = { ...(schema as Record<string, unknown>) };
    const declared = typeof obj.$schema === "string" ? obj.$schema : "";
    // Draft-07 Ajv only knows its own meta-schema; drop other declarations rather than fail.
    if (declared && !declared.includes("2020-12") && !declared.includes("2019-09")) {
      delete obj.$schema;
    }
    const ajv = ajvFor(obj);
    try {
      const validate = ajv.compile(obj) as Validator;
      result = { validate, compileError: null, errorsText: (e) => ajv.errorsText(e as never) };
    } catch (err) {
      result = {
        validate: null,
        compileError: err instanceof Error ? err.message : String(err),
        errorsText,
      };
    }
  }
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, result);
  return result;
}

function errorsText(errors: unknown): string {
  return Array.isArray(errors) ? `${errors.length} schema error(s)` : "schema validation failed";
}

/** Tool name → JSON Schema of its arguments, from a request's `tools`. */
export type ToolSchemas = Map<string, unknown>;

/** Tool schemas from an OpenAI Chat Completions request (`tools[].function.parameters`). */
export function openAiToolSchemas(tools: unknown): ToolSchemas {
  const map: ToolSchemas = new Map();
  if (!Array.isArray(tools)) return map;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = tool.function;
    if (!isRecord(fn) || typeof fn.name !== "string") continue;
    // A function with no `parameters` takes no arguments; an empty object schema accepts any object.
    map.set(fn.name, fn.parameters === undefined ? { type: "object" } : fn.parameters);
  }
  return map;
}

/** Tool schemas from an Anthropic Messages request (`tools[].input_schema`, custom tools only). */
export function anthropicToolSchemas(tools: unknown): ToolSchemas {
  const map: ToolSchemas = new Map();
  if (!Array.isArray(tools)) return map;
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    if (tool.input_schema === undefined) continue;
    map.set(tool.name, tool.input_schema);
  }
  return map;
}

export interface ParsedArguments {
  ok: boolean;
  value: unknown;
  error: string | null;
}

export function parseArguments(raw: string): ParsedArguments {
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, value: undefined, error: `invalid JSON: ${message}` };
  }
}

/** Check one tool call. Never throws. */
export function checkToolCall(call: RawToolCall, schemas: ToolSchemas): ToolCallRecord {
  const base = {
    name: call.name,
    id: call.id,
    arguments_bytes: Buffer.byteLength(call.arguments, "utf8"),
  };
  try {
    const parsed = parseArguments(call.arguments);
    if (!parsed.ok) {
      return { ...base, arguments_valid_json: false, schema_valid: null, error: parsed.error };
    }
    if (!schemas.has(call.name)) {
      return { ...base, arguments_valid_json: true, schema_valid: null, error: "unknown tool" };
    }
    const compiled = compile(schemas.get(call.name));
    if (!compiled.validate) {
      return {
        ...base,
        arguments_valid_json: true,
        schema_valid: null,
        error: `schema could not be compiled: ${compiled.compileError ?? "unknown error"}`,
      };
    }
    const valid = compiled.validate(parsed.value);
    if (valid) return { ...base, arguments_valid_json: true, schema_valid: true, error: null };
    return {
      ...base,
      arguments_valid_json: true,
      schema_valid: false,
      error: `schema: ${compiled.errorsText(compiled.validate.errors)}`,
    };
  } catch (err) {
    return {
      ...base,
      arguments_valid_json: parseArguments(call.arguments).ok,
      schema_valid: null,
      error: `validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkToolCalls(calls: RawToolCall[], schemas: ToolSchemas): ToolCallRecord[] {
  return calls.map((call) => checkToolCall(call, schemas));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
