/**
 * `--mcp-config` (Claude Code's CLI reference): each value a file, or a JSON string, holding an
 * `mcpServers` object in `.mcp.json`'s shape. Together they are the session's own servers, which
 * come before the project's and the person's and need no approval: the person named them. A later
 * value wins for a name two of them define. The definitions themselves are read as `.mcp.json`'s
 * are, by the engine; one that is not valid shows as failed in `/mcp`, with why.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export class McpConfigError extends Error {
  override name = "McpConfigError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one value says, as written, for messages: a file's path, or "the JSON given". */
function label(value: string): string {
  return value.trim().startsWith("{") ? "the JSON given to --mcp-config" : value;
}

/** Reads one `--mcp-config` value: inline JSON when it starts with `{`, else a file. */
async function readOne(value: string, cwd: string): Promise<Record<string, unknown>> {
  let text = value;
  if (!value.trim().startsWith("{")) {
    const file = path.resolve(cwd, value);
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new McpConfigError(
        code === "ENOENT"
          ? `--mcp-config: there is no file ${value}.`
          : `--mcp-config: could not read ${value} (${(error as Error).message}).`,
      );
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new McpConfigError(
      `--mcp-config: ${label(value)} is not valid JSON (${(error as Error).message}).`,
    );
  }
  if (!isPlainObject(data) || !isPlainObject(data.mcpServers)) {
    throw new McpConfigError(
      `--mcp-config: ${label(value)} should hold an "mcpServers" object, as .mcp.json does.`,
    );
  }
  return data.mcpServers;
}

/** The session's own servers from every `--mcp-config` value, or null when none was given. */
export async function readMcpConfigs(
  values: readonly string[],
  cwd: string,
): Promise<Record<string, unknown> | null> {
  if (values.length === 0) return null;
  const servers: Record<string, unknown> = {};
  for (const value of values) Object.assign(servers, await readOne(value, cwd));
  return servers;
}
