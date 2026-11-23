/**
 * Per-model settings, chosen by a catalog entry's `profile` id (catalog/catalog.json).
 *
 * Sampler and reasoning settings come from each model's own published recommendations: its model
 * card on Hugging Face, its generation_config.json and its chat_template.jinja, all read on
 * 2026-11-21 at the repos' main revisions. Where a source gives no value, the comment says so and
 * gives the reason for the value chosen. Unset sampler fields use the server's defaults.
 *
 * Choices made the same way for every model:
 * - `compactionThreshold` 0.65: the spec's default (PLAN.md section 7 asks for 60–70%). None of
 *   the cards says anything about it. It applies before a turn starts; within a turn the runtime
 *   compacts only when the next reply might not fit.
 * - `maxOutputTokens` is a ceiling, not a reservation: the runtime cuts each request's limit to
 *   what is left of the window.
 */
import type { ModelProfile } from "../contracts/prompt.ts";

/**
 * A profile plus settings the `ModelProfile` contract has no field for yet (proposed as a
 * contract change): chat-template options that must be sent with every request, as
 * `chat_template_kwargs`, because the template's own default is wrong for an agent.
 */
export interface ModelProfileDetails extends ModelProfile {
  chatTemplateKwargs: Readonly<Record<string, unknown>> | null;
}

/** Qwen3.8-27B (dense, thinking on by default). Sources: https://huggingface.co/Qwen/Qwen3.8-27B */
const QWEN38: ModelProfileDetails = {
  id: "qwen3.8",
  // Model card, "Best Practices" 1, thinking mode: temperature=1.0, top_p=0.95, top_k=20,
  // min_p=0.0, presence_penalty=0.0, repetition_penalty=1.0. generation_config.json agrees
  // (temperature 1.0, top_k 20, top_p 0.95).
  sampling: {
    temperature: 1.0,
    topP: 0.95,
    topK: 20,
    minP: 0.0,
    presencePenalty: 0.0,
    repeatPenalty: 1.0,
  },
  // Card: reasoning_effort levels xhigh (default), medium, low, and "lower reasoning effort does
  // not always reduce overall task completion time" in multi-turn agentic tasks. So the
  // template's own default (xhigh) is kept.
  defaultEffort: null,
  // Card, benchmark notes: QwenSWEBench ran "with the Claude Code harness ... max_tokens=32,768".
  // Its "Adequate Output Length" advice (262,144 reasoning + 131,072 answer) does not fit our
  // windows, so the harness setting is used.
  maxOutputTokens: 32_768,
  compactionThreshold: 0.65,
  // Card: no advice. chat_template.jinja renders every entry of message.tool_calls, so several
  // calls in one reply round-trip correctly.
  parallelToolCalls: true,
  // Card: preserve_thinking "is enabled by default"; the template keeps all reasoning unless it
  // is set to false. Nothing to send.
  chatTemplateKwargs: null,
};

/**
 * Qwen3.6-35B-A3B (sparse, 3B active, thinking on by default).
 * Sources: https://huggingface.co/Qwen/Qwen3.6-35B-A3B
 */
const QWEN36: ModelProfileDetails = {
  id: "qwen3.6",
  // Card, "Best Practices" 1, "Thinking mode for precise coding tasks (e.g., WebDev)":
  // temperature=0.6, top_p=0.95, top_k=20, min_p=0.0, presence_penalty=0.0,
  // repetition_penalty=1.0. (generation_config.json and the card's agentic benchmark notes use
  // temperature 1.0 and top_p 0.95; the coding set is chosen because an agent's edits and tool
  // calls are precise work, and a lower temperature means fewer malformed calls on a 4-bit
  // quant. The eval suite should settle it.)
  sampling: {
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    minP: 0.0,
    presencePenalty: 0.0,
    repeatPenalty: 1.0,
  },
  // Card and template: no reasoning-effort levels.
  defaultEffort: null,
  // Card, "Best Practices" 2: "an output length of 32,768 tokens for most queries".
  maxOutputTokens: 32_768,
  compactionThreshold: 0.65,
  // Card: no advice. chat_template.jinja renders every entry of message.tool_calls.
  parallelToolCalls: true,
  // Card, "Preserve Thinking": by default only the reasoning after the latest user message is
  // kept; the model "has been additionally trained to preserve and leverage thinking traces",
  // which is "particularly beneficial for agent scenarios" and improves KV-cache use. Without it
  // the template drops earlier reasoning whenever a user message arrives, and our notes are user
  // messages, so the rendered prefix would change under the cache on every note.
  chatTemplateKwargs: { preserve_thinking: true },
};

/**
 * Laguna XS 2.1 (sparse, 3B active, thinking optional).
 * Sources: https://huggingface.co/poolside/Laguna-XS-2.1 (the GGUF repo's card gives no
 * settings).
 */
const LAGUNA_XS_21: ModelProfileDetails = {
  id: "laguna-xs-2.1",
  // Card, evaluation notes: "temperature=1.0, top_k=20 and top_p=1, with thinking mode enabled".
  // generation_config.json: temperature 1.0, top_p 1.0, min_p 0.0, top_k 20. No penalties are
  // given anywhere, so the server defaults (none) apply.
  sampling: { temperature: 1.0, topP: 1.0, topK: 20, minP: 0.0 },
  // No reasoning-effort levels in the card or template.
  defaultEffort: null,
  // generation_config.json: max_new_tokens 32768.
  maxOutputTokens: 32_768,
  compactionThreshold: 0.65,
  // Card: no advice. chat_template.jinja renders every entry of message.tool_calls.
  parallelToolCalls: true,
  // chat_template.jinja defaults enable_thinking to false, while generation_config.json sets
  // default_chat_template_kwargs {"enable_thinking": true} and the card says "For agentic coding
  // use cases, we recommend enabling thinking and preserving reasoning in message history". With
  // it on, the template also keeps the reasoning of every earlier reply.
  chatTemplateKwargs: { enable_thinking: true },
};

/**
 * gpt-oss-20b (sparse, harmony format, reasoning effort low/medium/high).
 * Sources: https://huggingface.co/openai/gpt-oss-20b and https://github.com/openai/gpt-oss
 */
const GPT_OSS: ModelProfileDetails = {
  id: "gpt-oss",
  // github.com/openai/gpt-oss README, "Recommended Sampling Parameters": "temperature=1.0 and
  // top_p=1.0". The Hugging Face card and generation_config.json give none. topK 0 and minP 0
  // are our choice: they switch off llama-server's default top_k 40 and min_p 0.05, which would
  // otherwise cut the distribution that recommendation leaves whole.
  sampling: { temperature: 1.0, topP: 1.0, topK: 0, minP: 0.0 },
  // Card: effort low, medium or high, set through the system prompt; chat_template.jinja
  // defaults it to "medium". The template's default is kept until the eval suite says otherwise.
  defaultEffort: null,
  // No source gives a value. Our choice: the same ceiling as the other catalog models, room
  // enough for high-effort reasoning before a long file.
  maxOutputTokens: 32_768,
  compactionThreshold: 0.65,
  // chat_template.jinja: "We assume max 1 tool call per message" and renders only
  // tool_calls[0], so a second call in one reply would vanish from history.
  parallelToolCalls: false,
  chatTemplateKwargs: null,
};

/** For models not in the catalog (a GGUF loaded by hand, a remote endpoint). */
export const DEFAULT_PROFILE: ModelProfileDetails = {
  id: "default",
  // Unknown model: its own or the server's defaults are the best guess we have.
  sampling: {},
  defaultEffort: null,
  // Our choice: smaller than the catalog models' ceiling, because an unknown model may have a
  // small window.
  maxOutputTokens: 16_384,
  compactionThreshold: 0.65,
  // Our choice: many templates render only one call per reply, so ask for one at a time.
  parallelToolCalls: false,
  chatTemplateKwargs: null,
};

const PROFILES: ReadonlyMap<string, ModelProfileDetails> = new Map(
  [QWEN38, QWEN36, LAGUNA_XS_21, GPT_OSS].map((p) => [p.id, p]),
);

/** The profile ids we ship, in a fixed order. */
export function listModelProfileIds(): string[] {
  return [...PROFILES.keys()];
}

export function hasModelProfile(id: string): boolean {
  return PROFILES.has(id);
}

/** The profile for a catalog `profile` id, or `DEFAULT_PROFILE` for an unknown or missing one. */
export function getModelProfile(id: string | null | undefined): ModelProfileDetails {
  const found = id === null || id === undefined ? undefined : PROFILES.get(id);
  return copyProfile(found ?? DEFAULT_PROFILE);
}

/** A copy, so a caller that changes its profile cannot change everyone's. */
function copyProfile(profile: ModelProfileDetails): ModelProfileDetails {
  return {
    ...profile,
    sampling: { ...profile.sampling },
    chatTemplateKwargs:
      profile.chatTemplateKwargs === null ? null : { ...profile.chatTemplateKwargs },
  };
}
