/** The session's usage figures, in the protocol's `Usage` shape. */
import type { Usage } from "@dawg/protocol";
import type { ModelUsage } from "../contracts/model.ts";

const int = (n: number | null): number | null => (n === null ? null : Math.max(0, Math.round(n)));
const num = (n: number | null): number | null => (n === null ? null : Math.max(0, n));

export class UsageTracker {
  contextWindow: number;
  #contextUsed = 0;
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
  }

  get contextUsed(): number {
    return this.#contextUsed;
  }

  /** Null until the first request. */
  snapshot(): Usage | null {
    if (this.#last === null) return null;
    return {
      contextWindow: Math.max(0, Math.round(this.contextWindow)),
      contextUsed: this.#contextUsed,
      last: { ...this.#last },
      totals: { ...this.#totals },
    };
  }

  #add(usage: ModelUsage): void {
    this.#totals.requests += 1;
    this.#totals.promptTokens += int(usage.promptTokens) ?? 0;
    this.#totals.completionTokens += int(usage.completionTokens) ?? 0;
    this.#totals.cachedTokens += int(usage.cachedTokens) ?? 0;
  }
}
