/**
 * The agents a session can start: dawg's built-ins (Explore, Plan, general-purpose), and the
 * person's and the project's agent files (read by @dawg/compat), which take a built-in's place
 * when they share its name. Loaded once when the session opens: the list is in the `Agent`
 * tool's description, which is part of the cached prefix.
 */
import {
  type AgentDefinition,
  type AgentMcpServer,
  type AgentMemoryScope,
  agentServersNeedConsent,
  isProjectAgentCode,
  loadAgents,
  toolGrants,
  toolNameOf,
} from "@dawg/compat";
import type { CompatSource, PermissionMode } from "@dawg/protocol";
import type { AnyTool } from "../contracts/tools.ts";
import { isMcpEntry } from "./mcp.ts";
import { MEMORY_TOOLS } from "./memory.ts";
import {
  customAgentPrompt,
  EXPLORE_PROMPT,
  GENERAL_PURPOSE_PROMPT,
  PLAN_PROMPT,
} from "./prompts.ts";

/** What the model passes as `subagent_type` for a copy of itself. */
export const FORK_TYPE = "fork";

/** The default `subagent_type`. */
export const GENERAL_PURPOSE = "general-purpose";

/**
 * Tools no subagent gets: the agent tools (a subagent does not start agents of its own), and the
 * tools that need the person, who is not in a subagent's conversation.
 */
export const NOT_FOR_SUBAGENTS: ReadonlySet<string> = new Set([
  "Agent",
  "SendMessage",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

/** Tools a read-only agent never gets. Its shell is held to commands that change nothing. */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "TodoWrite"];

export interface AgentSpec {
  name: string;
  description: string;
  /** The role segment of its system message. */
  prompt: string;
  /** Tool names it may use, or null for every tool a subagent can have. */
  tools: readonly string[] | null;
  disallowedTools: readonly string[];
  /** Allow rules its file grants while it runs (`tools` entries with a specifier). */
  grants: readonly string[];
  permissionMode: PermissionMode | null;
  /** Read-only built-ins run in plan mode whatever the parent's mode. */
  readOnly: boolean;
  maxTurns: number | null;
  skills: readonly string[];
  background: boolean;
  isolation: "worktree" | null;
  /** The file it came from; null for a built-in. */
  source: CompatSource | null;
  /** Its grants, loose mode or servers of its own need the person's approval of the project's code. */
  projectCode: boolean;
  /** Added (round 3): its own lasting memory folder's scope; absent or null for none. */
  memory?: AgentMemoryScope | null;
  /** Added (round 3): `mcpServers`, references and servers of its own (./mcp.ts). */
  mcpServers?: readonly AgentMcpServer[];
  /**
   * Added (round 3): its servers of its own wait for the person's approval (a project's file, or
   * Claude Code's in the home folder; not `~/.dawg`'s).
   */
  serversNeedConsent?: boolean;
}

function builtIn(name: string, description: string, prompt: string, readOnly: boolean): AgentSpec {
  return {
    name,
    description,
    prompt,
    tools: null,
    disallowedTools: readOnly ? WRITE_TOOLS : [],
    grants: [],
    permissionMode: readOnly ? "plan" : null,
    readOnly,
    maxTurns: null,
    skills: [],
    background: false,
    isolation: null,
    source: null,
    projectCode: false,
    memory: null,
    mcpServers: [],
  };
}

export const BUILT_IN_AGENTS: readonly AgentSpec[] = [
  builtIn(
    "Explore",
    'Read-only search of the codebase: finds files, code and facts and reports where they are, without changing anything. Say how thorough to be: "quick", "medium" or "very thorough".',
    EXPLORE_PROMPT,
    true,
  ),
  builtIn(
    "Plan",
    "Read-only design: studies the code and returns a step-by-step plan for a change, with the files to touch, the order of work, how to verify it and the risks.",
    PLAN_PROMPT,
    true,
  ),
  builtIn(
    GENERAL_PURPOSE,
    "Carries out a multi-step task with every tool: research, changes across files, running commands. Use it when the work is independent and its details need not be in your own context.",
    GENERAL_PURPOSE_PROMPT,
    false,
  ),
];

function fromFile(def: AgentDefinition): AgentSpec {
  return {
    name: def.name,
    description: def.description.replace(/\s+/g, " ").trim(),
    prompt: customAgentPrompt(def.name, def.prompt),
    tools: def.tools === null ? null : def.tools.map(toolNameOf).filter((name) => name !== "Agent"),
    disallowedTools: def.disallowedTools.map(toolNameOf),
    grants: toolGrants(def),
    permissionMode: def.permissionMode,
    readOnly: false,
    maxTurns: def.maxTurns,
    skills: def.skills,
    background: def.background,
    isolation: def.isolation,
    source: def.source,
    projectCode: isProjectAgentCode(def),
    memory: def.memory,
    mcpServers: def.mcpServers,
    serversNeedConsent: agentServersNeedConsent(def),
  };
}

export class AgentRegistry {
  /** In listing order: the built-ins (or the files that replace them), then the others by name. */
  readonly specs: readonly AgentSpec[];

  constructor(files: readonly AgentDefinition[]) {
    const byName = new Map<string, AgentSpec>();
    for (const spec of BUILT_IN_AGENTS) byName.set(spec.name, spec);
    for (const def of files) {
      // A file can never take the fork's name: that one means a copy of the conversation.
      if (def.name === FORK_TYPE) continue;
      byName.set(def.name, fromFile(def));
    }
    const builtInNames = BUILT_IN_AGENTS.map((spec) => spec.name);
    const rest = [...byName.keys()].filter((name) => !builtInNames.includes(name)).sort();
    this.specs = [...builtInNames, ...rest].map((name) => byName.get(name) as AgentSpec);
  }

  static async load(input: {
    homeDir: string;
    cwd: string;
    projectDir: string;
  }): Promise<AgentRegistry> {
    const set = await loadAgents({
      homeDir: input.homeDir,
      cwd: input.cwd,
      projectDir: input.projectDir,
    }).catch(() => ({ all: [], active: [] }));
    return new AgentRegistry(set.active);
  }

  find(name: string): AgentSpec | undefined {
    return this.specs.find((spec) => spec.name === name);
  }

  get names(): string[] {
    return this.specs.map((spec) => spec.name);
  }
}

/**
 * The tools an agent gets, in the session's order: every tool a subagent may have, narrowed to
 * its `tools` when it names any, less its `disallowedTools`. With its memory on, Read, Write and
 * Edit are added to a `tools` list that leaves them out (as documented); `disallowedTools` still
 * wins. MCP tools join later, when the session decides them (./mcp.ts).
 */
export function agentTools(
  spec: AgentSpec,
  available: readonly AnyTool[],
  options: { memory?: boolean } = {},
): AnyTool[] {
  const allowed =
    spec.tools === null
      ? null
      : new Set([...spec.tools, ...(options.memory === true ? MEMORY_TOOLS : [])]);
  const denied = new Set(spec.disallowedTools);
  return available.filter(
    (tool) =>
      !NOT_FOR_SUBAGENTS.has(tool.name) &&
      !denied.has(tool.name) &&
      (allowed === null || allowed.has(tool.name)),
  );
}

/** Whether an agent's `tools` list or `mcpServers` asks for MCP tools, which come later than the rest. */
export function wantsMcp(spec: AgentSpec): boolean {
  return (spec.tools ?? []).some(isMcpEntry) || (spec.mcpServers ?? []).length > 0;
}

const LOOSENESS: Readonly<Record<PermissionMode, number>> = {
  plan: 0,
  dontAsk: 1,
  default: 2,
  acceptEdits: 3,
  bypassPermissions: 4,
};

/**
 * The mode an agent's calls are judged in, from the parent's mode now and the agent's own, as
 * documented: a parent in bypassPermissions or acceptEdits keeps its mode; a parent in plan mode
 * keeps its agents in plan mode; otherwise the agent's own mode applies, unless it is not
 * available (bypass turned off by settings) or is project code the person has not approved and
 * looser than the parent's. Read-only built-ins always run in plan mode.
 */
export function agentMode(input: {
  parent: PermissionMode;
  spec: AgentSpec;
  /** The person approved the project's code (asked only for project code). */
  approved: boolean;
  /** Whether the parent's settings allow a mode. */
  allowed: (mode: PermissionMode) => boolean;
}): PermissionMode {
  const { parent, spec } = input;
  if (spec.readOnly) return "plan";
  if (parent === "bypassPermissions" || parent === "acceptEdits" || parent === "plan") {
    return parent;
  }
  const own = spec.permissionMode;
  if (own === null || !input.allowed(own)) return parent;
  if (spec.projectCode && !input.approved && LOOSENESS[own] > LOOSENESS[parent]) return parent;
  return own;
}
