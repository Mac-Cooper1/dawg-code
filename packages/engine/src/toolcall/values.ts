/** Small helpers for plain JSON values. */

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sets an own, enumerable property. Plain assignment would treat a key named `__proto__` as the
 * prototype setter, so a model could change the object's prototype instead of sending a field.
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/** Deep equality for parsed JSON values. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJson(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && sameJson(ao[k], bo[k]));
}

/**
 * The canonical text of tool arguments: compact JSON, keys in the order the model sent them.
 *
 * Key order is kept rather than sorted because llama.cpp renders a call's arguments back into the
 * prompt in their stored order; keeping the model's own order makes the re-rendered history match
 * the tokens it generated, so the prompt cache stays valid past that reply.
 */
export function serializeArguments(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** "a string", "an array" and so on, for messages. */
export function describeValueKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  switch (typeof v) {
    case "string":
      return "a string";
    case "number":
      return Number.isInteger(v) ? "an integer" : "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return "a value";
  }
}
