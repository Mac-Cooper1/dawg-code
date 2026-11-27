/**
 * MCP servers (Phase 4 spec, "MCP"), on the official SDK's client:
 *
 * - connection.ts: one running server (stdio, streamable HTTP, older SSE), restarted with
 *   growing pauses when it fails;
 * - manager.ts: the engine's servers, which definition applies, what may start (consent, the
 *   settings keys, the person's switches), and sharing one server between sessions;
 * - session-mcp.ts: one session's servers, its tool list decided before its first request, and
 *   resources, prompts and `@` mentions;
 * - tools.ts: server tools as session tools, `ToolSearch` and `CallMcpTool`;
 * - result.ts: results for the model and the transcript, large ones saved to a file;
 * - command.ts: `/mcp`.
 *
 * Reading the configuration (and importing Claude Code's) is compat's (`@dawg/compat`, mcp/).
 */
export { mcpCommand } from "./command.ts";
export { type ConnectionState, McpConnection, McpUnavailableError } from "./connection.ts";
export {
  MCP_CHECK_LINGER_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LINGER_MS,
  MCP_RESTART_DELAYS_MS,
  McpManager,
  McpManagerError,
  type McpManagerOptions,
  type McpServerPlan,
} from "./manager.ts";
export { MAX_TOOL_NAME_CHARS, mcpPromptCommandName, mcpToolName, normalizeName } from "./names.ts";
export { MCP_INSTRUCTIONS_MAX_CHARS, renderMcpSegment } from "./prompt.ts";
export {
  MCP_RESULT_MAX_CHARS,
  MCP_RESULT_MAX_TOKENS,
  MCP_RESULT_PREVIEW_CHARS,
  resultCap,
  toolOutput,
} from "./result.ts";
export {
  MCP_SCHEMA_SHARE,
  MCP_START_WAIT_MS,
  MCP_TOOL_TIMEOUT_MS,
  type McpDecision,
  SessionMcp,
  type SessionMcpOptions,
} from "./session-mcp.ts";
export { McpSwitches, SWITCHES_FILE } from "./switches.ts";
export {
  callMcpTool,
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_SEARCH_DESCRIPTION_MAX_CHARS,
  MCP_STATE_KEY,
  mcpTool,
  TOOL_SEARCH,
  toolSearchTool,
} from "./tools.ts";
