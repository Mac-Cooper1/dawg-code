/**
 * Finds a setup's skills and custom commands and settles which one each name means, as Claude
 * Code documents it (code.claude.com/docs/en/skills, "Where skills live"):
 *
 * - Skills live in `<root>/skills/<name>/SKILL.md`, commands in `<root>/commands/**\/*.md`
 *   (a subfolder is a namespace: `frontend/component.md` is `/frontend:component`).
 * - Roots are `~/.claude` and `~/.dawg`, then the project's `.claude` and `.dawg` from the
 *   repository root down to the working directory, then (for the report, or as the agent works
 *   there) those of folders inside it.
 * - On a name conflict the person's own beat the project's, `.dawg` beats `.claude` at the same
 *   level (spec, principle 1), and a skill beats a command. A skill in a folder below a project
 *   level that already has the name loads under a name qualified with its folder,
 *   "apps/web:deploy".
 */
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { listRuleFiles } from "../instructions/rules.ts";
import { compareCodeUnits } from "../internal/paths.ts";
import { projectSubdirectories } from "../report/walk.ts";
import { readSkillFile } from "./read.ts";
import type { LoadSkillsOptions, SkillDefinition, SkillKind, SkillSet } from "./types.ts";

/**
 * dawg's own slash commands and their aliases. A file command never takes one of these names:
 * `/name` runs dawg's command, and the file is reported as a conflict. Kept in step with the
 * engine's built-in commands by a test there (packages/engine/src/skills).
 */
export const DAWG_COMMAND_NAMES: readonly string[] = [
  "add-dir",
  "allowed-tools",
  "clear",
  "compact",
  "context",
  "continue",
  "effort",
  "export",
  "help",
  "init",
  "mcp",
  "memory",
  "mode",
  "model",
  "new",
  "permissions",
  "plan",
  "rename",
  "reset",
  "resume",
  "rewind",
  "status",
];

/** What a command name typed after `/` may look like here (the engine's registry agrees). */
const TYPEABLE = /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/;

/** The name the person types for a skill or command, or null when it cannot be typed as one. */
export function commandNameOf(name: string): string | null {
  const lower = name.toLowerCase();
  return TYPEABLE.test(lower) ? lower : null;
}

/** One folder whose `.dawg` and `.claude` folders may hold skills and commands. */
interface Level {
  /** The folder holding `.claude` and `.dawg` (absolute). */
  base: string;
  scope: CompatSource["scope"];
  /** From the top project level, with `/`; "" for the person's level and the top level. */
  rel: string;
  commands: boolean;
}

/** The repository root at or above `dir`, or null when it is not in one. */
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

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function hasSkillsFolder(base: string): Promise<boolean> {
  return (
    (await isDirectory(path.join(base, ".claude", "skills"))) ||
    (await isDirectory(path.join(base, ".dawg", "skills")))
  );
}

/**
 * The project's levels, top first: the folders from the repository root down to `cwd` (only
 * `cwd` outside a repository). A worktree whose root has no skills folder takes the main
 * project's instead, as documented. The home folder's own folders are the person's, never the
 * project's.
 */
async function projectLevels(cwd: string, projectDir: string, homeDir: string): Promise<Level[]> {
  let start = path.resolve(cwd);
  if (path.resolve(projectDir) !== start && !(await hasSkillsFolder(start))) {
    start = path.resolve(projectDir);
  }
  const root = await repositoryRoot(start);
  const chain: string[] = [];
  let current = start;
  for (;;) {
    chain.unshift(current);
    if (root === null || current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const home = path.resolve(homeDir);
  const levels = chain.filter((base) => base !== home);
  const top = levels[0];
  return levels.map((base) => ({
    base,
    scope: "project" as const,
    rel: top === undefined ? "" : path.relative(top, base).split(path.sep).join("/"),
    commands: true,
  }));
}

/** Every `skills/<name>/SKILL.md` under a root, by folder name; a folder linked twice counts once. */
async function skillFiles(root: string): Promise<{ name: string; dir: string; file: string }[]> {
  const skillsDir = path.join(root, "skills");
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch {
    return [];
  }
  const out: { name: string; dir: string; file: string }[] = [];
  const seen = new Set<string>();
  for (const name of names.sort(compareCodeUnits)) {
    // Hidden folders (`.trash`) are never skills.
    if (name.startsWith(".")) continue;
    const dir = path.join(skillsDir, name);
    if (!(await isDirectory(dir))) continue;
    const real = await realpath(dir).catch(() => dir);
    if (seen.has(real)) continue;
    const file = path.join(dir, "SKILL.md");
    try {
      if (!(await stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(real);
    out.push({ name, dir, file });
  }
  return out;
}

/** Every command file under a root's `commands/` folder, with its namespaced name. */
async function commandFiles(root: string): Promise<{ name: string; file: string }[]> {
  const commandsDir = path.join(root, "commands");
  const files = await listRuleFiles(commandsDir);
  return files.map((file) => ({
    name: path.relative(commandsDir, file).replace(/\.md$/, "").split(path.sep).join(":"),
    file,
  }));
}

const ORIGINS = ["dawg", "claude"] as const;

async function readLevel(level: Level, kind: SkillKind): Promise<SkillDefinition[]> {
  const out: SkillDefinition[] = [];
  for (const origin of ORIGINS) {
    const root = path.join(level.base, `.${origin}`);
    if (kind === "skill") {
      for (const found of await skillFiles(root)) {
        out.push(
          await readSkillFile({
            kind,
            path: found.file,
            dir: found.dir,
            defaultName: found.name,
            source: { path: found.file, origin, scope: level.scope },
          }),
        );
      }
    } else if (level.commands) {
      for (const found of await commandFiles(root)) {
        out.push(
          await readSkillFile({
            kind,
            path: found.file,
            dir: path.dirname(found.file),
            defaultName: found.name,
            source: { path: found.file, origin, scope: level.scope },
          }),
        );
      }
    }
  }
  return out;
}

/** A path for a note: from the home folder with `~`, else in full. */
export function showSkillPath(file: string, homeDir: string): string {
  const home = path.resolve(homeDir);
  const rel = path.relative(home, file);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join("/")}`;
  }
  return file;
}

/** Gives each name to one definition, in the order given (highest precedence first). */
class Names {
  /** Lowercase name to the definition that has it. */
  readonly #taken = new Map<string, { def: SkillDefinition; level: Level }>();
  readonly #homeDir: string;

  constructor(homeDir: string) {
    this.#homeDir = homeDir;
  }

  /**
   * Places a definition: it keeps its name, takes a name qualified with its folder (a folder
   * below the project level that has the name), or is shadowed by the one that has it.
   */
  place(def: SkillDefinition, level: Level): SkillDefinition {
    if (def.status === "invalid") return def;
    const holder = this.#taken.get(def.name.toLowerCase());
    if (holder === undefined) {
      this.#taken.set(def.name.toLowerCase(), { def, level });
      return def;
    }
    const qualify =
      def.kind === "skill" &&
      holder.def.kind === "skill" &&
      level.rel !== "" &&
      level.base !== holder.level.base &&
      holder.level.scope !== "user";
    if (qualify) {
      const qualified = `${level.rel}:${def.name}`;
      if (!this.#taken.has(qualified.toLowerCase())) {
        const renamed = { ...def, name: qualified };
        this.#taken.set(qualified.toLowerCase(), { def: renamed, level });
        return renamed;
      }
    }
    return {
      ...def,
      shadowedBy: holder.def.path,
      notes: [
        ...def.notes,
        `Not used: ${showSkillPath(holder.def.path, this.#homeDir)} defines “${def.name}” too and takes its place.`,
      ],
    };
  }
}

function reservedNote(def: SkillDefinition): string {
  const name = def.name.toLowerCase();
  return def.modelInvocable
    ? `/${name} is one of dawg's own commands, so typing it runs that; the agent can still load this ${def.kind}.`
    : `/${name} is one of dawg's own commands, so typing it runs that, and the agent may not load this ${def.kind} on its own: it cannot run.`;
}

/** Notes that only depend on the final name: dawg's own commands, and names that cannot be typed. */
function finish(def: SkillDefinition, reserved: ReadonlySet<string>): SkillDefinition {
  if (def.status === "invalid" || def.shadowedBy !== null || !def.userInvocable) return def;
  const typed = commandNameOf(def.name);
  if (typed === null) {
    return {
      ...def,
      status: "partly-supported",
      notes: [
        ...def.notes,
        `“${def.name}” cannot be typed as a command here, so only the agent can load it.`,
      ],
    };
  }
  if (reserved.has(typed)) {
    return { ...def, status: "partly-supported", notes: [...def.notes, reservedNote(def)] };
  }
  return def;
}

/** Folders inside the project that hold a skills folder of their own, relative, top first. */
async function nestedBases(cwd: string, homeDir: string): Promise<string[]> {
  const dirs = await projectSubdirectories({ projectDir: cwd, homeDir });
  const out: string[] = [];
  for (const rel of dirs) {
    if (await hasSkillsFolder(path.join(cwd, rel))) out.push(rel);
  }
  return out;
}

/**
 * Loads every skill and command for a session in `cwd` (or only the person's, with `cwd` null).
 * Never throws: a file that cannot be used is in `all` as `invalid`, with why.
 */
export async function loadSkills(options: LoadSkillsOptions): Promise<SkillSet> {
  const homeDir = path.resolve(options.homeDir);
  const reserved = new Set(options.reservedNames ?? DAWG_COMMAND_NAMES);
  const levels: Level[] = [{ base: homeDir, scope: "user", rel: "", commands: true }];
  if (options.cwd !== null) {
    const cwd = path.resolve(options.cwd);
    levels.push(...(await projectLevels(cwd, options.projectDir ?? cwd, homeDir)));
    // The home folder is never walked as a project: it would read every project in it.
    if (options.nested && cwd !== homeDir) {
      const top = levels[1]?.base ?? cwd;
      for (const rel of await nestedBases(cwd, homeDir)) {
        const base = path.join(cwd, rel);
        levels.push({
          base,
          scope: "nested",
          rel: path.relative(top, base).split(path.sep).join("/"),
          commands: false,
        });
      }
    }
  }
  const names = new Names(homeDir);
  const all: SkillDefinition[] = [];
  for (const kind of ["skill", "command"] as const) {
    for (const level of levels) {
      for (const def of await readLevel(level, kind)) {
        let placed = names.place(def, level);
        if (level.scope === "nested") placed = withNestedNote(placed, level, top(levels));
        all.push(finish(placed, reserved));
      }
    }
  }
  return { all, active: activeOf(all) };
}

function top(levels: readonly Level[]): string {
  return levels.find((level) => level.scope !== "user")?.base ?? "";
}

function withNestedNote(def: SkillDefinition, level: Level, topBase: string): SkillDefinition {
  if (def.status === "invalid" || def.shadowedBy !== null) return def;
  const where = path.relative(topBase, level.base).split(path.sep).join("/") || ".";
  return {
    ...def,
    notes: [
      ...def.notes,
      `Loads once the agent reads or edits a file in ${where}, as documented for folders inside the project.`,
    ],
  };
}

function activeOf(all: readonly SkillDefinition[]): SkillDefinition[] {
  return all
    .filter((def) => def.status !== "invalid" && def.shadowedBy === null)
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}

/**
 * The skills of one folder inside the project, for a session that has just started working
 * there: `<cwd>/<rel>/.dawg/skills` and `.claude/skills`. Names already `taken` (lowercase) get
 * the folder-qualified name, as documented. Only usable definitions are returned.
 */
export async function loadNestedSkills(options: {
  homeDir: string;
  cwd: string;
  /** The folder, relative to `cwd`, with `/`. */
  rel: string;
  taken: ReadonlySet<string>;
}): Promise<SkillDefinition[]> {
  const cwd = path.resolve(options.cwd);
  const base = path.join(cwd, ...options.rel.split("/"));
  const level: Level = { base, scope: "nested", rel: options.rel, commands: false };
  const out: SkillDefinition[] = [];
  const local = new Set<string>();
  for (const def of await readLevel(level, "skill")) {
    if (def.status === "invalid") continue;
    let name = def.name;
    const key = name.toLowerCase();
    if (options.taken.has(key) || local.has(key)) name = `${options.rel}:${def.name}`;
    if (options.taken.has(name.toLowerCase()) || local.has(name.toLowerCase())) continue;
    local.add(name.toLowerCase());
    out.push({ ...def, name });
  }
  return out;
}
