/**
 * The definitions a setup supplies that run code, each hashed for consent (Phase 4 spec,
 * principle 3): hook handlers from the project's settings files and from Claude Code's own user
 * settings; the project's skills and custom commands that run shell commands when they load
 * (`!` commands) or allow tools without asking (`allowed-tools`); and the MCP servers of the
 * project's `.mcp.json` (../mcp starts them only with consent). The person's own `~/.dawg` hooks, and their own skills, need no consent.
 *
 * Each definition is hashed as canonical JSON together with the file it is in. Project files are
 * named relative to the project (".claude/settings.json"), so a worktree of the project, whose
 * shared files are the same, needs no consent of its own; the person's files from their home
 * ("~/.claude/settings.json").
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentDefinition,
  agentServersNeedConsent,
  defineSkill,
  eventTier,
  HANDLER_TYPES,
  type HookDefinition,
  hookItemName,
  hookSources,
  hookSupport,
  inlineMcpServers,
  isProjectAgentCode,
  isProjectCode,
  type LoadedHooks,
  loadAgents,
  loadHooks,
  loadSkills,
  parseInjections,
  parseSettingsText,
  projectSandboxHosts,
  readAgentFile,
  readHookFile,
  SANDBOX_HOST_NOTE,
  type SkillDefinition,
  sandboxHostItemName,
  skillItemName,
  toolGrants,
} from "@dawg/compat";
import type { CompatItem, CompatSource } from "@dawg/protocol";

/** One definition that needs consent, as the trust dialog lists it. */
export interface TrustDefinition {
  /** sha256 of the canonical definition and its file. */
  hash: string;
  /** Whose consent it is kept under: the person's (Claude Code's user files) or the project's. */
  scope: "user" | "project";
  /** As listed for the person, status left to the caller. */
  item: CompatItem;
}

/** JSON with every object's keys sorted, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * How a definition's file is named in its hash: ".claude/settings.json" for a project's files,
 * "~/.claude/settings.json" for the person's.
 */
export function fileLabel(source: CompatSource): string {
  const name = path.basename(source.path);
  if (source.scope === "user")
    return `~/${source.origin === "claude" ? ".claude" : ".dawg"}/${name}`;
  if (name === ".mcp.json") return name;
  return `${path.basename(path.dirname(source.path))}/${name}`;
}

/**
 * A hook handler's identity: its file, event, matcher and handler exactly as written. The trust
 * store keeps consent and the person's on/off switch under it; any change makes a new one.
 */
export function hookId(
  hook: Pick<HookDefinition, "event" | "matcher" | "handler" | "source">,
): string {
  return sha256(
    canonicalJson({
      kind: "hook",
      file: fileLabel(hook.source),
      event: hook.event,
      matcher: hook.matcher,
      handler: hook.handler.raw,
    }),
  );
}

/** True when the code in this file runs only with consent: everything but `~/.dawg`'s. */
export function needsConsent(source: CompatSource): boolean {
  return !(source.scope === "user" && source.origin === "dawg");
}

/**
 * Whether a hook is offered for consent: hooks that can never run (an undocumented event or
 * handler type) are not.
 */
function offered(hook: HookDefinition): boolean {
  return (
    needsConsent(hook.source) &&
    eventTier(hook.event) !== null &&
    (HANDLER_TYPES as readonly string[]).includes(hook.handler.type)
  );
}

function hookDefinition(hook: HookDefinition): TrustDefinition {
  const fromHome = hook.source.scope === "user";
  const notes: string[] = [];
  const { handler } = hook;
  const from = fromHome ? "Claude Code's settings in your home folder" : "the project's files";
  if (handler.type === "command") {
    notes.push(
      fromHome
        ? "Runs a command from Claude Code's settings in your home folder."
        : "Runs a command from the project's files.",
    );
  } else if (handler.type === "http") {
    // The person should see where events go, and which of their variables go with them.
    const vars = handler.allowedEnvVars.map((name) => `$${name}`);
    const address = handler.url?.split("?")[0] ?? "an address";
    const withVars = vars.length === 0 ? "" : `, with ${vars.join(", ")} in its headers`;
    notes.push(`Sends each event to ${address}${withVars}, from ${from}.`);
  } else if (handler.type === "prompt") {
    notes.push(`Asks the model to check each event, with instructions from ${from}.`);
  } else if (handler.type === "agent") {
    notes.push(
      `Starts a subagent that reads files to check each event, with instructions from ${from}.`,
    );
  } else if (handler.type === "mcp_tool") {
    notes.push(
      `Calls the tool ${handler.tool ?? "?"} of the MCP server ${handler.server ?? "?"} on each event, as ${from} ask.`,
    );
  } else {
    notes.push(`A ${handler.type} hook from ${from}.`);
  }
  const support = hookSupport(hook);
  if (support.status === "not-supported") {
    notes.push("dawg does not run it yet; approving now lets it run once it does.");
  }
  return {
    hash: hookId(hook),
    scope: fromHome ? "user" : "project",
    item: {
      kind: "hook",
      name: hookItemName(hook),
      source: hook.source,
      status: "needs-approval",
      notes,
    },
  };
}

/** Command-line words as a person reads them, quoted only where needed. */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./~$-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * A server definition that could ever start (code.claude.com/docs/en/mcp): a local command, or a
 * remote server with its type and URL. One that cannot is the report's to explain, not consent's.
 */
function startable(config: unknown): boolean {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return false;
  const entry = config as Record<string, unknown>;
  const type = entry.type ?? "stdio";
  if (type === "stdio") return typeof entry.command === "string" && entry.command.trim() !== "";
  return (
    ["http", "streamable-http", "sse", "ws"].includes(String(type)) && typeof entry.url === "string"
  );
}

/** The MCP servers of the project's `.mcp.json`, each as a definition. Never throws. */
async function mcpDefinitions(projectDir: string): Promise<TrustDefinition[]> {
  const file = path.join(projectDir, ".mcp.json");
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return []; // Missing or unreadable: the report says what is wrong with it.
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const servers = (data as Record<string, unknown>).mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return [];
  const source: CompatSource = { path: file, origin: "claude", scope: "project" };
  return Object.entries(servers as Record<string, unknown>).flatMap(([name, config]) => {
    if (!startable(config)) return [];
    const entry = config as Record<string, unknown>;
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];
    const what =
      typeof entry.command === "string"
        ? `Starts a program: ${[entry.command, ...args].map(quoteArg).join(" ")}.`
        : typeof entry.url === "string"
          ? `Connects to ${entry.url.split("?")[0]}.`
          : "An MCP server.";
    return {
      hash: sha256(canonicalJson({ kind: "mcp-server", file: ".mcp.json", name, config })),
      scope: "project" as const,
      item: {
        kind: "mcp-server" as const,
        name,
        source,
        status: "needs-approval" as const,
        notes: [
          what,
          "Starts with the project's sessions once approved, and its tools can then be called.",
        ],
      },
    };
  });
}

/**
 * A skill or command file's place in its hash: from its `.claude` or `.dawg` folder on
 * (".claude/commands/deploy.md"), so a worktree's copy is the same definition.
 */
function skillLabel(file: string): string {
  const parts = file.split(path.sep);
  let at = -1;
  parts.forEach((part, i) => {
    if (part === ".claude" || part === ".dawg") at = i;
  });
  return (at < 0 ? [path.basename(file)] : parts.slice(at)).join("/");
}

/**
 * A project skill or command as a definition, when it supplies code: the shell commands it runs
 * as it loads, and the tools it lets run without asking. Its prose is left out of the hash, so
 * rewording it does not ask again. Null when it supplies none, or it cannot load at all.
 */
function skillDefinition(def: SkillDefinition): TrustDefinition | null {
  // The same test the engine applies before running a skill's code (compat's isProjectCode).
  if (!isProjectCode(def) || def.status === "invalid") return null;
  const commands = parseInjections(def.body).flatMap((part) =>
    part.type === "command" ? [part.command] : [],
  );
  if (commands.length === 0 && def.allowedTools.length === 0) return null;
  const notes: string[] = [];
  if (commands.length > 0) {
    const shown = commands.map((c) => c.replace(/\s+/g, " ").trim()).join("; ");
    notes.push(
      `Runs shell commands from the project's files when it loads: ${shown.length > 160 ? `${shown.slice(0, 159)}…` : shown}.`,
    );
  }
  if (def.allowedTools.length > 0) {
    notes.push(`Lets these run without asking while it is in use: ${def.allowedTools.join(", ")}.`);
  }
  return {
    hash: sha256(
      canonicalJson({
        kind: def.kind,
        file: skillLabel(def.path),
        commands,
        allowedTools: def.allowedTools,
      }),
    ),
    scope: "project",
    item: {
      kind: def.kind,
      name: skillItemName(def),
      source: def.source,
      status: "needs-approval",
      notes,
    },
  };
}

/** The project's skills and commands (nested folders included) that supply code. */
async function skillDefinitions(options: CollectOptions): Promise<TrustDefinition[]> {
  if (options.projectDir === null) return [];
  const set = await loadSkills({ homeDir: options.homeDir, cwd: options.projectDir, nested: true });
  // One another definition shadows is not used; if it ever is, the definitions change and the
  // person is asked then.
  return set.all.flatMap((def) => {
    if (def.shadowedBy !== null) return [];
    const found = skillDefinition(def);
    return found === null ? [] : [found];
  });
}

/** Whether a project file is a subagent file: under an `agents` folder of `.claude` or `.dawg`. */
function isAgentFile(file: string): boolean {
  const parts = file.split(path.sep);
  return parts.some(
    (part, i) => (part === ".claude" || part === ".dawg") && parts[i + 1] === "agents",
  );
}

/**
 * A project subagent file as a definition, when it supplies power (compat's isProjectAgentCode):
 * the tools it grants itself, a permission mode looser than asking first, and (added in round 3)
 * the MCP servers it defines for itself, each of which runs a program or connects to an address.
 * Its prompt is left out of the hash, so rewording it does not ask again; a file without servers
 * of its own hashes as it did before they were read.
 */
function agentDefinition(def: AgentDefinition): TrustDefinition | null {
  if (!isProjectAgentCode(def) || def.status === "invalid") return null;
  const grants = toolGrants(def);
  const mode =
    def.permissionMode === "acceptEdits" || def.permissionMode === "bypassPermissions"
      ? def.permissionMode
      : null;
  const notes: string[] = [];
  if (grants.length > 0) {
    notes.push(`Lets these run without asking while the agent works: ${grants.join(", ")}.`);
  }
  if (mode !== null) notes.push(`Runs in ${mode} mode when the session asks first.`);
  const servers = agentServers(def);
  notes.push(...servers.map(serverNote));
  const what = { kind: "agent", file: skillLabel(def.path), grants, mode };
  return {
    hash: sha256(canonicalJson(servers.length === 0 ? what : { ...what, servers })),
    scope: "project",
    item: { kind: "agent", name: def.name, source: def.source, status: "needs-approval", notes },
  };
}

/** An agent file's own MCP servers, as they are hashed: name and definition as written. */
function agentServers(def: AgentDefinition): { name: string; config: unknown }[] {
  return inlineMcpServers(def).map((entry) => ({ name: entry.name, config: entry.inline }));
}

/** What one of an agent's own servers does, for the person deciding. */
function serverNote(server: { name: string; config: unknown }): string {
  const config = server.config as Record<string, unknown>;
  const args = Array.isArray(config.args)
    ? config.args.filter((a): a is string => typeof a === "string")
    : [];
  return typeof config.command === "string"
    ? `Starts an MCP server of its own, ${server.name}: ${[config.command, ...args].map(quoteArg).join(" ")}.`
    : typeof config.url === "string"
      ? `Connects to an MCP server of its own, ${server.name}, at ${config.url.split("?")[0]}.`
      : `Defines an MCP server of its own, ${server.name}.`;
}

/**
 * Added (round 3): one of Claude Code's agent files in the person's home (`~/.claude/agents`) as
 * a definition, when it defines MCP servers of its own. Like Claude Code's user hooks they run
 * code dawg did not write, so they are approved once, for every project (scope "user"). Only the
 * servers are hashed: that file's tool grants and mode stay the person's own, and its prompt can
 * be reworded without asking again. `~/.dawg/agents` files need no approval.
 */
function userAgentDefinition(def: AgentDefinition): TrustDefinition | null {
  if (def.status === "invalid" || def.source.scope !== "user") return null;
  if (!agentServersNeedConsent(def)) return null;
  const servers = agentServers(def);
  return {
    hash: sha256(canonicalJson({ kind: "agent", file: `~/${skillLabel(def.path)}`, servers })),
    scope: "user",
    item: {
      kind: "agent",
      name: def.name,
      source: def.source,
      status: "needs-approval",
      notes: [
        ...servers.map(serverNote),
        "From Claude Code's agent files in your home folder; approving it covers every project.",
      ],
    },
  };
}

/** The agent files that supply power: the project's, and the MCP servers of Claude Code's own. */
async function agentDefinitions(options: CollectOptions): Promise<TrustDefinition[]> {
  const set = await loadAgents({ homeDir: options.homeDir, cwd: options.projectDir });
  return set.all.flatMap((def) => {
    if (def.shadowedBy !== null) return [];
    const found =
      def.source.scope === "user"
        ? userAgentDefinition(def)
        : options.projectDir === null
          ? null
          : agentDefinition(def);
    return found === null ? [] : [found];
  });
}

// ---------------------------------------------------------------------------------------------
// Added (Phase 4, sandbox): hosts a project's settings let sandboxed commands reach
// ---------------------------------------------------------------------------------------------

/**
 * A host a project's settings file opens to sandboxed commands: its identity is the file and the
 * host, so adding one asks again and removing one asks nothing.
 */
export function sandboxHostId(source: CompatSource, host: string): string {
  return sha256(canonicalJson({ kind: "sandbox-host", file: fileLabel(source), host }));
}

/** How a sandbox host is named in the approval list (the report names its item the same). */
export function sandboxHostName(host: string): string {
  return sandboxHostItemName(host);
}

/**
 * The hosts one of a project's settings files lets sandboxed commands reach: its
 * `sandbox.network.allowedDomains` and its `WebFetch(domain:…)` allow rules (which feed the
 * sandbox's list, as documented), as the report lists them. None for the person's files.
 */
export async function sandboxHostsIn(source: CompatSource): Promise<string[]> {
  if (source.scope !== "project" && source.scope !== "local") return [];
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch {
    return [];
  }
  return projectSandboxHosts(parseSettingsText(text, source.path, source.origin));
}

/** The hosts of the project's settings files, each as a definition. */
async function sandboxHostDefinitions(options: CollectOptions): Promise<TrustDefinition[]> {
  const sources = hookSources({ projectDir: options.projectDir, homeDir: options.homeDir }).filter(
    (source) => source.scope === "project" || source.scope === "local",
  );
  const out: TrustDefinition[] = [];
  for (const source of sources) {
    for (const host of await sandboxHostsIn(source)) {
      out.push({
        hash: sandboxHostId(source, host),
        scope: "project",
        item: {
          kind: "other",
          name: sandboxHostName(host),
          source,
          status: "needs-approval",
          notes: [SANDBOX_HOST_NOTE],
        },
      });
    }
  }
  return out;
}

export interface CollectOptions {
  projectDir: string | null;
  homeDir: string;
  /** Hooks already loaded for the same folders, to save reading them again. */
  hooks?: LoadedHooks;
}

/**
 * Every definition in a setup that needs consent, in the order the files are read. Hooks are left
 * out while `disableAllHooks` turns them all off: nothing of theirs can run, and turning them
 * back on changes the definitions, so the person is asked then.
 */
export async function collectDefinitions(options: CollectOptions): Promise<TrustDefinition[]> {
  const loaded =
    options.hooks ??
    (await loadHooks({ projectDir: options.projectDir, homeDir: options.homeDir }));
  const hooks = loaded.disabledBy === null ? loaded.hooks.filter(offered).map(hookDefinition) : [];
  const skills = options.projectDir === null ? [] : await skillDefinitions(options);
  const mcp = options.projectDir === null ? [] : await mcpDefinitions(options.projectDir);
  const agents = await agentDefinitions(options);
  const hosts = options.projectDir === null ? [] : await sandboxHostDefinitions(options);
  // One handler written identically in two files is one definition for each file: both files
  // must be approved, since either could change on its own.
  return [...hooks, ...skills, ...mcp, ...agents, ...hosts];
}

/** The hashes of the definitions in one file now, for checking a hook still is what was approved. */
export async function definitionsIn(source: CompatSource): Promise<Set<string>> {
  if (source.path.endsWith(".md")) {
    if (isAgentFile(source.path)) {
      const def = await readAgentFile(source.path, source);
      const found = source.scope === "user" ? userAgentDefinition(def) : agentDefinition(def);
      return new Set(found === null ? [] : [found.hash]);
    }
    if (source.scope === "user") return new Set();
    const isSkill = path.basename(source.path) === "SKILL.md";
    let text: string;
    try {
      text = await readFile(source.path, "utf8");
    } catch {
      return new Set(); // Gone: nothing of it can run.
    }
    const def = defineSkill(
      {
        kind: isSkill ? "skill" : "command",
        name: path.basename(isSkill ? path.dirname(source.path) : source.path, ".md"),
        description: "",
        descriptionFrom: "none",
        whenToUse: null,
        argumentHint: null,
        argumentNames: [],
        allowedTools: [],
        disallowedTools: [],
        model: null,
        fork: false,
        userInvocable: true,
        modelInvocable: true,
        body: "",
        path: source.path,
        dir: path.dirname(source.path),
        source,
        status: "loaded",
        notes: [],
        shadowedBy: null,
        inlineShell: false,
      },
      text,
    );
    const found = skillDefinition(def);
    return new Set(found === null ? [] : [found.hash]);
  }
  if (path.basename(source.path) === ".mcp.json") {
    const defs = await mcpDefinitions(path.dirname(source.path));
    return new Set(defs.map((d) => d.hash));
  }
  const file = await readHookFile(source);
  const hosts = (await sandboxHostsIn(source)).map((host) => sandboxHostId(source, host));
  return new Set([...file.hooks.filter(offered).map(hookId), ...hosts]);
}

/** The source of one settings file, by path, among those that apply to a project. */
export function sourceFor(
  filePath: string,
  options: { projectDir: string | null; homeDir: string },
): CompatSource | null {
  return hookSources(options).find((s) => s.path === filePath) ?? null;
}

/** The overall hash a decision is given: every definition's hash, sorted. */
export function approvalHash(definitions: readonly TrustDefinition[]): string {
  return sha256([...definitions.map((d) => d.hash)].sort().join("\n"));
}
