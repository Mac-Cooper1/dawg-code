/**
 * Shortening one oversized tool result in place, so that one huge command output or file does not
 * force a compaction of everything else (docs/specs/phase-2-engine-core.md: "A single oversized
 * tool result is trimmed before compaction is considered").
 *
 * The result keeps its head and its tail (the end of a command's output holds the summary, the
 * error and the path of the saved full output), with a line in the middle saying what was cut.
 */
import type { ContentPart } from "@dawg/protocol";
import type { Message, ToolResultMessage } from "../contracts/messages.ts";
import type { TokenEstimator } from "../contracts/prompt.ts";
import { textTokens } from "./estimate.ts";

/** A trimmed result keeps at least this many tokens; below that, trimming is not the answer. */
export const MIN_KEPT_RESULT_TOKENS = 1_000;
/** Share of the kept text taken from the head; the rest comes from the tail. */
const HEAD_SHARE = 2 / 3;

function cutMessage(cutChars: number, cutLines: number): string {
  const lines = cutLines === 1 ? "1 line" : `${cutLines} lines`;
  return `[… ${lines} (${cutChars} characters) were cut from the middle of this result to save context. If you need them, get that part again with a narrower command or search, or Read with offset and limit. …]`;
}

/**
 * The head and tail of `text` in about `keepChars` characters, cut at line breaks where that
 * loses little.
 */
export function headAndTail(text: string, keepChars: number): string {
  if (keepChars >= text.length) return text;
  const headBudget = Math.max(0, Math.floor(keepChars * HEAD_SHARE));
  const tailBudget = Math.max(0, keepChars - headBudget);
  let headEnd = headBudget;
  const lineEnd = text.lastIndexOf("\n", headBudget);
  if (lineEnd > headBudget * 0.8) headEnd = lineEnd + 1;
  let tailStart = text.length - tailBudget;
  const lineStart = text.indexOf("\n", tailStart);
  if (lineStart !== -1 && lineStart < tailStart + tailBudget * 0.2) tailStart = lineStart + 1;
  if (tailStart <= headEnd) return text;
  const cut = text.slice(headEnd, tailStart);
  const cutLines = cut.split("\n").length - (cut.endsWith("\n") ? 1 : 0);
  const head = text.slice(0, headEnd).replace(/\n?$/, "\n");
  return `${head}\n${cutMessage(cut.length, cutLines)}\n\n${text.slice(tailStart)}`;
}

function largestTextPart(parts: readonly ContentPart[]): { index: number; tokens: number } | null {
  let best: { index: number; tokens: number } | null = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as ContentPart;
    if (part.type !== "text") continue;
    const tokens = textTokens(part.text);
    if (best === null || tokens > best.tokens) best = { index, tokens };
  }
  return best;
}

export function trimLargestResult(
  history: readonly Message[],
  targetTokens: number,
  estimator: TokenEstimator,
): Message[] | null {
  const total = estimator.estimate({ messages: history, tools: [] });
  if (total <= targetTokens) return null;

  let index = -1;
  let part = -1;
  let largest = 0;
  history.forEach((message, i) => {
    if (message.role !== "tool") return;
    const found = largestTextPart(message.content);
    if (found !== null && found.tokens > largest) {
      largest = found.tokens;
      index = i;
      part = found.index;
    }
  });
  if (index < 0) return null;

  const excess = total - targetTokens;
  const slack = Math.max(64, Math.ceil(targetTokens * 0.02));
  const keepTokens = largest - excess - slack;
  if (keepTokens < MIN_KEPT_RESULT_TOKENS) return null;

  const message = history[index] as ToolResultMessage;
  const original = message.content[part] as Extract<ContentPart, { type: "text" }>;
  const charsPerToken = original.text.length / Math.max(1, largest);
  let keepChars = Math.floor(keepTokens * charsPerToken);
  // The chars-per-token ratio is not uniform across the text; shrink until it fits.
  for (let attempt = 0; attempt < 4; attempt++) {
    const content = message.content.map((p, i) =>
      i === part ? { type: "text" as const, text: headAndTail(original.text, keepChars) } : p,
    );
    const trimmed: ToolResultMessage = { ...message, content };
    const next = history.map((m, i) => (i === index ? trimmed : m));
    const after = estimator.estimate({ messages: next, tools: [] });
    if (after <= targetTokens) return next;
    keepChars = Math.floor(keepChars * 0.9 - (after - targetTokens) * charsPerToken);
    if (keepChars / charsPerToken < MIN_KEPT_RESULT_TOKENS) return null;
  }
  return null;
}
