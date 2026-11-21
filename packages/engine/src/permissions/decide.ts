/**
 * The permission decision: allow, ask or deny one tool call, given the rules and the mode.
 *
 * Order, as documented: deny rules, then ask rules, then allow rules, then the mode's default.
 * The first match in that order decides, whatever the rules' specificity or the file they came
 * from. Around that order sit the checks no rule can override: protected paths, writes outside
 * the working directories, commands that cannot be analysed, and critical removals.
 *
 * Holds no state; the only side effect is reading the file system to resolve symbolic links.
 */
import path from "node:path";
import type { PermissionRule } from "@dawg/compat";
import type { PermissionMode } from "@dawg/protocol";
import picomatch from "picomatch";
import type {
  PermissionDecision,
  PermissionEngine,
  PermissionQuery,
  PermissionReason,
  PermissionState,
} from "../contracts/permissions.ts";
import {
  type CompiledPathRule,
  compilePathRule,
  groupMatch,
  type PathRuleGroup,
  pathRuleMatches,
} from "./path-rules.ts";
import {
  type FsProbe,
  isWithin,
  nodeFsProbe,
  PathResolver,
  protectedKind,
  WorkingDirectories,
} from "./paths.ts";
import {
  type CompiledRule,
  type CompiledRules,
  commandPatternHasWildcard,
  commandPatternMatches,
  compileRules,
  type RuleList,
  specifierMatches,
  toolNameMatches,
} from "./rules.ts";
import { analyzeCommand, type CommandPart, type FileTarget } from "./shell/analyze.ts";
import { editRuleFor, readRuleFor } from "./suggest.ts";
import { denialMessage } from "./wording.ts";

export interface PermissionEngineOptions {
  /** File system access for resolving symbolic links. Defaults to the real one (read-only). */
  fs?: FsProbe;
  /**
   * Whether recognised read-only shell commands (`ls`, `cat`, `git status`...) run without asking,
   * as documented for every mode. Defaults to true. In plan mode they always may.
   */
  readOnlyCommandsNeverAsk?: boolean;
}

const MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

type Outcome =
  | { behavior: "allow"; reason: PermissionReason }
  | { behavior: "ask"; reason: PermissionReason; suggestions: string[] }
  | { behavior: "deny"; reason: PermissionReason };

/** Decides one call. Never throws; a failure inside the check asks (or denies, in dontAsk). */
export function decidePermission(
  query: PermissionQuery,
  state: PermissionState,
  options: PermissionEngineOptions = {},
): PermissionDecision {
  let outcome: Outcome;
  try {
    outcome = new Judge(query, state, options).decide();
    if (outcome.behavior === "ask" && outcome.suggestions.length > 0) {
      outcome = {
        ...outcome,
        suggestions: verifySuggestions(query, state, options, outcome.suggestions),
      };
    }
  } catch {
    outcome = {
      behavior: "ask",
      reason: { type: "internal_error" },
      suggestions: [],
    };
  }
  return finalize(outcome, query, state);
}

export function createPermissionEngine(options: PermissionEngineOptions = {}): PermissionEngine {
  return { decide: (query, state) => decidePermission(query, state, options) };
}

function finalize(
  outcome: Outcome,
  query: PermissionQuery,
  state: PermissionState,
): PermissionDecision {
  if (outcome.behavior === "allow") return outcome;
  if (outcome.behavior === "ask" && state.mode !== "dontAsk") return outcome;
  const dontAsk = outcome.behavior === "ask";
  return {
    behavior: "deny",
    reason: outcome.reason,
    message: denialMessage(query, outcome.reason, {
      dontAsk,
      cwd: state.cwd,
      homeDir: state.homeDir,
    }),
  };
}

/**
 * Keeps suggestions only when saving them would really allow this call next time; a suggestion
 * that would not is worse than none.
 */
function verifySuggestions(
  query: PermissionQuery,
  state: PermissionState,
  options: PermissionEngineOptions,
  suggestions: string[],
): string[] {
  const from: PermissionRule["from"] = {
    source: "local",
    origin: "dawg",
    path: path.join(state.cwd, ".dawg", "settings.local.json"),
  };
  const withRules: PermissionState = {
    ...state,
    rules: {
      ...state.rules,
      allow: [...suggestions.map((rule) => ({ rule, from })), ...state.rules.allow],
    },
  };
  const again = new Judge(query, withRules, options).decide();
  return again.behavior === "allow" ? suggestions : [];
}

type PartResult =
  | { behavior: "deny"; reason: PermissionReason; commandRule: null }
  | {
      behavior: "ask";
      reason: PermissionReason;
      priority: number;
      commandRule: CompiledRule | null;
    }
  | {
      behavior: "needs";
      reason: PermissionReason;
      suggestions: string[];
      fixable: boolean;
      commandRule: CompiledRule | null;
    }
  | { behavior: "allow"; reason: PermissionReason; commandRule: CompiledRule | null };

/** Priorities among reasons to ask, most telling first. */
const PRIORITY = { askRule: 1, critical: 2, protected: 3, unparseable: 4 } as const;

interface Families {
  read: CompiledPathRule[];
  edit: CompiledPathRule[];
  readGroups: PathRuleGroup[];
  editGroups: PathRuleGroup[];
}

interface Candidates {
  /** Lexically normalised. */
  lexical: string;
  /** Where it really leads; null when that cannot be worked out. */
  real: string | null;
  all: string[];
}

class Judge {
  private readonly query: PermissionQuery;
  private readonly state: PermissionState;
  private readonly mode: PermissionMode;
  private readonly resolver: PathResolver;
  private readonly wds: WorkingDirectories;
  private readonly rules: CompiledRules;
  private readonly readOnlyCommands: boolean;
  private readonly families = new Map<RuleList, Families>();

  constructor(query: PermissionQuery, state: PermissionState, options: PermissionEngineOptions) {
    this.query = query;
    this.state = state;
    this.mode = MODES.includes(state.mode) ? state.mode : "default";
    this.resolver = new PathResolver(options.fs ?? nodeFsProbe);
    this.wds = new WorkingDirectories(
      [state.cwd, ...(state.workingDirectories ?? [])],
      this.resolver,
    );
    this.rules = compileRules(state.rules);
    this.readOnlyCommands = options.readOnlyCommandsNeverAsk ?? true;
  }

  decide(): Outcome {
    const subject = this.query.subject;
    switch (subject.kind) {
      case "none":
        return this.decideNone();
      case "read":
        return this.decideRead(subject.paths);
      case "edit":
        return this.decideEdit(subject.paths);
      case "command":
        return this.decideCommand(subject.command, subject.cwd);
      case "other":
        return this.decideOther(subject.specifier);
      default:
        return ask({ type: "mode", mode: this.mode });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rule lookups
  // -------------------------------------------------------------------------------------------

  /** The first rule in `list` that covers every use of the tool (or of the subject's kind). */
  private toolRule(list: RuleList): CompiledRule | null {
    const kind = this.query.subject.kind;
    for (const r of this.rules[list]) {
      if (r.kind !== "tool") continue;
      if (toolNameMatches(r, this.query.toolName)) return r;
      if (r.toolGlob !== null) continue;
      const name = r.parsed.toolName;
      if (name === "Read" && (kind === "read" || (list !== "allow" && kind === "edit"))) return r;
      if (name === "Edit" && kind === "edit") return r;
      if (name === "Bash" && kind === "command") return r;
    }
    return null;
  }

  private pathFamilies(list: RuleList): Families {
    const cached = this.families.get(list);
    if (cached !== undefined) return cached;
    const fam: Families = { read: [], edit: [], readGroups: [], editGroups: [] };
    const groups = new Map<string, PathRuleGroup>();
    const ctx = { cwd: path.resolve(this.state.cwd), homeDir: this.state.homeDir };
    for (const r of this.rules[list]) {
      if (r.kind !== "path" || r.family === null) continue;
      const compiled = compilePathRule(r, ctx, this.resolver);
      if (compiled === null) continue;
      if (list !== "allow" && compiled.cwdRelative) {
        const from = r.source.from;
        const key = `${r.family}\u0000${from.source}\u0000${from.path ?? ""}`;
        let group = groups.get(key);
        if (group === undefined) {
          group = { anchors: compiled.anchors, members: [] };
          groups.set(key, group);
          (r.family === "read" ? fam.readGroups : fam.editGroups).push(group);
        }
        group.members.push(compiled);
      } else if (!compiled.negated) {
        fam[r.family].push(compiled);
      }
    }
    this.families.set(list, fam);
    return fam;
  }

  /**
   * The first path rule (or bare Read/Edit rule) in `list` covering a path. For allow, a rule must
   * cover every candidate (the path as given and where it leads); for deny and ask, any one.
   * Read deny and ask rules also cover edits.
   */
  private pathRule(list: RuleList, family: "read" | "edit", c: Candidates): CompiledRule | null {
    for (const r of this.rules[list]) {
      if (r.kind !== "tool" || r.toolGlob !== null) continue;
      const name = r.parsed.toolName;
      if (name === "Edit" && family === "edit") return r;
      if (name === "Read" && (family === "read" || list !== "allow")) return r;
    }
    const families: ("read" | "edit")[] =
      family === "edit" && list !== "allow" ? ["edit", "read"] : [family];
    const fam = this.pathFamilies(list);
    if (list === "allow") {
      const opts = { ignoreCase: false, directoryContents: false };
      if (c.real === null) return null;
      for (const f of families) {
        for (const rule of fam[f]) {
          if (c.all.every((p) => pathRuleMatches(rule, p, opts))) return rule.rule;
        }
      }
      return null;
    }
    const opts = { ignoreCase: true, directoryContents: true };
    for (const f of families) {
      for (const rule of fam[f]) {
        if (c.all.some((p) => pathRuleMatches(rule, p, opts))) return rule.rule;
      }
      for (const group of f === "read" ? fam.readGroups : fam.editGroups) {
        for (const p of c.all) {
          const hit = groupMatch(group, p, opts);
          if (hit !== null) return hit.rule;
        }
      }
    }
    return null;
  }

  /**
   * Whether a glob a command reads (`src/*.ts`) could expand to a path a Read deny or ask rule
   * covers. The rules on the glob's directory itself are checked like any path; this proves
   * the rest disjoint where it can (`*.ts` never names `.env`) and answers yes otherwise.
   */
  private globMayHitReadRule(t: FileTarget): boolean {
    for (const list of ["deny", "ask"] as const) {
      const fam = this.pathFamilies(list);
      const rules = [
        ...fam.read,
        ...fam.readGroups.flatMap((g) => g.members.filter((m) => !m.negated)),
      ];
      for (const rule of rules) {
        const last = lastNamedSegment(rule.pattern);
        if (last === null) return true;
        if (t.globRest.some((seg) => segmentsMayMeet(seg, last))) return true;
      }
    }
    return false;
  }

  private hasReadDenyOrAsk(): boolean {
    for (const list of ["deny", "ask"] as const) {
      const fam = this.pathFamilies(list);
      if (fam.read.length > 0 || fam.readGroups.length > 0) return true;
    }
    return false;
  }

  private candidates(p: string): Candidates {
    const abs = path.isAbsolute(p) ? p : path.join(this.state.cwd, p);
    const lexical = path.resolve(abs);
    const real = this.resolver.real(abs);
    const all = real === null || real === lexical ? [lexical] : [lexical, real];
    return { lexical, real, all };
  }

  private inside(c: Candidates, strictly = false): boolean {
    if (c.real === null) return false;
    return strictly ? this.wds.containsStrictly(c.real) : this.wds.contains(c.real);
  }

  private protectedReason(c: Candidates): PermissionReason | null {
    for (const p of c.all) {
      const kind = protectedKind(p);
      if (kind !== null) return { type: "protected", path: p, why: kind };
    }
    return null;
  }

  readDenyRule(file: string): PermissionRule | null {
    const c = this.candidates(file);
    const rule = this.toolRule("deny") ?? this.pathRule("deny", "read", c);
    return rule?.source ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Subjects
  // -------------------------------------------------------------------------------------------

  private decideNone(): Outcome {
    const denyRule = this.toolRule("deny");
    if (denyRule !== null) return deny(ruleReason(denyRule));
    const askRule = this.toolRule("ask");
    if (askRule !== null) return ask(ruleReason(askRule));
    if (this.mode === "dontAsk" && this.query.toolName === "AskUserQuestion") {
      // Documented: there is no one to answer, so the question is denied whatever the rules say.
      return deny({ type: "mode", mode: this.mode });
    }
    return { behavior: "allow", reason: { type: "not_needed" } };
  }

  private decideRead(paths: string[]): Outcome {
    const all = paths.map((p) => this.candidates(p));
    const denyRule = this.toolRule("deny");
    if (denyRule !== null) return deny(ruleReason(denyRule));
    for (const c of all) {
      const r = this.pathRule("deny", "read", c);
      if (r !== null) return deny(ruleReason(r));
    }
    const askRule = this.toolRule("ask");
    if (askRule !== null) return ask(ruleReason(askRule));
    for (const c of all) {
      const r = this.pathRule("ask", "read", c);
      if (r !== null) return ask(ruleReason(r));
    }
    if (this.mode === "bypassPermissions") return allow({ type: "mode", mode: this.mode });
    if (all.length === 0) return ask({ type: "mode", mode: this.mode });
    const allowTool = this.toolRule("allow");
    let usedRule: CompiledRule | null = null;
    const outside: Candidates[] = [];
    for (const c of all) {
      if (this.inside(c)) continue;
      const r = allowTool ?? this.pathRule("allow", "read", c);
      if (r !== null) {
        usedRule ??= r;
        continue;
      }
      outside.push(c);
    }
    if (outside.length === 0) {
      return allow(usedRule !== null ? ruleReason(usedRule) : { type: "mode", mode: this.mode });
    }
    const suggestions = unique(
      outside.map((c) => readRuleFor(c.lexical, this.state.homeDir, this.resolver)),
    );
    return ask({ type: "mode", mode: this.mode }, suggestions);
  }

  private decideEdit(paths: string[]): Outcome {
    const all = paths.map((p) => this.candidates(p));
    const denyRule = this.toolRule("deny");
    if (denyRule !== null) return deny(ruleReason(denyRule));
    for (const c of all) {
      const r = this.pathRule("deny", "edit", c);
      if (r !== null) return deny(ruleReason(r));
    }
    if (this.mode === "plan") return deny({ type: "mode", mode: this.mode });
    const askRule = this.toolRule("ask");
    if (askRule !== null) return ask(ruleReason(askRule));
    for (const c of all) {
      const r = this.pathRule("ask", "edit", c);
      if (r !== null) return ask(ruleReason(r));
    }
    if (this.mode === "bypassPermissions") return allow({ type: "mode", mode: this.mode });
    if (all.length === 0) return ask({ type: "mode", mode: this.mode });
    for (const c of all) {
      const prot = this.protectedReason(c);
      if (prot !== null) return ask(prot);
    }
    for (const c of all) {
      if (!this.inside(c)) {
        return ask({
          type: "protected",
          path: c.real ?? c.lexical,
          why: "outside_working_directories",
        });
      }
    }
    const allowTool = this.toolRule("allow");
    if (allowTool !== null) return allow(ruleReason(allowTool));
    let usedRule: CompiledRule | null = null;
    let covered = true;
    for (const c of all) {
      const r = this.pathRule("allow", "edit", c);
      if (r === null) {
        covered = false;
        break;
      }
      usedRule ??= r;
    }
    if (covered && usedRule !== null) return allow(ruleReason(usedRule));
    if (this.mode === "acceptEdits") return allow({ type: "mode", mode: this.mode });
    const cwd = path.resolve(this.state.cwd);
    const suggestions = unique(all.map((c) => editRuleFor(c.lexical, cwd)));
    return ask({ type: "mode", mode: this.mode }, suggestions);
  }

  private decideOther(specifier: string | null): Outcome {
    const match = (list: RuleList): CompiledRule | null => {
      for (const r of this.rules[list]) {
        if (!toolNameMatches(r, this.query.toolName)) continue;
        if (r.kind === "tool") return r;
        if (r.kind === "other" && specifier !== null && r.parsed.specifier !== null) {
          if (specifierMatches(r.parsed.specifier, specifier, list)) return r;
        }
      }
      return null;
    };
    const denyRule = match("deny");
    if (denyRule !== null) return deny(ruleReason(denyRule));
    const askRule = match("ask");
    if (askRule !== null) return ask(ruleReason(askRule));
    if (this.mode === "bypassPermissions") return allow({ type: "mode", mode: this.mode });
    // Plan mode allows only what cannot change anything, which cannot be told for this tool.
    if (this.mode === "plan") return ask({ type: "mode", mode: this.mode });
    const allowRule = match("allow");
    if (allowRule !== null) return allow(ruleReason(allowRule));
    const name = this.query.toolName;
    const suggestion =
      specifier === null || name.startsWith("mcp__") || specifier.includes("*")
        ? name
        : `${name}(${specifier})`;
    return ask({ type: "mode", mode: this.mode }, [suggestion]);
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  private decideCommand(command: string, shellCwd: string | undefined): Outcome {
    const denyRule = this.toolRule("deny");
    if (denyRule !== null) return deny(ruleReason(denyRule));

    // Relative paths in the command resolve against the shell's directory, which differs from
    // the session's after a `cd` in an earlier call.
    const cwd =
      typeof shellCwd === "string" && path.isAbsolute(shellCwd) ? shellCwd : this.state.cwd;
    const analysis = analyzeCommand(command, { cwd, homeDir: this.state.homeDir });
    const parts = analysis.parts;
    const results: PartResult[] = [];
    for (const part of parts) results.push(this.judgePart(part, results));

    const several = parts.length > 1;
    const wrap = (part: CommandPart, reason: PermissionReason): PermissionReason =>
      several && reason.type !== "command_part"
        ? { type: "command_part", part: part.text, reason }
        : reason;

    for (const [i, r] of results.entries()) {
      if (r.behavior === "deny") return deny(wrap(parts[i] as CommandPart, r.reason));
    }
    const askRule = this.toolRule("ask");
    if (askRule !== null) return ask(ruleReason(askRule));

    let best: { priority: number; reason: PermissionReason } | null = null;
    if (analysis.unparseable !== null) {
      best = {
        priority: PRIORITY.unparseable,
        reason: { type: "unparseable_command", detail: analysis.unparseable },
      };
    }
    for (const [i, r] of results.entries()) {
      if (r.behavior !== "ask") continue;
      if (best === null || r.priority < best.priority) {
        best = { priority: r.priority, reason: wrap(parts[i] as CommandPart, r.reason) };
      }
    }
    if (best !== null) return ask(best.reason);
    if (this.mode === "bypassPermissions") return allow({ type: "mode", mode: this.mode });

    const needs = results
      .map((r, i) => ({ r, part: parts[i] as CommandPart }))
      .filter((x) => x.r.behavior === "needs");
    const first = needs[0];
    if (first !== undefined) {
      let suggestions: string[] = [];
      if (needs.every((x) => x.r.behavior === "needs" && x.r.fixable)) {
        suggestions = unique(
          needs.flatMap((x) => (x.r.behavior === "needs" ? x.r.suggestions : [])),
        );
        if (suggestions.length > 5) suggestions = [];
      }
      return ask(wrap(first.part, first.r.reason), suggestions);
    }
    if (parts.length === 0) return allow({ type: "not_needed" });
    for (const [i, r] of results.entries()) {
      if (r.behavior === "allow" && r.reason.type === "rule") {
        return allow(wrap(parts[i] as CommandPart, r.reason));
      }
    }
    return allow({ type: "mode", mode: this.mode });
  }

  private commandRule(list: RuleList, part: CommandPart): CompiledRule | null {
    const forms = list === "allow" ? part.allowForms : part.matchForms;
    if (forms.length === 0) return null;
    for (const r of this.rules[list]) {
      if (r.kind !== "command" || r.parsed.specifier === null) continue;
      const spec = r.parsed.specifier;
      if (list === "allow" && part.exactOnly && commandPatternHasWildcard(spec)) continue;
      if (forms.some((f) => commandPatternMatches(spec, f, list !== "allow"))) return r;
    }
    return null;
  }

  private judgePart(part: CommandPart, earlier: PartResult[]): PartResult {
    const mode = this.mode;
    const targets = (t: FileTarget) => [...t.paths, ...t.globDirs].map((p) => this.candidates(p));

    // A reason about a file written through a redirection names that redirection, so the
    // person can see which target decided.
    const about = (t: FileTarget, reason: PermissionReason): PermissionReason =>
      t.via === "redirect" && t.redirection !== null
        ? { type: "command_part", part: t.redirection, reason }
        : reason;

    // Deny rules: on the command and on every file it names.
    const denyRule = this.commandRule("deny", part);
    if (denyRule !== null)
      return { behavior: "deny", reason: ruleReason(denyRule), commandRule: null };
    for (const t of part.writes) {
      for (const c of targets(t)) {
        const r = this.pathRule("deny", "edit", c);
        if (r !== null)
          return { behavior: "deny", reason: about(t, ruleReason(r)), commandRule: null };
      }
    }
    for (const t of part.reads) {
      for (const c of targets(t)) {
        const r = this.pathRule("deny", "read", c);
        if (r !== null) return { behavior: "deny", reason: ruleReason(r), commandRule: null };
      }
    }

    // A file written through a redirection is an edit, and plan mode blocks edits, as it does
    // for the edit tools: before ask rules, since a block is the more restrictive outcome.
    if (mode === "plan") {
      const redirect = part.writes.find((t) => t.via === "redirect");
      if (redirect !== undefined) {
        return {
          behavior: "deny",
          reason: about(redirect, { type: "mode", mode }),
          commandRule: null,
        };
      }
    }

    // Ask rules, the same way.
    const askOf = (reason: PermissionReason, priority: number): PartResult => ({
      behavior: "ask",
      reason,
      priority,
      commandRule: null,
    });
    const askRule = this.commandRule("ask", part);
    if (askRule !== null) return askOf(ruleReason(askRule), PRIORITY.askRule);
    for (const t of part.writes) {
      for (const c of targets(t)) {
        const r = this.pathRule("ask", "edit", c);
        if (r !== null) return askOf(about(t, ruleReason(r)), PRIORITY.askRule);
      }
    }
    for (const t of part.reads) {
      for (const c of targets(t)) {
        const r = this.pathRule("ask", "read", c);
        if (r !== null) return askOf(ruleReason(r), PRIORITY.askRule);
      }
    }

    // Removals of the filesystem root, home, a working directory or a parent: never approved
    // by a rule or a mode.
    for (const t of part.writes) {
      const critical = this.criticalRemoval(t);
      if (critical !== null) return askOf(critical, PRIORITY.critical);
    }
    if (part.suspicious !== null) {
      return askOf({ type: "unparseable_command", detail: part.suspicious }, PRIORITY.unparseable);
    }
    if (mode === "bypassPermissions") {
      return { behavior: "allow", reason: { type: "mode", mode }, commandRule: null };
    }

    // What approves the command itself.
    let by: "rule" | "readonly" | "wrapper" | null = null;
    let commandRule: CompiledRule | null = null;
    if (part.role === "wrapper") {
      by = "wrapper";
    } else {
      const coverer =
        part.coveredBy === null ? null : (earlier[part.coveredBy]?.commandRule ?? null);
      commandRule = coverer ?? this.toolRule("allow") ?? this.commandRule("allow", part);
      if (commandRule !== null) by = "rule";
      else if (part.readOnly && (this.readOnlyCommands || mode === "plan")) by = "readonly";
    }

    let asked: PartResult | null = null;
    const needs: { reason: PermissionReason; suggestion: string | null; fixable: boolean }[] = [];
    const modeReason: PermissionReason = { type: "mode", mode };

    const cwd = path.resolve(this.state.cwd);
    for (const t of part.writes) {
      if (t.unknown !== null) {
        asked ??= askOf(
          about(t, { type: "unparseable_command", detail: t.unknown }),
          PRIORITY.unparseable,
        );
        continue;
      }
      // A program's own output files are covered by an allow rule for that program: writing them
      // is what the person allowed it to do. A redirection is the shell writing a file, judged
      // as an edit like any other: only edit rules or the mode approve it.
      const redirect = t.via === "redirect";
      for (const c of targets(t)) {
        const prot = this.protectedReason(c);
        if (prot !== null) {
          asked ??= askOf(about(t, prot), PRIORITY.protected);
          continue;
        }
        if (!this.inside(c, t.removal)) {
          asked ??= askOf(
            about(t, {
              type: "protected",
              path: c.real ?? c.lexical,
              why: "outside_working_directories",
            }),
            PRIORITY.protected,
          );
          continue;
        }
        const approved =
          mode === "acceptEdits" ||
          (by === "rule" && !redirect) ||
          this.pathRule("allow", "edit", c) !== null;
        if (approved) continue;
        const suggestion = redirect ? editRuleFor(c.lexical, cwd) : part.suggestion;
        needs.push({ reason: about(t, modeReason), suggestion, fixable: suggestion !== null });
      }
    }

    const readRulesExist = this.hasReadDenyOrAsk();
    for (const t of part.reads) {
      if (t.unknown !== null) {
        if (readRulesExist && (t.globDirs.length === 0 || this.globMayHitReadRule(t))) {
          asked ??= askOf(
            {
              type: "unparseable_command",
              detail: `${t.unknown}, so Read rules cannot be checked`,
            },
            PRIORITY.unparseable,
          );
          continue;
        }
        const globInside =
          t.globDirs.length > 0 && t.globDirs.every((d) => this.inside(this.candidates(d)));
        if (globInside || by === "rule") continue;
        needs.push({
          reason: modeReason,
          suggestion: part.suggestion,
          fixable: part.suggestion !== null,
        });
        continue;
      }
      for (const c of targets(t)) {
        if (this.inside(c)) continue;
        if (by === "rule" && t.via === "operand") continue;
        if (this.pathRule("allow", "read", c) !== null) continue;
        needs.push({
          reason: modeReason,
          suggestion: readRuleFor(c.lexical, this.state.homeDir, this.resolver),
          fixable: true,
        });
      }
    }

    if (
      mode === "plan" &&
      ((!part.readOnly && part.role !== "wrapper") || part.writes.length > 0)
    ) {
      needs.push({ reason: modeReason, suggestion: null, fixable: false });
    }
    if (by === null) {
      // The command itself comes first: its reason and rule lead those of its targets.
      needs.unshift({
        reason: modeReason,
        suggestion: part.suggestion,
        fixable: part.suggestion !== null,
      });
    }
    if (asked !== null) return asked;
    if (needs.length > 0) {
      return {
        behavior: "needs",
        reason: needs[0]?.reason ?? modeReason,
        suggestions: unique(needs.map((n) => n.suggestion).filter((s): s is string => s !== null)),
        fixable: needs.every((n) => n.fixable),
        commandRule,
      };
    }
    return {
      behavior: "allow",
      reason: commandRule !== null ? ruleReason(commandRule) : modeReason,
      commandRule,
    };
  }

  /** Why removing this target always needs a person's approval, or null. */
  private criticalRemoval(t: FileTarget): PermissionReason | null {
    if (!t.removal) return null;
    if (t.unknown !== null && t.globDirs.length === 0) {
      return t.recursive ? { type: "critical_removal", path: null } : null;
    }
    const home = path.resolve(this.state.homeDir);
    const homeReal = this.resolver.real(home) ?? home;
    for (const p of [...t.paths, ...t.globDirs]) {
      const c = this.candidates(p);
      for (const x of c.all) {
        if (
          x === "/" ||
          path.dirname(x) === "/" ||
          x === home ||
          x === homeReal ||
          isWithin(home, x) ||
          this.wds.isRootOrAncestor(x)
        ) {
          return { type: "critical_removal", path: x };
        }
      }
    }
    return null;
  }
}

const GLOB = /[*?[\\]/;

/**
 * The last segment of a gitignore pattern that names something: `.env` for a pattern ending in
 * `/.env`, `secrets` for one ending in `/secrets/` and a wildcard. Null when none is left.
 */
function lastNamedSegment(pattern: string): string | null {
  const segments = pattern.split("/").filter((s) => s !== "" && s !== "**" && s !== "*");
  const last = segments[segments.length - 1];
  return last === undefined ? null : last.toLowerCase();
}

function literalPrefix(glob: string): string {
  const i = glob.search(GLOB);
  return i === -1 ? glob : glob.slice(0, i);
}

function literalSuffix(glob: string): string {
  let last = -1;
  for (let i = 0; i < glob.length; i++) if ("*?[]\\".includes(glob[i] as string)) last = i;
  return glob.slice(last + 1);
}

/**
 * Whether some file name could match both a shell glob segment (from the command) and a
 * gitignore segment (from a rule). Answers true unless the two are provably disjoint.
 */
function segmentsMayMeet(shellSegment: string, ruleSegment: string): boolean {
  const s = shellSegment.toLowerCase();
  const r = ruleSegment;
  try {
    if (!GLOB.test(r)) return picomatch.isMatch(r, s, { dot: false, nocase: true });
    if (!GLOB.test(s)) return picomatch.isMatch(s, r, { dot: true, nocase: true });
  } catch {
    return true;
  }
  // The shell does not let a glob starting with a wildcard match a name starting with a dot.
  if (r.startsWith(".") && /^[*?[]/.test(s)) return false;
  const [sp, rp] = [literalPrefix(s), literalPrefix(r)];
  if (sp !== "" && rp !== "" && !sp.startsWith(rp) && !rp.startsWith(sp)) return false;
  const [ss, rs] = [literalSuffix(s), literalSuffix(r)];
  if (ss !== "" && rs !== "" && !ss.endsWith(rs) && !rs.endsWith(ss)) return false;
  return true;
}

function ruleReason(rule: CompiledRule): PermissionReason {
  return { type: "rule", list: rule.list, rule: rule.source };
}

function allow(reason: PermissionReason): Outcome {
  return { behavior: "allow", reason };
}

function ask(reason: PermissionReason, suggestions: string[] = []): Outcome {
  return { behavior: "ask", reason, suggestions };
}

function deny(reason: PermissionReason): Outcome {
  return { behavior: "deny", reason };
}

function unique(items: (string | null)[]): string[] {
  return [...new Set(items.filter((s): s is string => s !== null))];
}

/**
 * The deny rule that keeps a path from being read, or null. For tools that list or search many
 * files (Glob, Grep) to leave denied files out of their results, as documented.
 */
export function readDeniedBy(
  file: string,
  state: PermissionState,
  options: PermissionEngineOptions = {},
): PermissionRule | null {
  try {
    const judge = new Judge(
      { toolName: "Read", subject: { kind: "read", paths: [file] } },
      state,
      options,
    );
    return judge.readDenyRule(file);
  } catch {
    return null;
  }
}
