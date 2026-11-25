/** The context meter's numbers and sentences, kept apart from the markup so they are easy to test. */
import { formatNumber, formatPercent, formatTokens } from "../lib/format.ts";
import type { ContextMeterView } from "../state/types.ts";

/** Circumference of the meter's ring: radius 7 on an 18 px box. */
export const RING_CIRCUMFERENCE = 2 * Math.PI * 7;

export interface ContextSegment {
  key: "systemPrompt" | "instructions" | "tools" | "messages" | "cached" | "rest" | "used" | "free";
  label: string;
  tokens: number;
  /** Share of the window, 0–1. */
  share: number;
}

const BREAKDOWN_PARTS = [
  { key: "systemPrompt", label: "System prompt" },
  { key: "instructions", label: "Instructions" },
  { key: "tools", label: "Tools" },
  { key: "messages", label: "Messages" },
] as const;

/**
 * What fills the context, then what is free. The engine's breakdown splits the used part into
 * system prompt, instructions, tools and messages. Sessions stored before engines reported it
 * split it by what the last request read from the cache, when that is known.
 */
export function contextSegments(context: ContextMeterView): ContextSegment[] {
  const window = Math.max(1, context.window);
  const used = Math.min(Math.max(0, context.used), window);
  const cachedTokens = context.last?.cachedTokens;
  const segments: ContextSegment[] = [];
  if (context.breakdown !== null) {
    // Clamped in order, so the parts never add up to more than the window.
    let left = used;
    for (const part of BREAKDOWN_PARTS) {
      const tokens = Math.min(Math.max(0, context.breakdown[part.key]), left);
      left -= tokens;
      segments.push({ key: part.key, label: part.label, tokens, share: tokens / window });
    }
  } else if (cachedTokens == null) {
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

/**
 * "Compacts on its own at 65% (133.1K)." from the engine's threshold; once the context is past
 * it, "Compacts on its own before the next turn: past 65% (133.1K)." Null when the engine never
 * compacts on its own, or did not say (sessions stored before engines reported it).
 */
export function compactLine(context: ContextMeterView): string | null {
  if (context.compactAt === null || context.window <= 0) return null;
  const at = `${formatPercent(context.compactAt / context.window)} (${formatTokens(context.compactAt)})`;
  return context.used > context.compactAt
    ? `Compacts on its own before the next turn: past ${at}.`
    : `Compacts on its own at ${at}.`;
}

/** Where the compaction threshold sits on the bar, 0–1; null when there is none. */
export function compactMarker(context: ContextMeterView): number | null {
  if (context.compactAt === null || context.window <= 0) return null;
  return Math.min(1, Math.max(0, context.compactAt / context.window));
}
