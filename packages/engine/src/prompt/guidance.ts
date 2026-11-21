/**
 * Segment 2 of the system message: how to use the tools together. Each tool's own description
 * says how to call it; this says which tool to reach for and how they fit together.
 *
 * A block is included only when every tool it names is in the session's tool set, so a session
 * with fewer tools (a subagent, later) is never told about a tool it does not have. The blocks
 * keep a fixed order whatever order the tools come in, so the text depends only on which tools
 * are present.
 *
 * Every claim about a tool here is checked against that tool's real behaviour in
 * `guidance.test.ts`; keep the two in step.
 */

interface GuidanceBlock {
  /** Tool names this block mentions. All must be present for the block to be included. */
  requires: readonly string[];
  text: string;
}

const HEADING = "# Using the tools";

const BLOCKS: readonly GuidanceBlock[] = [
  {
    requires: ["Read", "Edit", "Write"],
    text: "- Look at files with Read. Read a file in this session before you change it: Edit and Write refuse a file you have not read, or one that changed on disk since you read it. Write over an existing file only after reading all of it.\n- Change part of a file with Edit, copying old_string exactly from the file without the line-number prefixes Read adds. Use Write to create a file or replace a whole one. Do not create files the task does not need, such as notes or summaries.",
  },
  {
    requires: ["Glob", "Grep"],
    text: "- Find files by name with Glob and search their contents with Grep.",
  },
  {
    requires: ["Bash"],
    text: "- Use Bash for what needs a shell: tests, builds, scripts, git, package managers. Each command starts in the directory where the previous one ended, but environment variables and other shell state do not carry over. Commands cannot read input, so use flags that avoid prompts. Long output is cut to its start and end, and the full text is saved to a file whose path the result gives.",
  },
  {
    requires: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    text: "- Do not use the shell to read, search, create or edit files (cat, head, find, grep, sed, echo >): the file tools do it better and show the result clearly.",
  },
  {
    requires: ["Bash", "TaskStop"],
    text: "- Start servers, watchers and other long-running commands with run_in_background. Check on them by reading the output file the call names, and stop them with TaskStop when you no longer need them. A note tells you when one ends.",
  },
  {
    requires: ["TodoWrite"],
    text: "# Task list\n\nFor a task with three or more steps, keep a task list with TodoWrite: write it before you start, keep exactly one task in_progress, and mark each task completed as soon as it is done. TodoWrite replaces the whole list, so send every task each time. Skip it for a quick one- or two-step job.",
  },
  {
    requires: ["ExitPlanMode"],
    text: "# Plan mode\n\nIn plan mode you cannot change files, and shell commands are limited to ones that change nothing. Study the relevant code, then call ExitPlanMode with a concrete plan: the files to change, what changes in each, and how you will verify it. The user approves it, or rejects it with feedback; then revise it and present it again.",
  },
  {
    requires: ["EnterPlanMode", "ExitPlanMode"],
    text: "Call EnterPlanMode yourself before a large or risky change, or when the right approach is unclear and you want the user's agreement first.",
  },
  {
    requires: ["AskUserQuestion"],
    text: "# Questions\n\nUse AskUserQuestion when you need a decision only the user can make, offering a few clear options. Do not ask what you can find out with the tools.",
  },
];

/**
 * The guidance for a tool set, or an empty string when no block applies. Depends only on which
 * names are present, never on their order.
 */
export function renderToolGuidance(toolNames: Iterable<string>): string {
  const present = new Set(toolNames);
  const parts: string[] = [];
  let listOpen = false;
  for (const block of BLOCKS) {
    if (!block.requires.every((name) => present.has(name))) continue;
    if (!block.text.startsWith("- ")) {
      parts.push(block.text);
    } else if (!listOpen) {
      parts.push(`${HEADING}\n\n${block.text}`);
      listOpen = true;
    } else {
      // List items of the one list sit on consecutive lines. The list blocks come first.
      parts[parts.length - 1] = `${parts[parts.length - 1]}\n${block.text}`;
    }
  }
  return parts.join("\n\n");
}

/** Every guidance text, for computing the prompt version. */
export const ALL_GUIDANCE_TEXT = BLOCKS.map((b) => `${b.requires.join(",")}\n${b.text}`).join(
  "\n\n",
);
