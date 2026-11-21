import type { Endpoint } from "@dawg/models";
import type { ContentPart } from "@dawg/protocol";
import type { Message, ToolResultMessage } from "../contracts/messages.ts";
import type { ModelRequest, SamplingParams, ToolSchema } from "../contracts/model.ts";

/**
 * Builds OpenAI Chat Completions request bodies from engine messages.
 *
 * Determinism matters more than anything else here: the prompt cache reuses a slot only when the
 * rendered prompt repeats the previous one exactly, so the same input must always give the same
 * JSON, byte for byte. Every object below is built with a fixed key order, nothing depends on
 * time, randomness or Map/Set iteration, and caller-provided objects (tool schemas, `extraBody`)
 * are passed through untouched.
 *
 * Choices worth knowing:
 * - User and tool content that is text only becomes one string, the parts joined by a blank line.
 *   Templates render tool content with `{{ message.content }}`; on llama-server b12359 a tool
 *   message whose content is a parts array rendered as an empty tool response with a template
 *   that accepts typed content, so tool content is always a string.
 * - Images in tool results: OpenAI does not accept images in tool messages and most chat
 *   templates cannot render them there. The tool message keeps its text plus a short pointer, and
 *   the images follow in one user message placed right after the run of consecutive tool
 *   messages. That keeps every tool call answered by a tool message (templates require it) and
 *   is stable as history grows.
 * - When images are not sent (the endpoint lacks vision), each image becomes a short text note,
 *   because a server without a projector rejects the whole request (HTTP 500 on b12359).
 * - Assistant tool calls carry `arguments` (always valid JSON), never `rawArguments`: llama-server
 *   answers HTTP 500 when a template that wants object arguments meets arguments it cannot parse.
 */

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | {
      role: "assistant";
      content: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** Facts about the chat template that an `Endpoint` does not carry (read from `/props`). */
export interface TemplateFacts {
  /** `chat_template_caps.supports_parallel_tool_calls`. false drops `parallel_tool_calls`. */
  parallelToolCalls?: boolean;
  /** `chat_template_caps.reasoning_effort_levels`. A level not listed is not sent. */
  reasoningEffortLevels?: readonly string[];
}

export interface RequestBuildOptions {
  /** "send" passes images as data URLs; "omit" replaces each with a text note. */
  images: "send" | "omit";
  /** The assistant field that carries reasoning back to the server; null sends none. */
  reasoningField: "reasoning_content" | "reasoning" | null;
  /** Ask for a usage chunk through `stream_options`. */
  includeUsage: boolean;
  template?: TemplateFacts;
}

const PART_SEPARATOR = "\n\n";
const IMAGE_OMITTED = "[image omitted: this model cannot view images]";

function dataUrl(part: Extract<ContentPart, { type: "image" }>): string {
  return `data:${part.mediaType};base64,${part.data}`;
}

function textOnly(parts: readonly ContentPart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : IMAGE_OMITTED)).join(PART_SEPARATOR);
}

function userContent(parts: readonly ContentPart[], images: "send" | "omit") {
  if (images === "omit" || parts.every((p) => p.type === "text")) return textOnly(parts);
  return parts.map(
    (p): ChatContentPart =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image_url", image_url: { url: dataUrl(p) } },
  );
}

function imageCount(message: ToolResultMessage): number {
  return message.content.filter((p) => p.type === "image").length;
}

function toolContent(message: ToolResultMessage, images: "send" | "omit"): string {
  if (images === "omit") return textOnly(message.content);
  const text = message.content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(PART_SEPARATOR);
  const count = imageCount(message);
  if (count === 0) return text;
  const note = `[${count === 1 ? "1 image" : `${count} images`} from this result follow${count === 1 ? "s" : ""} the tool results]`;
  return text.length > 0 ? `${text}${PART_SEPARATOR}${note}` : note;
}

/** Converts engine history to OpenAI chat messages. Pure and deterministic. */
export function toChatMessages(
  messages: readonly Message[],
  options: Pick<RequestBuildOptions, "images" | "reasoningField">,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pendingImages: ChatContentPart[] = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    out.push({ role: "user", content: pendingImages });
    pendingImages = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flushImages();
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user":
        out.push({ role: "user", content: userContent(message.content, options.images) });
        break;
      case "assistant": {
        const entry: Extract<ChatMessage, { role: "assistant" }> = {
          role: "assistant",
          content: message.content,
        };
        if (options.reasoningField && message.reasoning) {
          entry[options.reasoningField] = message.reasoning;
        }
        if (message.toolCalls.length > 0) {
          entry.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          }));
        }
        out.push(entry);
        break;
      }
      case "tool": {
        out.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: toolContent(message, options.images),
        });
        if (options.images === "send" && imageCount(message) > 0) {
          pendingImages.push({
            type: "text",
            text: `Image output of tool call ${message.toolCallId} (${message.toolName}):`,
          });
          for (const part of message.content) {
            if (part.type === "image") {
              pendingImages.push({ type: "image_url", image_url: { url: dataUrl(part) } });
            }
          }
        }
        break;
      }
    }
  }
  flushImages();
  return out;
}

export function toChatTools(tools: readonly ToolSchema[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * Which sampler fields go to which endpoint kinds. The OpenAI-standard ones go everywhere;
 * llama.cpp's own samplers go only to servers built on llama.cpp (the bundled runtime, LM Studio,
 * Ollama), because strict OpenAI-compatible services reject unknown fields. Use `extraBody` to
 * send them to a remote llama-server or vLLM.
 */
export const SAMPLING_FIELDS: readonly {
  param: keyof SamplingParams;
  field: string;
  kinds: readonly Endpoint["kind"][];
}[] = [
  {
    param: "temperature",
    field: "temperature",
    kinds: ["bundled", "ollama", "lmstudio", "remote"],
  },
  { param: "topP", field: "top_p", kinds: ["bundled", "ollama", "lmstudio", "remote"] },
  { param: "topK", field: "top_k", kinds: ["bundled", "ollama", "lmstudio"] },
  { param: "minP", field: "min_p", kinds: ["bundled", "ollama", "lmstudio"] },
  { param: "repeatPenalty", field: "repeat_penalty", kinds: ["bundled", "ollama", "lmstudio"] },
  {
    param: "presencePenalty",
    field: "presence_penalty",
    kinds: ["bundled", "ollama", "lmstudio", "remote"],
  },
  {
    param: "frequencyPenalty",
    field: "frequency_penalty",
    kinds: ["bundled", "ollama", "lmstudio", "remote"],
  },
  { param: "seed", field: "seed", kinds: ["bundled", "ollama", "lmstudio", "remote"] },
];

/** The full chat request body for `stream()`. */
export function buildChatBody(
  endpoint: Endpoint,
  request: ModelRequest,
  options: RequestBuildOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: toChatMessages(request.messages, options),
  };
  const hasTools = request.tools.length > 0;
  if (hasTools) {
    body.tools = toChatTools(request.tools);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }
  body.stream = true;
  if (options.includeUsage) body.stream_options = { include_usage: true };
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  const sampling = request.sampling ?? {};
  for (const { param, field, kinds } of SAMPLING_FIELDS) {
    const value = sampling[param];
    if (value !== undefined && kinds.includes(endpoint.kind)) body[field] = value;
  }
  const levels = options.template?.reasoningEffortLevels;
  if (
    request.reasoningEffort !== undefined &&
    (levels === undefined || levels.includes(request.reasoningEffort))
  ) {
    body.reasoning_effort = request.reasoningEffort;
  }
  if (
    request.parallelToolCalls !== undefined &&
    hasTools &&
    options.template?.parallelToolCalls !== false
  ) {
    body.parallel_tool_calls = request.parallelToolCalls;
  }
  if (endpoint.kind === "bundled") {
    body.cache_prompt = true;
    if (request.slot !== undefined) body.id_slot = request.slot;
    body.timings_per_token = true;
    body.return_progress = true;
  }
  if (request.extraBody) Object.assign(body, request.extraBody);
  return body;
}

/** The body for the token-count endpoint: the same prompt, nothing else. */
export function buildCountBody(
  endpoint: Endpoint,
  request: Pick<ModelRequest, "messages" | "tools">,
  options: Pick<RequestBuildOptions, "images" | "reasoningField">,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: toChatMessages(request.messages, options),
  };
  if (request.tools.length > 0) body.tools = toChatTools(request.tools);
  return body;
}
