/**
 * Permission rules: parsing `Tool` and `Tool(specifier)`, reporting rules that are malformed or
 * will never match, and deciding which rules can apply to a call.
 *
 * Syntax follows Claude Code's public documentation so that existing rules keep working:
 * a rule is a tool name, optionally followed by a specifier in parentheses that runs to the
 * final `)`. Parentheses inside the specifier are literal and need no escaping.
 */
import type { PermissionRule, PermissionSettings } from "@dawg/compat";

export type RuleList = "allow" | "ask" | "deny";

export interface ParsedRule {
  /** A tool name or a tool-name glob. */
  toolName: string;
  /** The text inside the parentheses. Null for a bare rule (and for `Tool(*)`). */
  specifier: string | null;
}

export type RuleParseResult = { ok: true; rule: ParsedRule } | { ok: false; message: string };

const TOOL_NAME = /^[A-Za-z0-9_*-]+$/;

/** Parses one rule. Never throws. */
export function parseRuleText(text: string): RuleParseResult {
  if (typeof text !== "string") return { ok: false, message: "A rule must be a string" };
  const rule = text.trim();
  if (rule === "") return { ok: false, message: "The rule is empty" };
  const open = rule.indexOf("(");
  if (open === -1) {
    if (rule.includes(")")) {
      return { ok: false, message: 'Malformed rule: ")" without "("' };
    }
    if (!TOOL_NAME.test(rule)) {
      return { ok: false, message: `"${rule}" is not a tool name` };
    }
    return { ok: true, rule: { toolName: rule, specifier: null } };
  }
  if (!rule.endsWith(")")) {
    return {
      ok: false,
      message:
        'Malformed rule: rules take the form Tool or Tool(content) and must end at the closing ")"',
    };
  }
  const toolName = rule.slice(0, open);
  if (!TOOL_NAME.test(toolName)) {
    return { ok: false, message: `"${toolName}" is not a tool name` };
  }
  const specifier = rule.slice(open + 1, -1);
  if (specifier.trim() === "") {
    return { ok: false, message: "The part in parentheses is empty" };
  }
  return { ok: true, rule: { toolName, specifier: specifier === "*" ? null : specifier } };
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

/** Tools whose path rules are read rules. `Glob` and `Grep` path rules count only as deny/ask. */
const READ_PATH_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
/** Tools whose path rules are edit rules. Only `Edit` path rules may allow. */
const EDIT_PATH_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** Input fields that a `Tool(param:value)` rule could name on the built-in tools. */
const PARAMETERS: Record<string, readonly string[]> = {
  Bash: ["command", "timeout", "description", "run_in_background", "dangerouslyDisableSandbox"],
  Read: ["file_path", "offset", "limit"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
  Write: ["file_path", "content"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob", "type", "output_mode", "head_limit"],
};

export type RuleKind =
  /** `Tool`: every use of the tool. */
  | "tool"
  /** `Bash(pattern)`: shell command lines. */
  | "command"
  /** `Read(path)` / `Edit(path)` and their aliases: file paths. */
  | "path"
  /** Any other `Tool(specifier)`: matched on the call's specifier text. */
  | "other";

export interface CompiledRule {
  source: PermissionRule;
  list: RuleList;
  parsed: ParsedRule;
  kind: RuleKind;
  /** For "path" rules and bare Read/Edit rules: which file operations they cover. */
  family: "read" | "edit" | null;
  /** For a tool-name glob: the compiled glob. */
  toolGlob: RegExp | null;
}

export interface RuleProblem {
  rule: PermissionRule;
  list: RuleList;
  /** "error": the rule is skipped. "warning": the rule is kept but may not do what was meant. */
  severity: "error" | "warning";
  message: string;
}

function globToRegExp(glob: string): RegExp {
  const body = glob.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${body}$`);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles one rule, or explains why it is skipped. A rule that compiles may still come with a
 * warning.
 */
export function compileRule(
  source: PermissionRule,
  list: RuleList,
): { rule: CompiledRule | null; problems: RuleProblem[] } {
  const problems: RuleProblem[] = [];
  const problem = (severity: RuleProblem["severity"], message: string) =>
    problems.push({ rule: source, list, severity, message });
  const parsed = parseRuleText(source.rule);
  if (!parsed.ok) {
    problem("error", parsed.message);
    return { rule: null, problems };
  }
  const { toolName, specifier } = parsed.rule;
  let toolGlob: RegExp | null = null;
  if (toolName.includes("*")) {
    if (specifier !== null) {
      problem("error", "A tool-name pattern cannot have a part in parentheses");
      return { rule: null, problems };
    }
    if (list === "allow") {
      const m = /^mcp__([^*_][^*]*?)__/.exec(toolName);
      if (m === null || (m[1] ?? "").includes("*")) {
        problem(
          "error",
          "An allow rule may use * in the tool name only after a literal mcp__<server>__ prefix",
        );
        return { rule: null, problems };
      }
    }
    toolGlob = globToRegExp(toolName);
  }
  if (toolName.startsWith("mcp__") && specifier !== null) {
    problem("error", "Rules for MCP tools take no part in parentheses");
    return { rule: null, problems };
  }
  const base = { source, list, parsed: parsed.rule, toolGlob };
  if (specifier === null) {
    const family = toolName === "Read" ? "read" : toolName === "Edit" ? "edit" : null;
    return { rule: { ...base, kind: "tool", family }, problems };
  }
  const params = PARAMETERS[toolName];
  const param = /^\s*([A-Za-z_]+)\s*:/.exec(specifier)?.[1];
  if (params !== undefined && param !== undefined && params.includes(param)) {
    problem(
      "error",
      `Rules on a tool's input fields (${param}:...) are not supported; this rule matches nothing`,
    );
    return { rule: null, problems };
  }
  if (toolName === "Bash") {
    if (list === "allow" && /\*\s*\S/.test(specifier.replace(/:\*$/, ""))) {
      problem(
        "warning",
        "This allow rule has a * before the rest of the command, so it also approves any options inserted there",
      );
    }
    return { rule: { ...base, kind: "command", family: null }, problems };
  }
  if (READ_PATH_TOOLS.has(toolName) || EDIT_PATH_TOOLS.has(toolName)) {
    const family = READ_PATH_TOOLS.has(toolName) ? "read" : "edit";
    if (toolName !== "Read" && toolName !== "Edit") {
      const use = family === "read" ? "Read" : "Edit";
      if (list === "allow") {
        problem("error", `${toolName}(path) allow rules never match; use ${use}(...) instead`);
        return { rule: null, problems };
      }
      problem(
        "warning",
        `${toolName}(path) is applied as ${use}(...), which covers every tool that ${family === "read" ? "reads" : "edits"} files`,
      );
    }
    if (list === "allow" && specifier.startsWith("!")) {
      problem("error", "A ! pattern only carves exceptions out of deny and ask rules");
      return { rule: null, problems };
    }
    return { rule: { ...base, kind: "path", family }, problems };
  }
  return { rule: { ...base, kind: "other", family: null }, problems };
}

export interface CompiledRules {
  deny: CompiledRule[];
  ask: CompiledRule[];
  allow: CompiledRule[];
  problems: RuleProblem[];
}

/** Compiles every rule, highest-precedence source first within each list. Never throws. */
export function compileRules(
  rules: Pick<PermissionSettings, "allow" | "ask" | "deny">,
): CompiledRules {
  const out: CompiledRules = { deny: [], ask: [], allow: [], problems: [] };
  for (const list of ["deny", "ask", "allow"] as const) {
    for (const source of rules[list] ?? []) {
      try {
        const { rule, problems } = compileRule(source, list);
        out.problems.push(...problems);
        if (rule !== null) out[list].push(rule);
      } catch {
        out.problems.push({
          rule: source,
          list,
          severity: "error",
          message: "The rule could not be read",
        });
      }
    }
  }
  return out;
}

/**
 * Problems with a rule set, for showing to people: malformed rules, rules that never match, and
 * rules that match more than they seem to. `knownTools` adds a check for deny and ask rules that
 * name no known tool.
 */
export function validatePermissionRules(
  rules: Pick<PermissionSettings, "allow" | "ask" | "deny">,
  knownTools?: readonly string[],
): RuleProblem[] {
  const compiled = compileRules(rules);
  const problems = [...compiled.problems];
  if (knownTools !== undefined) {
    for (const rule of [...compiled.deny, ...compiled.ask]) {
      const name = rule.parsed.toolName;
      if (name.includes("_") || name.includes("*")) continue;
      if (!knownTools.includes(name)) {
        problems.push({
          rule: rule.source,
          list: rule.list,
          severity: "warning",
          message: `"${name}" matches no known tool; check for typos`,
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------------------------

/** Whether a rule's tool name covers a tool, for the given list. */
export function toolNameMatches(rule: CompiledRule, toolName: string): boolean {
  if (rule.toolGlob !== null) return rule.toolGlob.test(toolName);
  const name = rule.parsed.toolName;
  if (name === toolName) return true;
  if (name.startsWith("mcp__") && toolName.startsWith(`${name}__`)) {
    const segments = name.split("__").length;
    if (rule.list !== "allow") {
      // As deny or ask, `mcp__server` covers every tool of that server and of any server whose
      // name starts the same way, since a tool name alone cannot tell them apart.
      return true;
    }
    // As allow, `mcp__server` covers only tool names that cannot belong to another server.
    return segments === 2 && !toolName.slice(name.length + 2).includes("__");
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Command patterns
// ---------------------------------------------------------------------------------------------

const commandPatternCache = new Map<string, RegExp>();

/**
 * Whether a shell command matches a `Bash(...)` pattern, as documented:
 * - without `*` the match is exact;
 * - `*` matches any text, spaces included, in any position;
 * - a trailing ` *` that is the only wildcard also matches the bare command (`ls *` matches
 *   `ls` but not `lsof`); the space before it is part of the rule;
 * - a trailing `:*` is the legacy spelling of ` *`; elsewhere the colon is literal.
 */
export function commandPatternMatches(
  pattern: string,
  command: string,
  ignoreCase: boolean,
): boolean {
  const key = `${ignoreCase ? "i" : "s"}\u0000${pattern}`;
  let re = commandPatternCache.get(key);
  if (re === undefined) {
    let p = pattern;
    if (p.endsWith(":*")) p = `${p.slice(0, -2)} *`;
    const stars = p.split("*").length - 1;
    let body: string;
    if (stars === 1 && p.endsWith(" *")) {
      body = `${escapeRegExp(p.slice(0, -2))}(?: .*)?`;
    } else {
      body = p.split("*").map(escapeRegExp).join(".*");
    }
    re = new RegExp(`^${body}$`, ignoreCase ? "si" : "s");
    if (commandPatternCache.size > 2000) commandPatternCache.clear();
    commandPatternCache.set(key, re);
  }
  return re.test(command);
}

/** Whether a `Bash(...)` pattern has a wildcard (an exact-only form must not). */
export function commandPatternHasWildcard(pattern: string): boolean {
  return pattern.includes("*");
}

// ---------------------------------------------------------------------------------------------
// Other specifiers
// ---------------------------------------------------------------------------------------------

/**
 * Whether a call's specifier text (for a tool that is neither a file nor a shell tool) matches
 * a rule's. For deny and ask, `*` matches any text. For allow it is narrower, so that a
 * wildcard cannot reach further than intended: `*` stays inside one `.`- or `/`-separated
 * segment, except a leading `*.` (any number of labels, as in `domain:*.example.com`) and a
 * `*` that makes up a whole value (`domain:*`).
 */
export function specifierMatches(pattern: string, value: string, list: RuleList): boolean {
  if (!pattern.includes("*")) {
    return list === "allow" ? pattern === value : pattern.toLowerCase() === value.toLowerCase();
  }
  if (list !== "allow") {
    return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "si").test(value);
  }
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c !== "*") {
      body += escapeRegExp(c);
      continue;
    }
    const before = pattern[i - 1];
    const after = pattern[i + 1];
    const startsValue = before === undefined || before === ":";
    if (startsValue && after === undefined) {
      body += ".+";
    } else if (startsValue && after === ".") {
      body += "(?:[^./]+\\.)*[^./]+";
    } else {
      body += "[^./]*";
    }
  }
  return new RegExp(`^${body}$`, "s").test(value);
}
