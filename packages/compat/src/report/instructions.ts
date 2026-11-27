/**
 * The report's instruction files: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/rules/`
 * and every file they import, found the way sessions find them (`loadInstructions`, following
 * code.claude.com/docs/en/memory). Files in folders inside the project load when the agent works
 * there, so they are listed too, with when.
 */
import { join, resolve } from "node:path";
import type { CompatItem, CompatSource } from "@dawg/protocol";
import { loadInstructions } from "../instructions/loader.ts";
import { readTextFile } from "../instructions/read.ts";
import { listRuleFiles, parseRule } from "../instructions/rules.ts";
import type {
  InstructionFile,
  InstructionKind,
  InstructionProblem,
} from "../instructions/types.ts";
import { ancestorsRootFirst, isWithin } from "../internal/paths.ts";
import { displayPath, isDirectory, readText, sentence } from "./files.ts";
import type { ReportContext, ReportProvider } from "./types.ts";
import { projectTree } from "./walk.ts";

const SCOPE_OF: Record<InstructionKind, CompatSource["scope"]> = {
  user: "user",
  "user-rule": "user",
  project: "project",
  "project-rule": "project",
  agents: "project",
  local: "local",
};

/** Problems that mean part of a file's instructions did not load. */
const PARTIAL: ReadonlySet<InstructionProblem["kind"]> = new Set([
  "import-cycle",
  "import-too-deep",
  "external-import",
  "front-matter",
]);

function item(
  context: ReportContext,
  path: string,
  scope: CompatSource["scope"],
  notes: string[] = [],
): CompatItem {
  return {
    kind: "instructions",
    name: displayPath(path, context),
    source: { path, origin: "claude", scope },
    status: "loaded",
    notes,
  };
}

function patternList(patterns: readonly string[]): string {
  return patterns.map((p) => `“${p}”`).join(", ");
}

export const instructionsProvider: ReportProvider = async (context) => {
  const home = resolve(context.homeDir);
  const project = context.projectDir === null ? null : resolve(context.projectDir);
  // Without a project, only the person's own files: their CLAUDE.md and rules.
  const set = await loadInstructions({
    cwd: project ?? home,
    homeDir: home,
    ...(project === null ? {} : { projectDir: project }),
  });
  const ownOnly = (kind: InstructionKind) =>
    project !== null || kind === "user" || kind === "user-rule";

  const items: CompatItem[] = [];
  const byPath = new Map<string, CompatItem>();
  const files: InstructionFile[] = set.files.filter((file) => ownOnly(file.kind));
  for (const file of files) {
    const scope = SCOPE_OF[file.kind];
    const top = item(context, file.path, scope);
    if (file.paths !== null) {
      top.notes.push(`Loaded when the agent works on files matching ${patternList(file.paths)}.`);
    }
    items.push(top);
    byPath.set(file.path, top);
    for (const imported of file.imports) {
      items.push(
        item(context, imported, scope, [`Imported by ${displayPath(file.path, context)}.`]),
      );
    }
  }

  // Rules limited to some paths wait until a matching file is touched, so the loader has not
  // handed them out yet.
  const ruleDirs: { dir: string; scope: CompatSource["scope"] }[] = [
    { dir: join(home, ".claude", "rules"), scope: "user" },
  ];
  if (project !== null) {
    for (const dir of ancestorsRootFirst(project)) {
      const rules = join(dir, ".claude", "rules");
      if (rules !== ruleDirs[0]?.dir) ruleDirs.push({ dir: rules, scope: "project" });
    }
  }
  for (const { dir, scope } of ruleDirs) {
    if (!(await isDirectory(dir))) continue;
    for (const path of await listRuleFiles(dir)) {
      if (byPath.has(path)) continue;
      const read = await readTextFile(path);
      if (!read.ok) continue;
      const rule = parseRule(read.text, path, []);
      if (rule.paths === null) continue;
      const pending = item(context, path, scope, [
        `Loaded when the agent works on files matching ${patternList(rule.paths)}.`,
      ]);
      items.push(pending);
      byPath.set(path, pending);
    }
  }

  // What went wrong, on the file it went wrong in.
  for (const problem of set.problems) {
    if (project === null && !isWithin(problem.path, join(home, ".claude"))) continue;
    const existing = byPath.get(problem.path);
    // Without a target the file itself could not be read; with one, an import of it.
    const fileItself = problem.target === null;
    if (fileItself && (problem.kind === "unreadable" || problem.kind === "too-large")) {
      const broken = existing ?? item(context, problem.path, scopeFor(problem.path, context));
      broken.status = "invalid";
      broken.notes.push(sentence(problem.message));
      if (!existing) {
        items.push(broken);
        byPath.set(problem.path, broken);
      }
      continue;
    }
    if (!existing) continue;
    existing.notes.push(sentence(problem.message));
    const partial = PARTIAL.has(problem.kind) || (!fileItself && problem.kind !== "missing-import");
    if (partial && existing.status === "loaded") {
      existing.status = "partly-supported";
    }
  }

  if (project !== null) items.push(...(await nestedFiles(context, project, set.files)));
  return items;
};

/** Where a file the loader could not read belongs. */
function scopeFor(path: string, context: ReportContext): CompatSource["scope"] {
  if (isWithin(path, join(resolve(context.homeDir), ".claude"))) return "user";
  return path.endsWith("CLAUDE.local.md") ? "local" : "project";
}

/** Names of the files a folder's instructions come from, in the order the loader reads them. */
const NESTED_NAMES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const AGENTS_NAMES = ["AGENTS.md", join(".claude", "AGENTS.md")];
/** Entries that make a folder worth reading: the files above, or a `.claude` folder. */
const INSTRUCTION_ENTRIES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude"];

/**
 * Instruction files in folders below the project root. Sessions read them when the agent first
 * works in that folder (`forFile`); the report lists them now. `AGENTS.md` counts only when the
 * session reads `AGENTS.md` files at all (no `CLAUDE.md` at the root or above) and the folder has
 * no `CLAUDE.md` of its own.
 */
async function nestedFiles(
  context: ReportContext,
  project: string,
  started: readonly InstructionFile[],
): Promise<CompatItem[]> {
  const agentsMode = started.every((file) => file.kind !== "project" && file.kind !== "local");
  const items: CompatItem[] = [];
  const tree = await projectTree(context);
  for (const rel of tree.dirs) {
    const names = tree.names.get(rel);
    // Only folders that hold one of the names are read.
    if (!names || !INSTRUCTION_ENTRIES.some((name) => names.has(name))) continue;
    const dir = join(project, rel);
    const when = `Loaded when the agent works on files in ${rel}/.`;
    let claudeFiles = 0;
    for (const name of NESTED_NAMES) {
      const path = join(dir, name);
      const read = await readText(path);
      if (read.kind === "missing") continue;
      claudeFiles += 1;
      const nested = item(context, path, "nested", [when]);
      if (read.kind === "invalid") {
        nested.status = "invalid";
        nested.notes = [read.message];
      }
      items.push(nested);
    }
    if (agentsMode && claudeFiles === 0) {
      for (const name of AGENTS_NAMES) {
        const path = join(dir, name);
        if ((await readText(path)).kind === "missing") continue;
        items.push(item(context, path, "nested", [when]));
      }
    }
    const rules = join(dir, ".claude", "rules");
    if (names.has(".claude") && (await isDirectory(rules))) {
      for (const path of await listRuleFiles(rules)) {
        items.push(item(context, path, "nested", [when]));
      }
    }
  }
  return items;
}
