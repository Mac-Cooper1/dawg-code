/**
 * Words for people and for the model: the title and reason of a permission request, and the
 * message the model gets when a call is denied.
 */
import path from "node:path";
import type { PermissionRule } from "@dawg/compat";
import type {
  PermissionDecision,
  PermissionQuery,
  PermissionReason,
} from "../contracts/permissions.ts";

export interface WordingContext {
  /** The session's working directory, to show paths relative to it. */
  cwd?: string;
  homeDir?: string;
}

/** A path as a person reads it: relative to the working directory, or with `~` for home. */
export function displayPath(p: string, ctx: WordingContext = {}): string {
  if (ctx.cwd !== undefined) {
    const cwd = path.resolve(ctx.cwd);
    if (p === cwd) return ".";
    if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  }
  if (ctx.homeDir !== undefined) {
    const home = path.resolve(ctx.homeDir);
    if (p === home) return "~";
    if (p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  }
  return p;
}

function ruleOrigin(rule: PermissionRule, ctx: WordingContext): string {
  const from = rule.from;
  if (from.source === "flags") return " (from the command line)";
  if (from.source === "session") return " (added in this session)";
  if (from.path !== null) return ` in ${displayPath(from.path, ctx)}`;
  return "";
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function subjectNoun(query: PermissionQuery): string {
  switch (query.subject.kind) {
    case "command":
      return "command";
    case "edit":
      return "edit";
    case "read":
      return "read";
    default:
      return `use of ${query.toolName}`;
  }
}

/** Why the decision came out as it did, as a sentence fragment that starts in lower case. */
export function describeReason(
  reason: PermissionReason,
  query: PermissionQuery,
  ctx: WordingContext = {},
): string {
  switch (reason.type) {
    case "rule": {
      const verb =
        reason.list === "deny"
          ? "blocks"
          : reason.list === "ask"
            ? "requires approval for"
            : "allows";
      return `the ${reason.list} rule ${reason.rule.rule}${ruleOrigin(reason.rule, ctx)} ${verb} this ${subjectNoun(query)}`;
    }
    case "protected": {
      const shown = displayPath(reason.path, ctx);
      if (reason.why === "git")
        return `${shown} is git data or git configuration, which always needs approval to change`;
      if (reason.why === "settings") {
        return `${shown} is a settings or tool configuration file, which always needs approval to change`;
      }
      return `${shown} is outside the working directories`;
    }
    case "critical_removal": {
      if (reason.path === null) {
        return "it removes recursively a path that is only known when it runs, which always needs approval";
      }
      const shown = displayPath(reason.path, ctx);
      const cwd = ctx.cwd === undefined ? null : path.resolve(ctx.cwd);
      const holdsCwd =
        cwd !== null &&
        (cwd === reason.path || cwd.startsWith(`${reason.path.replace(/\/$/, "")}/`));
      return holdsCwd
        ? `it would remove ${shown}, which holds the working directory`
        : `it would remove ${shown}, which always needs approval`;
    }
    case "internal_error":
      return "the permission check failed, so the safe answer was chosen";
    case "unparseable_command":
      return `the command could not be checked safely: ${reason.detail}`;
    case "command_part": {
      // A redirection is a file edit: describe what decided it as an edit, not a command.
      const inner = isRedirection(reason.part)
        ? describeReason(
            reason.reason,
            { toolName: query.toolName, subject: { kind: "edit", paths: [] } },
            ctx,
          )
        : describeReason(reason.reason, query, ctx);
      return `\`${oneLine(reason.part, 80)}\`: ${inner}`;
    }
    case "not_needed":
      return "no permission is needed";
    case "sandbox":
      return "it runs in the sandbox, which is set to allow sandboxed commands without asking";
    case "mode":
      return describeMode(reason.mode, query);
    default:
      return "no rule allows it";
  }
}

/** Whether a command part is a redirection such as `> out.txt` or `2>> log`. */
function isRedirection(part: string): boolean {
  return /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(&?>|<)/.test(part);
}

function describeMode(mode: string, query: PermissionQuery): string {
  const kind = query.subject.kind;
  if (mode === "plan") {
    if (kind === "edit") return "plan mode does not change files until the plan is approved";
    if (kind === "command") return "plan mode runs only read-only commands without approval";
    if (kind === "read") return "it reads outside the working directories";
    return `plan mode cannot tell whether ${query.toolName} changes anything`;
  }
  if (mode === "dontAsk" && query.toolName === "AskUserQuestion") {
    return "no one can answer questions in this session";
  }
  if (mode === "bypassPermissions") return "permission checks are bypassed in this session";
  switch (kind) {
    case "read":
      return "it reads outside the working directories, and no rule allows that";
    case "edit":
      return mode === "acceptEdits"
        ? "edits inside the working directories are accepted in this mode"
        : "no rule allows this edit";
    case "command":
      return "no rule allows this command";
    case "none":
      return "no permission is needed";
    default: {
      const host = fetchHost(query);
      return host === null
        ? `no rule allows ${query.toolName}`
        : `no rule allows fetching from ${host}`;
    }
  }
}

/** The host of a WebFetch call (its `domain:` specifier), or null for any other call. */
function fetchHost(query: PermissionQuery): string | null {
  const s = query.subject;
  if (query.toolName !== "WebFetch" || s.kind !== "other" || s.specifier === null) return null;
  return s.specifier.startsWith("domain:") ? s.specifier.slice("domain:".length) : null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]?.toUpperCase() + s.slice(1);
}

/** The `title` and `reason` of a `PermissionRequest` for an "ask" decision. */
export function describePermissionRequest(
  query: PermissionQuery,
  decision: PermissionDecision,
  ctx: WordingContext = {},
): { title: string; reason: string } {
  return {
    title: requestTitle(query, ctx),
    reason: `${capitalize(describeReason(decision.reason, query, ctx))}.`,
  };
}

function requestTitle(query: PermissionQuery, ctx: WordingContext): string {
  const s = query.subject;
  switch (s.kind) {
    case "command":
      return s.sandbox?.run === "outside"
        ? "Run a shell command outside the sandbox"
        : "Run a shell command";
    case "edit":
      return s.paths.length === 1
        ? `Edit ${displayPath(s.paths[0] as string, ctx)}`
        : `Edit ${s.paths.length} files`;
    case "read":
      return s.paths.length === 1
        ? `Read ${displayPath(s.paths[0] as string, ctx)}`
        : `Read ${s.paths.length} paths`;
    default: {
      const host = fetchHost(query);
      if (host !== null) return `Fetch a page from ${host}`;
      if (query.toolName === "WebSearch") return "Search the web";
      return `Use ${query.toolName}`;
    }
  }
}

/** The tool result the model gets for a denied call. */
export function denialMessage(
  query: PermissionQuery,
  reason: PermissionReason,
  options: WordingContext & { dontAsk?: boolean } = {},
): string {
  const why = describeReason(reason, query, options);
  let inner = reason;
  while (inner.type === "command_part") inner = inner.reason;
  const unanswerable = inner.type === "mode" && inner.mode === "dontAsk";
  if (query.toolName === "AskUserQuestion" && (options.dontAsk === true || unanswerable)) {
    return "No one can answer questions in this session. Continue with your best judgement and state the assumptions you make.";
  }
  if (options.dontAsk === true) {
    return `Denied: this needs approval (${why}), and this session does not ask for approval. Use an approach that is already allowed, or stop and explain what you need.`;
  }
  if (inner.type === "mode" && inner.mode === "plan") {
    return "Denied: plan mode is on, so files cannot be changed yet. Keep investigating with read-only tools, then present your plan with ExitPlanMode.";
  }
  return `Denied: ${why}. Do not try to get around this; if the action is needed, explain why to the user.`;
}
