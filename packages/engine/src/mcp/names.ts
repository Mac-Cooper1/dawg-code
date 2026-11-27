/**
 * How MCP tools and prompts are named in a session, as Claude Code names them
 * (code.claude.com/docs/en/mcp): a tool is `mcp__<server>__<tool>`, the name permission rules and
 * hooks match; a prompt is the slash command `/mcp__<server>__<prompt>`. A character outside
 * letters, digits, `_` and `-` becomes `_`.
 */

/** Longest tool name sent to a model; Claude Code leaves longer ones out, as APIs refuse them. */
export const MAX_TOOL_NAME_CHARS = 128;

export function normalizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** "mcp__github__get_issue". */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${normalizeName(server)}__${normalizeName(tool)}`;
}

/** The slash command for a prompt, lowercase as commands are: "mcp__github__pr_review". */
export function mcpPromptCommandName(server: string, prompt: string): string | null {
  const name = `mcp__${normalizeName(server)}__${normalizeName(prompt)}`.toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(name) ? name : null;
}
