/**
 * The MCP keys of settings files, as the settings reference documents them:
 *
 * - `disabledMcpjsonServers`: servers of the project's `.mcp.json` that never start. Honoured
 *   from every settings file, since it only turns servers off.
 * - `enableAllProjectMcpServers`, `enabledMcpjsonServers`: approve the project's servers. As in
 *   Claude Code, a project cannot approve its own: they count only from the person's files in
 *   their home (`~/.claude/settings.json`, `~/.dawg/settings.json`). Elsewhere they are ignored
 *   and the trust dialog asks as usual.
 * - `allowedMcpServers`, `deniedMcpServers`: lists that only let through, or keep out, servers
 *   matched by `serverName`, `serverCommand` or `serverUrl` (a `*` matches anything). Honoured
 *   from every file, since they only keep servers from starting; a deny wins.
 */
import { readFile } from "node:fs/promises";
import { settingsFilePaths } from "../settings/load.ts";
import type { McpServerConfig } from "./config.ts";

export interface McpMatcher {
  serverName?: string;
  serverCommand?: string[];
  serverUrl?: string;
}

export interface McpSettings {
  /** Approve every project server: true when one of the person's own files says so. */
  enableAllProjectMcpServers: boolean;
  /** Project servers the person's own files approve. */
  enabledMcpjsonServers: Set<string>;
  /** Project servers turned off, and the file that turned each off. */
  disabledMcpjsonServers: Map<string, string>;
  /** Null when no file sets an allow list. */
  allowedMcpServers: { matchers: McpMatcher[]; path: string }[] | null;
  deniedMcpServers: { matcher: McpMatcher; path: string }[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function matchers(value: unknown): McpMatcher[] {
  if (!Array.isArray(value)) return [];
  const out: McpMatcher[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const matcher: McpMatcher = {};
    if (typeof entry.serverName === "string") matcher.serverName = entry.serverName;
    if (Array.isArray(entry.serverCommand)) matcher.serverCommand = names(entry.serverCommand);
    if (typeof entry.serverUrl === "string") matcher.serverUrl = entry.serverUrl;
    if (Object.keys(matcher).length > 0) out.push(matcher);
  }
  return out;
}

/** Reads the MCP keys of every settings file that applies. Never throws. */
export async function readMcpSettings(options: {
  projectDir: string | null;
  localDir?: string | null;
  homeDir: string;
}): Promise<McpSettings> {
  const settings: McpSettings = {
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: new Set(),
    disabledMcpjsonServers: new Map(),
    allowedMcpServers: null,
    deniedMcpServers: [],
  };
  const specs = settingsFilePaths(options.projectDir, options.homeDir, options.localDir ?? null);
  for (const spec of specs) {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(spec.path, "utf8"));
    } catch {
      continue; // Missing or broken: the settings loader reports it.
    }
    if (!isPlainObject(data)) continue;
    if (spec.source === "user") {
      if (data.enableAllProjectMcpServers === true) settings.enableAllProjectMcpServers = true;
      for (const name of names(data.enabledMcpjsonServers))
        settings.enabledMcpjsonServers.add(name);
    }
    for (const name of names(data.disabledMcpjsonServers)) {
      if (!settings.disabledMcpjsonServers.has(name)) {
        settings.disabledMcpjsonServers.set(name, spec.path);
      }
    }
    if (data.allowedMcpServers !== undefined) {
      settings.allowedMcpServers ??= [];
      settings.allowedMcpServers.push({
        matchers: matchers(data.allowedMcpServers),
        path: spec.path,
      });
    }
    for (const matcher of matchers(data.deniedMcpServers)) {
      settings.deniedMcpServers.push({ matcher, path: spec.path });
    }
  }
  return settings;
}

function wildcard(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(text);
}

/** Whether a matcher names this server. */
export function matchesServer(
  matcher: McpMatcher,
  name: string,
  config: McpServerConfig | null,
): boolean {
  if (matcher.serverName !== undefined && matcher.serverName !== name) return false;
  if (matcher.serverCommand !== undefined) {
    if (config?.type !== "stdio") return false;
    const line = [config.command, ...config.args];
    if (line.length !== matcher.serverCommand.length) return false;
    if (line.some((word, i) => word !== matcher.serverCommand?.[i])) return false;
  }
  if (matcher.serverUrl !== undefined) {
    if (config === null || config.type === "stdio") return false;
    if (!wildcard(matcher.serverUrl, config.url)) return false;
  }
  return true;
}

/**
 * Why settings keep a server from starting, or null when they do not. `fromProject` is true for
 * a server of the project's `.mcp.json`.
 */
export function blockedBySettings(
  settings: McpSettings,
  name: string,
  config: McpServerConfig | null,
  fromProject: boolean,
): string | null {
  if (fromProject) {
    const file = settings.disabledMcpjsonServers.get(name);
    if (file !== undefined) return `Turned off by disabledMcpjsonServers in ${file}.`;
  }
  const denied = settings.deniedMcpServers.find((d) => matchesServer(d.matcher, name, config));
  if (denied !== undefined) return `Kept out by deniedMcpServers in ${denied.path}.`;
  for (const allow of settings.allowedMcpServers ?? []) {
    if (!allow.matchers.some((m) => matchesServer(m, name, config))) {
      return `Not in allowedMcpServers in ${allow.path}.`;
    }
  }
  return null;
}

/** Whether the person's own settings approve a project server without asking. */
export function approvedBySettings(settings: McpSettings, name: string): boolean {
  return settings.enableAllProjectMcpServers || settings.enabledMcpjsonServers.has(name);
}
