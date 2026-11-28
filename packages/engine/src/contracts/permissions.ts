/**
 * The seam between tools, the permission engine and the turn loop.
 * See docs/specs/phase-2-engine-core.md, "Permissions".
 */
import type { PermissionRule, PermissionSettings } from "@dawg/compat";
import type { PermissionMode } from "@dawg/protocol";

/**
 * What one tool call would do, in the terms the permission engine judges. A tool reports this
 * from its input; the engine never looks inside tool inputs itself.
 */
export type PermissionSubject =
  /** Nothing to judge: the call touches neither files nor processes (the task list, a question). */
  | { kind: "none" }
  /** Reads these files or directories. Absolute paths. */
  | { kind: "read"; paths: string[] }
  /** Creates or changes these files. Absolute paths. */
  | { kind: "edit"; paths: string[] }
  /**
   * Runs this shell command line. `cwd` is the directory the shell is in when the command starts
   * (absolute); it differs from the session's working directory after an earlier `cd`. When it is
   * absent the session's working directory is assumed.
   */
  | {
      kind: "command";
      command: string;
      cwd?: string;
      /** Added (Phase 4, sandbox): where the command runs while the sandbox is on; absent when off. */
      sandbox?: CommandSandboxPlan;
    }
  /**
   * Anything else. Rules match on the tool's name and, when there is one, on the specifier text
   * (the part inside the brackets of `Tool(specifier)`).
   */
  | { kind: "other"; specifier: string | null };

/**
 * Added (Phase 4, sandbox): where a shell command runs while the sandbox is on.
 *
 * - inside: in the sandbox. With `autoAllow` (`sandbox.autoAllowBashIfSandboxed`) the engine
 *   allows it where only the mode would have asked, outside plan mode, since the sandbox confines
 *   what it can write and reach. Deny rules, ask rules that name commands, critical removals,
 *   protected paths and commands that cannot be analysed still decide as usual; a bare `Bash` ask
 *   rule does not.
 * - outside: without the sandbox, for the reason given; judged like any command. A retry outside
 *   is never allowed just for being read-only: the sandbox may be what kept it from reading.
 */
export type CommandSandboxPlan =
  | { run: "inside"; autoAllow: boolean }
  | { run: "outside"; why: "excluded" | "retry" | "unavailable" };

export interface PermissionQuery {
  toolName: string;
  subject: PermissionSubject;
}

/** Everything a decision depends on. The engine holds no state of its own. */
export interface PermissionState {
  mode: PermissionMode;
  rules: Pick<PermissionSettings, "allow" | "ask" | "deny">;
  /** The session's primary working directory (absolute). */
  cwd: string;
  /** `cwd` plus any added directories (absolute). */
  workingDirectories: readonly string[];
  homeDir: string;
  /**
   * Folders the engine keeps memory in for this session (absolute): the project's memory folder,
   * a subagent's memory scope. The file tools read and change files inside them without asking,
   * in every mode but plan; deny rules and ask rules still apply, and so do protected names
   * inside them (`.git`, `.dawg`...). Shell commands get nothing from them. Absent: none.
   */
  memoryDirectories?: readonly string[];
}

export type PermissionReason =
  /** A rule matched. */
  | { type: "rule"; list: "allow" | "ask" | "deny"; rule: PermissionRule }
  /** No rule matched; the mode's default applied. */
  | { type: "mode"; mode: PermissionMode }
  /** A path that is always asked about, whatever the rules say. */
  | { type: "protected"; path: string; why: "git" | "settings" | "outside_working_directories" }
  /** One part of a compound shell command decided the outcome. */
  | { type: "command_part"; part: string; reason: PermissionReason }
  /** The command could not be parsed safely, so it is treated with suspicion. */
  | { type: "unparseable_command"; detail: string }
  /**
   * The command removes or moves something that must never go without a person seeing it: the
   * filesystem root, a home directory, a working directory itself, or a computed path removed
   * recursively. `path` is null when the target is computed.
   */
  | { type: "critical_removal"; path: string | null }
  /** The permission check itself failed. The safe outcome (ask or deny) was chosen. */
  | { type: "internal_error" }
  /** The call needs no permission. */
  | { type: "not_needed" }
  /** Added (Phase 4, sandbox): it runs in the sandbox, whose settings allow that without asking. */
  | { type: "sandbox" };

export type PermissionDecision =
  | { behavior: "allow"; reason: PermissionReason }
  | {
      behavior: "ask";
      reason: PermissionReason;
      /** Rules that "allow always" would save, in `Tool(specifier)` form. May be empty. */
      suggestions: string[];
    }
  | {
      behavior: "deny";
      reason: PermissionReason;
      /** Given to the model as the tool result. */
      message: string;
    };

export interface PermissionEngine {
  decide(query: PermissionQuery, state: PermissionState): PermissionDecision;
}
