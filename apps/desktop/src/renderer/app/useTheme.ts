/**
 * Theme resolution. Settings → General → Appearance is "system" (Match macOS, the default),
 * "dark" or "light"; "system" follows `prefers-color-scheme` live, so switching macOS between
 * light and dark repaints the window at once. The resolved theme goes on `<html data-theme>`,
 * which tokens.css reads (dark is the default; "light" switches).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Appearance, ResolvedTheme } from "../../shared/bridge.ts";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(appearance: Appearance, system: ResolvedTheme): ResolvedTheme {
  return appearance === "system" ? system : appearance;
}

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const query = darkQuery();
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function systemSnapshot(): ResolvedTheme {
  // Without matchMedia there is nothing to follow; dark is the app's default.
  const query = darkQuery();
  return !query || query.matches ? "dark" : "light";
}

/** What macOS shows right now, kept current. */
export function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, systemSnapshot, () => "dark");
}

/**
 * Resolves `appearance`, applies it to the document and reports it (to `setResolvedTheme`, so
 * `selectChrome` can expose it). Returns the resolved theme.
 */
export function useApplyTheme(
  appearance: Appearance,
  onResolved: (theme: ResolvedTheme) => void,
): ResolvedTheme {
  const theme = resolveTheme(appearance, useSystemTheme());
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    onResolved(theme);
  }, [theme, onResolved]);
  return theme;
}
