/**
 * Anthropic Messages request → OpenAI Chat Completions request.
 *
 * Sources (public API references):
 * - Messages API: https://platform.claude.com/docs/en/api/messages
 *   (system, messages, content blocks text/image/tool_use/tool_result/thinking/redacted_thinking/
 *   document, tools with input_schema, tool_choice auto/any/tool/none + disable_parallel_tool_use,
 *   max_tokens, temperature, top_p, stop_sequences, stream, metadata)
 * - Chat Completions: https://platform.openai.com/docs/api-reference/chat/create
 *   (messages system/user/assistant/tool, content parts text/image_url, tool_calls, tools
 *   [{type:"function", function:{name, description, parameters}}], tool_choice
 *   "none"|"auto"|"required"|{type:"function",function:{name}}, parallel_tool_calls, stop,
 *   stream_options.include_usage)
 *
 * Anything we do not map (cache_control, citations, server tools, thinking config, metadata,
 * output_config, service_tier, beta-only fields...) is dropped, never rejected.
 */

import { isRecord } from "../chat-accumulator.ts";

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationError";
  }
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiContentPart[] | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  /** llama-server (and DeepSeek-style servers) accept prior reasoning on assistant turns. */
  reasoning_content?: string;
}

export interface TranslateOptions {
  /** Model to request upstream instead of the one the client named. */
  upstreamModel: string | null;
  /** Add stream_options.include_usage on streamed requests. */
  includeUsage: boolean;
}

export interface TranslatedRequest {
  body: Record<string, unknown>;
  /** The model the client asked for (echoed back in responses). */
  requestedModel: string;
  stream: boolean;
}

export function translateRequest(input: unknown, options: TranslateOptions): TranslatedRequest {
  if (!isRecord(input)) throw new TranslationError("request body must be a JSON object");
  if (!Array.isArray(input.messages)) throw new TranslationError("messages: field required");
  const requestedModel = typeof input.model === "string" ? input.model : "";
  const stream = input.stream === true;

  const messages: OpenAiMessage[] = [];
  const systemText = systemToText(input.system);
  if (systemText !== null) messages.push({ role: "system", content: systemText });
  for (const message of input.messages) messages.push(...translateMessage(message));

  const body: Record<string, unknown> = {
    model: options.upstreamModel ?? requestedModel,
    messages,
  };
  if (typeof input.max_tokens === "number") body.max_tokens = input.max_tokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (typeof input.top_p === "number") body.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences)) {
    const stops = input.stop_sequences.filter((s): s is string => typeof s === "string");
    if (stops.length > 0) body.stop = stops;
  }

  const tools = translateTools(input.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = translateToolChoice(input.tool_choice, tools);
    if (choice.toolChoice !== undefined) body.tool_choice = choice.toolChoice;
    if (choice.parallel === false) body.parallel_tool_calls = false;
  }

  if (stream) {
    body.stream = true;
    if (options.includeUsage) body.stream_options = { include_usage: true };
  }
  return { body, requestedModel, stream };
}

/** `system` as a string, or an array of text blocks. */
export function systemToText(system: unknown): string | null {
  if (typeof system === "string") return system.length > 0 ? system : null;
  if (Array.isArray(system)) {
    const parts = system
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .filter((text) => text.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}

function translateMessage(message: unknown): OpenAiMessage[] {
  if (!isRecord(message)) return [];
  const role = message.role;
  const content = message.content;
  if (role === "assistant") return [translateAssistant(content)];
  if (role === "system") {
    const text = blocksToPlainText(content);
    return text ? [{ role: "system", content: text }] : [];
  }
  // Treat anything else as a user turn.
  return translateUser(content);
}

function translateUser(content: unknown): OpenAiMessage[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [];
  const toolMessages: OpenAiMessage[] = [];
  const toolImages: OpenAiContentPart[] = [];
  const parts: OpenAiContentPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    switch (block.type) {
      case "tool_result": {
        const result = toolResultContent(block);
        toolMessages.push({
          role: "tool",
          tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: result.text,
        });
        if (result.images.length > 0) {
          toolImages.push({
            type: "text",
            text: `Image output of tool call ${String(block.tool_use_id ?? "")}:`,
          });
          toolImages.push(...result.images);
        }
        break;
      }
      default: {
        const part = userPart(block);
        if (part) parts.push(part);
      }
    }
  }
  // OpenAI requires tool messages to follow the assistant turn directly, before any user text.
  const out: OpenAiMessage[] = [...toolMessages];
  const userParts = [...toolImages, ...parts];
  if (userParts.length > 0) out.push({ role: "user", content: compactParts(userParts) });
  return out;
}

function userPart(block: Record<string, unknown>): OpenAiContentPart | null {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" && block.text.length > 0
        ? { type: "text", text: block.text }
        : null;
    case "image":
      return imagePart(block);
    case "document":
      return documentPart(block);
    case "search_result": {
      const text = blocksToPlainText(block.content);
      return text ? { type: "text", text } : null;
    }
    default:
      // thinking blocks in user turns, server tool results, unknown future blocks: dropped.
      return null;
  }
}

function imagePart(block: Record<string, unknown>): OpenAiContentPart | null {
  const source = block.source;
  if (!isRecord(source)) return null;
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return { type: "text", text: `[image omitted: unsupported source type ${String(source.type)}]` };
}

function documentPart(block: Record<string, unknown>): OpenAiContentPart | null {
  const source = block.source;
  if (!isRecord(source)) return null;
  const title = typeof block.title === "string" ? `${block.title}\n` : "";
  if (source.type === "text" && typeof source.data === "string") {
    return { type: "text", text: `${title}${source.data}` };
  }
  if (source.type === "content") {
    const text = blocksToPlainText(source.content);
    return text ? { type: "text", text: `${title}${text}` } : null;
  }
  const kind = typeof source.media_type === "string" ? source.media_type : String(source.type);
  return { type: "text", text: `[document omitted: ${kind}]` };
}

function toolResultContent(block: Record<string, unknown>): {
  text: string;
  images: OpenAiContentPart[];
} {
  const images: OpenAiContentPart[] = [];
  let text = "";
  const content = block.content;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
      else if (item.type === "image") {
        const part = imagePart(item);
        if (part?.type === "image_url") {
          images.push(part);
          texts.push("[image attached below]");
        } else if (part) texts.push(part.text);
      } else if (item.type === "document") {
        const part = documentPart(item);
        if (part?.type === "text") texts.push(part.text);
      } else if (item.type === "search_result") {
        const inner = blocksToPlainText(item.content);
        if (inner) texts.push(inner);
      }
    }
    text = texts.join("\n");
  }
  if (block.is_error === true) text = text ? `Error: ${text}` : "Error";
  return { text, images };
}

function translateAssistant(content: unknown): OpenAiMessage {
  if (typeof content === "string") return { role: "assistant", content };
  const texts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "thinking" && typeof block.thinking === "string") {
        if (block.thinking) reasoning.push(block.thinking);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : "",
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "",
            arguments: stringifyInput(block.input),
          },
        });
      }
      // redacted_thinking (opaque), server_tool_use and server tool results: dropped.
    }
  }
  const text = texts.join("");
  const message: OpenAiMessage = {
    role: "assistant",
    content: text.length > 0 || toolCalls.length === 0 ? text : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("\n");
  return message;
}

function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return "{}";
  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

function compactParts(parts: OpenAiContentPart[]): string | OpenAiContentPart[] {
  // Plain text is the most widely supported form; keep the array only for images.
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n");
  }
  return parts;
}

function blocksToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
}

interface OpenAiTool {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

/** Custom tools only (they carry `input_schema`); server tools are dropped. */
export function translateTools(tools: unknown): OpenAiTool[] {
  if (!Array.isArray(tools)) return [];
  const out: OpenAiTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    if (tool.type !== undefined && tool.type !== "custom") continue;
    if (!isRecord(tool.input_schema)) continue;
    const fn: OpenAiTool["function"] = { name: tool.name, parameters: tool.input_schema };
    if (typeof tool.description === "string" && tool.description) {
      fn.description = tool.description;
    }
    out.push({ type: "function", function: fn });
  }
  return out;
}

export function translateToolChoice(
  choice: unknown,
  tools: OpenAiTool[],
): { toolChoice: unknown; parallel: boolean | undefined } {
  if (!isRecord(choice)) return { toolChoice: undefined, parallel: undefined };
  const parallel = choice.disable_parallel_tool_use === true ? false : undefined;
  switch (choice.type) {
    case "auto":
      return { toolChoice: "auto", parallel };
    case "any":
      return { toolChoice: "required", parallel };
    case "none":
      return { toolChoice: "none", parallel: undefined };
    case "tool": {
      const name = typeof choice.name === "string" ? choice.name : "";
      if (!tools.some((t) => t.function.name === name)) {
        // Forcing a tool we dropped (or that does not exist) would be rejected upstream.
        return { toolChoice: "required", parallel };
      }
      return { toolChoice: { type: "function", function: { name } }, parallel };
    }
    default:
      return { toolChoice: undefined, parallel };
  }
}
