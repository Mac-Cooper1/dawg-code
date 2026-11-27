/**
 * Copying Claude Code's own MCP servers into dawg (Phase 4 spec, MCP): "an explicit, one-time
 * action that shows what will be copied, because that file can contain credentials".
 *
 * `planMcpImport` reads `~/.claude.json` (never written) and lists each server it holds, for
 * every project and per project, with what would be copied and the values that may be secrets
 * (named, never shown). `applyMcpImport` copies exactly that plan, checked by its hash, into
 * `~/.dawg/mcp.json`, in Claude Code's own shape:
 *
 *   { "mcpServers": { ... }, "projects": { "/abs/project": { "mcpServers": { ... } } } }
 *
 * A name dawg already has at the same level is left as it is: the person's own definition wins.
 * The file is written with owner-only permissions, since it can now hold credentials.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { McpImportItem, McpImportPlan } from "@dawg/protocol";
import {
  type ClaudeDefinition,
  claudeJsonPath,
  dawgMcpPath,
  readClaudeDefinitions,
  readJsonObject,
} from "./sources.ts";

export class McpImportError extends Error {
  override name = "McpImportError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

/** A variable reference and nothing else, such as "${GITHUB_TOKEN}": not a secret itself. */
const ONLY_A_VARIABLE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;

/** The values a definition carries that may be secrets, named but not shown. */
export function secretsIn(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const out: string[] = [];
  for (const [field, label] of [
    ["env", "env"],
    ["headers", "header"],
  ] as const) {
    const values = raw[field];
    if (!isPlainObject(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string" && value !== "" && !ONLY_A_VARIABLE.test(value)) {
        out.push(`${label} ${key}`);
      }
    }
  }
  if (typeof raw.url === "string") {
    try {
      const url = new URL(raw.url);
      if (url.username !== "" || url.password !== "")
        out.push("a user name or password in the URL");
      if (url.search !== "") out.push("a query in the URL");
    } catch {
      // Not a URL dawg can read: nothing to name.
    }
  }
  if (
    Array.isArray(raw.args) &&
    raw.args.some((a) => typeof a === "string" && /token|key|secret|password/i.test(a))
  ) {
    out.push("arguments that look like keys");
  }
  return out;
}

function itemFor(definition: ClaudeDefinition, taken: boolean): McpImportItem {
  const { parsed } = definition;
  const base = {
    name: definition.name,
    project: definition.project,
    transport: parsed.transport,
    target: parsed.target,
    secrets: secretsIn(definition.raw),
  };
  if (taken) {
    return {
      ...base,
      action: "skip",
      reason:
        definition.project === null
          ? "dawg already has a server of this name in ~/.dawg/mcp.json; yours is kept."
          : "dawg already has a server of this name for this project; yours is kept.",
    };
  }
  if (parsed.status !== "ok") {
    return {
      ...base,
      action: "skip",
      reason: parsed.notes[0] ?? "dawg cannot run this server.",
    };
  }
  return { ...base, action: "copy", reason: null };
}

/** What dawg's file holds now: names for every project, and per project. */
async function dawgNames(homeDir: string): Promise<{
  user: Set<string>;
  projects: Map<string, Set<string>>;
  data: Record<string, unknown>;
}> {
  const path = dawgMcpPath(homeDir);
  const file = await readJsonObject(path);
  if (file.kind === "invalid") {
    throw new McpImportError(
      `${path} is not valid JSON, so nothing can be copied into it. Fix or move it first. (${file.message})`,
    );
  }
  const data = file.kind === "ok" ? file.data : {};
  const user = new Set(isPlainObject(data.mcpServers) ? Object.keys(data.mcpServers) : []);
  const projects = new Map<string, Set<string>>();
  if (isPlainObject(data.projects)) {
    for (const [key, entry] of Object.entries(data.projects)) {
      const servers = isPlainObject(entry) ? entry.mcpServers : undefined;
      projects.set(resolve(key), new Set(isPlainObject(servers) ? Object.keys(servers) : []));
    }
  }
  return { user, projects, data };
}

interface PlanWithDefinitions extends McpImportPlan {
  copies: ClaudeDefinition[];
}

async function plan(homeDir: string): Promise<PlanWithDefinitions> {
  const home = resolve(homeDir);
  const definitions = await readClaudeDefinitions(home, "all");
  const names = await dawgNames(home);
  const items: McpImportItem[] = [];
  const copies: ClaudeDefinition[] = [];
  for (const definition of definitions) {
    const taken =
      definition.project === null
        ? names.user.has(definition.name)
        : (names.projects.get(resolve(definition.project))?.has(definition.name) ?? false);
    const item = itemFor(definition, taken);
    items.push(item);
    if (item.action === "copy") copies.push(definition);
  }
  const hash =
    copies.length === 0
      ? null
      : `sha256:${createHash("sha256")
          .update(
            JSON.stringify(
              sortKeys(copies.map((d) => ({ name: d.name, project: d.project, raw: d.raw }))),
            ),
          )
          .digest("hex")}`;
  return { from: claudeJsonPath(home), to: dawgMcpPath(home), hash, items, copies };
}

/** What importing would copy from `~/.claude.json`, and what it would leave. Never writes. */
export async function planMcpImport(homeDir: string): Promise<McpImportPlan> {
  const { copies: _copies, ...shown } = await plan(homeDir);
  return shown;
}

/**
 * Copies the servers of the plan the person saw (`hash`) into `~/.dawg/mcp.json`. Throws an
 * `McpImportError` when Claude Code's file or dawg's changed since, so nothing unseen is copied.
 */
export async function applyMcpImport(
  homeDir: string,
  hash: string,
): Promise<{ imported: number; path: string }> {
  const home = resolve(homeDir);
  const now = await plan(home);
  if (now.hash === null) throw new McpImportError("There is nothing left to import.");
  if (now.hash !== hash) {
    throw new McpImportError(
      "Claude Code's servers changed since the list was shown, so nothing was copied. Look at the list again.",
    );
  }
  const { data } = await dawgNames(home);
  const out: Record<string, unknown> = { ...data };
  const user = isPlainObject(out.mcpServers) ? { ...out.mcpServers } : {};
  const projects: Record<string, unknown> = isPlainObject(out.projects) ? { ...out.projects } : {};
  for (const definition of now.copies) {
    if (definition.project === null) {
      user[definition.name] = definition.raw;
      continue;
    }
    const key = resolve(definition.project);
    const existing = Object.keys(projects).find((k) => resolve(k) === key) ?? key;
    const entry = isPlainObject(projects[existing]) ? { ...projects[existing] } : {};
    const servers = isPlainObject(entry.mcpServers) ? { ...entry.mcpServers } : {};
    servers[definition.name] = definition.raw;
    entry.mcpServers = servers;
    projects[existing] = entry;
  }
  if (Object.keys(user).length > 0) out.mcpServers = user;
  if (Object.keys(projects).length > 0) out.projects = projects;
  const path = dawgMcpPath(home);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(out, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => {});
  return { imported: now.copies.length, path };
}
