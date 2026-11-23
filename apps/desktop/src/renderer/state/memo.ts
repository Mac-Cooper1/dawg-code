/**
 * Memoisation for selectors. `useAppStore(selector)` re-renders whenever the selector returns a
 * different object, and while text streams the store changes every frame, so a selector must
 * give back the very same object when what it shows has not changed.
 */

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

/** Same keys with identical values (arrays: identical elements). One level deep. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && sameList(a, b);
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const bRecord = b as Record<string, unknown>;
  const aRecord = a as Record<string, unknown>;
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && Object.is(aRecord[key], bRecord[key]));
}

/** `previous` when `next` is shallow-equal to it, else `next`. */
export function stable<T>(previous: T | undefined, next: T): T {
  return previous !== undefined && shallowEqual(previous, next) ? previous : next;
}

export interface KeyedMemo<V> {
  /** The cached value for `key` while `deps` are identical to last time; else `compute()`. */
  get(key: string, deps: readonly unknown[], compute: (previous: V | undefined) => V): V;
}

/** One cached result per key (per session id), recomputed only when a dependency changes. */
export function createKeyedMemo<V>(maxKeys = 256): KeyedMemo<V> {
  const cache = new Map<string, { deps: readonly unknown[]; value: V }>();
  return {
    get(key, deps, compute) {
      const hit = cache.get(key);
      if (hit && sameList(hit.deps, deps)) return hit.value;
      const value = compute(hit?.value);
      cache.delete(key);
      cache.set(key, { deps, value });
      if (cache.size > maxKeys) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    },
  };
}
