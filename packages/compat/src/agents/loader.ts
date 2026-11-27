/**
 * Finds a setup's subagent files and settles which one each name means, as Claude Code
 * documents it (code.claude.com/docs/en/sub-agents, "Choose the subagent scope"):
 *
 * - Files live under `<root>/agents/`, read recursively; a subfolder does not change the name,
 *   which comes from the front matter alone.
 * - Roots are `~/.claude` and `~/.dawg`, then the project's `.claude` and `.dawg` from the
 *   repository root down to the working directory.
 * - On a name conflict the project's beat the person's, the folder nearest the working directory
 *   wins, and `.dawg` beats `.claude` at the same level (spec, principle 1). Within one folder
 *   the first file (by path) keeps the name.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { compareCodeUnits } from "../internal/paths.ts";
import { listFiles } from "../report/files.ts";
import { readAgentFile } from "./read.ts";
import type { AgentDefinition, AgentSet, LoadAgentsOptions } from "./types.ts";

interface Root {
  dir: string;
  origin: CompatSource["origin"];
  scope: CompatSource["scope"];
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function repositoryRoot(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      // Not here; keep looking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function hasAgentsFolder(base: string): Promise<boolean> {
  return (
    (await isDirectory(path.join(base, ".claude", "agents"))) ||
    (await isDirectory(path.join(base, ".dawg", "agents")))
  );
}

/** Roots in rising precedence: the person's, then the project's from the top down to `cwd`. */
async function roots(options: LoadAgentsOptions): Promise<Root[]> {
  const home = path.resolve(options.homeDir);
  const out: Root[] = [
    { dir: path.join(home, ".claude"), origin: "claude", scope: "user" },
    { dir: path.join(home, ".dawg"), origin: "dawg", scope: "user" },
  ];
  if (options.cwd === null) return out;
  let start = path.resolve(options.cwd);
  const projectDir = path.resolve(options.projectDir ?? start);
  // A worktree without agents of its own reads its project's.
  if (projectDir !== start && !(await hasAgentsFolder(start))) start = projectDir;
  const top = await repositoryRoot(start);
  const chain: string[] = [];
  let current = start;
  for (;;) {
    chain.unshift(current);
    if (top === null || current === top) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const base of chain) {
    // The home folder's own folders are the person's, never the project's.
    if (base === home) continue;
    out.push(
      { dir: path.join(base, ".claude"), origin: "claude", scope: "project" },
      { dir: path.join(base, ".dawg"), origin: "dawg", scope: "project" },
    );
  }
  return out;
}

/** A path for a note: from the home folder with `~`, else in full. */
function shown(file: string, homeDir: string): string {
  const rel = path.relative(path.resolve(homeDir), file);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return file;
}

/**
 * Loads every subagent file for a session in `cwd` (or only the person's, with `cwd` null).
 * Never throws: a file that cannot be used is in `all` as `invalid`, with why.
 */
export async function loadAgents(options: LoadAgentsOptions): Promise<AgentSet> {
  const all: AgentDefinition[] = [];
  for (const root of await roots(options)) {
    const dir = path.join(root.dir, "agents");
    if (!(await isDirectory(dir))) continue;
    const local = new Map<string, AgentDefinition>();
    for (const file of await listFiles(dir, ".md")) {
      const def = await readAgentFile(file, { path: file, origin: root.origin, scope: root.scope });
      const first = def.status === "invalid" ? undefined : local.get(def.name);
      if (first !== undefined) {
        all.push({
          ...def,
          shadowedBy: first.path,
          notes: [
            ...def.notes,
            `Not used: ${shown(first.path, options.homeDir)} in the same folder is also named “${def.name}”.`,
          ],
        });
        continue;
      }
      if (def.status !== "invalid") local.set(def.name, def);
      all.push(def);
    }
  }
  // The last valid definition of each name (the highest precedence) is the one in use.
  const winner = new Map<string, number>();
  all.forEach((def, index) => {
    if (def.status !== "invalid" && def.shadowedBy === null) winner.set(def.name, index);
  });
  const settled = all.map((def, index) => {
    const wins = winner.get(def.name);
    if (def.status === "invalid" || def.shadowedBy !== null || wins === index) return def;
    const by = all[wins as number] as AgentDefinition;
    return {
      ...def,
      shadowedBy: by.path,
      notes: [
        ...def.notes,
        `Not used: ${shown(by.path, options.homeDir)} defines “${def.name}” too and takes its place.`,
      ],
    };
  });
  const active = settled
    .filter((def) => def.status !== "invalid" && def.shadowedBy === null)
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  return { all: settled, active };
}
