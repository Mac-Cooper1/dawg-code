/**
 * Schema-guided coercion: the safe fixes applied to parsed arguments before validation.
 *
 * Ajv's own `coerceTypes` is not used because it also makes unsafe changes (null becomes "" or 0,
 * numbers become strings). Every rule here changes only representation, never meaning, and only
 * where the schema leaves exactly one reading. The full table is in README.md.
 */
import type { JsonSchema } from "../contracts/model.ts";
import { parseJsonValue, TOLERANT_NO_CLOSERS } from "./json-parse.ts";
import { looseName } from "./names.ts";
import {
  allowsNull,
  declaredTypes,
  deref,
  type JsonType,
  nullableBranch,
  propertiesOf,
  requiredOf,
  type SchemaNode,
  typeMatches,
  unionBranches,
} from "./schema.ts";
import { isPlainObject, sameJson, setOwn } from "./values.ts";

export type CoercionKind =
  /** `"10"` for a number field. */
  | "number_from_string"
  /** `"10"` or `"10.0"` for an integer field. */
  | "integer_from_string"
  /** `"true"` / `"false"` (any letter case) for a boolean field. */
  | "boolean_from_string"
  /** An array sent as JSON text inside a string. */
  | "array_from_json_string"
  /** An object sent as JSON text inside a string. */
  | "object_from_json_string"
  /** One string, number or boolean where an array of that type was expected. */
  | "wrapped_in_array"
  /** `null` for an optional field that does not accept null; the field is left out. */
  | "dropped_null"
  /** `filePath` for `file_path`: a name differing only in case or punctuation. */
  | "renamed_field"
  /** A case/punctuation variant sent alongside the real field with the same value. */
  | "dropped_duplicate_field"
  /** `"In_Progress"` for the enum value `"in_progress"`. */
  | "enum_case";

export interface Coercion {
  kind: CoercionKind;
  /** Where, as a readable path such as `todos[0].status`. */
  path: string;
  /** The field name or value the model sent, where that is not obvious from `kind`. */
  from?: string;
}

export type PathSegment = string | number;

/**
 * `todos[0].status`, `-i`. Keys containing spaces, dots, brackets or quotes are quoted:
 * `["odd key"]`.
 */
export function formatPath(path: readonly PathSegment[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (/^[^\s.[\]"'`]+$/.test(seg)) out += out === "" ? seg : `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const BOOLEAN = /^(?:true|false)$/i;
const MAX_DEPTH = 64;

interface Ctx {
  readonly root: JsonSchema;
  readonly coercions: Coercion[];
}

/** Applies the safe coercions. Returns a new value; the input is not modified. */
export function coerceToSchema(
  root: JsonSchema,
  value: Record<string, unknown>,
): { value: Record<string, unknown>; coercions: Coercion[] } {
  const ctx: Ctx = { root, coercions: [] };
  const out = coerce(value, root, [], ctx, 0);
  return { value: isPlainObject(out) ? out : value, coercions: ctx.coercions };
}

function note(ctx: Ctx, kind: CoercionKind, path: readonly PathSegment[], from?: string): void {
  ctx.coercions.push(
    from === undefined ? { kind, path: formatPath(path) } : { kind, path: formatPath(path), from },
  );
}

function coerce(
  value: unknown,
  node: SchemaNode,
  path: PathSegment[],
  ctx: Ctx,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return value;
  const n = deref(ctx.root, node);
  if (typeof n === "boolean") return value;

  const nullable = nullableBranch(ctx.root, n);
  if (nullable !== null) {
    return value === null ? value : coerce(value, nullable, path, ctx, depth + 1);
  }
  // Other unions and intersections are left alone: with several possible readings, picking one
  // would be a guess.
  if (unionBranches(n) !== null || Array.isArray(n.allOf)) return value;

  const types = declaredTypes(n);
  let v = value;
  if (types !== null && !typeMatches(types, v)) v = coerceType(v, types, n, path, ctx);

  if (isPlainObject(v) && (types === null || types.includes("object"))) {
    return coerceObject(v, n, path, ctx, depth);
  }
  if (Array.isArray(v) && (types === null || types.includes("array"))) {
    return coerceArray(v, n, path, ctx, depth);
  }
  if (typeof v === "string") return fixEnumCase(v, n, path, ctx);
  return v;
}

function coerceType(
  v: unknown,
  types: readonly JsonType[],
  n: JsonSchema,
  path: PathSegment[],
  ctx: Ctx,
): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    if (NUMERIC.test(t)) {
      const num = Number(t);
      if (types.includes("integer") && Number.isSafeInteger(num)) {
        note(ctx, types.includes("number") ? "number_from_string" : "integer_from_string", path);
        return num;
      }
      if (types.includes("number") && Number.isFinite(num)) {
        note(ctx, "number_from_string", path);
        return num;
      }
    }
    if (types.includes("boolean") && BOOLEAN.test(t)) {
      note(ctx, "boolean_from_string", path);
      return t.toLowerCase() === "true";
    }
    if (types.includes("array") && t.startsWith("[")) {
      const decoded = parseJsonValue(t, TOLERANT_NO_CLOSERS);
      if (decoded.ok && Array.isArray(decoded.value)) {
        note(ctx, "array_from_json_string", path);
        return decoded.value;
      }
      // Looks like a list but is not valid JSON: wrapping it as one item would be a guess.
      return v;
    }
    if (types.includes("object") && t.startsWith("{")) {
      const decoded = parseJsonValue(t, TOLERANT_NO_CLOSERS);
      if (decoded.ok && isPlainObject(decoded.value)) {
        note(ctx, "object_from_json_string", path);
        return decoded.value;
      }
      return v;
    }
  }
  if (types.includes("array") && wrapsAsItem(v, n, ctx)) {
    note(ctx, "wrapped_in_array", path);
    return [v];
  }
  return v;
}

/**
 * A lone value is put in a one-item array only when it is a scalar that already has the item
 * type. Objects are never wrapped: for a tool that replaces a whole list (a task list), one object
 * more likely means "update this item" than "make this the only item", and wrapping it would
 * silently drop the rest of the list.
 */
function wrapsAsItem(v: unknown, n: JsonSchema, ctx: Ctx): boolean {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return false;
  const items = n.items;
  if (!isPlainObject(items)) return false;
  const itemNode = deref(ctx.root, items as SchemaNode);
  const itemTypes = declaredTypes(itemNode);
  if (itemTypes === null || itemTypes.some((t) => t === "object" || t === "array")) return false;
  return typeMatches(itemTypes, v);
}

function coerceObject(
  obj: Record<string, unknown>,
  n: JsonSchema,
  path: PathSegment[],
  ctx: Ctx,
  depth: number,
): Record<string, unknown> {
  const props = propertiesOf(n);
  const required = new Set(requiredOf(n));
  const additional = n.additionalProperties;
  // `false` means "no other fields", not a schema for them; such fields are left for validation.
  const additionalNode =
    isPlainObject(additional) || additional === true ? (additional as SchemaNode) : undefined;
  const { renames, drops } = additional === false ? planRenames(obj, props) : EMPTY_PLAN;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (drops.has(key)) {
      note(ctx, "dropped_duplicate_field", [...path, key], key);
      continue;
    }
    const name = renames.get(key) ?? key;
    if (name !== key) note(ctx, "renamed_field", [...path, name], key);
    const propNode = Object.hasOwn(props, name) ? props[name] : additionalNode;
    let v = obj[key];
    if (
      v === null &&
      propNode !== undefined &&
      !required.has(name) &&
      !allowsNull(ctx.root, propNode)
    ) {
      note(ctx, "dropped_null", [...path, name]);
      continue;
    }
    if (propNode !== undefined) v = coerce(v, propNode, [...path, name], ctx, depth + 1);
    setOwn(out, name, v);
  }
  return out;
}

const EMPTY_PLAN = { renames: new Map<string, string>(), drops: new Set<string>() };

/**
 * Unknown keys that differ from exactly one declared field only in case or punctuation are
 * renamed to it. When the real field was also sent, a variant carrying the same value is dropped
 * (it adds nothing); one carrying a different value is left for validation to report, because
 * either value might be the one the model meant.
 */
function planRenames(
  obj: Record<string, unknown>,
  props: Record<string, SchemaNode>,
): { renames: Map<string, string>; drops: Set<string> } {
  const byLoose = new Map<string, string[]>();
  for (const p of Object.keys(props)) {
    const l = looseName(p);
    byLoose.set(l, [...(byLoose.get(l) ?? []), p]);
  }
  const byTarget = new Map<string, string[]>();
  for (const k of Object.keys(obj)) {
    if (Object.hasOwn(props, k)) continue;
    const candidates = byLoose.get(looseName(k));
    const target = candidates?.length === 1 ? candidates[0] : undefined;
    if (target === undefined) continue;
    byTarget.set(target, [...(byTarget.get(target) ?? []), k]);
  }
  const renames = new Map<string, string>();
  const drops = new Set<string>();
  for (const [target, aliases] of byTarget) {
    const first = aliases[0];
    if (first === undefined) continue;
    if (Object.hasOwn(obj, target)) {
      if (aliases.every((a) => sameJson(obj[a], obj[target]))) {
        for (const a of aliases) drops.add(a);
      }
    } else if (aliases.every((a) => sameJson(obj[a], obj[first]))) {
      renames.set(first, target);
      for (const a of aliases.slice(1)) drops.add(a);
    }
  }
  return { renames, drops };
}

function coerceArray(
  arr: unknown[],
  n: JsonSchema,
  path: PathSegment[],
  ctx: Ctx,
  depth: number,
): unknown[] {
  const tuple = Array.isArray(n.prefixItems)
    ? n.prefixItems
    : Array.isArray(n.items)
      ? n.items
      : [];
  const items =
    isPlainObject(n.items) || typeof n.items === "boolean" ? (n.items as SchemaNode) : undefined;
  return arr.map((el, i) => {
    const itemNode = i < tuple.length ? (tuple[i] as SchemaNode) : items;
    return itemNode === undefined ? el : coerce(el, itemNode, [...path, i], ctx, depth + 1);
  });
}

function fixEnumCase(v: string, n: JsonSchema, path: PathSegment[], ctx: Ctx): string {
  if (!Array.isArray(n.enum) || n.enum.includes(v)) return v;
  const loose = looseName(v);
  if (loose === "") return v;
  const hits = n.enum.filter((e): e is string => typeof e === "string" && looseName(e) === loose);
  if (hits.length !== 1 || hits[0] === undefined) return v;
  note(ctx, "enum_case", path, v);
  return hits[0];
}
