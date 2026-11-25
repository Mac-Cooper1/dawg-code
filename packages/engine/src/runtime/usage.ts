/** The session's usage figures, in the protocol's `Usage` shape. */
import type { ContextBreakdown, Usage } from "@dawg/protocol";
import type { ModelUsage } from "../contracts/model.ts";

const int = (n: number | null): number | null => (n === null ? null : Math.max(0, Math.round(n)));
const num = (n: number | null): number | null => (n === null ? null : Math.max(0, n));

/**
 * Scales estimated part sizes to a measured total. The endpoint counts only the whole, so the
 * split is the estimate's, in whole tokens that add up exactly to `total`: the system prompt,
 * instructions and tools are rounded down and the conversation takes the remainder. With no
 * estimate at all, the whole total is the conversation.
 */
export function splitContext(estimate: ContextBreakdown, total: number): ContextBreakdown {
  const whole = Math.max(0, Math.round(total));
  const parts = {
    systemPrompt: Math.max(0, estimate.systemPrompt),
    instructions: Math.max(0, estimate.instructions),
    tools: Math.max(0, estimate.tools),
    messages: Math.max(0, estimate.messages),
  };
  const sum = parts.systemPrompt + parts.instructions + parts.tools + parts.messages;
  if (sum <= 0) return { systemPrompt: 0, instructions: 0, tools: 0, messages: whole };
  const scale = whole / sum;
  const systemPrompt = Math.floor(parts.systemPrompt * scale);
  const instructions = Math.floor(parts.instructions * scale);
  const tools = Math.floor(parts.tools * scale);
  return {
    systemPrompt,
    instructions,
    tools,
    messages: Math.max(0, whole - systemPrompt - instructions - tools),
  };
}

export class UsageTracker {
  contextWindow: number;
  /** The context size above which the session compacts before a turn; null when it never does. */
  compactAt: number | null = null;
  #contextUsed = 0;
  #breakdown: ContextBreakdown | null = null;
  #last: Usage["last"] | null = null;
  #totals: Usage["totals"] = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    malformedToolCalls: 0,
  };

  constructor(contextWindow: number, restored: Usage | null = null) {
    this.contextWindow = contextWindow;
    if (restored !== null) {
      this.#contextUsed = restored.contextUsed;
      this.#last = restored.last;
      this.#totals = { ...restored.totals };
      this.compactAt = restored.compactAt;
      this.#breakdown = restored.breakdown === null ? null : { ...restored.breakdown };
    }
  }

  /**
   * One request of the conversation. `estimate` gives the prompt and reply sizes for whatever
   * the endpoint did not report.
   */
  recordRequest(
    usage: ModelUsage,
    malformedCalls: number,
    estimate: () => { prompt: number; completion: number },
  ): void {
    let prompt = usage.promptTokens;
    let completion = usage.completionTokens;
    if (prompt === null || completion === null) {
      const guess = estimate();
      prompt ??= guess.prompt;
      completion ??= guess.completion;
    }
    this.#contextUsed = Math.max(0, Math.round(prompt + completion));
    this.#breakdown = null;
    this.#last = {
      promptTokens: int(usage.promptTokens),
      completionTokens: int(usage.completionTokens),
      cachedTokens: int(usage.cachedTokens),
      promptTokensPerSecond: num(usage.promptTokensPerSecond),
      completionTokensPerSecond: num(usage.completionTokensPerSecond),
    };
    this.#add(usage);
    this.#totals.malformedToolCalls += malformedCalls;
  }

  /** A side request (a summary, a title): counted in the totals, not in the context. */
  recordSide(usage: ModelUsage): void {
    this.#add(usage);
  }

  /** After compaction the context is the new, smaller view. */
  setContextUsed(tokens: number): void {
    this.#contextUsed = Math.max(0, Math.round(tokens));
    this.#breakdown = null;
  }

  /** Splits the current context size by the estimated size of each part (see `splitContext`). */
  split(estimate: ContextBreakdown): void {
    this.#breakdown = splitContext(estimate, this.#contextUsed);
  }

  get contextUsed(): number {
    return this.#contextUsed;
  }

  get breakdown(): ContextBreakdown | null {
    return this.#breakdown === null ? null : { ...this.#breakdown };
  }

  /** Null until the first request. */
  snapshot(): Usage | null {
    if (this.#last === null) return null;
    return {
      contextWindow: Math.max(0, Math.round(this.contextWindow)),
      contextUsed: this.#contextUsed,
      last: { ...this.#last },
      totals: { ...this.#totals },
      compactAt: this.compactAt,
      breakdown: this.breakdown,
    };
  }

  #add(usage: ModelUsage): void {
    this.#totals.requests += 1;
    this.#totals.promptTokens += int(usage.promptTokens) ?? 0;
    this.#totals.completionTokens += int(usage.completionTokens) ?? 0;
    this.#totals.cachedTokens += int(usage.cachedTokens) ?? 0;
  }
}
