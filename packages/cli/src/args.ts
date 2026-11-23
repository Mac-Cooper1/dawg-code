/**
 * Command-line parsing. Flag names follow the public CLI reference where it has them
 * (`-p`, `--output-format`, `--allowedTools`, `--continue`...). No library: rule lists and
 * `--add-dir` take several values after one flag, which `node:util`'s parser cannot express.
 */
import { statSync } from "node:fs";
import { parseRuleList } from "@dawg/compat";
import { type PermissionMode, PermissionModeSchema } from "@dawg/protocol";

export type OutputFormat = "text" | "json" | "stream-json";

export interface CliOptions {
  command: "run" | "serve";
  /** `-p`: one turn, nobody to answer, then exit. */
  print: boolean;
  /** Prompt words given on the command line, joined by spaces; null when none. */
  prompt: string | null;
  outputFormat: OutputFormat;
  model: string | null;
  /** Reasoning effort for the session; null keeps the model's default. */
  effort: string | null;
  endpoint: string | null;
  modelFile: string | null;
  /** Context window per conversation for `--model-file`, in tokens. */
  contextSize: number | null;
  permissionMode: PermissionMode | null;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns: number | null;
  continue: boolean;
  resume: string | null;
  cwd: string | null;
  addDirs: string[];
  verbose: boolean;
}

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "options"; options: CliOptions }
  | { kind: "error"; message: string };

export class UsageError extends Error {
  override name = "UsageError";
}

type Spec =
  | { type: "boolean"; key: keyof CliOptions | "help" | "version" | "skipPermissions" }
  | { type: "value"; key: string; metavar: string }
  | { type: "list"; key: "allowedTools" | "disallowedTools" | "addDirs"; metavar: string };

const FLAGS: Record<string, Spec> = {
  "-p": { type: "boolean", key: "print" },
  "--print": { type: "boolean", key: "print" },
  "--output-format": { type: "value", key: "outputFormat", metavar: "format" },
  "--model": { type: "value", key: "model", metavar: "id" },
  "--effort": { type: "value", key: "effort", metavar: "level" },
  "--endpoint": { type: "value", key: "endpoint", metavar: "url" },
  "--model-file": { type: "value", key: "modelFile", metavar: "path" },
  "--context-size": { type: "value", key: "contextSize", metavar: "tokens" },
  "--permission-mode": { type: "value", key: "permissionMode", metavar: "mode" },
  "--dangerously-skip-permissions": { type: "boolean", key: "skipPermissions" },
  "--allowedTools": { type: "list", key: "allowedTools", metavar: "rules" },
  "--allowed-tools": { type: "list", key: "allowedTools", metavar: "rules" },
  "--disallowedTools": { type: "list", key: "disallowedTools", metavar: "rules" },
  "--disallowed-tools": { type: "list", key: "disallowedTools", metavar: "rules" },
  "--max-turns": { type: "value", key: "maxTurns", metavar: "n" },
  "-c": { type: "boolean", key: "continue" },
  "--continue": { type: "boolean", key: "continue" },
  "-r": { type: "value", key: "resume", metavar: "id" },
  "--resume": { type: "value", key: "resume", metavar: "id" },
  "--cwd": { type: "value", key: "cwd", metavar: "dir" },
  "--add-dir": { type: "list", key: "addDirs", metavar: "dir" },
  "--verbose": { type: "boolean", key: "verbose" },
  "-h": { type: "boolean", key: "help" },
  "--help": { type: "boolean", key: "help" },
  "-v": { type: "boolean", key: "version" },
  "--version": { type: "boolean", key: "version" },
};

/** One rule, or a comma list of them: `Read`, `Bash(git log *)`, `mcp__server__tool`. */
const RULE_WORD =
  /^(?:(?:[A-Z][A-Za-z0-9_]*|mcp__[A-Za-z0-9_-]+|\*)(?:\(.*\))?)(?:\s*,\s*(?:[A-Z][A-Za-z0-9_]*|mcp__[A-Za-z0-9_-]+|\*)(?:\(.*\))?)*$/s;

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a word after a list flag belongs to the list. Rule lists take words shaped like rules,
 * `--add-dir` takes existing directories, so `dawg -p --allowedTools Read "fix the bug"` keeps
 * the prompt out of the list.
 */
function continuesList(key: "allowedTools" | "disallowedTools" | "addDirs", word: string): boolean {
  if (word.startsWith("-")) return false;
  return key === "addDirs" ? isDirectory(word) : RULE_WORD.test(word.trim());
}

const MODE_ALIASES: Record<string, PermissionMode> = { manual: "default" };

function parseMode(value: string): PermissionMode {
  const mode = MODE_ALIASES[value] ?? PermissionModeSchema.safeParse(value).data;
  if (mode === undefined) {
    throw new UsageError(
      `--permission-mode must be one of ${PermissionModeSchema.options.join(", ")} (or manual), not "${value}".`,
    );
  }
  return mode;
}

function positiveInt(flag: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} needs a positive whole number, not "${value}".`);
  }
  return Number(value);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  try {
    return parseOrThrow(argv);
  } catch (error) {
    if (error instanceof UsageError) return { kind: "error", message: error.message };
    throw error;
  }
}

function parseOrThrow(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {};
  const lists = {
    allowedTools: [] as string[],
    disallowedTools: [] as string[],
    addDirs: [] as string[],
  };
  const flags = new Set<string>();
  const positionals: string[] = [];
  let command: CliOptions["command"] = "run";
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (afterDoubleDash || !arg.startsWith("-") || arg === "-") {
      if (i === 0 && arg === "serve" && !afterDoubleDash) {
        command = "serve";
        continue;
      }
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const spec = FLAGS[name];
    if (spec === undefined) throw new UsageError(`Unknown option ${name}.`);
    if (spec.type === "boolean") {
      if (inline !== null) throw new UsageError(`${name} takes no value.`);
      flags.add(spec.key);
      continue;
    }
    const take = (): string => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        throw new UsageError(`${name} needs a ${spec.metavar}.`);
      }
      i += 1;
      return next;
    };
    if (spec.type === "value") {
      if (values[spec.key] !== undefined) throw new UsageError(`${name} was given twice.`);
      values[spec.key] = take();
      continue;
    }
    lists[spec.key].push(take());
    if (inline === null) {
      while (i + 1 < argv.length && continuesList(spec.key, argv[i + 1] as string)) {
        i += 1;
        lists[spec.key].push(argv[i] as string);
      }
    }
  }

  if (flags.has("help")) return { kind: "help" };
  if (flags.has("version")) return { kind: "version" };

  const outputFormat = values.outputFormat ?? "text";
  if (outputFormat !== "text" && outputFormat !== "json" && outputFormat !== "stream-json") {
    throw new UsageError(
      `--output-format must be text, json or stream-json, not "${outputFormat}".`,
    );
  }
  let permissionMode =
    values.permissionMode === undefined ? null : parseMode(values.permissionMode);
  if (flags.has("skipPermissions")) {
    if (permissionMode !== null && permissionMode !== "bypassPermissions") {
      throw new UsageError(
        `--dangerously-skip-permissions conflicts with --permission-mode ${permissionMode}.`,
      );
    }
    permissionMode = "bypassPermissions";
  }
  const options: CliOptions = {
    command,
    print: flags.has("print"),
    prompt: positionals.length === 0 ? null : positionals.join(" "),
    outputFormat,
    model: values.model ?? null,
    effort: values.effort === undefined ? null : effortLevel(values.effort),
    endpoint: values.endpoint ?? null,
    modelFile: values.modelFile ?? null,
    contextSize:
      values.contextSize === undefined ? null : positiveInt("--context-size", values.contextSize),
    permissionMode,
    allowedTools: parseRuleList(lists.allowedTools),
    disallowedTools: parseRuleList(lists.disallowedTools),
    maxTurns: values.maxTurns === undefined ? null : positiveInt("--max-turns", values.maxTurns),
    continue: flags.has("continue"),
    resume: values.resume ?? null,
    cwd: values.cwd ?? null,
    addDirs: lists.addDirs,
    verbose: flags.has("verbose"),
  };

  if (options.endpoint !== null && options.modelFile !== null) {
    throw new UsageError("Give --endpoint or --model-file, not both.");
  }
  if (options.contextSize !== null && options.modelFile === null) {
    throw new UsageError("--context-size only applies to --model-file.");
  }
  if (options.continue && options.resume !== null) {
    throw new UsageError("Give --continue or --resume, not both.");
  }
  if (!options.print && values.outputFormat !== undefined && command === "run") {
    throw new UsageError("--output-format only applies with -p.");
  }
  if (command === "serve") {
    const refused = [
      options.print && "-p",
      values.outputFormat !== undefined && "--output-format",
      options.continue && "--continue",
      options.resume !== null && "--resume",
      options.effort !== null && "--effort",
      options.prompt !== null && "a prompt",
    ].filter((x): x is string => typeof x === "string");
    if (refused.length > 0) {
      throw new UsageError(`dawg serve does not take ${refused.join(", ")}: clients send those.`);
    }
  }
  return { kind: "options", options };
}

/** Effort levels come from the model's chat template, so only their shape is checked here. */
function effortLevel(value: string): string {
  const level = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(level)) {
    throw new UsageError(`--effort takes a level name such as low or high, not "${value}".`);
  }
  return level;
}

export const HELP = `dawg: a coding agent for local models.

Usage:
  dawg [options] [prompt]          Start an interactive session (optionally with a first prompt)
  dawg -p [options] [prompt]       Run one turn without asking anything, print the result, exit
  dawg serve [options]             Serve the engine protocol on standard input and output

The prompt for -p comes from the arguments, or from standard input when none is given.

Model (one of):
  --endpoint <url>                 An OpenAI-compatible root, e.g. http://127.0.0.1:8080/v1.
                                   The API key is read from DAWG_API_KEY only.
  --model-file <path.gguf>         Run a local model file with the bundled llama-server
  --context-size <tokens>          Context window for --model-file (default 32768)
  (neither)                        Use the endpoint in DAWG_ENDPOINT
  --model <id>                     The model to use on the endpoint
  --effort <level>                 Reasoning effort, from the levels the model offers
                                   (for example low, medium or xhigh)

Output (with -p):
  --output-format <format>         text (default): the final message
                                   json: one object with the result, usage and session id
                                   stream-json: every protocol event, one JSON object per line

Permissions:
  --permission-mode <mode>         default, acceptEdits, plan, dontAsk or bypassPermissions
  --dangerously-skip-permissions   Same as --permission-mode bypassPermissions
  --allowedTools <rules...>        Allow rules, e.g. "Bash(npm test *)" Edit Read
  --disallowedTools <rules...>     Deny rules, in the same form

Session:
  -c, --continue                   Continue the most recent session in the working directory
  -r, --resume <id>                Resume a session by id, from any directory
  --cwd <dir>                      Working directory (default: the current one)
  --add-dir <dir...>               More directories the agent may read and edit
  --max-turns <n>                  Most model requests in one turn

Other:
  --verbose                        Diagnostics on standard error
  -h, --help                       This help
  -v, --version                    The version

Exit codes: 0 completed, 1 model or engine error, 2 bad usage, 3 turn limit reached,
130 interrupted (SIGINT), 143 terminated (SIGTERM).
`;
