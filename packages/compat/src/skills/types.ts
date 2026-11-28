/**
 * Skills and custom slash commands, as Claude Code documents them (code.claude.com/docs/en/skills,
 * which also covers the older `commands/` folder). A custom command is a skill in the older
 * format: the engine treats both alike, and the report tells them apart.
 *
 * This file is a contract between the reader in this package and the engine's skill support
 * (packages/engine/src/skills). Change it deliberately.
 */
import type { CompatItemStatus, CompatSource } from "@dawg/protocol";

/** `skills/<name>/SKILL.md`, or a Markdown file anywhere under a `commands/` folder. */
export type SkillKind = "skill" | "command";

export interface SkillDefinition {
  kind: SkillKind;
  /**
   * What the skill is called: the front matter's `name`, else its folder's name; for a command,
   * its path under `commands/` with `/` written as `:` ("frontend:component"). A nested skill
   * whose name a skill nearer the project root already has is qualified with its folder, as
   * documented: "apps/web:deploy".
   */
  name: string;
  /** For the listing: the front matter's `description`, else the body's first line. */
  description: string;
  /** Where `description` came from. */
  descriptionFrom: "front-matter" | "body" | "none";
  /** `when_to_use`: appended to the description in the listing. */
  whenToUse: string | null;
  /** `argument-hint`, shown after the name in the `/` menu. */
  argumentHint: string | null;
  /** `arguments`: names for positional arguments (`$name`), in order. */
  argumentNames: string[];
  /** `allowed-tools`: permission rules granted while the skill's turn runs. */
  allowedTools: string[];
  /** `disallowed-tools`: tools taken away while the skill's turn runs. */
  disallowedTools: string[];
  /** `model`, as written; mapped to the session's model (principle 4). Null when absent or `inherit`. */
  model: string | null;
  /** `context: fork`: runs as a subagent. */
  fork: boolean;
  /** `agent`: the agent type a forked skill runs as; absent or null for general-purpose. */
  agent?: string | null;
  /** False when `user-invocable: false`: hidden from the `/` menu. */
  userInvocable: boolean;
  /** False when `disable-model-invocation: true`: left out of the listing; the agent may load it only when the person's message names it. */
  modelInvocable: boolean;
  /** The body after the front matter, with normalised line endings. */
  body: string;
  /** The defining file (absolute): `SKILL.md`, or the command's `.md` file. */
  path: string;
  /** The skill's folder (supporting files, `${CLAUDE_SKILL_DIR}`); for a command, its file's folder. */
  dir: string;
  source: CompatSource;
  /**
   * `loaded`; `partly-supported` when a documented field is ignored or works differently (each
   * named in `notes`); `invalid` when the file cannot be used at all.
   */
  status: CompatItemStatus;
  /** Sentences for people: ignored fields, how a field is mapped, why it is not used. */
  notes: string[];
  /**
   * The file of the definition that takes this name instead, when this one is not used: a
   * personal skill over a project one, `.dawg` over `.claude`, a skill over a command. Null when
   * this one is in use.
   */
  shadowedBy: string | null;
  /** True when the body runs commands: `` !`command` `` or a ```` ```! ```` block. */
  inlineShell: boolean;
}

export interface LoadSkillsOptions {
  /** The person's home directory (absolute): `~/.claude` and `~/.dawg`. */
  homeDir: string;
  /** The session's working directory (absolute), or null for only the person's own files. */
  cwd: string | null;
  /**
   * The project a worktree session belongs to (absolute). When the worktree has no skills of its
   * own at its root, the project's load instead, as documented. Defaults to `cwd`.
   */
  projectDir?: string;
  /**
   * Also read the `.claude/skills` and `.dawg/skills` folders inside the project (below `cwd`).
   * Sessions load those only once the agent works there (`loadNestedSkills`); the report and
   * the Settings page list them all. Default false.
   */
  nested?: boolean;
  /**
   * Names a file command may not take: dawg's own commands and their aliases. Defaults to
   * `DAWG_COMMAND_NAMES`. A skill or command with one of these names is still loaded for the
   * agent, but `/name` runs dawg's command, so it is reported as a conflict.
   */
  reservedNames?: readonly string[];
}

export interface SkillSet {
  /**
   * Every skill and command found, those not used included (`shadowedBy`), in precedence order:
   * the person's before the project's, `.dawg` before `.claude`, skills before commands, the
   * project root before folders inside it.
   */
  all: SkillDefinition[];
  /** The ones in use: one per name, valid, sorted by name (byte-wise). */
  active: SkillDefinition[];
}
