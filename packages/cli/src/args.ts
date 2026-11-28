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
  command: "run" | "serve" | "compat";
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
  /**
   * `--approve-project-code`: approve the hooks, skills and MCP servers the project defines now,
   * without asking (see trust.ts).
   */
  approveProjectCode: boolean;
  /** Added (Phase 4, sandbox): `--sandbox`, which turns the sandbox on for shell commands. */
  sandbox: boolean;
  /**
   * Added (Phase 4, round 3): `--mcp-config`, each a file or a JSON string holding an
   * `mcpServers` object, as Claude Code's CLI takes them: the session's own MCP servers.
   */
  mcpConfigs: string[];
  /** `--strict-mcp-config`: only the `--mcp-config` servers, none of the project's or yours. */
  strictMcpConfig: boolean;
  /** `dawg compat`: the folder to report on (default: the current one). */
  path: string | null;
  /** `dawg compat --json`: the report as JSON. */
  json: boolean;
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
  | {
      type: "list";
      key: "allowedTools" | "disallowedTools" | "addDirs" | "mcpConfigs";
      metavar: string;
    };

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
  "--approve-project-code": { type: "boolean", key: "approveProjectCode" },
  "--sandbox": { type: "boolean", key: "sandbox" },
  "--mcp-config": { type: "list", key: "mcpConfigs", metavar: "file or JSON" },
  "--strict-mcp-config": { type: "boolean", key: "strictMcpConfig" },
  "--json": { type: "boolean", key: "json" },
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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a word after a list flag belongs to the list. Rule lists take words shaped like rules,
 * `--add-dir` takes existing directories, so `dawg -p --allowedTools Read "fix the bug"` keeps
 * the prompt out of the list.
 */
function continuesList(
  key: "allowedTools" | "disallowedTools" | "addDirs" | "mcpConfigs",
  word: string,
): boolean {
  if (word.startsWith("-")) return false;
  if (key === "mcpConfigs") return word.trim().startsWith("{") || isFile(word);
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
    mcpConfigs: [] as string[],
  };
  const flags = new Set<string>();
  /** Every option as typed, for `dawg compat`, which takes almost none. */
  const given: string[] = [];
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
      if (i === 0 && arg === "compat" && !afterDoubleDash) {
        command = "compat";
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
    given.push(name);
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
  if (command === "compat") {
    return { kind: "options", options: compatOptions(given, flags, positionals) };
  }

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
    approveProjectCode: flags.has("approveProjectCode"),
    sandbox: flags.has("sandbox"),
    mcpConfigs: lists.mcpConfigs,
    strictMcpConfig: flags.has("strictMcpConfig"),
    path: null,
    json: false,
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
  if (flags.has("json")) throw new UsageError("--json only applies to dawg compat.");
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
      options.mcpConfigs.length > 0 && "--mcp-config",
      options.strictMcpConfig && "--strict-mcp-config",
    ].filter((x): x is string => typeof x === "string");
    if (refused.length > 0) {
      throw new UsageError(`dawg serve does not take ${refused.join(", ")}: clients send those.`);
    }
  }
  return { kind: "options", options };
}

/** `dawg compat [path] [--json]`: a folder, and nothing for sessions or models. */
function compatOptions(
  given: readonly string[],
  flags: ReadonlySet<string>,
  positionals: readonly string[],
): CliOptions {
  const refused = [...new Set(given.filter((name) => name !== "--json" && name !== "--verbose"))];
  if (refused.length > 0) {
    throw new UsageError(`dawg compat takes a folder and --json, not ${refused.join(", ")}.`);
  }
  if (positionals.length > 1) throw new UsageError("dawg compat takes one folder.");
  return {
    command: "compat",
    print: false,
    prompt: null,
    outputFormat: "text",
    model: null,
    effort: null,
    endpoint: null,
    modelFile: null,
    contextSize: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: null,
    continue: false,
    resume: null,
    cwd: null,
    addDirs: [],
    verbose: flags.has("verbose"),
    approveProjectCode: false,
    sandbox: false,
    mcpConfigs: [],
    strictMcpConfig: false,
    path: positionals[0] ?? null,
    json: flags.has("json"),
  };
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
  dawg compat [path] [--json]      Show what dawg makes of the Claude Code setup in a folder
                                   (default: the current one) and your home folder

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
  --sandbox                        Run shell commands in the sandbox (macOS): they may write
                                   only in the working directories and temp, and reach only
                                   the hosts in sandbox.network.allowedDomains. Same as
                                   "sandbox": { "enabled": true } in a settings file

Session:
  -c, --continue                   Continue the most recent session in the working directory
  -r, --resume <id>                Resume a session by id, from any directory
  --cwd <dir>                      Working directory (default: the current one)
  --add-dir <dir...>               More directories the agent may read and edit
  --max-turns <n>                  Most model requests in one turn
  --approve-project-code           Approve the hooks, skills and MCP servers the project
                                   defines now, without asking (otherwise -p never runs
                                   them until they are approved)

MCP servers:
  --mcp-config <file or JSON...>   The session's own servers: a file, or a JSON string, with
                                   an "mcpServers" object as in .mcp.json. Repeatable; a later
                                   one wins for the same name. They need no approval
  --strict-mcp-config              Only the --mcp-config servers, none of the project's or yours

Web search (WebSearch is offered only when a service is set; WebFetch needs nothing):
  DAWG_SEARCH_PROVIDER             brave (the default with a key), tavily or searxng
  DAWG_SEARCH_API_KEY              Your key for Brave Search or Tavily
  DAWG_SEARXNG_URL                 A SearXNG instance's address

Other:
  --verbose                        Diagnostics on standard error
  -h, --help                       This help
  -v, --version                    The version

Exit codes: 0 completed, 1 model or engine error, 2 bad usage, 3 turn limit reached,
130 interrupted (SIGINT), 143 terminated (SIGTERM).
`;
