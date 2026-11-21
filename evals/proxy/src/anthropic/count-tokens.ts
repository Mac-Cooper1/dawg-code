/**
 * Best-effort token counting for `POST /v1/messages/count_tokens`
 * (response shape `{"input_tokens": N}`, per
 * https://platform.claude.com/docs/en/build-with-claude/token-counting).
 *
 * The proxy first asks the upstream: llama-server exposes `POST /v1/chat/completions/input_tokens`,
 * which takes a chat-completion body and answers `{"object":"response.input_tokens",
 * "input_tokens": N}` (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
 * When that is unavailable it falls back to this estimate.
 */

import { isRecord } from "../chat-accumulator.ts";

const CHARS_PER_TOKEN = 3.5;
/** Rough per-image cost; image bytes are not text and must not be counted as characters. */
const TOKENS_PER_IMAGE = 1600;

/** Estimate from a translated (OpenAI-shaped) request body: characters / 3.5. */
export function estimateTokens(openAiBody: Record<string, unknown>): number {
  let chars = 0;
  let images = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      chars += value.length;
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isRecord(value)) {
      if (value.type === "image_url") {
        images++;
        return;
      }
      for (const [key, inner] of Object.entries(value)) {
        chars += key.length;
        visit(inner);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      chars += String(value).length;
    }
  };
  visit(openAiBody.messages);
  visit(openAiBody.tools);
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}
