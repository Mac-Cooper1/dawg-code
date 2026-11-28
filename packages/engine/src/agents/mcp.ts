/**
 * The MCP tools a typed subagent gets (Phase 4 spec, "Subagents"; Claude Code's subagents docs,
 * "Available tools" and "Scope MCP servers to a subagent"):
 *
 * - With no `tools` list it gets the session's MCP tools, as the docs say a subagent inherits
 *   the main conversation's built-in and MCP tools.
 * - With a list, the MCP tools it names: an exact `mcp__server__tool`, a prefix ending in `*`
 *   (`mcp__github__*`, every tool of one server; `mcp__*`, every MCP tool), or a server alone
 *   (`mcp__github`), which is how permission rules name a whole server.
 * - Every server named in `mcpServers` (a configured one by reference, or one of its own) is
 *   granted whole, whatever `tools` says: naming the server there is the grant.
 * - `disallowedTools` takes them away with the same forms; as documented, `mcp__reports__*`
 *   also withholds a server named `reports__v2`, since names are matched by prefix.
 *
 * In deferred mode `ToolSearch` and `CallMcpTool` reach only what the agent may use (the
 * session's MCP view is opened with this filter, ../mcp/session-mcp.ts), and the resource tools
 * only its servers. A server of its own (an inline definition) is opened as the agent session's
 * own server; one from a project file is project-supplied code and runs only once the person has
 * approved the project's code (it is in the trust hash, ../trust/definitions.ts).
 */
import { PROJECT_WITHHELD_VARIABLES } from "@dawg/compat";
import { normalizeName } from "../mcp/names.ts";
import { LIST_MCP_RESOURCES, READ_MCP_RESOURCE } from "../mcp/resource-tools.ts";
import type { McpToolFilter } from "../mcp/session-mcp.ts";
import { TOOL_SEARCH } from "../mcp/tools.ts";
import { MCP_DISPATCHER } from "../toolcall/index.ts";

/** The tools that come with MCP servers rather than from one. */
export const FIXED_MCP_TOOLS: ReadonlySet<string> = new Set([
  TOOL_SEARCH,
  MCP_DISPATCHER,
  LIST_MCP_RESOURCES,
  READ_MCP_RESOURCE,
]);

/** Whether a `tools` or `disallowedTools` entry names MCP tools. */
export function isMcpEntry(entry: string): boolean {
  return entry === "mcp__*" || entry.startsWith("mcp__");
}

/** Whether one entry matches a tool's full name (`mcp__server__tool`). */
function matches(entry: string, fullName: string): boolean {
  if (entry.endsWith("*")) return fullName.startsWith(entry.slice(0, -1));
  if (entry === fullName) return true;
  // A server alone: `mcp__github` names every tool of github.
  return entry.split("__").length === 2 && fullName.startsWith(`${entry}__`);
}

/** Whether an entry could match some tool of a server. */
function reachesServer(entry: string, server: string): boolean {
  const prefix = `mcp__${normalizeName(server)}__`;
  if (entry.endsWith("*")) {
    const head = entry.slice(0, -1);
    return prefix.startsWith(head) || head.startsWith(prefix);
  }
  return entry.startsWith(prefix) || `${entry}__` === prefix;
}

/** What a typed agent may use of the session's MCP servers. */
export interface AgentMcpAccess extends McpToolFilter {
  /** Its own servers (approved), to open as its session's own, by name. */
  readonly servers: Readonly<Record<string, unknown>>;
  /** Whether a tool that comes with MCP servers (ToolSearch, CallMcpTool, the resource tools) stays. */
  keeps(toolName: string): boolean;
  /** Sentences for the agent's notes: servers left out, and why. */
  readonly notes: readonly string[];
}

export interface AgentMcpInput {
  /** `tools` as written (entries with a specifier are not MCP names); null for every tool. */
  tools: readonly string[] | null;
  disallowedTools: readonly string[];
  /** `mcpServers`, in order. */
  mcpServers: readonly { name: string; inline: Readonly<Record<string, unknown>> | null }[];
  /** Its servers of its own may start: the person's dawg file, or another that is approved. */
  inlineAllowed: boolean;
  /** From a project's file: a server of its own never gets the withheld variables. */
  fromProject: boolean;
}

/** `${NAME}` and `${NAME:-default}` references in a definition. */
function variablesIn(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
      out.add(match[1] as string);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) variablesIn(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) variablesIn(item, out);
  }
  return out;
}

/**
 * The agent's MCP access, or null when it gets no MCP tools at all: its `tools` list names
 * none and it names no servers, or `disallowedTools` withholds every one (`mcp__*`).
 */
export function agentMcpAccess(input: AgentMcpInput): AgentMcpAccess | null {
  const denied = input.disallowedTools.filter(isMcpEntry);
  if (denied.includes("mcp__*")) return null;
  const listed = input.tools === null ? null : input.tools.filter(isMcpEntry);
  const named = new Set(input.mcpServers.map((s) => s.name));
  if (listed !== null && listed.length === 0 && named.size === 0) return null;

  const notes: string[] = [];
  const servers: Record<string, unknown> = {};
  for (const entry of input.mcpServers) {
    if (entry.inline === null) continue;
    if (!input.inlineAllowed) {
      notes.push(
        input.fromProject
          ? `Its MCP server ${entry.name} is defined in the project's files, so it starts once you approve the project's code.`
          : `Its MCP server ${entry.name} is defined in Claude Code's agent files in your home folder, so it starts once you approve it.`,
      );
      continue;
    }
    if (input.fromProject) {
      const withheld = [...variablesIn(entry.inline, new Set())].filter((name) =>
        PROJECT_WITHHELD_VARIABLES.has(name),
      );
      if (withheld.length > 0) {
        notes.push(
          `Its MCP server ${entry.name} is left out: a project's server never gets ${withheld.join(", ")}.`,
        );
        continue;
      }
    }
    servers[entry.name] = entry.inline;
  }
  const own = new Set(Object.keys(servers));
  const grantedServer = (server: string) => named.has(server) || own.has(server);
  const deniedTool = (fullName: string) => denied.some((entry) => matches(entry, fullName));
  const deniedServer = (server: string) =>
    denied.some((entry) => {
      // Only a whole-server entry takes a server away; one tool's leaves the rest.
      const prefix = `mcp__${normalizeName(server)}__`;
      if (entry.endsWith("*")) return prefix.startsWith(entry.slice(0, -1));
      return `${entry}__` === prefix;
    });

  const allowsServer = (server: string) => {
    if (deniedServer(server)) return false;
    if (listed === null || grantedServer(server)) return true;
    return listed.some((entry) => reachesServer(entry, server));
  };
  const allowsTool = (fullName: string, server: string) => {
    if (!allowsServer(server) || deniedTool(fullName)) return false;
    if (listed === null || grantedServer(server)) return true;
    return listed.some((entry) => matches(entry, fullName));
  };
  const deniedNames = new Set(input.disallowedTools);
  return {
    servers,
    notes,
    allowsServer,
    allowsTool,
    keeps: (toolName) => FIXED_MCP_TOOLS.has(toolName) && !deniedNames.has(toolName),
  };
}
