/**
 * An MCP tool's result as the model and the transcript get it. Text stays text; an image goes to
 * a model that can see; resources are given as text with their address. A result too long for
 * the conversation is saved whole to the session's `tool-results/` folder and replaced by its
 * start and the file's path, as Claude Code does (code.claude.com/docs/en/mcp, "MCP output
 * limits": more than 50,000 characters, or more than `MAX_MCP_OUTPUT_TOKENS`, default 25,000).
 */
import type { ContentPart, McpDisplay } from "@dawg/protocol";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ToolContext, ToolOutput } from "../contracts/tools.ts";

/** Characters of text an MCP result may put in the conversation (Claude Code's threshold). */
export const MCP_RESULT_MAX_CHARS = 50_000;
/** Tokens an MCP result may take, unless `MAX_MCP_OUTPUT_TOKENS` says otherwise. */
export const MCP_RESULT_MAX_TOKENS = 25_000;
/** Characters of a saved result's start given to the model with the file's path. */
export const MCP_RESULT_PREVIEW_CHARS = 2_000;
/** Characters of a result's text the transcript card shows. */
const DISPLAY_CHARS = 4_000;

/** The cap in characters: the smaller of the fixed cap and the token cap (four per token). */
export function resultCap(env: Readonly<Record<string, string | undefined>>): number {
  const tokens = Number(env.MAX_MCP_OUTPUT_TOKENS);
  const tokenCap = Number.isFinite(tokens) && tokens > 0 ? tokens : MCP_RESULT_MAX_TOKENS;
  return Math.min(MCP_RESULT_MAX_CHARS, Math.round(tokenCap * 4));
}

type Block = CallToolResult["content"][number];

function blockText(block: Block): string | null {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource": {
      const resource = block.resource as {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
      if (typeof resource.text === "string") return `Resource ${resource.uri}:\n${resource.text}`;
      const size =
        typeof resource.blob === "string" ? Math.floor((resource.blob.length * 3) / 4) : 0;
      return `[A binary resource, ${resource.uri} (${resource.mimeType ?? "unknown type"}, about ${size.toLocaleString("en-US")} bytes), not shown.]`;
    }
    case "resource_link":
      return `[A link to the resource ${block.uri}${block.name ? ` (${block.name})` : ""}.]`;
    case "audio":
      return `[Audio (${block.mimeType}), not shown.]`;
    default:
      return null;
  }
}

/** Turns a tool's result into what the model is given, and the card's display. */
export async function toolOutput(
  result: CallToolResult,
  info: { server: string; tool: string; maxChars: number },
  ctx: Pick<ToolContext, "vision" | "saveOutput">,
): Promise<ToolOutput> {
  const parts: ContentPart[] = [];
  const texts: string[] = [];
  let images = 0;
  for (const block of result.content ?? []) {
    if (block.type === "image") {
      images += 1;
      if (ctx.vision) {
        parts.push({ type: "image", mediaType: block.mimeType, data: block.data });
        texts.push(`[An image (${block.mimeType}).]`);
      } else {
        const line = `[An image (${block.mimeType}), which this model cannot see.]`;
        parts.push({ type: "text", text: line });
        texts.push(line);
      }
      continue;
    }
    const text = blockText(block);
    if (text !== null) {
      parts.push({ type: "text", text });
      texts.push(text);
    }
  }
  // A result with only structured content is given as its JSON.
  if (texts.length === 0 && result.structuredContent !== undefined) {
    const text = JSON.stringify(result.structuredContent, null, 2);
    parts.push({ type: "text", text });
    texts.push(text);
  }
  const isError = result.isError === true;
  if (parts.length === 0) {
    const text = isError ? "The tool failed and said nothing more." : "The tool returned nothing.";
    parts.push({ type: "text", text });
    texts.push(text);
  }

  const whole = parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  let content = parts;
  let savedTo: string | null = null;
  if (!isError && whole.length > info.maxChars) {
    const size = whole.length.toLocaleString("en-US");
    try {
      savedTo = await ctx.saveOutput(`mcp-${info.server}-${info.tool}.txt`, whole);
      content = [
        {
          type: "text",
          text: `${whole.slice(0, MCP_RESULT_PREVIEW_CHARS)}\n\n[The whole result is ${size} characters, more than an MCP result may put in the conversation. It was saved to ${savedTo}. Read it in parts with Read (offset and limit), or search it with Grep.]`,
        },
        ...parts.filter((p) => p.type === "image"),
      ];
    } catch (error) {
      content = [
        {
          type: "text",
          text: `${whole.slice(0, info.maxChars)}\n\n[The result was cut at ${info.maxChars.toLocaleString("en-US")} of ${size} characters and could not be saved (${error instanceof Error ? error.message : String(error)}).]`,
        },
      ];
    }
  }
  const shown = texts.join("\n");
  const display: McpDisplay = {
    kind: "mcp",
    server: info.server,
    tool: info.tool,
    text: shown.length > DISPLAY_CHARS ? `${shown.slice(0, DISPLAY_CHARS)}…` : shown,
    images,
    isError,
    chars: whole.length,
    savedTo,
  };
  return { content, isError, display };
}
