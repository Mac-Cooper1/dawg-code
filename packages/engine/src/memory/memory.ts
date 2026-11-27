/**
 * Auto memory (Phase 4 spec, "Memory"): a folder per project that lasts between sessions, which
 * the model keeps with the ordinary file tools.
 *
 *   <data root>/projects/<project key>/memory/MEMORY.md    the index, loaded at session start
 *   <data root>/projects/<project key>/memory/<topic>.md   topic files, read on demand
 *
 * The project key is the one session folders use (`projectKey` in ../session/paths.ts, with its
 * collision handling), taken from the project's root: the main working tree of the git
 * repository the project is in, else the project folder itself. So every session in a repository
 * shares one memory: one started in a subfolder, and one in a worktree of it (a worktree's `.git`
 * file names `<main>/.git/worktrees/<name>`, which leads back to `<main>`). A submodule is its own
 * project. Claude Code's own memory for the project (under `~/.claude/projects/`) is not read.
 *
 * The first `MEMORY_MAX_LINES` lines of MEMORY.md, at most `MEMORY_MAX_BYTES`, are read when a
 * session opens and go into the static prefix with the instructions below. They stay as they are
 * while the session runs, through compactions, so the prompt cache holds: a change made
 * meanwhile, by the model or the person, is seen by the next session (or the next time this one
 * is opened). The file tools may work in the folder without asking (see `memoryDirectories` in
 * the permission state); deny rules, ask rules and plan mode still apply.
 */
import { lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveProjectDir } from "../session/paths.ts";

/** The index file's name. */
export const MEMORY_INDEX = "MEMORY.md";
/** Lines of MEMORY.md loaded at session start, as Claude Code documents (200 lines or 25 KB). */
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 25 * 1024;

/**
 * The folder that names a project for memory: the main working tree of the git repository `dir`
 * is in, else `dir` itself. Reads `.git` entries only; runs no git command.
 */
export function memoryProjectRoot(dir: string): string {
  const start = path.resolve(dir);
  let current = start;
  for (;;) {
    const dotGit = path.join(current, ".git");
    let info: ReturnType<typeof lstatSync> | undefined;
    try {
      info = lstatSync(dotGit, { throwIfNoEntry: false });
    } catch {
      info = undefined;
    }
    if (info?.isDirectory()) return current;
    if (info?.isFile()) return mainWorktreeOf(current, dotGit);
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** For a `.git` file: the main working tree when it names a linked worktree, else `dir`. */
function mainWorktreeOf(dir: string, dotGit: string): string {
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8");
  } catch {
    return dir;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match?.[1] === undefined) return dir;
  const gitdir = path.resolve(dir, match[1]);
  // A linked worktree's git folder is <main>/.git/worktrees/<name>.
  const parts = gitdir.split(path.sep);
  const at = parts.lastIndexOf("worktrees");
  if (at >= 2 && parts[at - 1] === ".git" && at === parts.length - 2) {
    return parts.slice(0, at - 1).join(path.sep) || path.sep;
  }
  return dir;
}

/**
 * A project's memory folder: `<data root>/projects/<project key>/memory`. Claims the project
 * folder (its `project.json`) when nothing has yet; does not create `memory/` itself.
 */
export async function memoryDirectory(storeRoot: string, projectDir: string): Promise<string> {
  const root = memoryProjectRoot(projectDir);
  const folder = await resolveProjectDir(storeRoot, root, { create: true });
  return path.join(folder, "memory");
}

/** Where a subagent's own memory lives (agent front matter `memory: user | project | local`). */
export type AgentMemoryScope = "user" | "project" | "local";

/**
 * A subagent's memory folder for a scope, for the subagents feature:
 * - `user`: `<data root>/agent-memory/<agent>/`, the person's, for every project;
 * - `project`: `<project root>/.dawg/agent-memory/<agent>/`, meant to be committed;
 * - `local`: `<project root>/.dawg/agent-memory-local/<agent>/`, the person's, for this project.
 * The project root is `memoryProjectRoot(projectDir)`. Give the folder to the agent's session
 * as one of its `memoryDirectories` so the file tools work there without asking.
 */
export function agentMemoryDirectory(input: {
  scope: AgentMemoryScope;
  agentName: string;
  storeRoot: string;
  projectDir: string;
}): string {
  const name = input.agentName.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "") || "agent";
  if (input.scope === "user") return path.join(input.storeRoot, "agent-memory", name);
  const root = memoryProjectRoot(input.projectDir);
  const folder = input.scope === "project" ? "agent-memory" : "agent-memory-local";
  return path.join(root, ".dawg", folder, name);
}

export interface MemoryIndex {
  /** The memory folder (absolute). */
  directory: string;
  /** `<directory>/MEMORY.md`. */
  indexPath: string;
  /** Whether MEMORY.md exists. */
  exists: boolean;
  /** The part of MEMORY.md loaded into the prompt; "" when there is none. */
  text: string;
  totalLines: number;
  loadedLines: number;
  /** True when lines were left out by the line or size cap. */
  truncated: boolean;
}

/** Reads the start of a memory folder's MEMORY.md, within the caps. Never throws. */
export async function loadMemoryIndex(
  directory: string,
  limits: { maxLines?: number; maxBytes?: number } = {},
): Promise<MemoryIndex> {
  const maxLines = limits.maxLines ?? MEMORY_MAX_LINES;
  const maxBytes = limits.maxBytes ?? MEMORY_MAX_BYTES;
  const indexPath = path.join(directory, MEMORY_INDEX);
  let raw: string | null;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    raw = null;
  }
  if (raw === null) {
    return {
      directory,
      indexPath,
      exists: false,
      text: "",
      totalLines: 0,
      loadedLines: 0,
      truncated: false,
    };
  }
  const normalized = raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const lines = normalized === "" ? [] : normalized.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, maxLines)) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  return {
    directory,
    indexPath,
    exists: true,
    text: kept.join("\n"),
    totalLines: lines.length,
    loadedLines: kept.length,
    truncated: kept.length < lines.length,
  };
}

/**
 * Whether auto memory is on for a session: `autoMemoryEnabled` from the highest-precedence
 * settings file that sets it (Claude Code's documented key), else on. Reads the files as given.
 */
export async function autoMemoryEnabled(
  files: readonly { path: string; exists: boolean }[],
): Promise<boolean> {
  for (const file of files) {
    if (!file.exists) continue;
    try {
      const data: unknown = JSON.parse(await readFile(file.path, "utf8"));
      const value = (data as { autoMemoryEnabled?: unknown } | null)?.autoMemoryEnabled;
      if (typeof value === "boolean") return value;
    } catch {
      // A file that cannot be read says nothing about memory.
    }
  }
  return true;
}

/**
 * The memory segment of the static prefix: how to keep the memory, then what MEMORY.md held when
 * the session opened. Depends only on the folder and that text, so it is byte-stable.
 */
export function renderMemoryPrompt(index: MemoryIndex): string {
  const lines = [
    "# Memory",
    "",
    `You have a memory folder for this project that lasts from one session to the next: ${index.directory}`,
    "",
    `${MEMORY_INDEX} in that folder is its index. Its first ${MEMORY_MAX_LINES} lines are loaded into this prompt when a session starts; below is what it held when this one started. Keep it short: one line per memory, pointing to a topic file in the same folder that holds the detail, like "- [Test setup](testing.md): runs on a local database; reset it with make db-reset". Read a topic file with Read when its subject comes up. Use Write and Edit to keep the folder; working in it needs no permission. What you change now is seen from the next session on.`,
    "",
    "Save a memory when you learn something that will still help in a later session and that cannot be found again from the project itself:",
    "- how the person likes to work: preferences, corrections, things to avoid, and approaches they confirmed; their role and what they know well;",
    "- facts about the project that are not in its code, instruction files or git history: why things are the way they are, decisions and constraints, deadlines, who owns what;",
    "- where to find things outside the project: trackers, dashboards, documents, other repositories.",
    "When the person asks you to remember something, save it. When they ask you to forget something, remove it.",
    "",
    "Do not save what can be learned again from the project: its structure, file paths, how the code works, commands that are in its files, or fixes already in the code or its git history. Do not save what only matters to the current conversation, such as the state of the task at hand. Never save secrets: passwords, keys, tokens.",
    "",
    "Before adding a memory, look for one on the same subject and update it instead. Correct or remove memories that turn out to be wrong or out of date. Write short, plain statements, and add the date when it matters.",
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
        `(Only the first ${index.loadedLines} of its ${index.totalLines} lines were loaded. Shorten ${MEMORY_INDEX}: move detail into topic files and keep one line per memory.)`,
      );
    }
  }
  return lines.join("\n");
}
