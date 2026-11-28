/**
 * Every place an MCP server can be defined for a session, read-only (Phase 4 spec, MCP;
 * code.claude.com/docs/en/mcp), and which definition of each name is used:
 *
 *   session   the session's own additions                                  highest
 *   local     the person's servers for this project: `~/.dawg/mcp.json` → `projects[dir]`
 *   project   the project's `.mcp.json` (committed; needs the person's consent to start)
 *   user      the person's servers for every project: `~/.dawg/mcp.json` → `mcpServers`
 *
 * The local scope sits above the project's file, as in Claude Code ("local > project > user").
 * Claude Code's own `~/.claude.json` (its user servers, and its local ones under `projects`) is
 * read too, but its servers never start from there: they can hold credentials written for
 * another app, so they are copied into `~/.dawg/mcp.json` only by an explicit import
 * (import.ts). The whole winning entry is used; fields are not merged across scopes.
 */
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { type ParsedServer, PROJECT_WITHHELD_VARIABLES, parseServer } from "./config.ts";

export type McpScope = "session" | "local" | "project" | "user";

/** One definition found in one file. */
export interface McpDefinition {
  name: string;
  scope: McpScope;
  source: CompatSource;
  /** As written. */
  raw: unknown;
  parsed: ParsedServer;
  /** The definition of the same name that is used instead, or null when this one is used. */
  shadowedBy: McpDefinition | null;
}

/** A definition in Claude Code's `~/.claude.json`, which dawg does not start. */
export interface ClaudeDefinition {
  name: string;
  /** The project it is for (as Claude Code keys it), or null for every project. */
  project: string | null;
  source: CompatSource;
  raw: unknown;
  parsed: ParsedServer;
}

export interface McpSourcesOptions {
  /** The session's working directory: its `.mcp.json` (committed, so a worktree's own). */
  cwd: string | null;
  /** The project the session belongs to (default `cwd`): the person's servers for it. */
  projectDir?: string | null;
  homeDir: string;
  /** The environment `${VAR}` is expanded from. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The session's own servers, as an `mcpServers` object. */
  sessionServers?: Readonly<Record<string, unknown>>;
  /** Where the session's own servers came from, for people (a file given on the command line). */
  sessionSource?: string;
  /**
   * Only the session's own servers (`--strict-mcp-config`): the project's and the person's files
   * are not read for servers. Claude Code's own are still listed, for the import offer.
   */
  strict?: boolean;
}

export interface McpSources {
  /** Every definition dawg may start, in precedence order, shadowed ones included. */
  definitions: McpDefinition[];
  /** Claude Code's own servers that apply here (its user ones and this project's local ones). */
  claude: ClaudeDefinition[];
  /** Files that could not be read as JSON, or whose `mcpServers` is not a table, with why. */
  problems: { path: string; message: string; name?: string }[];
}

/** dawg's own MCP file: `~/.dawg/mcp.json`. */
export function dawgMcpPath(homeDir: string): string {
  return join(resolve(homeDir), ".dawg", "mcp.json");
}

/** Claude Code's user file: `~/.claude.json`. */
export function claudeJsonPath(homeDir: string): string {
  return join(resolve(homeDir), ".claude.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonFile =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; data: Record<string, unknown> };

/** Reads a JSON object. Never throws. */
export async function readJsonObject(path: string): Promise<JsonFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "invalid", message: `Could not read it: ${(error as Error).message}` };
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim() === "") return { kind: "ok", data: {} };
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch (error) {
    return { kind: "invalid", message: `Not valid JSON: ${(error as Error).message}` };
  }
  if (!isPlainObject(data)) return { kind: "invalid", message: "Expected a JSON object." };
  return { kind: "ok", data };
}

/** The keys a per-project table may use for a folder: its path as given and its real path. */
export async function projectKeys(dir: string): Promise<Set<string>> {
  const keys = new Set([resolve(dir)]);
  try {
    keys.add(await realpath(dir));
  } catch {
    // Not there: the path as given is the only key.
  }
  return keys;
}

/** The `mcpServers` of a project in a per-project table (`projects`), matched by path. */
async function projectServers(
  projects: unknown,
  dir: string,
): Promise<{ key: string; servers: unknown }[]> {
  if (!isPlainObject(projects)) return [];
  const keys = await projectKeys(dir);
  const out: { key: string; servers: unknown }[] = [];
  for (const [key, entry] of Object.entries(projects)) {
    if (!keys.has(resolve(key)) || !isPlainObject(entry)) continue;
    if (entry.mcpServers !== undefined) out.push({ key, servers: entry.mcpServers });
  }
  return out;
}

function entriesOf(
  servers: unknown,
  path?: string,
  problems?: McpSources["problems"],
): [string, unknown][] {
  if (isPlainObject(servers)) return Object.entries(servers);
  if (servers !== undefined && path !== undefined) {
    problems?.push({
      path,
      name: "mcpServers",
      message: "“mcpServers” should map server names to their definitions.",
    });
  }
  return [];
}

/** Reads every source. Never throws: unreadable files are listed in `problems`. */
export async function readMcpSources(options: McpSourcesOptions): Promise<McpSources> {
  const env = options.env ?? process.env;
  const home = resolve(options.homeDir);
  const cwd = options.cwd === null ? null : resolve(options.cwd);
  const projectDir =
    options.projectDir === undefined || options.projectDir === null
      ? cwd
      : resolve(options.projectDir);
  const definitions: McpDefinition[] = [];
  const problems: McpSources["problems"] = [];
  const add = (name: string, scope: McpScope, source: CompatSource, raw: unknown) => {
    const withheld = scope === "project" ? PROJECT_WITHHELD_VARIABLES : undefined;
    definitions.push({
      name,
      scope,
      source,
      raw,
      parsed: parseServer(raw, { env, ...(withheld === undefined ? {} : { withheld }) }),
      shadowedBy: null,
    });
  };

  for (const [name, raw] of Object.entries(options.sessionServers ?? {})) {
    add(
      name,
      "session",
      { path: options.sessionSource ?? "<session>", origin: "dawg", scope: "flags" },
      raw,
    );
  }

  const dawgPath = dawgMcpPath(home);
  const dawg: JsonFile =
    options.strict === true ? { kind: "missing" } : await readJsonObject(dawgPath);
  if (dawg.kind === "invalid") problems.push({ path: dawgPath, message: dawg.message });
  if (dawg.kind === "ok" && projectDir !== null && projectDir !== home) {
    for (const { servers } of await projectServers(dawg.data.projects, projectDir)) {
      for (const [name, raw] of entriesOf(servers)) {
        add(name, "local", { path: dawgPath, origin: "dawg", scope: "local" }, raw);
      }
    }
  }

  // The project's own file; the home folder as a project has none of its own.
  if (cwd !== null && cwd !== home && options.strict !== true) {
    const path = join(cwd, ".mcp.json");
    const file = await readJsonObject(path);
    if (file.kind === "invalid") problems.push({ path, message: file.message });
    if (file.kind === "ok") {
      for (const [name, raw] of entriesOf(file.data.mcpServers, path, problems)) {
        add(name, "project", { path, origin: "claude", scope: "project" }, raw);
      }
    }
  }

  if (dawg.kind === "ok") {
    for (const [name, raw] of entriesOf(dawg.data.mcpServers, dawgPath, problems)) {
      add(name, "user", { path: dawgPath, origin: "dawg", scope: "user" }, raw);
    }
  }

  // One name, one server: the first definition in precedence order is used.
  const winners = new Map<string, McpDefinition>();
  for (const definition of definitions) {
    const winner = winners.get(definition.name);
    if (winner === undefined) winners.set(definition.name, definition);
    else definition.shadowedBy = winner;
  }

  return {
    definitions,
    claude: await readClaudeDefinitions(home, projectDir, env, problems),
    problems,
  };
}

/**
 * Claude Code's servers in `~/.claude.json`: its user servers, and those it keeps for this
 * project (or, with `projectDir` "all", for every project).
 */
export async function readClaudeDefinitions(
  homeDir: string,
  projectDir: string | null | "all",
  env: Readonly<Record<string, string | undefined>> = process.env,
  problems: McpSources["problems"] = [],
): Promise<ClaudeDefinition[]> {
  const path = claudeJsonPath(homeDir);
  const file = await readJsonObject(path);
  if (file.kind === "invalid") problems.push({ path, message: file.message });
  if (file.kind !== "ok") return [];
  const out: ClaudeDefinition[] = [];
  for (const [name, raw] of entriesOf(file.data.mcpServers, path, problems)) {
    out.push({
      name,
      project: null,
      source: { path, origin: "claude", scope: "user" },
      raw,
      parsed: parseServer(raw, { env }),
    });
  }
  const projects = file.data.projects;
  if (isPlainObject(projects) && projectDir !== null) {
    const found =
      projectDir === "all"
        ? Object.entries(projects).map(([key, entry]) => ({
            key,
            servers: isPlainObject(entry) ? entry.mcpServers : undefined,
          }))
        : await projectServers(projects, projectDir);
    for (const { key, servers } of found) {
      for (const [name, raw] of entriesOf(servers)) {
        out.push({
          name,
          project: key,
          source: { path, origin: "claude", scope: "local" },
          raw,
          parsed: parseServer(raw, { env }),
        });
      }
    }
  }
  return out;
}

/** The definitions used: one per name, in precedence order. */
export function effectiveDefinitions(sources: McpSources): McpDefinition[] {
  return sources.definitions.filter((d) => d.shadowedBy === null);
}
