/**
 * `/init`: which instruction file to write, and the prompt that asks the model to write it.
 *
 * Instruction files are loaded as `@dawg/compat` loads them: every `CLAUDE.md` from the
 * filesystem root down to the working directory is read, while `AGENTS.md` files are read only
 * when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or
 * above it. So:
 *
 * 1. A `CLAUDE.md` in the working directory is improved in place.
 * 2. Otherwise, when the session is reading `AGENTS.md` files (no Claude file anywhere up the
 *    tree, and an `AGENTS.md` here or above), `AGENTS.md` here is written. Creating a `CLAUDE.md`
 *    instead would silently switch every existing `AGENTS.md` off.
 * 3. Otherwise `CLAUDE.md` is created in the working directory: it is loaded whatever else the
 *    tree holds, and other agents that follow the same convention read it too.
 *
 * Never `.claude/CLAUDE.md`: nothing under `.claude/` is ever written.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

const CLAUDE_FILES = ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const AGENTS_FILES = ["AGENTS.md", path.join(".claude", "AGENTS.md")];

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The directory and each of its parents, nearest first. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

async function anyExists(dirs: readonly string[], names: readonly string[], skip: string) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (candidate !== skip && (await isFile(candidate))) return true;
    }
  }
  return false;
}

export interface InitTarget {
  /** Absolute path of the file to write. */
  path: string;
  /** True when it exists and should be improved rather than created. */
  exists: boolean;
  /** Why this file, in one sentence for the person. */
  reason: string;
}

export async function chooseInstructionFile(cwd: string, homeDir: string): Promise<InitTarget> {
  const dirs = ancestors(cwd);
  const userFile = path.join(path.resolve(homeDir), ".claude", "CLAUDE.md");
  const claudeHere = path.join(path.resolve(cwd), "CLAUDE.md");
  if (await isFile(claudeHere)) {
    return { path: claudeHere, exists: true, reason: "CLAUDE.md already exists here." };
  }
  const claudeMode = await anyExists(dirs, CLAUDE_FILES, userFile);
  if (!claudeMode && (await anyExists(dirs, AGENTS_FILES, ""))) {
    const agentsHere = path.join(path.resolve(cwd), "AGENTS.md");
    return {
      path: agentsHere,
      exists: await isFile(agentsHere),
      reason:
        "This project uses AGENTS.md; a new CLAUDE.md would stop AGENTS.md files from being read.",
    };
  }
  return {
    path: claudeHere,
    exists: false,
    reason: "CLAUDE.md is read in every session, whatever other instruction files exist.",
  };
}

/** The prompt `/init` sends. Written for this project. */
export function initPrompt(target: InitTarget, cwd: string, extra: string): string {
  const relative = path.relative(cwd, target.path) || path.basename(target.path);
  const action = target.exists
    ? `Improve the existing instruction file \`${relative}\`: keep what is still accurate, correct what is wrong, and fill the gaps.`
    : `Create the instruction file \`${relative}\` in the project root.`;
  const lines = [
    "Study this project and write the instruction file that coding agents read at the start of every session.",
    "",
    action,
    "",
    "Explore before writing: read the README and the build, test, lint and formatting configuration, look at how the source tree is laid out, and skim a few representative source and test files.",
    "",
    "The file should be short Markdown (well under 200 lines) and cover:",
    "- what the project is, in a sentence or two;",
    "- the exact commands to install dependencies, build, run all tests, run a single test, lint and format;",
    "- how the code is organised, naming only the directories that matter;",
    "- conventions a newcomer would not guess from the code: style rules, error handling, testing patterns, things to avoid.",
    "",
    "Write only facts you checked in the repository. Do not invent commands or describe files that do not exist. Do not repeat generic programming advice.",
    `Change no file other than \`${relative}\`.`,
  ];
  if (extra.trim() !== "") lines.push("", `The person added: ${extra.trim()}`);
  return lines.join("\n");
}
