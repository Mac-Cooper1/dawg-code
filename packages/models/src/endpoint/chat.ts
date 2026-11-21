import { z } from "zod";
import type { Endpoint } from "../types.ts";
import { requestJson, trimSlash } from "./http.ts";

export class EndpointError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EndpointError";
    this.status = status;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOnceOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Extra request fields, passed through as-is. */
  extra?: Record<string, unknown>;
}

export interface ChatOnceResult {
  content: string;
  /** `reasoning_content` (llama.cpp, DeepSeek style) or `reasoning` (Ollama, OpenRouter). */
  reasoning?: string;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
  model?: string;
  raw: unknown;
}

const responseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.string().nullable().optional(),
            message: z
              .object({
                content: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                reasoning: z.string().nullable().optional(),
              })
              .loose(),
          })
          .loose(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        prompt_tokens_details: z
          .object({ cached_tokens: z.number().optional() })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** One non-streamed chat completion against any endpoint. For smoke checks, not the agent loop. */
export async function chatOnce(
  endpoint: Endpoint,
  input: string | ChatOnceOptions,
): Promise<ChatOnceResult> {
  const options: ChatOnceOptions =
    typeof input === "string" ? { messages: [{ role: "user", content: input }] } : input;
  const result = await requestJson(`${trimSlash(endpoint.baseUrl)}/chat/completions`, {
    apiKey: endpoint.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 120_000,
    signal: options.signal,
    body: {
      ...options.extra,
      model: endpoint.model,
      messages: options.messages,
      stream: false,
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    },
  });
  if (!result.ok) {
    throw new EndpointError(`chat completion failed: ${result.message}`, result.status);
  }
  const parsed = responseSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new EndpointError("chat completion returned an unexpected body", result.status);
  }
  const choice = parsed.data.choices[0];
  const message = choice?.message;
  const usage = parsed.data.usage;
  return {
    content: message?.content ?? "",
    reasoning: message?.reasoning_content ?? message?.reasoning ?? undefined,
    finishReason: choice?.finish_reason ?? undefined,
    usage: usage && {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens,
    },
    model: parsed.data.model,
    raw: result.data,
  };
}
