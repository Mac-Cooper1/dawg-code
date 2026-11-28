/**
 * A new subagent file, in the front matter format Claude Code documents
 * (code.claude.com/docs/en/sub-agents, "Write subagent files"): YAML between `---` lines with the
 * fields the person chose, then the agent's system prompt. dawg writes these only under `.dawg`
 * (the person's `~/.dawg/agents/` or a project's `.dawg/agents/`), never under `.claude`; the
 * engine does the writing (Settings → Subagents' "New subagent" form).
 */
import type { PermissionMode } from "@dawg/protocol";
import { stringify } from "yaml";
import { BUILT_IN_AGENT_NAMES, refusedAgentName } from "./read.ts";
import type { AgentMemoryScope } from "./types.ts";

/** Longest name the form accepts; a file name has room for it. */
export const NEW_AGENT_NAME_MAX = 64;

/**
 * The names a new file may take. The docs describe a name as a unique identifier of lowercase
 * letters and hyphens; digits are allowed after the first letter too. Such a name is also a safe
 * file name, so `<name>.md` is the file.
 */
const NEW_AGENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Why a name cannot be given to a new agent file, or null when it can. */
export function newAgentNameProblem(name: string): string | null {
  if (name === "") return "Give the subagent a name.";
  if (name.length > NEW_AGENT_NAME_MAX) {
    return `A name has at most ${NEW_AGENT_NAME_MAX} characters.`;
  }
  if (!NEW_AGENT_NAME.test(name)) {
    return "Use lowercase letters, digits and single hyphens, starting with a letter, as in code-reviewer.";
  }
  if (name === "fork") return "“fork” names a copy of the conversation; choose another name.";
  if (BUILT_IN_AGENT_NAMES.includes(name)) {
    return `“${name}” is one of dawg's built-in agents. To replace it, write the file by hand.`;
  }
  return refusedAgentName(name);
}

export interface NewAgentFile {
  name: string;
  description: string;
  /** The system prompt: the file's body. */
  prompt: string;
  /** Null to leave `tools` out: every tool a subagent can have. */
  tools: readonly string[] | null;
  disallowedTools: readonly string[];
  /** As written (mapped to the session's model when it runs); null for the session's own. */
  model: string | null;
  permissionMode: PermissionMode | null;
  memory: AgentMemoryScope | null;
  background: boolean;
  isolation: "worktree" | null;
}

/** One line: front matter values are kept on a single line. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The file's text: front matter with the fields set, then the prompt. */
export function renderAgentFile(file: NewAgentFile): string {
  const fields: Record<string, unknown> = {
    name: file.name,
    description: flat(file.description),
  };
  // Lists are written as the docs' examples write them: "Read, Grep, Glob".
  if (file.tools !== null) fields.tools = file.tools.map(flat).join(", ");
  if (file.disallowedTools.length > 0) {
    fields.disallowedTools = file.disallowedTools.map(flat).join(", ");
  }
  if (file.model !== null) fields.model = flat(file.model);
  if (file.permissionMode !== null) fields.permissionMode = file.permissionMode;
  if (file.memory !== null) fields.memory = file.memory;
  if (file.background) fields.background = true;
  if (file.isolation !== null) fields.isolation = file.isolation;
  const yaml = stringify(fields, { lineWidth: 0 }).trimEnd();
  const body = file.prompt.replace(/\r\n?/g, "\n").trim();
  return `---\n${yaml}\n---\n${body === "" ? "" : `\n${body}\n`}`;
}
