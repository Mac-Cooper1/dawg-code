/**
 * Reading tool JSON Schemas: following local `$ref`s, finding the allowed types, and describing a
 * schema in a few words for error messages.
 */
import type { JsonSchema } from "../contracts/model.ts";
import { isPlainObject } from "./values.ts";

export type SchemaNode = JsonSchema | boolean;

/** Resolves a local JSON Pointer (`#/$defs/x`) against the root. Remote refs return undefined. */
export function resolvePointer(root: JsonSchema, ref: string): SchemaNode | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      node = node[Number(key)];
    } else if (isPlainObject(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return undefined;
    }
  }
  return isPlainObject(node) || typeof node === "boolean" ? (node as SchemaNode) : undefined;
}

/** Follows `$ref` chains (local only), giving up on cycles. */
export function deref(root: JsonSchema, node: SchemaNode): SchemaNode {
  let current = node;
  for (let i = 0; i < 32; i++) {
    if (typeof current === "boolean") return current;
    const ref = current.$ref;
    if (typeof ref !== "string") return current;
    const next = resolvePointer(root, ref);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
export type JsonType = (typeof JSON_TYPES)[number];

/** The types the `type` keyword allows, or null when it does not constrain the type. */
export function declaredTypes(node: SchemaNode): JsonType[] | null {
  if (typeof node === "boolean") return null;
  const t = node.type;
  if (typeof t === "string") return JSON_TYPES.includes(t as JsonType) ? [t as JsonType] : null;
  if (Array.isArray(t)) {
    const list = t.filter((x): x is JsonType => JSON_TYPES.includes(x as JsonType));
    return list.length > 0 ? list : null;
  }
  return null;
}

export function typeOfValue(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  return "object";
}

export function typeMatches(types: readonly JsonType[], v: unknown): boolean {
  const actual = typeOfValue(v);
  if (types.includes(actual)) return true;
  return actual === "integer" && types.includes("number");
}

/** The branches of an `anyOf` / `oneOf`, when the node has one. */
export function unionBranches(node: SchemaNode): SchemaNode[] | null {
  if (typeof node === "boolean") return null;
  const list = node.anyOf ?? node.oneOf;
  return Array.isArray(list)
    ? (list.filter((b) => isPlainObject(b) || typeof b === "boolean") as SchemaNode[])
    : null;
}

function isNullOnly(root: JsonSchema, node: SchemaNode): boolean {
  const n = deref(root, node);
  if (typeof n === "boolean") return false;
  const types = declaredTypes(n);
  return (types !== null && types.length === 1 && types[0] === "null") || n.const === null;
}

/**
 * `anyOf: [X, {type: "null"}]`, the shape many schema generators give an optional field, is
 * treated as X for coercion. Returns null when the union is anything else.
 */
export function nullableBranch(root: JsonSchema, node: SchemaNode): SchemaNode | null {
  const branches = unionBranches(node);
  if (!branches) return null;
  const rest = branches.filter((b) => !isNullOnly(root, b));
  return rest.length === 1 && rest.length < branches.length && rest[0] !== undefined
    ? rest[0]
    : null;
}

/** Whether `null` would satisfy the node's type, as far as can be told without full validation. */
export function allowsNull(root: JsonSchema, node: SchemaNode): boolean {
  const n = deref(root, node);
  if (typeof n === "boolean") return n;
  if (Array.isArray(n.enum)) return n.enum.includes(null);
  if (Object.hasOwn(n, "const")) return n.const === null;
  const branches = unionBranches(n);
  if (branches) return branches.some((b) => allowsNull(root, b));
  const types = declaredTypes(n);
  return types === null || types.includes("null");
}

export function propertiesOf(node: SchemaNode): Record<string, SchemaNode> {
  if (typeof node === "boolean" || !isPlainObject(node.properties)) return {};
  return node.properties as Record<string, SchemaNode>;
}

export function requiredOf(node: SchemaNode): string[] {
  if (typeof node === "boolean" || !Array.isArray(node.required)) return [];
  return node.required.filter((r): r is string => typeof r === "string");
}

const ARTICLE: Record<string, string> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};

/** `an integer`, `a string or null`, for "expected ..." clauses. */
export function describeExpected(types: readonly string[]): string {
  return types.map((t) => ARTICLE[t] ?? t).join(" or ");
}

function plural(type: string): string {
  if (type === "any value") return "values";
  return `${type}s`;
}

const MAX_ENUM_SHOWN = 8;

/** A short description of the values a schema allows, such as `array of strings`. */
export function describeSchema(root: JsonSchema, node: SchemaNode, depth = 0): string {
  const n = deref(root, node);
  if (typeof n === "boolean") return n ? "any value" : "nothing";
  if (Array.isArray(n.enum)) {
    const shown = n.enum.slice(0, MAX_ENUM_SHOWN).map((v) => JSON.stringify(v));
    if (n.enum.length > MAX_ENUM_SHOWN) shown.push("…");
    return `one of ${shown.join(", ")}`;
  }
  if (Object.hasOwn(n, "const")) return `exactly ${JSON.stringify(n.const)}`;
  const types = declaredTypes(n);
  if (types) {
    return types
      .map((t) => {
        if (t === "array" && depth < 2) {
          const items = n.items;
          if (isPlainObject(items) || typeof items === "boolean") {
            const inner = describeSchema(root, items as SchemaNode, depth + 1);
            return inner === "any value" ? "array" : `array of ${plural(inner)}`;
          }
        }
        return t;
      })
      .join(" or ");
  }
  const branches = unionBranches(n);
  if (branches && depth < 2) {
    return branches.map((b) => describeSchema(root, b, depth + 1)).join(" or ");
  }
  if (isPlainObject(n.properties)) return "object";
  return "any value";
}

const MAX_FIELDS_SHOWN = 24;

/**
 * The fields a tool takes, for the end of an error:
 * `file_path (string, required), offset (integer), limit (integer)`.
 */
export function describeFields(root: JsonSchema): string {
  const node = deref(root, root);
  const props = propertiesOf(node);
  const names = Object.keys(props);
  if (names.length === 0) {
    const open = typeof node !== "boolean" && node.additionalProperties !== false;
    return open ? "any fields" : "no arguments (send {})";
  }
  const required = new Set(requiredOf(node));
  const parts = names.slice(0, MAX_FIELDS_SHOWN).map((name) => {
    const type = describeSchema(root, props[name] as SchemaNode);
    return `${name} (${type}${required.has(name) ? ", required" : ""})`;
  });
  if (names.length > MAX_FIELDS_SHOWN) parts.push(`and ${names.length - MAX_FIELDS_SHOWN} more`);
  return parts.join(", ");
}
