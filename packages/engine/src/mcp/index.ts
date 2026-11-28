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
 * - elicitation.ts: a server's requests for input, routed to the session whose call caused them;
 * - resource-tools.ts: `ListMcpResourcesTool` and `ReadMcpResourceTool`;
 * - command.ts: `/mcp`;
 * - oauth.ts and credentials.ts: signing in to remote servers, and where their tokens are kept.
 *
 * Reading the configuration (and importing Claude Code's) is compat's (`@dawg/compat`, mcp/).
 */
export { mcpCommand } from "./command.ts";
export { type ConnectionState, McpConnection, McpUnavailableError } from "./connection.ts";
export {
  CREDENTIALS_FILE,
  createCredentialStore,
  credentialId,
  FileCredentialStore,
  KeychainCredentialStore,
  keychainAccount,
  keychainService,
  type McpCredentialKey,
  type McpCredentialStore,
  type McpCredentials,
  MemoryCredentialStore,
  runSecurity,
  type SecurityRunner,
} from "./credentials.ts";
export {
  fieldsFromSchema,
  type McpCaller,
  McpElicitations,
  McpTimeoutError,
  URL_MAX_CHARS,
} from "./elicitation.ts";
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
export {
  authTarget,
  CALLBACK_PATH,
  McpAuth,
  type McpAuthTarget,
  McpSignInError,
  SIGN_IN_TIMEOUT_MS,
} from "./oauth.ts";
export { MCP_INSTRUCTIONS_MAX_CHARS, renderMcpSegment } from "./prompt.ts";
export {
  LIST_MCP_RESOURCES,
  listMcpResourcesTool,
  MCP_RESOURCE_TOOLS,
  READ_MCP_RESOURCE,
  readMcpResourceTool,
} from "./resource-tools.ts";
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
  type McpToolFilter,
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
