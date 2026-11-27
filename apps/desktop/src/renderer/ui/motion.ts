/**
 * macOS "Reduce motion", for motion that CSS cannot reach: a terminal's blinking cursor, a scroll
 * done from script, anything run on a timer. base.css already stops CSS animations and
 * transitions. React components can use `useReducedMotion` from src/renderer/markdown.
 */

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}

/** True when the person asked macOS to reduce motion. */
export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false;
}

/** Calls `listener` whenever the setting changes. Returns the unsubscribe. */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  const list = query();
  if (!list || typeof list.addEventListener !== "function") return () => {};
  const changed = (event: MediaQueryListEvent) => listener(event.matches);
  list.addEventListener("change", changed);
  return () => list.removeEventListener("change", changed);
}

/** "smooth" unless motion should be reduced, for `scrollTo` and `scrollIntoView`. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
