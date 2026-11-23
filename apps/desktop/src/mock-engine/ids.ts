/**
 * Ids in played events. A recording's ids (turnId, messageId, toolCallId, requestId,
 * compactionId) keep their recorded names the first time; if a name is already taken in the
 * session (a recording played twice, or a generated id that happens to match) it gets a suffix.
 *
 * Scopes nest: a branch plays in a child of the scope its request was raised in, so its
 * references to the stored turn and tool call resolve to the names already sent, while ids the
 * branch introduces are allocated fresh.
 */

const ID_KEYS: ReadonlySet<string> = new Set([
  "turnId",
  "messageId",
  "toolCallId",
  "requestId",
  "compactionId",
]);

/** Payload fields holding tool or person data, never ids; left untouched. */
const DATA_KEYS: ReadonlySet<string> = new Set([
  "input",
  "content",
  "display",
  "prompt",
  "response",
]);

export class IdScope {
  readonly #parent: IdScope | null;
  readonly #used: Set<string>;
  readonly #names = new Map<string, string>();

  constructor(parent: IdScope | null = null) {
    this.#parent = parent;
    this.#used = parent === null ? new Set() : parent.#used;
  }

  child(): IdScope {
    return new IdScope(this);
  }

  /** The name a recorded id is sent under in this scope. */
  map(id: string): string {
    for (let scope: IdScope | null = this; scope !== null; scope = scope.#parent) {
      const name = scope.#names.get(id);
      if (name !== undefined) return name;
    }
    let name = id;
    for (let n = 2; this.#used.has(name); n++) name = `${id}~${n}`;
    this.#used.add(name);
    this.#names.set(id, name);
    return name;
  }

  /** A new id that no event of the session has used, for generated events. */
  fresh(prefix: string): string {
    let n = this.#used.size + 1;
    while (this.#used.has(`${prefix}-${n}`)) n++;
    const name = `${prefix}-${n}`;
    this.#used.add(name);
    return name;
  }

  /** Marks ids of copied events (a fork) as taken. */
  reserve(id: string): void {
    this.#used.add(id);
  }

  /** A copy of `payload` with every id renamed through this scope. */
  remap<T>(payload: T): T {
    return this.#walk(payload) as T;
  }

  #walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.#walk(item));
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (ID_KEYS.has(key) && typeof item === "string") out[key] = this.map(item);
      else if (DATA_KEYS.has(key)) out[key] = item;
      else out[key] = this.#walk(item);
    }
    return out;
  }
}

/** Every id an event names, for reserving them in a fork. */
export function idsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) idsIn(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (ID_KEYS.has(key) && typeof item === "string") out.push(item);
      else if (!DATA_KEYS.has(key)) idsIn(item, out);
    }
  }
  return out;
}

let sessionCounter = 0;

/**
 * A session id shaped like the real engine's (a UUIDv7: creation time, then randomness), so
 * sorting ids sorts sessions by creation. Randomness comes from Math.random: the ids only need
 * to be unique within one engine.
 */
export function newSessionId(now: number): string {
  sessionCounter = (sessionCounter + 1) & 0xfff;
  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
  const ms = hex(Math.max(0, Math.floor(now)), 12).slice(-12);
  const random = (width: number) => {
    let out = "";
    while (out.length < width) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  };
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${hex(sessionCounter, 3)}-${variant}${random(3)}-${random(12)}`;
}
