/**
 * The folders inside a project, for what Claude Code reads from them as the agent works there
 * (`CLAUDE.md` files, `.claude/rules`, nested `.claude/skills`). Walked once per report and
 * shared by the providers that need it.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareCodeUnits } from "../internal/paths.ts";
import type { ReportContext } from "./types.ts";

/** How deep below the project root the walk goes. */
export const MAX_WALK_DEPTH = 8;
/** Most folders the walk reads, so a huge tree cannot stall the report. */
export const MAX_WALK_DIRECTORIES = 5000;

/**
 * Folders never walked: dependencies and build output, which hold other people's files, and
 * hidden folders (`.git`, `.claude`, `.venv`...), which are read for what they are, not walked.
 */
const SKIPPED = new Set(["node_modules", "bower_components", "__pycache__", "target", "vendor"]);

/** The folders below a project root, and what each one holds. */
export interface ProjectTree {
  /** Relative with `/` separators, breadth first and sorted within each level. */
  dirs: string[];
  /** The names of each folder's entries (files and folders, hidden ones too), by `dirs` entry. */
  names: ReadonlyMap<string, ReadonlySet<string>>;
}

const EMPTY_TREE: ProjectTree = { dirs: [], names: new Map() };
const cache = new WeakMap<ReportContext, Promise<ProjectTree>>();

/** The project's folders and their entries, walked once per report. Empty without a project. */
export function projectTree(context: ReportContext): Promise<ProjectTree> {
  if (context.projectDir === null) return Promise.resolve(EMPTY_TREE);
  let pending = cache.get(context);
  if (!pending) {
    pending = walk(resolve(context.projectDir));
    cache.set(context, pending);
  }
  return pending;
}

/**
 * Every folder below the project root, relative with `/` separators, breadth first and sorted
 * within each level. Empty without a project. Symbolic links to folders are not followed.
 */
export async function projectSubdirectories(context: ReportContext): Promise<string[]> {
  return (await projectTree(context)).dirs;
}

async function walk(root: string): Promise<ProjectTree> {
  const dirs: string[] = [];
  const names = new Map<string, ReadonlySet<string>>();
  let level: string[] = [""];
  for (let depth = 0; level.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(rel === "" ? root : join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      if (rel !== "") names.set(rel, new Set(entries.map((entry) => entry.name)));
      // The deepest folders are read for what they hold, not walked further.
      if (depth >= MAX_WALK_DEPTH) continue;
      const children = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith(".") && !SKIPPED.has(name))
        .sort(compareCodeUnits);
      for (const name of children) {
        if (dirs.length >= MAX_WALK_DIRECTORIES) break;
        const child = rel === "" ? name : `${rel}/${name}`;
        dirs.push(child);
        next.push(child);
      }
    }
    level = next;
  }
  return { dirs, names };
}
