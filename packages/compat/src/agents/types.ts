/**
 * Subagent files, as Claude Code documents them (code.claude.com/docs/en/sub-agents): Markdown
 * with front matter under `agents/` in `~/.claude`, `~/.dawg`, and a project's `.claude` and
 * `.dawg`. The front matter configures the agent; the body is its system prompt.
 *
 * This file is a contract between the reader in this package and the engine's subagents
 * (packages/engine/src/agents). Change it deliberately.
 */
import type { CompatItemStatus, CompatSource, PermissionMode } from "@dawg/protocol";

export interface AgentDefinition {
  /** `name`: what the model passes as `subagent_type`. */
  name: string;
  /** `description`: when the model should hand a task to this agent. */
  description: string;
  /**
   * `tools`: the tools it may use, by name. Null when absent: every tool a subagent can have. An
   * entry with a specifier, `Bash(npm test *)`, makes the tool available and is also granted as
   * an allow rule while the agent runs (`toolGrants`).
   */
  tools: string[] | null;
  /** `disallowedTools`: taken away, before `tools` is applied. */
  disallowedTools: string[];
  /** `model`, as written; mapped to the session's model (principle 4). Null when absent or `inherit`. */
  model: string | null;
  /** `permissionMode`, when it names a mode dawg has ("manual" reads as "default"). */
  permissionMode: PermissionMode | null;
  /** `maxTurns`: model requests per task before it stops. */
  maxTurns: number | null;
  /** `skills`: skills whose instructions are loaded into its context when it starts. */
  skills: string[];
  /** `background: true`: always runs in the background. */
  background: boolean;
  /** `isolation: worktree`: runs in a git worktree of its own. */
  isolation: "worktree" | null;
  /**
   * `memory`: a lasting folder of its own (`user`, `project` or `local`), loaded and kept the way
   * a session's memory is; null for none.
   */
  memory: AgentMemoryScope | null;
  /**
   * `mcpServers`: MCP servers it gets, each a reference to one configured for the session (by
   * name) or a definition of its own (`inline`), in the order written.
   */
  mcpServers: AgentMcpServer[];
  /** The body: the agent's own system prompt. */
  prompt: string;
  /** The file (absolute). */
  path: string;
  source: CompatSource;
  /** `loaded`, `partly-supported` (each ignored field named in `notes`) or `invalid`. */
  status: CompatItemStatus;
  /** Sentences for people: ignored fields, mapped ones, why it is not used. */
  notes: string[];
  /** The file whose definition of the same name is used instead, or null when this one is used. */
  shadowedBy: string | null;
}

/** Where an agent's own memory lives: the person's for every project, the project's, or the person's for this project. */
export type AgentMemoryScope = "user" | "project" | "local";

/** One `mcpServers` entry. */
export interface AgentMcpServer {
  /** The server's name: the configured server it refers to, or the inline definition's key. */
  name: string;
  /** The definition, as written, for a server of its own; null for a reference by name. */
  inline: Readonly<Record<string, unknown>> | null;
}

export interface LoadAgentsOptions {
  /** The person's home directory (absolute): `~/.claude/agents`, `~/.dawg/agents`. */
  homeDir: string;
  /** The session's working directory (absolute), or null for only the person's own. */
  cwd: string | null;
  /**
   * The project a worktree session belongs to (absolute). When the worktree has no agents folder
   * of its own, the project's are read instead. Defaults to `cwd`.
   */
  projectDir?: string;
}

export interface AgentSet {
  /** Every file found, in reading order (the person's, then the project's from the top down). */
  all: AgentDefinition[];
  /** The ones in use: one per name, valid, sorted by name. */
  active: AgentDefinition[];
}
