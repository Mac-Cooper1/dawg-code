/**
 * Turns a command line into the parts the permission engine judges: every simple command it
 * would run (including those inside substitutions, subshells, `bash -c` scripts and wrappers),
 * the text rules are matched against, the files each part reads and writes, and whether it is
 * read-only.
 */
import path from "node:path";
import {
  type Arg,
  type ClassifyContext,
  classify,
  EVALUATING_BUILTINS,
  isDangerousVariable,
  isPrivilegeWrapper,
  isSafeEnvVariable,
  isShell,
  knownProgramName,
  suggestCommandRule,
  toArg,
  tooDangerousToRemember,
  unwrap,
  XARGS_SAFE,
} from "./commands.ts";
import {
  assignmentName,
  hasBraceExpansion,
  hasUnquotedGlob,
  isProcessSubstitution,
  type ParseFeature,
  type ParseResult,
  parseShell,
  type ShellRedirect,
  type ShellWord,
  staticValue,
  tildePrefix,
} from "./parse.ts";

/** A file a part reads or writes. */
export interface FileTarget {
  /** As written. */
  raw: string;
  via: "redirect" | "operand";
  /** For a redirection: the redirection as written, such as `> out.txt` or `2>> log`. */
  redirection: string | null;
  /**
   * Absolute paths it may name, not normalised, so that `..` can be resolved the way the
   * kernel does. Several when an earlier `cd` leaves the directory uncertain. Empty when unknown.
   */
  paths: string[];
  /** Why the path cannot be known before the command runs, or null. */
  unknown: string | null;
  /** For a glob: the directories it is rooted in (absolute, not normalised). */
  globDirs: string[];
  /** For a glob: the path segments after those directories, as written (`*.ts`, `*` `/x.ts`). */
  globRest: string[];
  /** The file is removed or moved away (rm, rmdir, mv source). */
  removal: boolean;
  /** The removal is recursive. */
  recursive: boolean;
}

export interface CommandPart {
  /** The simple command as written, with its redirections. */
  text: string;
  /** The program name as written, or null for a part with no command (an assignment). */
  program: string | null;
  /** Where the part sits, outermost first: "command substitution", "bash -c", "xargs"... */
  nesting: string[];
  /**
   * "wrapper": runs another part and does nothing else worth judging (`timeout`, `bash -c` with
   * a script we parsed); it needs no allow rule of its own.
   * "exec_wrapper": runs another part in a way only an exact rule may approve (`sudo`, `watch`,
   * `find -exec`, `xargs` with options).
   */
  role: "command" | "wrapper" | "exec_wrapper";
  /** Index of the exec wrapper whose exact rule also approves this part. */
  coveredBy: number | null;
  /** Texts an allow rule is matched against. Empty when no allow rule can approve the part. */
  allowForms: string[];
  /** Only an allow rule without wildcards may approve it. */
  exactOnly: boolean;
  /** Texts deny and ask rules are matched against (any match counts). */
  matchForms: string[];
  /** The command itself changes nothing (its redirections and file operands are judged apart). */
  readOnly: boolean;
  /** Why it is not read-only. */
  readOnlyReason: string | null;
  writes: FileTarget[];
  reads: FileTarget[];
  /** Set when the part cannot be judged at all, for example a computed command name. */
  suspicious: string | null;
  /** False when the part is too dangerous to save as "allow always". */
  rememberable: boolean;
  /** Why it is too dangerous to remember. */
  dangerReason: string | null;
  /** The rule "allow always" would save for this part, if it needs one. */
  suggestion: string | null;
}

export interface CommandAnalysis {
  command: string;
  parts: CommandPart[];
  /** Why the line cannot be analysed with confidence. Such a line is never allowed by a rule. */
  unparseable: string | null;
}

export interface AnalyzeOptions {
  /** The directory the command runs in (absolute). */
  cwd: string;
  homeDir: string;
}

/** Longer commands are not analysed; they always need approval. */
export const MAX_COMMAND_LENGTH = 10_000;

/** Appended to the allow text of a command run by xargs, which adds arguments of its own. */
const XARGS_MARK = "\u0000";

const WRITE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const READ_SOURCES = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
]);

interface RawPart {
  role: CommandPart["role"];
  assignments: ShellWord[];
  words: ShellWord[];
  redirects: ShellRedirect[];
  nesting: string[];
  coveredBy: number | null;
  /** xargs appends arguments the command line does not show. */
  appendsArguments: boolean;
  /** find -exec: this text stands for each found path. */
  placeholder: string | null;
  suspicious: string | null;
  /** The name used for the tables, or null for a program they do not describe. */
  knownName: string | null;
}

const MAX_SCRIPT_DEPTH = 6;

/** Analyses a command line. Never throws. */
export function analyzeCommand(command: string, options: AnalyzeOptions): CommandAnalysis {
  try {
    return new Analyzer(command, options).run();
  } catch {
    return { command, parts: [], unparseable: "the command could not be analysed" };
  }
}

class Analyzer {
  private readonly command: string;
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly raw: RawPart[] = [];
  private unparseable: string | null = null;
  private readonly features = new Set<ParseFeature>();

  constructor(command: string, options: AnalyzeOptions) {
    this.command = command;
    this.cwd = path.resolve(options.cwd);
    this.homeDir = path.resolve(options.homeDir);
  }

  run(): CommandAnalysis {
    const command = this.command;
    if (command.length > MAX_COMMAND_LENGTH) {
      return { command, parts: [], unparseable: "it is longer than 10,000 characters" };
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) {
      this.fail("it contains control characters, which can hide what it does");
    }
    if (/[\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/.test(command)) {
      this.fail("it contains invisible or direction-changing characters");
    }
    this.walkScript(parseShell(command), [], null, 0);
    return { command, parts: this.build(), unparseable: this.unparseable };
  }

  private fail(reason: string): void {
    this.unparseable ??= reason;
  }

  // -------------------------------------------------------------------------------------------
  // Phase 1: find every part
  // -------------------------------------------------------------------------------------------

  private walkScript(
    parsed: ParseResult,
    nesting: string[],
    coveredBy: number | null,
    depth: number,
  ): void {
    if (parsed.error !== null) this.fail(parsed.error);
    for (const v of parsed.loopVariables) {
      if (isDangerousVariable(v))
        this.fail(`a loop sets ${v}, which changes how later commands run`);
    }
    for (const f of parsed.features) this.features.add(f);
    for (const cmd of parsed.commands) {
      this.walkCommand(
        cmd.assignments,
        cmd.words,
        cmd.redirects,
        [...nesting, ...cmd.nesting],
        coveredBy,
        depth,
        { appendsArguments: false, placeholder: null },
      );
    }
  }

  private push(part: RawPart): number {
    this.raw.push(part);
    return this.raw.length - 1;
  }

  private walkCommand(
    assignments: ShellWord[],
    words: ShellWord[],
    redirects: ShellRedirect[],
    nesting: string[],
    coveredBy: number | null,
    depth: number,
    extra: { appendsArguments: boolean; placeholder: string | null },
  ): void {
    const base: Omit<RawPart, "role" | "knownName" | "suspicious"> = {
      assignments,
      words,
      redirects,
      nesting,
      coveredBy,
      appendsArguments: extra.appendsArguments,
      placeholder: extra.placeholder,
    };
    const first = words[0];
    if (first === undefined) {
      this.push({ ...base, role: "command", knownName: null, suspicious: null });
      return;
    }
    const name = staticValue(first);
    if (name === null || hasUnquotedGlob(first) || hasBraceExpansion(first)) {
      this.push({
        ...base,
        role: "command",
        knownName: null,
        suspicious: "the program it runs is only known when the command runs",
      });
      return;
    }
    if (extra.placeholder !== null && name.includes(extra.placeholder)) {
      this.push({
        ...base,
        role: "command",
        knownName: null,
        suspicious: "the program it runs comes from the paths find finds",
      });
      return;
    }
    const known = knownProgramName(name);
    const unwrapped = known === null ? null : unwrap(known, words.slice(1));
    if (known === null || unwrapped === null) {
      this.push({ ...base, role: "command", knownName: known, suspicious: null });
      return;
    }
    const innerNesting = [...nesting, known];
    if (unwrapped.kind === "transparent") {
      const inner = unwrapped.inner ?? [];
      if (inner.length === 0) {
        // `exec > file` on its own redirects everything after it: keep the redirection here.
        this.push({ ...base, role: "wrapper", knownName: known, suspicious: null });
        return;
      }
      this.push({ ...base, role: "wrapper", redirects: [], knownName: known, suspicious: null });
      // `env A=1 cmd`: env's assignments act like assignments written before cmd.
      const envAssignments = known === "env" ? words.slice(1, words.length - inner.length) : [];
      this.walkCommand(
        [...assignments, ...envAssignments],
        inner,
        redirects,
        innerNesting,
        coveredBy,
        depth,
        {
          appendsArguments: unwrapped.appendsArguments === true || extra.appendsArguments,
          placeholder: extra.placeholder,
        },
      );
      return;
    }
    if (unwrapped.kind === "exec") {
      const index = this.push({
        ...base,
        role: "exec_wrapper",
        knownName: known,
        suspicious: null,
      });
      if (unwrapped.script !== undefined) {
        this.walkInlineScript(
          unwrapped.script,
          unwrapped.shell ?? known,
          innerNesting,
          index,
          depth,
        );
      }
      const inners = unwrapped.innerList ?? (unwrapped.inner === null ? [] : [unwrapped.inner]);
      for (const inner of inners) {
        if (inner.length === 0) continue;
        this.walkCommand([], inner, [], innerNesting, index, depth, {
          appendsArguments: unwrapped.appendsArguments === true,
          placeholder: unwrapped.placeholder ?? null,
        });
      }
      return;
    }
    // A shell running a script string: the script's own commands are the parts.
    this.push({ ...base, role: "wrapper", knownName: known, suspicious: null });
    this.walkInlineScript(
      unwrapped.script ?? null,
      unwrapped.shell ?? known,
      [...nesting, known === "eval" || known === "trap" ? known : `${known} -c`],
      coveredBy,
      depth,
    );
  }

  private walkInlineScript(
    script: string | null,
    shell: string,
    nesting: string[],
    coveredBy: number | null,
    depth: number,
  ): void {
    if (script === null) {
      this.fail(`${shell} runs a script that is only known when the command runs`);
      return;
    }
    if (depth + 1 > MAX_SCRIPT_DEPTH) {
      this.fail("scripts are nested too deeply to check");
      return;
    }
    this.walkScript(parseShell(script), nesting, coveredBy, depth + 1);
  }

  // -------------------------------------------------------------------------------------------
  // Phase 2: judge each part
  // -------------------------------------------------------------------------------------------

  private build(): CommandPart[] {
    const cwds = this.possibleDirectories();
    const changesDirectory = cwds.some((d) => d === null || d !== this.cwd);
    const taint = this.environmentTaint();
    this.checkEvaluation();
    const parts = this.raw.map((raw) => this.buildPart(raw, cwds));
    for (const [index, part] of parts.entries()) {
      if (taint !== null) {
        part.allowForms = [];
        part.suggestion = null;
        if (part.role !== "wrapper") {
          part.readOnly = false;
          part.readOnlyReason ??= taint;
        }
      }
      if (changesDirectory && this.raw[index]?.knownName === "git" && part.readOnly) {
        part.readOnly = false;
        part.readOnlyReason =
          "git runs after a cd into another directory, whose hooks and configuration apply";
      }
    }
    return parts;
  }

  /** Every directory a relative path could be resolved against, given the `cd`s in the line. */
  private possibleDirectories(): (string | null)[] {
    const targets: (string | null)[] = [];
    for (const raw of this.raw) {
      if (raw.knownName === "popd" && raw.role === "command") {
        // The directory stack may hold directories from before this command.
        targets.push(null);
        continue;
      }
      if (raw.knownName !== "cd" && raw.knownName !== "pushd") continue;
      if (raw.role !== "command") continue;
      const operands = raw.words.slice(1).filter((w) => {
        const v = staticValue(w);
        return v === null || !(v.startsWith("-") && v.length > 1);
      });
      const target = operands[0];
      if (target === undefined) {
        targets.push(this.homeDir);
        continue;
      }
      const v = staticValue(target);
      if (v === null || v === "-" || hasUnquotedGlob(target) || hasBraceExpansion(target)) {
        targets.push(null);
        continue;
      }
      const tilde = tildePrefix(target);
      if (tilde === "user") targets.push(null);
      else if (tilde === "home") targets.push(path.join(this.homeDir, v.slice(1)));
      else targets.push(v);
    }
    const dirs: (string | null)[] = [this.cwd];
    for (let round = 0; round < 2; round++) {
      for (const t of targets) {
        if (t === null) {
          if (!dirs.includes(null)) dirs.push(null);
          continue;
        }
        for (const d of [...dirs]) {
          const next = path.isAbsolute(t)
            ? path.resolve(t)
            : d === null
              ? null
              : path.resolve(d, t);
          if (!dirs.includes(next)) dirs.push(next);
        }
      }
    }
    if (dirs.length > 16) return [this.cwd, null];
    return dirs;
  }

  /**
   * Setting a variable that is not known to be harmless can change what a later command does
   * (`GIT_SSH_COMMAND=...; git fetch`), so after one no part can be approved by a rule.
   */
  private environmentTaint(): string | null {
    let taint: string | null = null;
    const consider = (name: string | null, how: string) => {
      if (name === null) return;
      if (isDangerousVariable(name)) {
        this.fail(`it ${how} ${name}, which changes what later commands run`);
      } else if (!isSafeEnvVariable(name) && mayBeEnvironmentVariable(name)) {
        taint ??= `it ${how} ${name}, which can change what later commands do`;
      }
    };
    for (const raw of this.raw) {
      // Leading assignments only affect their own command, which is judged with them.
      if (raw.words.length === 0) {
        for (const a of raw.assignments) consider(assignmentName(a), "sets");
        continue;
      }
      for (const a of raw.assignments) {
        const name = assignmentName(a);
        if (name !== null && isDangerousVariable(name)) {
          this.fail(`it sets ${name}, which changes what the command runs`);
        }
      }
      const program = raw.knownName;
      if (program === null || raw.role !== "command") continue;
      const args = raw.words.slice(1).map((w) => staticValue(w));
      if (
        [
          "export",
          "declare",
          "typeset",
          "local",
          "readonly",
          "read",
          "mapfile",
          "readarray",
          "let",
          "unset",
        ].includes(program)
      ) {
        for (const v of args) {
          if (v === null) {
            taint ??= `${program} sets a variable whose name is only known when it runs`;
            continue;
          }
          if (v.startsWith("-")) continue;
          const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(v);
          consider(m?.[1] ?? null, program === "unset" ? "unsets" : "sets");
        }
      }
      if (program === "printf" && args[0] === "-v") consider(args[1] ?? null, "sets");
      if (program === "set" && args.some((v) => v === null || /^-[a-zA-Z]*[ak]/.test(v))) {
        taint ??= "set -a or -k exports later assignments";
      }
    }
    return taint;
  }

  /**
   * Bash evaluates some values a second time: arithmetic, array subscripts, `printf -v` and
   * friends. A quoted string that holds `$(...)` is harmless on its own but runs once one of
   * those evaluates it, so the combination is not analysed.
   */
  private checkEvaluation(): void {
    if (!this.features.has("quoted_substitution_text")) return;
    const evaluates =
      this.features.has("arithmetic") ||
      this.features.has("conditional") ||
      this.features.has("subscript") ||
      this.raw.some((r) => r.knownName !== null && EVALUATING_BUILTINS.has(r.knownName));
    if (evaluates) {
      this.fail("a quoted $(...) could be evaluated as code by another part of the command");
    }
  }

  private buildPart(raw: RawPart, cwds: (string | null)[]): CommandPart {
    const words =
      raw.placeholder === null
        ? raw.words
        : raw.words.map((w) => markPlaceholder(w, raw.placeholder as string));
    const rawWords = raw.words.map((w) => w.raw);
    const canonical = words.map(render);
    const program = words[0] === undefined ? null : (staticValue(words[0]) ?? words[0].raw);
    const args = words.slice(1).map(toArg);
    const names = raw.assignments.map(assignmentName);
    const unsafeAssignment = names.find((n) => n !== null && !isSafeEnvVariable(n));

    const matchForms = new Set<string>();
    if (words.length > 0) {
      matchForms.add([...raw.assignments.map((w) => w.raw), ...rawWords].join(" "));
      matchForms.add(rawWords.join(" "));
      matchForms.add(canonical.join(" "));
      if (program?.includes("/")) {
        matchForms.add([path.basename(program), ...canonical.slice(1)].join(" "));
      }
      if (raw.knownName === "git") matchForms.add(withoutGitOptions(canonical));
    }

    let allowForms: string[] = [];
    if (
      raw.role !== "wrapper" &&
      raw.suspicious === null &&
      unsafeAssignment === undefined &&
      words.length > 0
    ) {
      allowForms = [...new Set([canonical.join(" "), rawWords.join(" ")])];
      if (raw.appendsArguments) allowForms = allowForms.map((f) => `${f} ${XARGS_MARK}`);
    }

    const reads: FileTarget[] = [];
    const writes: FileTarget[] = [];
    let readOnly = true;
    let readOnlyReason: string | null = null;
    let exactOnly = raw.role === "exec_wrapper";
    let danger: string | null = null;

    const ctx: ClassifyContext = {
      cwdRelative: (a) => {
        const t = this.target(a.word, cwds, "operand");
        return (
          t.unknown === null && t.paths.every((p) => path.resolve(p) === path.resolve(this.cwd))
        );
      },
      safeVariable: isSafeEnvVariable,
    };

    if (raw.role === "exec_wrapper") {
      readOnly = false;
      readOnlyReason = `${raw.knownName ?? program} runs another command`;
      danger = "a prefix rule cannot approve a command that runs other commands this way";
    } else if (raw.role === "wrapper") {
      readOnly = true;
    } else if (words.length === 0) {
      readOnly = true;
    } else if (raw.suspicious !== null) {
      readOnly = false;
      readOnlyReason = raw.suspicious;
    } else if (raw.knownName === null) {
      readOnly = false;
      readOnlyReason = `${program} is not a known read-only command`;
    } else {
      const effects = classify(raw.knownName, args, ctx);
      readOnly = effects.readOnly;
      readOnlyReason = effects.reason;
      for (const a of effects.reads)
        this.addTarget(reads, "read", a.word, cwds, "operand", false, false);
      for (const a of effects.writes) {
        this.addTarget(writes, "write", a.word, cwds, "operand", false, false);
      }
      const recursive = args.some(
        (a) => /^-[a-zA-Z]*[rR]/.test(a.value ?? "") || a.value === "--recursive",
      );
      for (const a of effects.removals) {
        const isRecursive = recursive || raw.knownName === "mv";
        this.addTarget(writes, "write", a.word, cwds, "operand", true, isRecursive);
      }
      if ((raw.knownName === "cd" || raw.knownName === "pushd") && effects.reads.length === 0) {
        reads.push(knownTarget("~", [this.homeDir], "operand"));
      }
      if (raw.appendsArguments) {
        const unknown = unknownTarget(
          "(from xargs input)",
          "its file names come from the input of xargs",
        );
        if (readOnly && XARGS_SAFE.has(raw.knownName)) {
          reads.push(unknown);
        } else {
          readOnly = false;
          readOnlyReason ??= "xargs passes it arguments that are only known when it runs";
          if (effects.writes.length > 0 || effects.removals.length > 0) {
            writes.push({ ...unknown, removal: effects.removals.length > 0, recursive: true });
          }
        }
      }
      if (raw.knownName === "find" && !readOnly) {
        // Docs: a prefix rule cannot approve find with actions that run, delete or write.
        exactOnly = true;
        danger = "find with this action can only be approved one call at a time";
      }
      if (isShell(raw.knownName) && !readOnly) {
        const operand = args.find((a) => !(a.value?.startsWith("-") ?? false));
        if (
          operand === undefined ||
          isProcessSubstitution(operand.word) ||
          operand.value === "-s"
        ) {
          danger = "it runs commands it reads from its input";
        }
      }
      if (
        (raw.knownName === "source" || raw.knownName === ".") &&
        args.some((a) => isProcessSubstitution(a.word))
      ) {
        danger = "it runs code produced by another command";
      }
      danger ??= tooDangerousToRemember(raw.knownName, args);
    }
    if (raw.knownName !== null && isPrivilegeWrapper(raw.knownName)) {
      danger = "it runs with raised privileges";
    }
    // An assignment on its own is judged through the taint check; in front of a command it can
    // change what that command does.
    if (unsafeAssignment !== undefined && raw.role !== "wrapper" && words.length > 0) {
      readOnly = false;
      readOnlyReason = `it sets ${unsafeAssignment}, which can change what the command does`;
    }

    for (const r of raw.redirects) {
      const t = r.target;
      if (r.heredoc !== null || t === null || r.op === "<<<") continue;
      if ((r.op === ">&" || r.op === "<&") && /^(\d+-?|-)$/.test(staticValue(t) ?? "")) continue;
      const isWrite = r.op !== "<";
      const isRead = r.op === "<" || r.op === "<>";
      const text = `${r.fd ?? ""}${r.op} ${t.raw}`;
      if (isWrite) this.addTarget(writes, "write", t, cwds, "redirect", false, false, text);
      if (isRead) this.addTarget(reads, "read", t, cwds, "redirect", false, false, text);
    }

    const rememberable = danger === null;
    const suggestion =
      rememberable && allowForms.length > 0 && raw.role !== "wrapper"
        ? suggestCommandRule(canonical, exactOnly)
        : null;

    return {
      text: displayText(raw),
      program,
      nesting: raw.nesting,
      role: raw.role,
      coveredBy: raw.coveredBy,
      allowForms,
      exactOnly,
      matchForms: [...matchForms].filter((f) => f !== ""),
      readOnly,
      readOnlyReason: readOnly ? null : (readOnlyReason ?? "it is not known to be read-only"),
      writes,
      reads,
      suspicious: raw.suspicious,
      rememberable,
      dangerReason: danger,
      suggestion,
    };
  }

  private addTarget(
    into: FileTarget[],
    kind: "read" | "write",
    word: ShellWord,
    cwds: (string | null)[],
    via: FileTarget["via"],
    removal: boolean,
    recursive: boolean,
    redirection: string | null = null,
  ): void {
    if (isProcessSubstitution(word)) return;
    const v = staticValue(word);
    // Device files with no file behind them. Removing one is never harmless, so removals stay.
    if (v !== null && !removal) {
      const sinks = kind === "write" ? WRITE_SINKS : READ_SOURCES;
      if (sinks.has(v) || /^\/dev\/fd\/\d+$/.test(v)) return;
    }
    const t = this.target(word, cwds, via);
    into.push({ ...t, removal, recursive, redirection });
  }

  private target(word: ShellWord, cwds: (string | null)[], via: FileTarget["via"]): FileTarget {
    const raw = word.raw;
    const v = staticValue(word);
    if (v === null) return unknownTarget(raw, `${raw} is only known when the command runs`, via);
    if (hasBraceExpansion(word)) return unknownTarget(raw, `${raw} is expanded by the shell`, via);
    let value = v;
    const tilde = tildePrefix(word);
    if (tilde === "user") return unknownTarget(raw, `${raw} names another user's home`, via);
    if (tilde === "home") value = this.homeDir + v.slice(1);
    const resolve = (p: string): (string | null)[] =>
      path.isAbsolute(p) ? [p] : cwds.map((d) => (d === null ? null : joinRaw(d, p)));
    if (hasUnquotedGlob(word)) {
      const segments = value.split("/");
      const firstGlob = segments.findIndex((s) => /[*?[]/.test(s));
      const dir =
        segments.slice(0, Math.max(firstGlob, 0)).join("/") || (value.startsWith("/") ? "/" : ".");
      const dirs = resolve(dir);
      if (dirs.includes(null)) {
        return unknownTarget(raw, `${raw} is relative to a directory only known when it runs`, via);
      }
      return {
        raw,
        via,
        paths: [],
        unknown: `${raw} is a pattern the shell expands`,
        redirection: null,
        globDirs: dirs as string[],
        globRest: segments.slice(Math.max(firstGlob, 0)).filter((s) => s !== ""),
        removal: false,
        recursive: false,
      };
    }
    const paths = resolve(value);
    if (paths.includes(null)) {
      return unknownTarget(raw, `${raw} is relative to a directory only known when it runs`, via);
    }
    return knownTarget(raw, paths as string[], via);
  }
}

/**
 * Whether a variable may already be in the environment, where changing it affects programs.
 * Lowercase names are by convention the shell's own (`for f in`, `read line`), apart from the
 * proxy settings.
 */
function mayBeEnvironmentVariable(name: string): boolean {
  return /[A-Z]/.test(name) || /_proxy$/.test(name);
}

function joinRaw(dir: string, rel: string): string {
  return dir.endsWith("/") ? `${dir}${rel}` : `${dir}/${rel}`;
}

function knownTarget(raw: string, paths: string[], via: FileTarget["via"]): FileTarget {
  return {
    raw,
    via,
    paths,
    unknown: null,
    redirection: null,
    globDirs: [],
    globRest: [],
    removal: false,
    recursive: false,
  };
}

function unknownTarget(raw: string, why: string, via: FileTarget["via"] = "operand"): FileTarget {
  return {
    raw,
    via,
    paths: [],
    unknown: why,
    redirection: null,
    globDirs: [],
    globRest: [],
    removal: false,
    recursive: false,
  };
}

/** Marks words holding find's `{}` as computed at run time. */
function markPlaceholder(word: ShellWord, placeholder: string): ShellWord {
  const v = staticValue(word);
  if (v === null || !v.includes(placeholder)) return word;
  return {
    raw: word.raw,
    segments: [{ kind: "expansion", type: "parameter", raw: word.raw, quoted: false }],
  };
}

/** A word as a rule would naturally spell it: its value, quoted only where needed. */
export function render(word: ShellWord): string {
  const v = staticValue(word);
  if (v === null) return word.raw;
  if (hasUnquotedGlob(word) || hasBraceExpansion(word) || tildePrefix(word) !== null)
    return word.raw;
  if (v === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v;
  return `'${v.replaceAll("'", "'\\''")}'`;
}

function displayText(raw: RawPart): string {
  const pieces = [...raw.assignments.map((w) => w.raw), ...raw.words.map((w) => w.raw)];
  for (const r of raw.redirects) {
    const fd = r.fd ?? "";
    if (r.heredoc !== null) pieces.push(`${fd}${r.op}${r.heredoc.delimiter}`);
    else if (r.op === ">&" || r.op === "<&") pieces.push(`${fd}${r.op}${r.target?.raw ?? ""}`);
    else pieces.push(`${fd}${r.op} ${r.target?.raw ?? ""}`);
  }
  return pieces.join(" ");
}

/** `git -C x -c y status` as `git status`, so deny rules written for the subcommand still apply. */
function withoutGitOptions(words: string[]): string {
  const out = [words[0] ?? "git"];
  let i = 1;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (!w.startsWith("-")) break;
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(w)
      ? 2
      : 1;
  }
  return [...out, ...words.slice(i)].join(" ");
}

export type { Arg };

/**
 * Whether a command line changes nothing: it parses with confidence, every part is read-only,
 * nothing is written, and every file it reads is named. Says nothing about where the files are;
 * the permission engine checks that.
 */
export function isReadOnlyCommand(command: string, options: AnalyzeOptions): boolean {
  const analysis = analyzeCommand(command, options);
  if (analysis.unparseable !== null) return false;
  return analysis.parts.every(
    (p) =>
      p.suspicious === null &&
      (p.readOnly || p.role === "wrapper") &&
      p.writes.length === 0 &&
      p.reads.every((t) => t.unknown === null || t.globDirs.length > 0),
  );
}
