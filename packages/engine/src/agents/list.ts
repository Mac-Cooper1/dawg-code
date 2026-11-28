/**
 * `project.subagents`: every subagent a project's new sessions can start, for Settings →
 * Subagents and `/agents`. Read from the files as they are now (a session keeps the agents it
 * read when it opened), with the built-ins, and with the files that cannot be used or that
 * another definition of the same name replaces, so the page accounts for everything it found.
 *
 * Statuses: a definition whose project file supplies power (tool grants, a looser mode, MCP
 * servers of its own) is "needs-approval" until the person approves the project's code; the
 * agent still loads, without that power (registry.ts, `agentMode`; ./mcp.ts).
 */
import path from "node:path";
import {
  type AgentDefinition,
  agentServersNeedConsent,
  inlineMcpServers,
  isProjectAgentCode,
  loadAgents,
  toolGrants,
} from "@dawg/compat";
import type { SubagentDefinition } from "@dawg/protocol";
import { agentMemoryDirectory } from "../memory/index.ts";
import type { CodeTrust } from "../trust/index.ts";
import { BUILT_IN_AGENTS, FORK_TYPE } from "./registry.ts";

export interface ProjectSubagentsInput {
  homeDir: string;
  /** The engine's data root: the person's agents keep their memory under it. */
  storeRoot: string;
  /** An absolute folder, or null for only the built-ins and the person's own files. */
  projectDir: string | null;
  trust: CodeTrust;
}

export interface ProjectSubagents {
  projectDir: string | null;
  agents: SubagentDefinition[];
  folders: { user: string; project: string | null };
}

/** Where new agent files go: always `.dawg`, never `.claude`. */
export function agentFolders(
  homeDir: string,
  projectDir: string | null,
): { user: string; project: string | null } {
  return {
    user: path.join(homeDir, ".dawg", "agents"),
    project: projectDir === null ? null : path.join(projectDir, ".dawg", "agents"),
  };
}

/** A path for a note: from the home folder with `~`, else in full. */
function shown(file: string, homeDir: string): string {
  const rel = path.relative(path.resolve(homeDir), file);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return file;
}

/** What waits for the project's code to be approved, in words. */
function pendingPower(def: AgentDefinition): { what: string; plural: boolean } {
  const parts: { text: string; plural: boolean }[] = [];
  // From the person's home only the servers wait: that file's grants and mode are theirs.
  if (isProjectAgentCode(def)) {
    const grants = toolGrants(def);
    if (grants.length > 0)
      parts.push({ text: `its tool grants (${grants.join(", ")})`, plural: true });
    if (def.permissionMode === "acceptEdits" || def.permissionMode === "bypassPermissions") {
      parts.push({ text: `its ${def.permissionMode} mode`, plural: false });
    }
  }
  const servers = inlineMcpServers(def).map((s) => s.name);
  if (servers.length > 0) {
    parts.push({
      text: `its MCP server${servers.length === 1 ? "" : "s"} ${servers.join(", ")}`,
      plural: servers.length > 1,
    });
  }
  return {
    what: parts.map((p) => p.text).join(" and "),
    plural: parts.length > 1 || parts.some((p) => p.plural),
  };
}

/** Whether a definition holds power that waits for the person's approval. */
function needsConsent(def: AgentDefinition): boolean {
  return isProjectAgentCode(def) || agentServersNeedConsent(def);
}

function fromFile(
  def: AgentDefinition,
  input: ProjectSubagentsInput,
  approved: boolean,
): SubagentDefinition {
  const notes = [...def.notes];
  let status: SubagentDefinition["status"];
  let overriddenBy: string | null = null;
  if (def.status === "invalid") status = "invalid";
  else if (def.name === FORK_TYPE) {
    status = "invalid";
    notes.push("“fork” names a copy of the conversation, so a file cannot take that name.");
  } else if (def.shadowedBy !== null) {
    status = "overridden";
    overriddenBy = def.shadowedBy;
  } else if (needsConsent(def) && !approved) {
    status = "needs-approval";
    // The reader's own sentence about project code says the same at more length.
    const kept = notes.filter(
      (note) => !note.startsWith("Project code:") && !note.startsWith("Its MCP server"),
    );
    const { what, plural } = pendingPower(def);
    notes.length = 0;
    notes.push(
      def.source.scope === "user"
        ? `It loads, but ${what} ${plural ? "wait" : "waits"} for your approval: Claude Code's agent files in your home folder run code dawg did not write.`
        : `It loads, but ${what} ${plural ? "wait" : "waits"} for you to approve the project's code.`,
      ...kept,
    );
  } else status = def.status === "partly-supported" ? "partly-supported" : "loaded";
  const memoryDirectory =
    def.memory === null || (def.memory !== "user" && input.projectDir === null)
      ? null
      : agentMemoryDirectory({
          scope: def.memory,
          agentName: def.name,
          storeRoot: input.storeRoot,
          projectDir: input.projectDir ?? input.homeDir,
        });
  return {
    name: def.name,
    description: def.description,
    builtIn: false,
    source: def.source,
    tools: def.tools,
    disallowedTools: def.disallowedTools,
    model: def.model,
    mappedModel: null,
    permissionMode: def.permissionMode,
    readOnly: false,
    maxTurns: def.maxTurns,
    skills: def.skills,
    memory: def.memory,
    memoryDirectory,
    mcpServers: def.mcpServers.map((s) => ({ name: s.name, inline: s.inline !== null })),
    background: def.background,
    isolation: def.isolation,
    status,
    overriddenBy,
    notes,
  };
}

/** The listing. Never throws for a file: one that cannot be used is listed as invalid. */
export async function projectSubagents(input: ProjectSubagentsInput): Promise<ProjectSubagents> {
  const set = await loadAgents({ homeDir: input.homeDir, cwd: input.projectDir }).catch(() => ({
    all: [] as AgentDefinition[],
    active: [] as AgentDefinition[],
  }));
  const files: SubagentDefinition[] = [];
  for (const def of set.all) {
    const approved =
      needsConsent(def) && def.status !== "invalid"
        ? await input.trust.allows(def.source, input.projectDir).catch(() => false)
        : true;
    files.push(fromFile(def, input, approved));
  }
  const used = new Map(
    set.active.filter((def) => def.name !== FORK_TYPE).map((def) => [def.name, def.path]),
  );
  const builtIns: SubagentDefinition[] = BUILT_IN_AGENTS.map((spec) => {
    const by = used.get(spec.name) ?? null;
    return {
      name: spec.name,
      description: spec.description,
      builtIn: true,
      source: null,
      tools: null,
      disallowedTools: [...spec.disallowedTools],
      model: null,
      mappedModel: null,
      permissionMode: spec.permissionMode,
      readOnly: spec.readOnly,
      maxTurns: null,
      skills: [],
      memory: null,
      memoryDirectory: null,
      mcpServers: [],
      background: false,
      isolation: null,
      status: by === null ? "loaded" : "overridden",
      overriddenBy: by,
      notes:
        by === null
          ? []
          : [`Not used: ${shown(by, input.homeDir)} defines “${spec.name}” and takes its place.`],
    };
  });
  return {
    projectDir: input.projectDir,
    agents: [...builtIns, ...files],
    folders: agentFolders(input.homeDir, input.projectDir),
  };
}
