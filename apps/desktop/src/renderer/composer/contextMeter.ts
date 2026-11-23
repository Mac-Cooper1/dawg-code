/** The context meter's numbers and sentences, kept apart from the markup so they are easy to test. */
import { formatNumber, formatPercent, formatTokens } from "../lib/format.ts";
import type { ContextMeterView } from "../state/types.ts";

/** Circumference of the meter's ring: radius 7 on an 18 px box. */
export const RING_CIRCUMFERENCE = 2 * Math.PI * 7;

export interface ContextSegment {
  key: "cached" | "rest" | "used" | "free";
  label: string;
  tokens: number;
  /** Share of the window, 0–1. */
  share: number;
}

/**
 * What the protocol tells us about the context: how much is used, and how much of the last
 * request's prompt came from the cache. The used part splits into cached and the rest when the
 * cache figure is known.
 */
export function contextSegments(context: ContextMeterView): ContextSegment[] {
  const window = Math.max(1, context.window);
  const used = Math.min(Math.max(0, context.used), window);
  const cachedTokens = context.last?.cachedTokens;
  const segments: ContextSegment[] = [];
  if (cachedTokens == null) {
    segments.push({ key: "used", label: "In use", tokens: used, share: used / window });
  } else {
    const cached = Math.min(Math.max(0, cachedTokens), used);
    segments.push(
      {
        key: "cached",
        label: "Read from cache on the last request",
        tokens: cached,
        share: cached / window,
      },
      {
        key: "rest",
        label: "Rest of the context",
        tokens: used - cached,
        share: (used - cached) / window,
      },
    );
  }
  segments.push({
    key: "free",
    label: "Free",
    tokens: window - used,
    share: (window - used) / window,
  });
  return segments;
}

/** "Context · 36% of 204.8K tokens" */
export function contextHeading(context: ContextMeterView): string {
  return `Context · ${formatPercent(context.fraction)} of ${formatTokens(context.window)} tokens`;
}

/** "74.2K / 204.8K" */
export function contextLabel(context: ContextMeterView): string {
  return `${formatTokens(context.used)} / ${formatTokens(context.window)}`;
}

/**
 * "Last request: read 1,240 tokens/s, wrote 41 tokens/s, 97% of the prompt from cache." Parts the
 * engine did not report are left out; null when it reported none.
 */
export function lastRequestLine(context: ContextMeterView): string | null {
  const last = context.last;
  if (!last) return null;
  const parts: string[] = [];
  if (last.promptTokensPerSecond != null) {
    parts.push(`read ${formatNumber(last.promptTokensPerSecond)} tokens/s`);
  }
  if (last.completionTokensPerSecond != null) {
    parts.push(`wrote ${formatNumber(last.completionTokensPerSecond)} tokens/s`);
  }
  if (last.promptTokens && last.cachedTokens != null) {
    parts.push(`${formatPercent(last.cachedTokens / last.promptTokens)} of the prompt from cache`);
  }
  return parts.length > 0 ? `Last request: ${parts.join(", ")}.` : null;
}

/** "Compacts on its own at 65% (133K)." The threshold is approximate, so it rounds to thousands. */
export function compactLine(context: ContextMeterView): string {
  const tokens = Math.round((context.compactAt * context.window) / 1000) * 1000;
  return `Compacts on its own at ${formatPercent(context.compactAt)} (${formatTokens(tokens)}).`;
}
