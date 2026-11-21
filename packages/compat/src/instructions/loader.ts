import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ancestorsRootFirst, isWithin, realpathLoose } from "../internal/paths.ts";
import { expandImports, isInternal, type ReadContext, readTextFile } from "./read.ts";
import { compileRulePatterns, listRuleFiles, parseRule, relativeInside } from "./rules.ts";
import type {
  InstructionBatch,
  InstructionFile,
  InstructionKind,
  InstructionSet,
  LoadInstructionsOptions,
} from "./types.ts";

/** Files whose presence in the working directory or above means `AGENTS.md` is not read. */
const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];

interface PendingRule {
  file: InstructionFile;
  real: string;
  base: string;
  matches: (relPath: string) => boolean;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sizeOf(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

class Loader {
  readonly cwd: string;
  readonly homeDir: string;
  readonly userFile: string;
  readonly userRulesDir: string;
  /** Real paths of every file already handed out, so each is returned once. */
  private readonly delivered = new Set<string>();
  /** Directories below the working directory already searched on demand. */
  private readonly searched = new Set<string>();
  private readonly pending: PendingRule[] = [];
  private agentsMode = false;
  private queue: Promise<unknown> = Promise.resolve();
  ctx: ReadContext;

  constructor(options: LoadInstructionsOptions, internalRoots: string[]) {
    this.cwd = resolve(options.cwd);
    this.homeDir = resolve(options.homeDir);
    this.userFile = join(this.homeDir, ".claude", "CLAUDE.md");
    this.userRulesDir = join(this.homeDir, ".claude", "rules");
    this.ctx = {
      homeDir: this.homeDir,
      internalRoots,
      allowExternal: options.externalImports === "allow",
      problems: [],
      externalFiles: new Set(),
    };
  }

  /** Starts collecting a fresh batch: problems and external files found from here on. */
  private beginBatch(): void {
    this.ctx = { ...this.ctx, problems: [], externalFiles: new Set() };
  }

  private endBatch(files: InstructionFile[]): InstructionBatch {
    return {
      files,
      problems: this.ctx.problems,
      externalFiles: [...this.ctx.externalFiles].sort(),
    };
  }

  /** Loads one memory file (not a rule) if it exists and has not been handed out yet. */
  private async loadMemoryFile(
    path: string,
    kind: InstructionKind,
    trusted: boolean,
  ): Promise<InstructionFile | null> {
    const outcome = await readTextFile(path);
    if (!outcome.ok) {
      if (outcome.reason !== "missing") {
        this.ctx.problems.push({
          kind: outcome.reason,
          path,
          target: null,
          message: outcome.detail,
        });
      }
      return null;
    }
    if (this.delivered.has(outcome.real)) return null;
    this.delivered.add(outcome.real);
    const { content, imports } = await expandImports(
      outcome.text,
      { path, real: outcome.real, trusted },
      this.ctx,
    );
    return { path, kind, content, imports, size: sizeOf(content), paths: null };
  }

  /**
   * Reads every rule in a `.claude/rules` directory. Rules that always apply are returned; rules
   * limited by `paths:` wait in `pending` until a matching file is touched.
   */
  private async loadRulesDir(
    rulesDir: string,
    kind: "user-rule" | "project-rule",
    base: string,
  ): Promise<InstructionFile[]> {
    const out: InstructionFile[] = [];
    const trusted = kind === "user-rule";
    const baseReal = await realpathLoose(base);
    for (const path of await listRuleFiles(rulesDir)) {
      const outcome = await readTextFile(path);
      if (!outcome.ok) {
        if (outcome.reason !== "missing") {
          this.ctx.problems.push({
            kind: outcome.reason,
            path,
            target: null,
            message: outcome.detail,
          });
        }
        continue;
      }
      if (this.delivered.has(outcome.real)) continue;
      if (this.pending.some((p) => p.real === outcome.real)) continue;
      const rule = parseRule(outcome.text, path, this.ctx.problems);
      // A project rule linked in from outside the project counts as an external import: it
      // needs approval, and even then only rules that always apply are used (documented).
      const external =
        !trusted && !isWithin(outcome.real, baseReal) && !isInternal(outcome.real, this.ctx);
      if (external) {
        if (!this.ctx.allowExternal) {
          this.ctx.externalFiles.add(outcome.real);
          this.ctx.problems.push({
            kind: "external-import",
            path,
            target: outcome.real,
            message:
              "Linked rule skipped: it is outside the project and external imports are not approved.",
          });
          continue;
        }
        if (rule.paths !== null) continue;
      }
      const { content, imports } = await expandImports(
        rule.body,
        { path, real: outcome.real, trusted },
        this.ctx,
      );
      const file: InstructionFile = {
        path,
        kind,
        content,
        imports,
        size: sizeOf(content),
        paths: rule.paths,
      };
      if (rule.paths === null) {
        this.delivered.add(outcome.real);
        out.push(file);
      } else {
        this.pending.push({
          file,
          real: outcome.real,
          base,
          matches: compileRulePatterns(rule.paths),
        });
      }
    }
    return out;
  }

  /**
   * The instruction files of one directory, in documented order: `CLAUDE.md`,
   * `.claude/CLAUDE.md`, the directory's rules, then `CLAUDE.local.md` last so personal notes
   * come after the shared ones. `AGENTS.md` stands in when no `CLAUDE.md` applies.
   */
  private async loadDirectory(dir: string, useAgents: boolean): Promise<InstructionFile[]> {
    const out: InstructionFile[] = [];
    const push = (file: InstructionFile | null) => {
      if (file) out.push(file);
    };
    if (useAgents) {
      push(await this.loadMemoryFile(join(dir, "AGENTS.md"), "agents", false));
      push(await this.loadMemoryFile(join(dir, ".claude", "AGENTS.md"), "agents", false));
    } else {
      push(await this.loadMemoryFile(join(dir, "CLAUDE.md"), "project", false));
      push(await this.loadMemoryFile(join(dir, ".claude", "CLAUDE.md"), "project", false));
    }
    const rulesDir = join(dir, ".claude", "rules");
    // The home directory's rules are the user's rules, already loaded with their own base.
    if (rulesDir !== this.userRulesDir) {
      out.push(...(await this.loadRulesDir(rulesDir, "project-rule", dir)));
    }
    if (!useAgents) push(await this.loadMemoryFile(join(dir, "CLAUDE.local.md"), "local", false));
    return out;
  }

  private async hasClaudeFile(dir: string): Promise<boolean> {
    for (const name of CLAUDE_FILES) {
      const candidate = join(dir, name);
      // The user's own file does not count, even when the home directory is an ancestor.
      if (candidate !== this.userFile && (await isFile(candidate))) return true;
    }
    return false;
  }

  async start(): Promise<InstructionBatch> {
    this.beginBatch();
    const dirs = ancestorsRootFirst(this.cwd);
    let anyClaude = false;
    for (const dir of dirs) {
      if (await this.hasClaudeFile(dir)) {
        anyClaude = true;
        break;
      }
    }
    this.agentsMode = !anyClaude;

    const files: InstructionFile[] = [];
    const user = await this.loadMemoryFile(this.userFile, "user", true);
    if (user) files.push(user);
    // User rules come before project rules; their patterns are relative to the working directory.
    files.push(...(await this.loadRulesDir(this.userRulesDir, "user-rule", this.cwd)));
    for (const dir of dirs) {
      this.searched.add(dir);
      files.push(...(await this.loadDirectory(dir, this.agentsMode)));
    }
    return this.endBatch(files);
  }

  forFile(path: string): Promise<InstructionBatch> {
    // Tools may report reads concurrently; one at a time keeps "returned once" true.
    const run = this.queue.then(() => this.forFileNow(path));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async forFileNow(path: string): Promise<InstructionBatch> {
    this.beginBatch();
    const target = resolve(this.cwd, path);
    const files: InstructionFile[] = [];

    if (target !== this.cwd && isWithin(target, this.cwd)) {
      const chain: string[] = [];
      for (
        let dir = dirname(target);
        dir !== this.cwd && isWithin(dir, this.cwd);
        dir = dirname(dir)
      ) {
        chain.unshift(dir);
      }
      for (const dir of chain) {
        if (this.searched.has(dir)) continue;
        this.searched.add(dir);
        // A subdirectory's AGENTS.md is read only when the session is reading AGENTS.md files at
        // all and the subdirectory has no CLAUDE.md of its own.
        const useAgents = this.agentsMode && !(await this.hasClaudeFile(dir));
        files.push(...(await this.loadDirectory(dir, useAgents)));
      }
    }

    for (const rule of this.pending) {
      if (this.delivered.has(rule.real)) continue;
      const rel = relativeInside(rule.base, target);
      if (rel !== null && rule.matches(rel)) {
        this.delivered.add(rule.real);
        files.push(rule.file);
      }
    }
    return this.endBatch(files);
  }
}

/**
 * Discovers and loads the instruction files for a session starting in `cwd`, in the order
 * Claude Code documents: the user's `~/.claude/CLAUDE.md` and `~/.claude/rules/`, then for each
 * directory from the filesystem root down to `cwd` its `CLAUDE.md`, `.claude/CLAUDE.md`,
 * `.claude/rules/` and `CLAUDE.local.md`. When no `CLAUDE.md`, `.claude/CLAUDE.md` or
 * `CLAUDE.local.md` exists in `cwd` or above it, `AGENTS.md` and `.claude/AGENTS.md` are read in
 * their place. Rules limited by `paths:` and files in subdirectories load later through
 * `forFile`. Never throws for a bad file.
 */
export async function loadInstructions(options: LoadInstructionsOptions): Promise<InstructionSet> {
  const roots = [resolve(options.cwd)];
  if (options.projectDir) roots.push(resolve(options.projectDir));
  const internalRoots = [...new Set(await Promise.all(roots.map(realpathLoose)))];
  const loader = new Loader(options, internalRoots);
  const batch = await loader.start();
  return {
    ...batch,
    totalSize: batch.files.reduce((sum, f) => sum + f.size, 0),
    forFile: (path: string) => loader.forFile(path),
  };
}
