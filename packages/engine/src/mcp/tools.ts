/**
 * MCP tools as the model sees them. Each server's tool is a tool of its own, named
 * `mcp__<server>__<tool>` (names.ts), whose calls go to the server. When their schemas would take
 * too much of the context window, a session offers two fixed tools instead (spec, "Keeping the
 * prompt stable"): `ToolSearch`, which returns tools' full schemas as its result, and
 * `CallMcpTool`, which calls one by name with arguments checked against its schema. Either way
 * permission rules and hooks see the real `mcp__` name: `CallMcpTool` hands each call to the tool
 * it names (`ToolDefinition.resolve`) before anything judges it.
 */
import type { Tool } from "@modelcontextprotocol/client";
import type { JsonSchema } from "../contracts/model.ts";
import type { AnyTool, ToolDefinition, ToolProbeContext } from "../contracts/tools.ts";
import { MCP_DISPATCHER, validateToolInput } from "../toolcall/index.ts";
import type { SessionMcp } from "./session-mcp.ts";

/** Where a session keeps its MCP view in the tools' state bag. */
export const MCP_STATE_KEY = "mcp.session";

/** Characters of a tool's description sent with its schema (Claude Code's upfront limit). */
export const MCP_DESCRIPTION_MAX_CHARS = 4_096;
/** Characters of a description ToolSearch returns (Claude Code's limit for searched tools). */
export const MCP_SEARCH_DESCRIPTION_MAX_CHARS = 16_384;

export const TOOL_SEARCH = "ToolSearch";

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A server's schema as a JSON Schema object: an object, whatever the server wrote. */
export function inputSchemaOf(tool: Tool): JsonSchema {
  const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  return { ...schema, type: "object" } as JsonSchema;
}

function sessionOf(ctx: Pick<ToolProbeContext, "state">): SessionMcp | null {
  return ctx.state.get<SessionMcp | null>(MCP_STATE_KEY, () => null);
}

/**
 * One server tool as a tool of the session. Its description and schema are what the server
 * listed when the tool was made; the call goes to the server as it is then.
 */
export function mcpTool(server: string, fullName: string, tool: Tool, mcp: SessionMcp): AnyTool {
  const description = (tool.description ?? tool.title ?? "").trim();
  const definition: ToolDefinition<Record<string, unknown>> = {
    name: fullName,
    description: cut(
      description === "" ? `The ${tool.name} tool of the ${server} MCP server.` : description,
      MCP_DESCRIPTION_MAX_CHARS,
    ),
    inputSchema: inputSchemaOf(tool),
    readOnly: tool.annotations?.readOnlyHint === true,
    // Nothing the engine can judge inside: rules match the tool's name, as documented.
    permission: () => ({ kind: "other", specifier: null }),
    execute: (input, ctx) => mcp.callTool(server, tool.name, input, ctx),
  };
  return definition;
}

interface ToolSearchInput {
  query: string;
  max_results?: number;
}

export const toolSearchTool: ToolDefinition<ToolSearchInput> = {
  name: TOOL_SEARCH,
  description:
    "Finds tools of the MCP servers connected to this session and returns their full input schemas. Search with words that describe what you need, or ask for exact tools with select:<name>,<name>. Then call a tool with CallMcpTool, giving its name and arguments that match its schema.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          'Words to search the tools\' names and descriptions for, or "select:" and exact tool names separated by commas.',
      },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "The most tools to return (default 5).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  readOnly: true,
  permission: () => ({ kind: "none" }),
  async execute(input, ctx) {
    const mcp = sessionOf(ctx);
    if (mcp === null) {
      return { content: [{ type: "text", text: "No MCP servers are connected." }], isError: true };
    }
    return {
      content: [{ type: "text", text: mcp.searchText(input.query, input.max_results ?? 5) }],
    };
  },
};

interface CallInput {
  name: string;
  arguments?: Record<string, unknown>;
}

export const callMcpTool: ToolDefinition<CallInput> = {
  name: MCP_DISPATCHER,
  description:
    "Calls a tool of an MCP server by its full name (mcp__<server>__<tool>) with arguments that match its input schema. Get the schema from ToolSearch first.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The tool's full name, as ToolSearch or the listing gives it.",
      },
      arguments: {
        type: "object",
        description: "The tool's input, matching its schema.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  readOnly: false,
  // Never judged itself: `resolve` hands each call to the tool it names.
  permission: () => ({ kind: "other", specifier: null }),
  resolve(input, ctx) {
    const mcp = sessionOf(ctx);
    if (mcp === null) return { error: "Error: no MCP servers are connected to this session." };
    return mcp.dispatch(input.name, input.arguments ?? {});
  },
  async execute(input, ctx) {
    // Reached only when nothing resolved the call first: resolve and run it here.
    const resolved = callMcpTool.resolve?.(input, ctx);
    if (resolved === undefined || "error" in resolved) {
      return {
        content: [{ type: "text", text: resolved?.error ?? "Error: the call could not be made." }],
        isError: true,
      };
    }
    return resolved.tool.execute(resolved.input, ctx);
  },
};

/** Checks arguments against a server tool's schema, for the dispatcher. */
export function checkArguments(
  fullName: string,
  tool: Tool,
  args: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const checked = validateToolInput(
    { name: fullName, description: tool.description ?? "", parameters: inputSchemaOf(tool) },
    args,
  );
  if (checked.ok) return { ok: true, value: checked.value };
  const issues = checked.issues
    .map((i) => (i.path === "" ? i.problem : `${i.path}: ${i.problem}`))
    .join("; ");
  return {
    ok: false,
    error: `Error: the arguments for ${fullName} do not match its schema (${issues}). Call ToolSearch with select:${fullName} to see the schema, then call it again.`,
  };
}
