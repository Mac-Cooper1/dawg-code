/**
 * The token figures the mock engine and its recordings share: what the model's view holds before
 * any conversation, the split of the context that `usage.updated` reports, and the size at which
 * the engine compacts on its own.
 */
import type { ContextBreakdown } from "@dawg/protocol";

/** The engine's own system prompt, without instruction files. */
export const SYSTEM_PROMPT_TOKENS = 4_112;
/** Tool definitions. */
export const TOOL_TOKENS = 10_992;
/** System prompt and tools: cached from the first request on. */
export const PREFIX_TOKENS = SYSTEM_PROMPT_TOKENS + TOOL_TOKENS;
/** Project instructions and environment, read with the first request. */
export const INSTRUCTION_TOKENS = 1_186;

/**
 * The default model profile's `compactionThreshold` (packages/engine/src/profiles): the share of
 * the context window above which the engine compacts on its own before a turn.
 */
export const COMPACTION_THRESHOLD = 0.65;

/** `Usage.compactAt` for a context window, rounded down as the engine rounds it. */
export function compactAtFor(contextWindow: number): number {
  return Math.floor(contextWindow * COMPACTION_THRESHOLD);
}

/**
 * `Usage.breakdown`: the fixed parts as given, the conversation as the rest, so the parts add up
 * to `contextUsed` exactly. When the fixed parts alone are more than `contextUsed`, they are
 * scaled down to fit and the conversation is empty.
 */
export function contextBreakdown(
  contextUsed: number,
  fixed: Omit<ContextBreakdown, "messages"> = {
    systemPrompt: SYSTEM_PROMPT_TOKENS,
    instructions: INSTRUCTION_TOKENS,
    tools: TOOL_TOKENS,
  },
): ContextBreakdown {
  const used = Math.max(0, Math.round(contextUsed));
  const total = fixed.systemPrompt + fixed.instructions + fixed.tools;
  if (total <= used) return { ...fixed, messages: used - total };
  const scale = used / total;
  const systemPrompt = Math.floor(fixed.systemPrompt * scale);
  const instructions = Math.floor(fixed.instructions * scale);
  return { systemPrompt, instructions, tools: used - systemPrompt - instructions, messages: 0 };
}
