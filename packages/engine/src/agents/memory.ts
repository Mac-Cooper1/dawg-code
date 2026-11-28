/**
 * A subagent's own memory (Phase 4 spec, "Memory"; Claude Code's subagents docs, "Enable
 * persistent memory"): front matter `memory: user | project | local` gives the agent a folder
 * that lasts between sessions, from `agentMemoryDirectory` (../memory):
 *
 *   user     <data root>/agent-memory/<agent>/                 the person's, for every project
 *   project  <project root>/.dawg/agent-memory/<agent>/        the project's, meant to be committed
 *   local    <project root>/.dawg/agent-memory-local/<agent>/  the person's, for this project
 *
 * As documented, the agent's system prompt then holds instructions for keeping the folder and
 * the first 200 lines (at most 25 KB) of its MEMORY.md, with a request to tidy it when it is
 * longer; Read, Write and Edit are given to it even when its `tools` list leaves them out; and
 * the file tools work in the folder without asking (the folder is its session's memory folder,
 * so the permission state's `memoryDirectories` holds it). Nothing happens when auto memory is
 * off. Claude Code's own folders (`.claude/agent-memory`) are not read: dawg keeps its own state.
 */
import {
  type AgentMemoryScope,
  agentMemoryDirectory,
  loadMemoryIndex,
  MEMORY_INDEX,
  MEMORY_MAX_LINES,
  type MemoryIndex,
} from "../memory/index.ts";

/** The tools a memory-enabled agent always gets, so it can keep its folder. */
export const MEMORY_TOOLS: readonly string[] = ["Read", "Write", "Edit"];

/** What an agent's memory folder holds, in a few words. */
const SCOPE_WORDS: Readonly<Record<AgentMemoryScope, string>> = {
  user: "It is yours across every project of this user, so keep what holds anywhere, not facts about one project.",
  project:
    "It belongs to this project and is meant to be shared with the team through version control, so keep what helps anyone who uses you here, and nothing personal or secret.",
  local:
    "It belongs to this project and stays on this user's machine, out of version control, so keep what helps you here for this user.",
};

/** An agent's memory as its session opens: the folder, and the prompt segment for it. */
export interface AgentMemory {
  scope: AgentMemoryScope;
  index: MemoryIndex;
  /** The memory segment of its prefix. */
  prompt: string;
}

/** Reads an agent's MEMORY.md and renders its segment. Never throws. */
export async function loadAgentMemory(input: {
  scope: AgentMemoryScope;
  agentName: string;
  storeRoot: string;
  projectDir: string;
}): Promise<AgentMemory> {
  const directory = agentMemoryDirectory(input);
  const index = await loadMemoryIndex(directory);
  return {
    scope: input.scope,
    index,
    prompt: renderAgentMemoryPrompt(index, input.scope, input.agentName),
  };
}

/**
 * The memory segment of an agent's prefix: how to keep its folder, then what MEMORY.md held when
 * its session opened. Depends only on its arguments, so it is byte-stable.
 */
export function renderAgentMemoryPrompt(
  index: MemoryIndex,
  scope: AgentMemoryScope,
  agentName: string,
): string {
  const lines = [
    "# Your memory",
    "",
    `As the ${agentName} agent you have a memory folder of your own that lasts from one task and session to the next: ${index.directory}`,
    "",
    SCOPE_WORDS[scope],
    "",
    `${MEMORY_INDEX} in that folder is its index. Its first ${MEMORY_MAX_LINES} lines are loaded into this prompt when you start; below is what it held then. Look at it before you start work, and read a topic file in the folder with Read when its subject comes up. Keep the index short: one line per memory, pointing to a topic file that holds the detail. Use Write and Edit to keep the folder; working in it needs no permission.`,
    "",
    "When you finish a task, save what you learned that will help with later tasks and cannot be found again from the project itself: patterns and conventions you confirmed, decisions and the reasons for them, pitfalls and how you got past them. Update a memory on the same subject instead of adding another, and correct or remove ones that turn out to be wrong. Do not save the task's own state, what the code already says, or secrets: passwords, keys, tokens.",
    "",
    `## ${MEMORY_INDEX}`,
    "",
  ];
  if (!index.exists || index.text.trim() === "") {
    lines.push("(Empty: nothing has been saved yet.)");
  } else {
    lines.push(index.text);
    if (index.truncated) {
      lines.push(
        "",
        `(Only the first ${index.loadedLines} of its ${index.totalLines} lines were loaded. Tidy ${MEMORY_INDEX}: move detail into topic files and keep one line per memory.)`,
      );
    }
  }
  return lines.join("\n");
}
