/**
 * A fast token estimate for when the endpoint cannot count exactly
 * (docs/specs/phase-2-engine-core.md, "Context accounting and compaction").
 *
 * The tokenizers of the models we run (Qwen3.x, Laguna, gpt-oss, and SmolLM2 in tests) are
 * byte-level BPE tokenizers that first cut text into pieces with nearly the same regular
 * expression: words with an optional leading space, single digits, runs of punctuation, runs of
 * whitespace. The estimate makes the same cut and prices each piece:
 * - a word: one token, plus one for every 3 ASCII letters past the fifth (long identifiers split);
 * - a digit: one token;
 * - a run of punctuation: one token per 1.5 characters;
 * - a run of whitespace: one token;
 * - a character outside ASCII: one token.
 * Each message adds the chat template's role markers, each tool call and result its wrapping,
 * each image a fixed cost, and a tool set the template's tool-use preamble.
 *
 * Calibration: the prices were chosen by a grid search over 98 texts (this repo's source code,
 * Read-style numbered output, Markdown prose, tool schemas, JSON, test logs) tokenized with the
 * real tokenizer.json of Qwen3.8-27B, Laguna-XS-2.1, gpt-oss-20b and SmolLM2-135M, using a
 * byte-level BPE counter that reproduces llama-server's counts for the fixtures exactly. The
 * search favoured estimates that lean high, because deciding to compact a little early is
 * better than overflowing the window. Mean error per kind of text, Qwen3.8 (Laguna within a few
 * points): code +12%, numbered file output +9%, prose +15%, JSON +19%, logs +3%; mean absolute
 * error 14%; no text underestimated by more than 1%. gpt-oss: +20% to +40%. SmolLM2: -11% to
 * +40%, mean absolute error 6%. estimate.test.ts checks whole prompts against the real
 * llama-server captures in src/model/__fixtures__/llama-server/.
 */
import type { ContentPart } from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { ToolSchema } from "../contracts/model.ts";
import type { TokenEstimator } from "../contracts/prompt.ts";

/**
 * A fixed cost per image. Qwen-style vision encoders spend roughly one token per 28×28 to
 * 32×32-pixel patch after merging, so a one-megapixel screenshot is about 1,000 to 1,350 tokens;
 * this rounds up.
 */
export const DEFAULT_IMAGE_TOKENS = 1_500;

export interface TokenEstimatorOptions {
  imageTokens?: number;
  /**
   * Multiplies the result. A caller that has an exact count for one prompt can set this to
   * exact / estimate to correct later estimates for the same model.
   */
  scale?: number;
}

/** Role markers around one message, as in ChatML: `<|im_start|>role\n … <|im_end|>\n`. */
const MESSAGE_OVERHEAD = 5;
/** The generation prompt that opens the reply (`<|im_start|>assistant\n`, a `<think>` tag). */
const REPLY_PRIMING = 4;
/** `<tool_call>`, the function name markup and argument wrapping around one call. */
const TOOL_CALL_OVERHEAD = 12;
/** `<tool_response>` wrapping around one result. */
const TOOL_RESULT_OVERHEAD = 6;
/** Reasoning markup (`<think>` and `</think>`). */
const REASONING_OVERHEAD = 4;
/**
 * The template's tool-use instructions, rendered once when tools are offered. Qwen3.8's are about
 * 250 tokens, Laguna's about 40, the fixtures' test template about 60.
 */
const TOOLS_PREAMBLE = 150;
/** Separators and the `{"type": "function", "function": …}` frame around one tool. */
const PER_TOOL_OVERHEAD = 10;

/** Letters in a word that come free with its first token. */
const FREE_LETTERS = 5;
/** Letters per extra token past those. */
const LETTERS_PER_TOKEN = 3;
/** Punctuation characters per token. */
const SYMBOLS_PER_TOKEN = 1.5;

/**
 * The pre-tokenizer cut shared (with small differences) by the Qwen3.x, Laguna, gpt-oss and
 * SmolLM2 tokenizers. Groups: 1 contraction, 2 word, 3 digit, 4 punctuation run, 5 whitespace.
 */
const PIECE =
  /('(?:[sdmt]|re|ve|ll))|([^\r\n\p{L}\p{N}]?\p{L}+)|(\p{N})|( ?[^\s\p{L}\p{N}]+[\r\n]*)|(\s*[\r\n]+|\s+(?!\S)|\s+)/giu;

function isAsciiLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function wordTokens(word: string): number {
  let ascii = 0;
  let wide = 0;
  let lead = 0;
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    if (isAsciiLetter(code)) {
      ascii++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // second half of a surrogate pair
    if (i === 0 && code !== 32) {
      // A leading symbol rarely merges with the word after it.
      lead = code < 128 ? 0.5 : 1;
      continue;
    }
    if (code > 127) wide++;
  }
  const letters =
    ascii > 0 ? 1 + Math.floor(Math.max(0, ascii - FREE_LETTERS) / LETTERS_PER_TOKEN) : 0;
  return letters + wide + lead;
}

function symbolTokens(run: string): number {
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < run.length; i++) {
    const code = run.charCodeAt(i);
    if (code === 10 || code === 13 || (i === 0 && code === 32)) continue;
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (code < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / SYMBOLS_PER_TOKEN) + wide;
}

/** Estimated tokens for one text (not rounded). */
export function textTokens(text: string): number {
  let total = 0;
  PIECE.lastIndex = 0;
  for (let m = PIECE.exec(text); m !== null; m = PIECE.exec(text)) {
    if (m[2] !== undefined) total += wordTokens(m[2]);
    else if (m[4] !== undefined) total += symbolTokens(m[4]);
    else total += 1;
  }
  return total;
}

function partsTokens(parts: readonly ContentPart[], imageTokens: number): number {
  let total = 0;
  for (const part of parts) total += part.type === "text" ? textTokens(part.text) : imageTokens;
  return total;
}

/** Estimated tokens for one message, including its template markup (not rounded). */
export function messageTokens(message: Message, imageTokens = DEFAULT_IMAGE_TOKENS): number {
  switch (message.role) {
    case "system":
      return MESSAGE_OVERHEAD + textTokens(message.content);
    case "user":
      return MESSAGE_OVERHEAD + partsTokens(message.content, imageTokens);
    case "assistant": {
      let total = MESSAGE_OVERHEAD + textTokens(message.content);
      if (message.reasoning) total += REASONING_OVERHEAD + textTokens(message.reasoning);
      for (const call of message.toolCalls) {
        total += TOOL_CALL_OVERHEAD + textTokens(call.name) + textTokens(call.arguments);
      }
      return total;
    }
    case "tool":
      return TOOL_RESULT_OVERHEAD + partsTokens(message.content, imageTokens);
  }
}

/** The tool as a template serialises it. A schema JSON cannot hold counts as a fixed amount. */
function toolJson(tool: ToolSchema): string {
  try {
    return JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  } catch {
    return `${tool.name} ${tool.description} ${"word ".repeat(500)}`;
  }
}

/** Estimated tokens for one tool's schema (not rounded). */
export function toolTokens(tool: ToolSchema): number {
  return PER_TOOL_OVERHEAD + textTokens(toolJson(tool));
}

export function createTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  const imageTokens = options.imageTokens ?? DEFAULT_IMAGE_TOKENS;
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1;
  // History is append-only and messages are never edited, so each is priced once.
  const messageCache = new WeakMap<Message, number>();
  const toolCache = new WeakMap<ToolSchema, number>();
  return {
    estimate({ messages, tools }) {
      let total = 0;
      if (tools.length > 0) {
        total += TOOLS_PREAMBLE;
        for (const tool of tools) {
          let cost = toolCache.get(tool);
          if (cost === undefined) {
            cost = toolTokens(tool);
            toolCache.set(tool, cost);
          }
          total += cost;
        }
      }
      for (const message of messages) {
        let cost = messageCache.get(message);
        if (cost === undefined) {
          cost = messageTokens(message, imageTokens);
          messageCache.set(message, cost);
        }
        total += cost;
      }
      if (messages.length > 0) total += REPLY_PRIMING;
      return Math.ceil(total * scale);
    },
  };
}
