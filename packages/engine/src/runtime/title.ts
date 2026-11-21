/**
 * Session titles, written by a separate small request. It shares nothing with the conversation:
 * its own messages, no tools, and the side slot the model provider names, so it can neither
 * change the conversation's history nor evict its prompt cache.
 */
import type { ModelClient, ModelUsage } from "../contracts/model.ts";

export const TITLE_INSTRUCTIONS =
  "Write a short title for a coding session that begins with the request below: three to seven words, plain text, no quotes and no full stop. Reply with the title only.";

const MAX_PROMPT_CHARS = 2_000;
const MAX_TITLE_CHARS = 80;

export interface TitleRequest {
  client: ModelClient;
  slot?: number;
  promptText: string;
  /** The weakest effort level the model accepts, when it has levels. */
  effort?: string;
  /** Template options the model's profile asks for (`chat_template_kwargs`). */
  extraBody?: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export async function generateTitle(
  request: TitleRequest,
): Promise<{ title: string | null; usage: ModelUsage | null }> {
  let text = "";
  let usage: ModelUsage | null = null;
  for await (const event of request.client.stream({
    messages: [
      { role: "system", content: TITLE_INSTRUCTIONS },
      {
        role: "user",
        kind: "prompt",
        content: [{ type: "text", text: request.promptText.slice(0, MAX_PROMPT_CHARS) }],
      },
    ],
    tools: [],
    maxOutputTokens: 256,
    sampling: { temperature: 0.2 },
    ...(request.slot === undefined ? {} : { slot: request.slot }),
    ...(request.effort === undefined ? {} : { reasoningEffort: request.effort }),
    ...(request.extraBody === undefined ? {} : { extraBody: request.extraBody }),
    signal: request.signal,
  })) {
    if (event.type === "finished") {
      text = event.reply.content;
      usage = event.reply.usage;
    }
  }
  return { title: cleanTitle(text), usage };
}

export function cleanTitle(raw: string): string | null {
  const line =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  let title = line
    .replace(/^(title\s*:\s*)/i, "")
    .replace(/^[#*_`"'\s]+|[#*_`"'\s]+$/g, "")
    .replace(/[.]+$/, "")
    .trim();
  if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
  return title === "" ? null : title;
}
