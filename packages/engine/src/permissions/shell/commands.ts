/**
 * What we know about individual programs: which ones only read, which flags change that, which
 * operands are files, and which programs run other programs.
 *
 * Everything here is an allow-list. A program, flag or form that is not listed is treated as
 * able to change things.
 */
import { hasUnquotedGlob, type ShellWord, staticValue } from "./parse.ts";

/** One argument, with the facts the checks below need. */
export interface Arg {
  word: ShellWord;
  /** The literal value, or null when the shell computes it at run time. */
  value: string | null;
  /** Contains an unquoted glob character. */
  glob: boolean;
}

export function toArg(word: ShellWord): Arg {
  return { word, value: staticValue(word), glob: hasUnquotedGlob(word) };
}

/** What a program does with its arguments. */
export interface Effects {
  /** True when the program, run with these arguments, cannot change anything. */
  readOnly: boolean;
  /** Why it is not read-only. */
  reason: string | null;
  /** Arguments that name files or directories it reads. */
  reads: Arg[];
  /** Arguments that name files or directories it creates or changes. */
  writes: Arg[];
  /** Arguments that name files or directories it removes or moves away. */
  removals: Arg[];
}

function readOnly(reads: Arg[] = []): Effects {
  return { readOnly: true, reason: null, reads, writes: [], removals: [] };
}

function notReadOnly(
  reason: string,
  files: { reads?: Arg[]; writes?: Arg[]; removals?: Arg[] } = {},
): Effects {
  return {
    readOnly: false,
    reason,
    reads: files.reads ?? [],
    writes: files.writes ?? [],
    removals: files.removals ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// Argument splitting
// ---------------------------------------------------------------------------------------------

interface Split {
  /** Options as written, with the value of an option that takes one. */
  flags: { name: string; value: Arg | null; arg: Arg }[];
  operands: Arg[];
}

/**
 * Splits arguments into options and operands. `valueFlags` lists options whose value is the
 * next argument. A `--` ends the options.
 */
function splitArgs(args: Arg[], valueFlags: readonly string[] = []): Split {
  const flags: Split["flags"] = [];
  const operands: Arg[] = [];
  let i = 0;
  let endOfOptions = false;
  while (i < args.length) {
    const arg = args[i] as Arg;
    const v = arg.value;
    if (!endOfOptions && v === "--") {
      endOfOptions = true;
      i++;
      continue;
    }
    if (!endOfOptions && v !== null && v.length > 1 && v.startsWith("-")) {
      const name = v.includes("=") ? v.slice(0, v.indexOf("=")) : v;
      if (valueFlags.includes(v)) {
        flags.push({ name, value: args[i + 1] ?? null, arg });
        i += 2;
        continue;
      }
      flags.push({ name, value: null, arg });
      i++;
      continue;
    }
    operands.push(arg);
    i++;
  }
  return { flags, operands };
}

/** True when an option named in `deny` is present, including `--name=value` and short clusters. */
function hasFlag(split: Split, deny: readonly string[], denyShort = ""): string | null {
  for (const f of split.flags) {
    if (deny.includes(f.name)) return f.name;
    if (denyShort !== "" && /^-[A-Za-z0-9]/.test(f.name)) {
      // A cluster such as `-no`, or an option with its value attached such as `-oout.txt`.
      // Letters after one that takes a value are that value; checking them too only errs safe.
      for (const letter of /^-([A-Za-z0-9]+)/.exec(f.name)?.[1] ?? "") {
        if (denyShort.includes(letter)) return `-${letter}`;
      }
    }
  }
  return null;
}

/** Arguments the shell computes or expands at run time; any of them could become an option. */
function unpredictable(args: Arg[]): Arg | undefined {
  return args.find((a) => a.value === null || a.glob);
}

interface SimpleSpec {
  valueFlags?: readonly string[];
  /** Options that make the command able to change something. */
  deny?: readonly string[];
  /** Short option letters that do the same inside a cluster such as `-no`. */
  denyShort?: string;
  /** Whether operands are files it reads. */
  operands?: "paths" | "none";
  maxOperands?: number;
  /** Options allowed; anything else makes it not read-only. */
  only?: readonly string[];
  /** Options whose value is a file the program writes (also listed in `deny`). */
  outputs?: readonly string[];
}

/** The files named by output options such as `-o out`, `--output=out` or `-oout`. */
function outputFiles(args: Arg[], outputs: readonly string[]): Arg[] {
  const files: Arg[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === null || v === undefined) continue;
    if (v === "--") break;
    for (const o of outputs) {
      if (v === o && args[i + 1] !== undefined) files.push(args[i + 1] as Arg);
      else if (o.startsWith("--") && v.startsWith(`${o}=`))
        files.push(subArg(v.slice(o.length + 1)));
      else if (/^-[A-Za-z]$/.test(o) && v.startsWith(o) && v.length > 2)
        files.push(subArg(v.slice(2)));
    }
  }
  return files;
}

function simple(spec: SimpleSpec): (args: Arg[]) => Effects {
  return (args) => {
    const split = splitArgs(args, spec.valueFlags);
    const hasDeny = (spec.deny?.length ?? 0) > 0 || (spec.denyShort ?? "") !== "";
    if (hasDeny || spec.only !== undefined) {
      // A computed or globbed argument could expand to one of the dangerous options.
      const odd = unpredictable(args);
      if (odd !== undefined) return notReadOnly(`"${odd.word.raw}" could expand to an option`);
    }
    const bad = hasFlag(split, spec.deny ?? [], spec.denyShort);
    if (bad !== null) {
      return notReadOnly(`the ${bad} option can change files or run programs`, {
        writes: outputFiles(args, spec.outputs ?? []),
        reads: spec.operands === "paths" ? split.operands : [],
      });
    }
    if (spec.only !== undefined) {
      const other = split.flags.find((f) => !spec.only?.includes(f.name));
      if (other !== undefined)
        return notReadOnly(`the ${other.name} option is not known to be safe`);
    }
    if (spec.maxOperands !== undefined && split.operands.length > spec.maxOperands) {
      // The extra operand is where uniq and xxd write their output.
      return notReadOnly("it writes its output to a file", {
        reads: split.operands.slice(0, spec.maxOperands),
        writes: split.operands.slice(spec.maxOperands),
      });
    }
    return readOnly(spec.operands === "paths" ? split.operands : []);
  };
}

// ---------------------------------------------------------------------------------------------
// Programs with their own rules
// ---------------------------------------------------------------------------------------------

function grepLike(extraDeny: readonly string[], valueFlags: readonly string[]) {
  return (args: Arg[]): Effects => {
    const split = splitArgs(args, valueFlags);
    if (extraDeny.length > 0) {
      // A computed or globbed argument (even a file name) could expand to one of those options.
      const odd = unpredictable(args);
      if (odd !== undefined) return notReadOnly(`"${odd.word.raw}" could expand to an option`);
    }
    const bad = hasFlag(split, extraDeny);
    if (bad !== null) return notReadOnly(`the ${bad} option runs another program`);
    const patternGiven = split.flags.some((f) =>
      ["-e", "--regexp", "-f", "--file"].includes(f.name),
    );
    const files = patternGiven ? split.operands : split.operands.slice(1);
    const patternFiles = split.flags
      .filter((f) => (f.name === "-f" || f.name === "--file") && f.value !== null)
      .map((f) => f.value as Arg);
    return readOnly([...files, ...patternFiles]);
  };
}

const GREP_VALUE_FLAGS = [
  "-e",
  "--regexp",
  "-f",
  "--file",
  "-m",
  "--max-count",
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-d",
  "--directories",
  "-D",
  "--devices",
  "--label",
] as const;

const RG_VALUE_FLAGS = [
  ...GREP_VALUE_FLAGS,
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "--type-add",
  "-j",
  "--threads",
  "-M",
  "--max-columns",
  "--max-depth",
  "--max-filesize",
  "-E",
  "--encoding",
  "--sort",
  "--sortr",
  "-r",
  "--replace",
  "--colors",
  "--color",
  "--ignore-file",
  "--engine",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--hostname-bin",
] as const;

function find(args: Arg[]): Effects {
  const dangerous = [
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
    "-files0-from",
  ];
  const odd = unpredictable(args);
  if (odd !== undefined) return notReadOnly(`"${odd.word.raw}" could expand to an action`);
  const action = args.find((a) => a.value !== null && dangerous.includes(a.value));
  if (action !== undefined) {
    return notReadOnly(`the ${action.value} action runs programs or changes files`);
  }
  let i = 0;
  while (i < args.length && ["-H", "-L", "-P"].includes(args[i]?.value ?? "")) i++;
  const paths: Arg[] = [];
  while (i < args.length) {
    const v = args[i]?.value ?? "";
    if (v.startsWith("-") || v === "(" || v === "!" || v === ")" || v === ",") break;
    paths.push(args[i] as Arg);
    i++;
  }
  return readOnly(paths);
}

function sed(args: Arg[]): Effects {
  const valueFlags = ["-e", "--expression", "-f", "--file", "-l", "--line-length"];
  const split = splitArgs(args, valueFlags);
  const odd = unpredictable(args);
  if (odd !== undefined) return notReadOnly(`"${odd.word.raw}" could expand to an option`);
  const inPlace = split.flags.find(
    (f) => /^-[A-Za-z]*[iI]/.test(f.name) || f.name === "--in-place",
  );
  const scripts = split.flags
    .filter((f) => f.name === "-e" || f.name === "--expression")
    .map((f) => f.value?.value ?? null);
  const usesFile = split.flags.some((f) => f.name === "-f" || f.name === "--file");
  let files = split.operands;
  if (scripts.length === 0 && !usesFile) {
    scripts.push(split.operands[0]?.value ?? null);
    files = split.operands.slice(1);
  }
  if (inPlace !== undefined) {
    return notReadOnly("it edits files in place", { writes: files });
  }
  if (usesFile) return notReadOnly("its script comes from a file", { reads: files });
  for (const script of scripts) {
    if (script === null || !sedScriptIsReadOnly(script)) {
      return notReadOnly("its script can write files or run commands", { reads: files });
    }
  }
  return readOnly(files);
}

/**
 * Accepts only sed scripts made of printing, deleting, substituting (without the `w` and `e`
 * flags), transliterating and flow-control commands.
 */
export function sedScriptIsReadOnly(script: string): boolean {
  let i = 0;
  const n = script.length;
  const readRegex = (delim: string): boolean => {
    while (i < n) {
      const c = script[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") return false;
      i++;
      if (c === delim) return true;
    }
    return false;
  };
  const readAddress = (): boolean => {
    const c = script[i];
    if (c === undefined) return true;
    if (/[0-9]/.test(c)) {
      while (/[0-9~]/.test(script[i] ?? "")) i++;
      return true;
    }
    if (c === "$") {
      i++;
      return true;
    }
    if (c === "/") {
      i++;
      if (!readRegex("/")) return false;
      while (/[IM]/.test(script[i] ?? "")) i++;
      return true;
    }
    if (c === "\\") {
      const d = script[i + 1];
      if (d === undefined || d === "\n") return false;
      i += 2;
      return readRegex(d);
    }
    return true;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i] as string)) i++;
    if (i >= n) break;
    if (!readAddress()) return false;
    if (script[i] === ",") {
      i++;
      if (script[i] === "+" || script[i] === "~") i++;
      if (!readAddress()) return false;
    }
    while (script[i] === " ") i++;
    if (script[i] === "!") i++;
    while (script[i] === " ") i++;
    const cmd = script[i];
    if (cmd === undefined) return false;
    i++;
    if ("pdDPgGhHxzlnN={}=".includes(cmd)) continue;
    if (cmd === "q" || cmd === "Q") {
      while (/[0-9 ]/.test(script[i] ?? "")) i++;
      continue;
    }
    if (cmd === "s" || cmd === "y") {
      const delim = script[i];
      if (delim === undefined || delim === "\\" || delim === "\n") return false;
      i++;
      if (!readRegex(delim) || !readRegex(delim)) return false;
      if (cmd === "s") {
        // Flags `w` (write a file) and `e` (run a command) are not in this set, so they are
        // read as the next command and rejected below.
        while (/[gpiImM0-9]/.test(script[i] ?? "")) i++;
      }
      continue;
    }
    if (cmd === "b" || cmd === "t" || cmd === "T" || cmd === ":") {
      while (i < n && script[i] !== ";" && script[i] !== "\n") i++;
      continue;
    }
    if (cmd === "a" || cmd === "i" || cmd === "c") {
      while (i < n && script[i] !== "\n") i++;
      continue;
    }
    // Anything else, including w, W, e, r, R, F and v.
    return false;
  }
  return true;
}

function sortCmd(args: Arg[]): Effects {
  return simple({
    valueFlags: ["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "-o", "-T"],
    deny: ["-o", "--output", "--compress-program", "-T", "--temporary-directory"],
    denyShort: "oT",
    outputs: ["-o", "--output"],
    operands: "paths",
  })(args);
}

function git(args: Arg[], ctx: { cwdRelative: (a: Arg) => boolean }): Effects {
  const odd = unpredictable(args);
  if (odd !== undefined) return notReadOnly(`"${odd.word.raw}" could expand to an option`);
  const reads: Arg[] = [];
  let i = 0;
  // Global options before the subcommand.
  while (i < args.length) {
    const v = args[i]?.value ?? "";
    if (!v.startsWith("-")) break;
    if (v === "-c" || v === "--config-env" || v.startsWith("--config-env=")) {
      return notReadOnly("git -c can make git run any program");
    }
    if (v.startsWith("--exec-path="))
      return notReadOnly("--exec-path changes which programs git runs");
    if (v === "-C" || v === "--git-dir" || v === "--work-tree" || v === "--namespace") {
      const value = args[i + 1];
      if (value === undefined) return notReadOnly(`${v} has no value`);
      if (v !== "--namespace") reads.push(value);
      if (v === "-C" && !ctx.cwdRelative(value)) {
        return notReadOnly("git -C runs git in another repository, whose hooks and config apply");
      }
      i += 2;
      continue;
    }
    if (v.startsWith("--git-dir=") || v.startsWith("--work-tree=")) {
      return notReadOnly(`${v.slice(0, v.indexOf("="))} points git at another repository`);
    }
    if (
      [
        "--no-pager",
        "-P",
        "--no-optional-locks",
        "--literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
        "--no-replace-objects",
        "--bare",
        "--version",
      ].includes(v)
    ) {
      i++;
      continue;
    }
    return notReadOnly(`the git option ${v} is not known to be safe`);
  }
  const sub = args[i]?.value;
  const rest = args.slice(i + 1);
  if (sub === null) return notReadOnly("the git subcommand is only known when it runs");
  if (sub === undefined) {
    return args.some((a) => a.value === "--version")
      ? readOnly(reads)
      : notReadOnly("git with no subcommand");
  }
  const restValues = rest.map((a) => a.value ?? "");
  const positional = restValues.filter((v) => !v.startsWith("-"));
  const anyFlag = (names: string[]) =>
    restValues.find((v) => names.some((n) => v === n || v.startsWith(`${n}=`)));
  const plain = [
    "status",
    "log",
    "show",
    "diff",
    "blame",
    "annotate",
    "shortlog",
    "describe",
    "rev-parse",
    "ls-files",
    "ls-tree",
    "cat-file",
    "grep",
    "merge-base",
    "name-rev",
    "rev-list",
    "for-each-ref",
    "show-ref",
    "count-objects",
    "check-ignore",
    "check-attr",
    "whatchanged",
    "diff-tree",
    "diff-files",
    "diff-index",
    "var",
    "show-branch",
    "cherry",
    "range-diff",
    "version",
    "ls-remote",
    "verify-commit",
    "verify-tag",
  ];
  if (plain.includes(sub)) {
    const bad = anyFlag(["--output", "-O", "--open-files-in-pager", "--ext-diff"]);
    if (bad !== undefined) {
      return notReadOnly(`git ${sub} ${bad} writes files or runs a program`, {
        reads,
        writes: outputFiles(rest, ["--output"]),
      });
    }
    if (restValues.some((v) => /^-O./.test(v))) {
      return notReadOnly(`git ${sub} -O runs a program`);
    }
    return readOnly(reads);
  }
  if (sub === "branch") {
    const listing = restValues.some((v) => v === "--list" || v === "-l");
    const unsafe = restValues.find(
      (v) =>
        v.startsWith("-") &&
        ![
          "-a",
          "--all",
          "-r",
          "--remotes",
          "-v",
          "-vv",
          "--verbose",
          "--list",
          "-l",
          "--show-current",
          "--no-color",
          "--contains",
          "--no-contains",
          "--merged",
          "--no-merged",
          "--points-at",
        ].includes(v) &&
        !/^--(sort|format|color|column|contains|no-contains|merged|no-merged|points-at)(=|$)/.test(
          v,
        ),
    );
    if (unsafe !== undefined) return notReadOnly(`git branch ${unsafe} changes branches`);
    if (positional.length > 0 && !listing) return notReadOnly("git branch <name> creates a branch");
    return readOnly(reads);
  }
  if (sub === "tag") {
    const listing = restValues.some((v) => v === "--list" || v === "-l");
    const unsafe = restValues.find(
      (v) =>
        v.startsWith("-") &&
        !["-l", "--list", "-n"].includes(v) &&
        !/^(-n\d+|--(sort|format|contains|no-contains|points-at|merged|no-merged|column|color)(=|$))/.test(
          v,
        ),
    );
    if (unsafe !== undefined) return notReadOnly(`git tag ${unsafe} changes tags`);
    if (positional.length > 0 && !listing) return notReadOnly("git tag <name> creates a tag");
    return readOnly(reads);
  }
  if (sub === "remote") {
    const first = positional[0];
    if (first === undefined || first === "show" || first === "get-url") return readOnly(reads);
    return notReadOnly(`git remote ${first} changes remotes`);
  }
  if (sub === "config") {
    // Writing git's configuration can make git run any program (core.fsmonitor, aliases).
    const scope = restValues.find((v) => ["--global", "--system", "--file", "-f"].includes(v));
    const configFile = (): Arg[] => {
      if (scope === "--global") return [subArg("~/.gitconfig")];
      if (scope === "--file" || scope === "-f") {
        const file = rest[restValues.indexOf(scope) + 1];
        return file === undefined ? [] : [file];
      }
      if (scope === "--system") return [subArg("/etc/gitconfig")];
      return [subArg(".git/config")];
    };
    const getters = [
      "--get",
      "--get-all",
      "--get-regexp",
      "--get-urlmatch",
      "--list",
      "-l",
      "get",
      "list",
    ];
    if (restValues.some((v) => getters.includes(v))) {
      const setter = restValues.find((v) =>
        [
          "--add",
          "--unset",
          "--unset-all",
          "--replace-all",
          "--edit",
          "-e",
          "set",
          "unset",
        ].includes(v),
      );
      if (setter !== undefined) {
        return notReadOnly(`git config ${setter} changes configuration`, { writes: configFile() });
      }
      return readOnly(reads);
    }
    return notReadOnly("git config without a read option can change configuration", {
      writes: configFile(),
    });
  }
  if (sub === "stash" || sub === "worktree" || sub === "reflog" || sub === "notes") {
    const first = positional[0];
    const ok: Record<string, string[]> = {
      stash: ["list", "show"],
      worktree: ["list"],
      reflog: ["show", "exists"],
      notes: ["list", "show"],
    };
    if (sub === "reflog" && first === undefined) return readOnly(reads);
    if (first !== undefined && ok[sub]?.includes(first)) return readOnly(reads);
    return notReadOnly(`git ${sub} ${first ?? ""} changes the repository`.trimEnd());
  }
  if (sub === "symbolic-ref") {
    if (positional.length <= 1) return readOnly(reads);
    return notReadOnly("git symbolic-ref with a target changes a reference");
  }
  return notReadOnly(`git ${sub} can change the repository`);
}

function cdLike(args: Arg[]): Effects {
  const operands = args.filter((a) => !(a.value?.startsWith("-") && a.value.length > 1));
  // The target is reported as a read: moving into a directory is what lets later commands
  // read it, and the decision treats it like any other read.
  return readOnly(operands.slice(0, 1));
}

function setBuiltin(args: Arg[]): Effects {
  const okOptions = new Set(["pipefail", "errexit", "nounset", "xtrace", "verbose", "noclobber"]);
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === null || v === undefined) return notReadOnly("set with a computed argument");
    if (/^[-+][euxv]*o[euxv]*$/.test(v)) {
      // `-o name`, also inside a cluster such as `-euo pipefail`.
      const opt = args[i + 1]?.value;
      if (opt === undefined || opt === null || !okOptions.has(opt)) {
        return notReadOnly(`set ${v} ${opt ?? ""} is not known to be safe`.trimEnd());
      }
      i++;
      continue;
    }
    if (/^[-+][euxv]+$/.test(v)) continue;
    return notReadOnly(`set ${v} changes how later commands run`);
  }
  return readOnly();
}

function date(args: Arg[]): Effects {
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === null || v === undefined) return notReadOnly("date with a computed argument");
    if (v.startsWith("+")) continue;
    if (["-u", "-R", "--utc", "--universal", "--rfc-email", "-j"].includes(v)) continue;
    if (/^(-I\w*|--iso-8601(=\w+)?|--rfc-3339=\w+|--date=.*|-d.+)$/.test(v)) continue;
    if (v === "-d" || v === "--date" || v === "-r") {
      i++;
      continue;
    }
    return notReadOnly("date with an operand can set the clock");
  }
  return readOnly();
}

function ps(args: Arg[]): Effects {
  for (const a of args) {
    if (a.value === null) return notReadOnly("ps with a computed argument");
    // The e option prints the environment of processes, which can hold secrets.
    if (/^-?[A-Za-z]*e/.test(a.value))
      return notReadOnly("this ps form prints environment variables");
  }
  return readOnly();
}

function jq(args: Arg[]): Effects {
  const reads: Arg[] = [];
  const operands: Arg[] = [];
  let fromFile = false;
  let rawArgs = false;
  for (let i = 0; i < args.length; i++) {
    const v = args[i]?.value;
    if (v === null || v === undefined) {
      operands.push(args[i] as Arg);
      continue;
    }
    if (rawArgs) continue;
    if (v === "--args" || v === "--jsonargs") {
      rawArgs = true;
      continue;
    }
    if (["--arg", "--argjson"].includes(v)) {
      i += 2;
      continue;
    }
    if (["--slurpfile", "--rawfile"].includes(v)) {
      const file = args[i + 2];
      if (file !== undefined) reads.push(file);
      i += 2;
      continue;
    }
    if (v === "-f" || v === "--from-file") {
      const file = args[i + 1];
      if (file !== undefined) reads.push(file);
      fromFile = true;
      i++;
      continue;
    }
    if (["--indent", "-L"].includes(v)) {
      i++;
      continue;
    }
    if (v.startsWith("-") && v.length > 1) continue;
    operands.push(args[i] as Arg);
  }
  return readOnly([...reads, ...(fromFile ? operands : operands.slice(1))]);
}

function exportLike(args: Arg[], safeVariable: (name: string) => boolean): Effects {
  if (args.length === 0) return notReadOnly("it prints every exported variable");
  for (const a of args) {
    const v = a.value;
    if (v === null) return notReadOnly("it sets a computed variable");
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(v);
    if (m?.[1] === undefined || !safeVariable(m[1])) {
      return notReadOnly(`${v.split("=")[0]} is not a variable known to be safe to set`);
    }
  }
  return readOnly();
}

const VERSION_FLAGS: Record<string, readonly string[]> = {
  node: ["--version", "-v"],
  npm: ["--version", "-v"],
  pnpm: ["--version", "-v"],
  yarn: ["--version", "-v"],
  bun: ["--version"],
  deno: ["--version"],
  python: ["--version", "-V"],
  python3: ["--version", "-V"],
  pip: ["--version", "-V"],
  pip3: ["--version", "-V"],
  ruby: ["--version", "-v"],
  gem: ["--version"],
  cargo: ["--version", "-V"],
  rustc: ["--version", "-V"],
  go: ["version"],
  java: ["-version", "--version"],
  javac: ["-version", "--version"],
  tsc: ["--version", "-v"],
  cmake: ["--version"],
  gcc: ["--version"],
  clang: ["--version"],
  swift: ["--version"],
  make: ["--version"],
  docker: ["--version"],
  brew: ["--version"],
  uv: ["--version"],
};

type Classifier = (args: Arg[], ctx: ClassifyContext) => Effects;

export interface ClassifyContext {
  /** Whether a path argument resolves to the directory the command runs in. */
  cwdRelative: (arg: Arg) => boolean;
  /** Variables safe to set (see SAFE_ENV_VARIABLES). */
  safeVariable: (name: string) => boolean;
}

const pathsOnly = simple({ operands: "paths" });
const noOperands = simple({ operands: "none" });

/** Programs known to change nothing in their read-only forms. */
const READ_ONLY: Record<string, Classifier> = {
  ls: simple({ operands: "paths", valueFlags: ["-I", "-w", "-T", "--hide", "--ignore"] }),
  cat: pathsOnly,
  head: simple({ operands: "paths", valueFlags: ["-n", "-c", "--lines", "--bytes"] }),
  tail: simple({ operands: "paths", valueFlags: ["-n", "-c", "-s", "--lines", "--bytes"] }),
  wc: pathsOnly,
  nl: simple({ operands: "paths", valueFlags: ["-b", "-v", "-i", "-w", "-s", "-n", "-d", "-l"] }),
  tac: pathsOnly,
  rev: pathsOnly,
  od: simple({ operands: "paths", valueFlags: ["-A", "-j", "-N", "-t", "-w"] }),
  hexdump: simple({ operands: "paths", valueFlags: ["-n", "-s", "-e", "-f"] }),
  xxd: simple({
    operands: "paths",
    maxOperands: 1,
    valueFlags: ["-c", "-g", "-l", "-s", "-o", "-n"],
  }),
  strings: simple({ operands: "paths", valueFlags: ["-n", "-t", "-e"] }),
  cut: simple({ operands: "paths", valueFlags: ["-b", "-c", "-d", "-f"] }),
  fold: simple({ operands: "paths", valueFlags: ["-w"] }),
  fmt: simple({ operands: "paths", valueFlags: ["-w"] }),
  expand: simple({ operands: "paths", valueFlags: ["-t"] }),
  unexpand: simple({ operands: "paths", valueFlags: ["-t"] }),
  paste: simple({ operands: "paths", valueFlags: ["-d"] }),
  column: simple({
    operands: "paths",
    valueFlags: ["-s", "-c", "-o", "-N", "-R", "-E", "-H", "-W", "-l"],
  }),
  comm: pathsOnly,
  join: simple({ operands: "paths", valueFlags: ["-t", "-1", "-2", "-o", "-a", "-v", "-e"] }),
  cmp: simple({ operands: "paths", valueFlags: ["-n", "-i"] }),
  diff: simple({ operands: "paths", valueFlags: ["-U", "-C", "-L", "-I", "-F", "-x", "-X"] }),
  md5: simple({ operands: "paths", valueFlags: ["-s"] }),
  md5sum: pathsOnly,
  shasum: simple({ operands: "paths", valueFlags: ["-a"] }),
  sha1sum: pathsOnly,
  sha224sum: pathsOnly,
  sha256sum: pathsOnly,
  sha384sum: pathsOnly,
  sha512sum: pathsOnly,
  b2sum: pathsOnly,
  cksum: pathsOnly,
  stat: simple({ operands: "paths", valueFlags: ["-f", "-c", "-t", "--format", "--printf"] }),
  file: simple({
    operands: "paths",
    deny: ["-m", "--magic-file", "-f", "--files-from", "-C", "--compile"],
    denyShort: "mfC",
  }),
  du: simple({ operands: "paths", valueFlags: ["-d", "-B", "-t", "-X", "--max-depth"] }),
  df: pathsOnly,
  readlink: pathsOnly,
  realpath: pathsOnly,
  basename: noOperands,
  dirname: noOperands,
  pwd: noOperands,
  echo: noOperands,
  // Only a leading -v (assign to a variable) changes anything.
  printf: (args) =>
    args[0] === undefined || (args[0].value !== null && args[0].value !== "-v")
      ? readOnly()
      : notReadOnly("printf -v assigns a variable"),
  command: (args) =>
    args[0]?.value === "-v" || args[0]?.value === "-V"
      ? readOnly()
      : notReadOnly("command runs another command"),
  true: noOperands,
  false: noOperands,
  ":": noOperands,
  test: noOperands,
  "[": noOperands,
  "[[": noOperands,
  which: simple({ operands: "none", only: ["-a", "-s"] }),
  type: simple({ operands: "none", only: ["-a", "-t", "-p", "-P", "-f"] }),
  whoami: noOperands,
  id: noOperands,
  groups: noOperands,
  uname: noOperands,
  arch: simple({ operands: "none", maxOperands: 0 }),
  nproc: noOperands,
  uptime: noOperands,
  sw_vers: noOperands,
  tty: noOperands,
  locale: noOperands,
  getconf: noOperands,
  logname: noOperands,
  hostname: simple({
    operands: "none",
    maxOperands: 0,
    only: ["-s", "-f", "-d", "-i", "-I", "--short", "--fqdn"],
  }),
  date,
  sleep: noOperands,
  seq: noOperands,
  tr: noOperands,
  jq,
  sort: sortCmd,
  uniq: simple({ operands: "paths", maxOperands: 1, valueFlags: ["-f", "-s", "-w"] }),
  grep: grepLike([], GREP_VALUE_FLAGS),
  egrep: grepLike([], GREP_VALUE_FLAGS),
  fgrep: grepLike([], GREP_VALUE_FLAGS),
  rg: grepLike(["--pre", "--pre-glob", "--hostname-bin"], RG_VALUE_FLAGS),
  find,
  tree: simple({
    operands: "paths",
    valueFlags: ["-L", "-P", "-I", "-H", "--filelimit", "--timefmt", "-o"],
    deny: ["-o", "-R"],
    outputs: ["-o"],
  }),
  git,
  sed,
  cd: cdLike,
  pushd: cdLike,
  popd: noOperands,
  dirs: noOperands,
  set: setBuiltin,
  ps,
  pgrep: noOperands,
  lsof: noOperands,
  wait: noOperands,
  jobs: noOperands,
  export: (args, ctx) => exportLike(args, ctx.safeVariable),
  alias: (args) =>
    args.every((a) => a.value !== null && !a.value.includes("="))
      ? readOnly()
      : notReadOnly("alias with a definition changes how later commands run"),
};

/** Programs whose extra, unknown arguments (as `xargs` appends) cannot make them write. */
export const XARGS_SAFE = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "stat",
  "du",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
  "basename",
  "dirname",
  "echo",
  "readlink",
  "realpath",
]);

/** Directories whose programs are taken to be the standard ones of the same name. */
const SYSTEM_DIRS = [
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/sbin",
  "/usr/sbin",
  "/opt/homebrew/bin",
];

/**
 * The name used to look a program up in the tables: the bare name, or the base name of a path in
 * a standard system directory. A program run from anywhere else is not the standard one.
 */
export function knownProgramName(name: string): string | null {
  if (!name.includes("/")) return name;
  const slash = name.lastIndexOf("/");
  const dir = name.slice(0, slash);
  return SYSTEM_DIRS.includes(dir) ? name.slice(slash + 1) : null;
}

/** Classifies what a program would do with these arguments. */
export function classify(program: string, args: Arg[], ctx: ClassifyContext): Effects {
  const versionFlags = VERSION_FLAGS[program];
  if (
    versionFlags !== undefined &&
    args.length === 1 &&
    versionFlags.includes(args[0]?.value ?? "")
  ) {
    return readOnly();
  }
  const reader = READ_ONLY[program];
  if (reader !== undefined) return reader(args, ctx);
  const effects = fileEffects(program, args);
  return effects ?? notReadOnly(`${program} is not a known read-only command`);
}

// ---------------------------------------------------------------------------------------------
// Programs that change files
// ---------------------------------------------------------------------------------------------

/** The files a known file-changing program touches, so they can be checked like edits. */
function fileEffects(program: string, args: Arg[]): Effects | null {
  const reason = `${program} changes files`;
  switch (program) {
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred": {
      const { operands } = splitArgs(args);
      return notReadOnly(reason, { removals: operands });
    }
    case "touch": {
      const { operands, flags } = splitArgs(args, ["-t", "-d", "-r"]);
      const ref = flags
        .filter((f) => f.name === "-r" && f.value !== null)
        .map((f) => f.value as Arg);
      return notReadOnly(reason, { writes: operands, reads: ref });
    }
    case "mkdir": {
      const { operands } = splitArgs(args, ["-m", "--mode"]);
      return notReadOnly(reason, { writes: operands });
    }
    case "truncate": {
      const { operands } = splitArgs(args, ["-s", "-r", "--size", "--reference"]);
      return notReadOnly(reason, { writes: operands });
    }
    case "tee": {
      const { operands } = splitArgs(args);
      return operands.length === 0 ? readOnly() : notReadOnly(reason, { writes: operands });
    }
    case "chmod":
    case "chown":
    case "chgrp": {
      const { operands, flags } = splitArgs(args);
      const files = flags.some((f) => f.name.startsWith("--reference"))
        ? operands
        : operands.slice(1);
      return notReadOnly(reason, { writes: files });
    }
    case "mv":
    case "cp":
    case "install":
    case "ln": {
      const valueFlags = ["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "-g"];
      const { operands, flags } = splitArgs(args, valueFlags);
      const target = flags.find((f) => f.name === "-t" || f.name === "--target-directory");
      let sources = operands;
      let dest: Arg[] = [];
      if (target?.value !== null && target?.value !== undefined) {
        dest = [target.value];
      } else if (operands.length >= 2 || program !== "ln") {
        dest = operands.slice(-1);
        sources = operands.slice(0, -1);
      }
      if (program === "mv") return notReadOnly(reason, { writes: dest, removals: sources });
      if (program === "ln") {
        // `ln -s target name`: only the link name is created; the target is not touched. With a
        // single operand the link is made in the current directory.
        return notReadOnly(reason, { writes: dest });
      }
      return notReadOnly(reason, { writes: dest, reads: sources });
    }
    case "dd": {
      const writes: Arg[] = [];
      const reads: Arg[] = [];
      for (const a of args) {
        const v = a.value;
        if (v?.startsWith("of=")) writes.push(subArg(v.slice(3)));
        if (v?.startsWith("if=")) reads.push(subArg(v.slice(3)));
      }
      return notReadOnly(reason, { writes, reads });
    }
    case "curl":
    case "wget": {
      const valueFlags =
        program === "curl"
          ? ["-o", "--output"]
          : ["-O", "--output-document", "-P", "--directory-prefix"];
      const { flags } = splitArgs(args, valueFlags);
      const writes = flags
        .filter((f) => valueFlags.includes(f.name) && f.value !== null)
        .map((f) => f.value as Arg);
      for (const f of flags) {
        const v = f.arg.value ?? "";
        const m = /^--(output|output-document|directory-prefix)=(.*)$/.exec(v);
        if (m?.[2] !== undefined) writes.push(subArg(m[2]));
      }
      return notReadOnly(`${program} reaches the network`, { writes });
    }
    case "tar":
    case "unzip": {
      const flag = program === "tar" ? ["-C", "--directory"] : ["-d"];
      const { flags } = splitArgs(args, flag);
      const writes = flags
        .filter((f) => flag.includes(f.name) && f.value !== null)
        .map((f) => f.value as Arg);
      return notReadOnly(reason, { writes });
    }
    default:
      return null;
  }
}

/**
 * A file named inside another argument (`of=x`, `--output=x`). Read as unquoted, so a leading
 * `~` counts as home and glob characters make it unknown: both err on the side of asking.
 */
function subArg(value: string): Arg {
  const word: ShellWord = {
    raw: value,
    segments: [{ kind: "literal", text: value, quoted: false }],
  };
  return { word, value, glob: hasUnquotedGlob(word) };
}

// ---------------------------------------------------------------------------------------------
// Programs that run other programs
// ---------------------------------------------------------------------------------------------

export type WrapperKind =
  /** Runs its argument as a command and does nothing else worth judging. */
  | "transparent"
  /** Runs a command in a way a prefix rule should not approve (privileges, other processes). */
  | "exec"
  /** Runs a shell script given as a string. */
  | "script";

export interface Unwrapped {
  kind: WrapperKind;
  /** The command it runs, as words. Null when it cannot be found. */
  inner: ShellWord[] | null;
  /** For "script": the script text, or null when it is computed at run time. */
  script?: string | null;
  /** For "script": the shell that runs it. */
  shell?: string;
  /** Extra words the wrapper appends to the inner command (xargs). */
  appendsArguments?: boolean;
  /** For an inner command found by find -exec: `{}` stands for each found path. */
  placeholder?: string;
  /** Inner commands when there are several (find with several -exec actions). */
  innerList?: ShellWord[][];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);
const PRIVILEGE = new Set(["sudo", "doas", "pkexec", "run0"]);
const EXEC_WRAPPERS = new Set([
  "watch",
  "setsid",
  "ionice",
  "flock",
  "chroot",
  "nsenter",
  "unshare",
  "script",
  "caffeinate",
  "taskset",
  "chrt",
  "numactl",
  "strace",
  "ltrace",
  "dtruss",
]);

export function isShell(program: string): boolean {
  return SHELLS.has(program);
}

export function isPrivilegeWrapper(program: string): boolean {
  return PRIVILEGE.has(program);
}

/**
 * When `program` runs another command, says how and finds that command. Returns null for an
 * ordinary program.
 */
export function unwrap(program: string, rest: ShellWord[]): Unwrapped | null {
  const args = rest.map(toArg);
  const values = args.map((a) => a.value);
  const skipOptions = (valueFlags: readonly string[], allowed: RegExp | null): number | null => {
    let i = 0;
    while (i < values.length) {
      const v = values[i];
      if (v === null || v === undefined) return null;
      if (v === "--") return i + 1;
      if (!v.startsWith("-") || v === "-") return i;
      if (allowed !== null && !allowed.test(v)) return null;
      i += valueFlags.includes(v) ? 2 : 1;
    }
    return i;
  };
  switch (program) {
    case "nohup":
    case "builtin":
    case "noglob":
      return { kind: "transparent", inner: rest };
    case "exec": {
      const i = skipOptions(["-a"], /^-[acl]+$/);
      return i === null
        ? { kind: "exec", inner: null }
        : { kind: "transparent", inner: rest.slice(i) };
    }
    case "command": {
      if (values[0] === "-v" || values[0] === "-V") return null;
      const i = skipOptions([], /^-p$/);
      return i === null
        ? { kind: "exec", inner: null }
        : { kind: "transparent", inner: rest.slice(i) };
    }
    case "time": {
      const i = skipOptions([], /^-p$/);
      return i === null
        ? { kind: "exec", inner: null }
        : { kind: "transparent", inner: rest.slice(i) };
    }
    case "nice": {
      const i = skipOptions(["-n", "--adjustment"], /^(-n|--adjustment(=.*)?|-\d+)$/);
      return i === null
        ? { kind: "exec", inner: null }
        : { kind: "transparent", inner: rest.slice(i) };
    }
    case "timeout": {
      const i = skipOptions(
        ["-s", "--signal", "-k", "--kill-after"],
        /^(-s|--signal(=.*)?|-k|--kill-after(=.*)?|--preserve-status|--foreground|-v|--verbose)$/,
      );
      if (i === null || values[i] === undefined) return { kind: "exec", inner: null };
      // The first operand is the duration.
      return { kind: "transparent", inner: rest.slice(i + 1) };
    }
    case "stdbuf": {
      const i = skipOptions(["-i", "-o", "-e"], /^(-[ioe].*|--(input|output|error)=.*)$/);
      return i === null
        ? { kind: "exec", inner: null }
        : { kind: "transparent", inner: rest.slice(i) };
    }
    case "env": {
      let i = 0;
      let options = false;
      while (i < values.length) {
        const v = values[i];
        if (v === null || v === undefined) return { kind: "exec", inner: null };
        if (
          v === "-S" ||
          v === "--split-string" ||
          v.startsWith("--split-string=") ||
          /^-S./.test(v)
        ) {
          // `env -S 'cmd args'` splits the string into a command line of its own.
          const script =
            v === "-S" || v === "--split-string"
              ? (values[i + 1] ?? null)
              : v.slice(v.startsWith("-S") ? 2 : "--split-string=".length);
          return { kind: "exec", inner: null, script, shell: "env -S" };
        }
        if (v.startsWith("-")) {
          options = true;
          i += ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(v) ? 2 : 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
          i++;
          continue;
        }
        break;
      }
      if (i >= values.length) return null;
      // Without options, env only sets variables, which are judged like leading assignments.
      return { kind: options ? "exec" : "transparent", inner: rest.slice(i) };
    }
    case "xargs": {
      const valueFlags = [
        "-n",
        "-L",
        "-P",
        "-I",
        "-d",
        "-s",
        "-E",
        "-a",
        "--max-args",
        "--max-procs",
      ];
      let i = 0;
      let options = false;
      while (i < values.length) {
        const v = values[i];
        if (v === null || v === undefined) return { kind: "exec", inner: null };
        if (!v.startsWith("-")) break;
        options = true;
        if (
          !/^(-[0rtpx]+|-[nLPIdsEa].*|--(null|no-run-if-empty|verbose|max-args|max-procs|arg-file|delimiter)(=.*)?)$/.test(
            v,
          )
        ) {
          return { kind: "exec", inner: null };
        }
        i += valueFlags.includes(v) ? 2 : 1;
      }
      const inner = rest.slice(i);
      return {
        kind: options ? "exec" : "transparent",
        inner: inner.length > 0 ? inner : [literal("echo")],
        appendsArguments: true,
      };
    }
    case "eval":
    case "trap": {
      const words = program === "trap" ? rest.slice(0, 1) : rest;
      if (
        program === "trap" &&
        (rest.length === 0 || ["-p", "-l", "-", ""].includes(values[0] ?? ""))
      ) {
        return null;
      }
      const parts = words.map((w) => staticValue(w));
      const script = parts.some((p) => p === null) ? null : parts.join(" ");
      return { kind: "script", inner: null, script, shell: program };
    }
    case "find": {
      const inners: ShellWord[][] = [];
      for (let i = 0; i < values.length; i++) {
        if (["-exec", "-execdir", "-ok", "-okdir"].includes(values[i] ?? "")) {
          const start = i + 1;
          let j = start;
          while (j < values.length && values[j] !== ";" && values[j] !== "+") j++;
          inners.push(rest.slice(start, j));
          i = j;
        }
      }
      if (inners.length === 0) return null;
      return { kind: "exec", inner: inners[0] ?? null, innerList: inners, placeholder: "{}" };
    }
    default:
      break;
  }
  if (SHELLS.has(program)) {
    let i = 0;
    let script: string | null | undefined;
    while (i < values.length) {
      const v = values[i];
      if (v === null || v === undefined) return { kind: "exec", inner: null };
      if (v === "-o" || v === "+o" || v === "-O" || v === "+O") {
        i += 2;
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(v) || /^--[a-z-]+$/.test(v)) {
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(v)) {
          const scriptWord = rest[i + 1];
          script = scriptWord === undefined ? null : staticValue(scriptWord);
          if (scriptWord === undefined) return { kind: "exec", inner: null };
          return { kind: "script", inner: null, script, shell: program };
        }
        i++;
        continue;
      }
      break;
    }
    // No -c: the shell runs a script file or reads commands from its input.
    return null;
  }
  if (program === "su" || program === "runuser") return { kind: "exec", inner: null };
  if (PRIVILEGE.has(program)) {
    const i = skipOptions(
      ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group"],
      /^-.*/,
    );
    const inner = i === null ? null : rest.slice(i);
    return { kind: "exec", inner: inner !== null && inner.length > 0 ? inner : null };
  }
  if (EXEC_WRAPPERS.has(program)) {
    if (program === "watch") {
      const i = skipOptions(["-n", "--interval", "-d"], /^-.*/);
      if (i === null) return { kind: "exec", inner: null };
      const parts = rest.slice(i).map((w) => staticValue(w));
      // watch hands its arguments to `sh -c` as one string.
      const script = parts.some((p) => p === null) ? null : parts.join(" ");
      return { kind: "exec", inner: null, script, shell: "sh" };
    }
    const i = skipOptions(["-c", "-n", "-p", "-w", "-E", "-o", "-u", "-g"], /^-.*/);
    if (i === null) return { kind: "exec", inner: null };
    // flock and ionice take a file or class before the command.
    const skip = program === "flock" || program === "chroot" ? 1 : 0;
    const inner = rest.slice(i + skip);
    return { kind: "exec", inner: inner.length > 0 ? inner : null };
  }
  return null;
}

function literal(text: string): ShellWord {
  return { raw: text, segments: [{ kind: "literal", text, quoted: false }] };
}

// ---------------------------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------------------------

/**
 * Variables that are safe to set in front of a command: they change formatting, locale or
 * verbosity, never which program runs or what it loads.
 */
const SAFE_ENV_VARIABLES = new Set([
  "LANG",
  "LANGUAGE",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLUMNS",
  "LINES",
  "TERM",
  "NODE_ENV",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "CI",
  "DEBUG",
  "VERBOSE",
  "GIT_PAGER_IN_USE",
]);

export function isSafeEnvVariable(name: string): boolean {
  return SAFE_ENV_VARIABLES.has(name) || /^LC_[A-Z]+$/.test(name);
}

/**
 * Variables whose value changes what later commands mean: which program a name runs, how words
 * split, what the shell runs on its own. Setting one makes the rest of the line unjudgeable.
 */
const DANGEROUS_VARIABLES = new Set([
  "PATH",
  "IFS",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "GLOBIGNORE",
  "CDPATH",
  "BASH_XTRACEFD",
  "HISTFILE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "FPATH",
  "ZDOTDIR",
]);

export function isDangerousVariable(name: string): boolean {
  return DANGEROUS_VARIABLES.has(name) || name.startsWith("DYLD_") || name.startsWith("BASH_FUNC_");
}

/** Builtins that can evaluate a variable's value as arithmetic or as a name with a subscript. */
export const EVALUATING_BUILTINS = new Set([
  "let",
  "declare",
  "typeset",
  "local",
  "readonly",
  "export",
  "unset",
  "printf",
  "read",
  "mapfile",
  "readarray",
  "test",
  "[",
]);

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

/** Programs whose first argument names what they do, so a rule keeps it: `git status *`. */
const SUBCOMMAND_PROGRAMS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "brew",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "gh",
  "make",
  "just",
  "swift",
  "xcodebuild",
  "gradle",
  "mvn",
  "dotnet",
  "terraform",
  "bundle",
  "mix",
  "rake",
  "composer",
  "turbo",
  "nx",
]);

/** Programs for which only an exact rule is suggested, since any wildcard would cover too much. */
const EXACT_ONLY_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "dd",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "kill",
  "pkill",
  "killall",
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "php",
  "deno",
  "osascript",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "source",
  ".",
  "open",
  "tar",
  "unzip",
  "truncate",
  "install",
  "tee",
  "touch",
  "mkdir",
  "awk",
  "sed",
  "env",
  "xargs",
  "sh",
  "bash",
  "zsh",
  "fish",
]);

/** Subcommands that rewrite history, discard work or publish it. */
const RISKY_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: [
    "push",
    "reset",
    "clean",
    "rebase",
    "filter-branch",
    "filter-repo",
    "checkout",
    "restore",
    "gc",
    "prune",
    "update-ref",
  ],
  npm: ["publish", "unpublish", "exec"],
  pnpm: ["publish", "exec", "dlx"],
  yarn: ["publish", "dlx"],
  docker: ["rm", "rmi", "system", "volume", "exec", "run"],
  kubectl: ["delete", "apply", "exec"],
  cargo: ["publish"],
  gh: ["release", "repo", "api"],
  terraform: ["apply", "destroy"],
};

/** Too dangerous to save as "allow always", whatever the form. */
export function tooDangerousToRemember(program: string, args: Arg[]): string | null {
  const values = args.map((a) => a.value ?? "");
  if (PRIVILEGE.has(program) || program === "su") return "it runs with raised privileges";
  if (
    (program === "rm" || program === "rmdir") &&
    values.some((v) => /^-[a-zA-Z]*[rR]/.test(v) || v === "--recursive")
  ) {
    return "it deletes recursively";
  }
  if (
    [
      "dd",
      "mkfs",
      "diskutil",
      "fdisk",
      "shred",
      "shutdown",
      "reboot",
      "halt",
      "launchctl",
      "crontab",
      "eval",
    ].includes(program) ||
    program.startsWith("mkfs.")
  ) {
    return `${program} is too dangerous to allow always`;
  }
  if (
    (program === "chmod" || program === "chown" || program === "chgrp") &&
    values.some((v) => /^-[a-zA-Z]*R/.test(v))
  ) {
    return "it changes permissions recursively";
  }
  if (program === "git") {
    const sub = values.find((v) => !v.startsWith("-"));
    if (
      sub === "push" &&
      values.some((v) => v === "--force" || v === "-f" || v.startsWith("--force"))
    ) {
      return "it force-pushes";
    }
    if (sub === "reset" && values.includes("--hard")) return "it discards work";
    if (sub === "clean") return "it deletes untracked files";
  }
  if (program === "kill" || program === "killall" || program === "pkill") {
    if (values.some((v) => v === "-1" || v === "-9" || v === "-KILL"))
      return "it kills processes forcibly";
  }
  return null;
}

/** The rule "allow always" should save for one command, or null when none is sensible. */
export function suggestCommandRule(words: string[], exactOnly: boolean): string | null {
  const text = words.join(" ");
  // A `*` in an exact rule would be read as a wildcard, so such a command cannot be saved.
  const exact = text.includes("*") || text.includes("\n") ? null : `Bash(${text})`;
  const program = words[0];
  if (program === undefined) return null;
  if (exactOnly || EXACT_ONLY_PROGRAMS.has(program)) return exact;
  const plain = (w: string | undefined) =>
    w !== undefined && /^[A-Za-z0-9][\w.:@+-]*$/.test(w) && !w.includes("*");
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    const sub = words[1];
    if (sub === undefined) return exact;
    if (!plain(sub)) return exact;
    if (RISKY_SUBCOMMANDS[program]?.includes(sub)) return exact;
    const prefix = [program, sub];
    const third = words[2];
    if (
      ["npm", "pnpm", "yarn", "bun"].includes(program) &&
      ["run", "run-script", "x", "exec"].includes(sub) &&
      plain(third)
    ) {
      prefix.push(third as string);
    } else if (["docker", "podman"].includes(program) && sub === "compose" && plain(third)) {
      prefix.push(third as string);
    }
    return `Bash(${prefix.join(" ")} *)`;
  }
  if (words.length === 1) return exact;
  return `Bash(${program} *)`;
}
