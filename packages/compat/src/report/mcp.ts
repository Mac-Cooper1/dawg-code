/**
 * The report's MCP servers, from every place the MCP docs name (code.claude.com/docs/en/mcp) and
 * dawg's own file (spec, MCP): the project's `.mcp.json`, `~/.dawg/mcp.json` (the person's
 * servers, and theirs for one project under `projects`), and Claude Code's `~/.claude.json`.
 *
 * dawg starts the servers of `.mcp.json` (with the person's consent) and of `~/.dawg/mcp.json`.
 * Those in `~/.claude.json` are listed but never started from there: importing copies them into
 * `~/.dawg/mcp.json`, once, after showing what would be copied (../mcp/import.ts).
 */
import { join, resolve } from "node:path";
import type { CompatItem, CompatItemStatus, CompatSource } from "@dawg/protocol";
import type { ParsedServer } from "../mcp/config.ts";
import { blockedBySettings, readMcpSettings } from "../mcp/settings.ts";
import { type McpDefinition, readMcpSources } from "../mcp/sources.ts";
import { displayPath } from "./files.ts";
import type { ReportProvider } from "./types.ts";

const FROM_PROJECT =
  "Defined in the project's files, so dawg will ask before starting it, as Claude Code does.";
export const MCP_NOT_IMPORTED =
  "In Claude Code's own settings, so dawg does not start it from there: import it (Settings → MCP servers, or /mcp import) to copy it into ~/.dawg/mcp.json.";

/** What a definition does, in a sentence. */
function describe(parsed: ParsedServer): string | null {
  if (parsed.transport === "stdio") return `Runs a local command: ${parsed.target}.`;
  if (parsed.transport === "http") return `Connects to ${parsed.target} over HTTP.`;
  if (parsed.transport === "sse") return `Connects to ${parsed.target} over SSE (older servers).`;
  if (parsed.target !== "" && parsed.status === "not-supported") {
    return `Connects to ${parsed.target} over WebSocket.`;
  }
  return null;
}

/** Notes about fields dawg leaves out (not missing variables, which are the person's to set). */
function partly(parsed: ParsedServer): boolean {
  return parsed.notes.some((note) => !note.includes("is not set") && !note.includes("are not set"));
}

function statusOf(parsed: ParsedServer): CompatItemStatus {
  if (parsed.status === "invalid") return "invalid";
  if (parsed.status === "not-supported") return "not-supported";
  return partly(parsed) ? "partly-supported" : "loaded";
}

function item(
  name: string,
  source: CompatSource,
  parsed: ParsedServer,
  extra: readonly string[],
  status: CompatItemStatus = statusOf(parsed),
): CompatItem {
  const what = describe(parsed);
  const notes =
    parsed.status === "invalid"
      ? [...parsed.notes]
      : parsed.status === "not-supported"
        ? [...(what === null ? [] : [what]), ...parsed.notes, ...extra]
        : [...(what === null ? [] : [what]), ...extra, ...parsed.notes];
  return {
    kind: "mcp-server",
    name: name.trim() === "" ? "(no name)" : name,
    source,
    status,
    notes: [...new Set(notes)],
  };
}

export const mcpProvider: ReportProvider = async (context) => {
  const home = resolve(context.homeDir);
  const projectDir = context.projectDir === null ? null : resolve(context.projectDir);
  const sources = await readMcpSources({ cwd: projectDir, homeDir: home });
  const settings = await readMcpSettings({ projectDir, homeDir: home });
  const items: CompatItem[] = [];

  for (const { path, message, name } of sources.problems) {
    items.push({
      kind: "mcp-server",
      name: name ?? displayPath(path, context),
      source: {
        path,
        origin: path === join(home, ".dawg", "mcp.json") ? "dawg" : "claude",
        scope: path.startsWith(`${home}/.`) ? "user" : "project",
      },
      status: "invalid",
      notes: [message],
    });
  }

  const order = (d: McpDefinition) => ({ project: 0, local: 1, user: 2, session: 3 })[d.scope];
  const definitions = [...sources.definitions].sort((a, b) => order(a) - order(b));
  for (const definition of definitions) {
    const extra: string[] = [];
    if (definition.scope === "project" && definition.parsed.status === "ok") {
      extra.push(FROM_PROJECT);
    }
    if (definition.scope === "local") extra.push("Yours, for this project only.");
    if (definition.shadowedBy !== null) {
      extra.push(
        `Not used: ${displayPath(definition.shadowedBy.source.path, context)} defines “${definition.name}” too and takes its place.`,
      );
    }
    const blocked = blockedBySettings(
      settings,
      definition.name,
      definition.parsed.config,
      definition.scope === "project",
    );
    if (blocked !== null) extra.push(blocked);
    items.push(item(definition.name, definition.source, definition.parsed, extra));
  }

  // Claude Code's own servers: listed, never started from there.
  const dawgNames = new Set(
    sources.definitions.filter((d) => d.scope !== "project").map((d) => d.name),
  );
  for (const claude of sources.claude) {
    const extra = claude.project === null ? [] : ["Yours, for this project only."];
    if (dawgNames.has(claude.name)) {
      extra.push(`Not used: ~/.dawg/mcp.json defines “${claude.name}” too and takes its place.`);
    } else if (claude.parsed.status === "ok") {
      extra.push(MCP_NOT_IMPORTED);
    }
    items.push(
      item(
        claude.name,
        claude.source,
        claude.parsed,
        extra,
        claude.parsed.status === "invalid" ? "invalid" : "not-supported",
      ),
    );
  }
  return items;
};
