/**
 * What kind of instruction file this is.
 * - `user`: `~/.claude/CLAUDE.md`
 * - `project`: a `CLAUDE.md` or `.claude/CLAUDE.md` in the working directory, above it or below it
 * - `local`: a `CLAUDE.local.md`
 * - `agents`: an `AGENTS.md` or `.claude/AGENTS.md`, read when no `CLAUDE.md` applies
 * - `user-rule`: a file under `~/.claude/rules/`
 * - `project-rule`: a file under a project's `.claude/rules/`
 */
export type InstructionKind =
  | "user"
  | "project"
  | "local"
  | "agents"
  | "user-rule"
  | "project-rule";

export interface InstructionFile {
  /** Absolute path, as found (not resolved through symbolic links). */
  path: string;
  kind: InstructionKind;
  /**
   * The text given to the model: imports expanded, block-level HTML comments and rule front
   * matter removed, line endings normalised.
   */
  content: string;
  /** Absolute paths of every file expanded into `content`, in order, including nested ones. */
  imports: string[];
  /** UTF-8 byte length of `content`. Callers warn about large sets from this; nothing is cut. */
  size: number;
  /** For a rule limited by `paths:` front matter, its glob patterns; otherwise null. */
  paths: string[] | null;
}

export type InstructionProblemKind =
  | "unreadable"
  | "too-large"
  | "missing-import"
  | "import-cycle"
  | "import-too-deep"
  | "external-import"
  | "front-matter";

/** Something skipped while loading. Never fatal; reported so it can be shown on request. */
export interface InstructionProblem {
  kind: InstructionProblemKind;
  /** The file being loaded when the problem was found. */
  path: string;
  /** The file the problem is about (an import target, for example), when it differs. */
  target: string | null;
  message: string;
}

export interface LoadInstructionsOptions {
  /** The session's working directory (absolute). */
  cwd: string;
  /** The user's home directory (absolute). Tests point this at a temporary directory. */
  homeDir: string;
  /**
   * The project root (absolute). Imports and linked rules that resolve inside it or inside `cwd`
   * are internal. Defaults to `cwd`.
   */
  projectDir?: string;
  /**
   * Whether project files may pull in files from outside the project (`@~/notes.md`, a rule
   * linked from elsewhere). Claude Code asks once per project before allowing this; until the
   * caller has that answer, keep the default, `"block"`, and offer `externalFiles` for approval.
   * Files in the user's own `~/.claude/` may always import anything.
   */
  externalImports?: "allow" | "block";
}

/** Instruction files loaded in one step, at session start or on demand. */
export interface InstructionBatch {
  /** In the order they belong in context. */
  files: InstructionFile[];
  problems: InstructionProblem[];
  /** Real paths of external files that were skipped because external imports are blocked. */
  externalFiles: string[];
}

export interface InstructionSet extends InstructionBatch {
  /** Sum of `size` over `files`. */
  totalSize: number;
  /**
   * Call when the agent reads, writes or edits a file. Returns the instruction files that this
   * makes relevant and that have not been returned before: `CLAUDE.md` files (or `AGENTS.md`)
   * between the working directory and the file, rules from `.claude/rules/` in those
   * directories, and path-limited rules whose patterns match the file. Each file is returned at
   * most once per set.
   */
  forFile(path: string): Promise<InstructionBatch>;
}
