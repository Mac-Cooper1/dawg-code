/**
 * `sandbox.excludedCommands`: commands that run outside the sandbox, as documented
 * (code.claude.com/docs/en/sandboxing, "Excluded commands"; settings reference).
 *
 * - Patterns use the syntax of a `Bash(...)` rule's content: without `*` the match is exact,
 *   `docker *` matches `docker` with or without arguments.
 * - Every command of the call must match; `npm ci && docker build .` stays sandboxed unless
 *   `npm ci` is excluded too.
 * - Matching is on the call's text: scripts and absolute paths to a program do not match.
 * - Calls of these shapes stay sandboxed: anything that cannot be parsed with confidence, a
 *   wrapper such as `sudo`, `eval` or `xargs`, `cd`, `pushd` or `popd`, command substitutions,
 *   subshells and `if`/`for` blocks, redirections to files, command names from variables, and
 *   `git clone`, `git init`, `git worktree add`/`move` or `git bundle create` with a path that is
 *   absolute, starts with `~` or holds `..`.
 *
 * An excluded command is not trusted for it: it runs outside the sandbox only after the
 * permission check, which treats it like any command without the sandbox.
 */
import { commandPatternMatches } from "../permissions/rules.ts";
import { analyzeCommand, type CommandPart } from "../permissions/shell/analyze.ts";

const DIRECTORY_CHANGES = new Set(["cd", "pushd", "popd"]);

/** `git` subcommands whose path operand must stay inside the project for an exclusion to count. */
function escapesWithGit(part: CommandPart): boolean {
  if (part.program !== "git") return false;
  const words = part.text.split(/\s+/).slice(1);
  const sub = words.find((w) => !w.startsWith("-"));
  const second = words[words.indexOf(sub ?? "") + 1];
  const risky =
    sub === "clone" ||
    sub === "init" ||
    (sub === "worktree" && (second === "add" || second === "move")) ||
    (sub === "bundle" && second === "create");
  if (!risky) return false;
  return words.some((w) => w.startsWith("/") || w.startsWith("~") || w.split("/").includes(".."));
}

/** Whether every command of `command` matches one of `patterns`. */
export function isExcludedCommand(
  command: string,
  patterns: readonly string[],
  context: { cwd: string; homeDir: string },
): boolean {
  if (patterns.length === 0 || command.trim() === "") return false;
  const analysis = analyzeCommand(command, context);
  if (analysis.unparseable !== null || analysis.parts.length === 0) return false;
  for (const part of analysis.parts) {
    if (part.suspicious !== null || part.role !== "command" || part.nesting.length > 0) {
      return false;
    }
    if (part.program === null || DIRECTORY_CHANGES.has(part.program)) return false;
    if (part.writes.some((t) => t.via === "redirect")) return false;
    if (escapesWithGit(part)) return false;
    const forms = part.allowForms.length > 0 ? part.allowForms : [part.text];
    const matched = patterns.some((pattern) =>
      forms.some((form) => commandPatternMatches(pattern.trim(), form, false)),
    );
    if (!matched) return false;
  }
  return true;
}
