/**
 * Reads the `hooks` key of every settings file, in the documented shape
 * (code.claude.com/docs/en/hooks, "Configuration"): event name → list of matcher groups
 * `{ matcher, hooks: [handler] }`. Lenient like the settings reader: a bad entry is reported as a
 * problem and skipped, never thrown, and the rest of the file still counts.
 *
 * Hook entries from every file are combined, not replaced ("Hook entries merge across levels");
 * `disableAllHooks` is read after settings precedence, so the first file that sets it decides.
 * The HTTP hook allowlists (`allowedHttpHookUrls`, `httpHookAllowedEnvVars`) are read too; their
 * arrays merge across files, as the settings reference says.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CompatSource } from "@dawg/protocol";
import { settingsFilePaths } from "../settings/load.ts";
import type { SettingsProblem } from "../types.ts";

/** One handler as written, with the fields dawg reads pulled out. */
export interface HookHandler {
  /** As written: "command", "http", "prompt", "agent", "mcp_tool", or anything else. */
  type: string;
  /** For `command` handlers: what runs (with `args`, the program). Null for other types. */
  command: string | null;
  /** Exec form: when present the program is run directly with these arguments, no shell. */
  args: string[] | null;
  /** Its own timeout in seconds, or null for the documented default. */
  timeout: number | null;
  /** One permission rule that must match the tool call, or null. */
  if: string | null;
  async: boolean;
  asyncRewake: boolean;
  /** "bash" (the default) or "powershell", as written; null when absent. */
  shell: string | null;
  /** Whether the action goes ahead when the hook fails; null when absent ("continue"). */
  onFailure: "continue" | "block" | null;
  statusMessage: string | null;
  /** What it runs, for people: the command line, the URL, the prompt or the MCP tool. */
  target: string;
  /** For `http` handlers: where the event is posted, as written. Null for other types. */
  url: string | null;
  /** For `http` handlers: extra headers as written; values may name environment variables. */
  headers: Record<string, string>;
  /** For `http` handlers: the environment variables its headers may read. */
  allowedEnvVars: string[];
  /** For `prompt` and `agent` handlers: the prompt as written. Null for other types. */
  prompt: string | null;
  /** For `prompt` and `agent` handlers: `model` as written (mapped, principle 4), or null. */
  model: string | null;
  /** For `prompt` handlers: an `ok: false` reason goes back to the model instead of ending the turn. */
  continueOnBlock: boolean;
  /** For `mcp_tool` handlers: the server and the tool, as written. Null for other types. */
  server: string | null;
  tool: string | null;
  /** For `mcp_tool` handlers: the tool's arguments as written (`${path}` substitutions), or null. */
  input: Record<string, unknown> | null;
  /** `once` as written: honoured only in skill front matter, so ignored in settings files. */
  once: boolean;
  /** Keys as written that dawg does not know, so the report can name them. */
  unknownKeys: string[];
  /** The handler exactly as written, so consent can cover every byte of it. */
  raw: Record<string, unknown>;
}

/** One handler of one matcher group of one event, in one settings file. */
export interface HookDefinition {
  event: string;
  /** As written; null when the group has none. */
  matcher: string | null;
  handler: HookHandler;
  source: CompatSource;
  /** Where it is in its file, for messages: "hooks.PreToolUse[0].hooks[1]". */
  location: string;
}

/** What one settings file holds for hooks. */
export interface HookFile {
  source: CompatSource;
  exists: boolean;
  hooks: HookDefinition[];
  /** `disableAllHooks` as written, or null when the file does not set it. */
  disableAllHooks: boolean | null;
  /** `allowedHttpHookUrls` as written, or null when the file does not set it. */
  allowedHttpHookUrls: string[] | null;
  /** `httpHookAllowedEnvVars` as written, or null when the file does not set it. */
  httpHookAllowedEnvVars: string[] | null;
  problems: SettingsProblem[];
}

/**
 * The settings that restrict HTTP hooks (settings reference, "allowedHttpHookUrls" and
 * "httpHookAllowedEnvVars"), merged across every file. Null where no file sets the key: then any
 * URL is allowed, and each hook's own `allowedEnvVars` applies.
 */
export interface HttpHookPolicy {
  allowedUrls: string[] | null;
  allowedEnvVars: string[] | null;
}

export interface LoadedHooks {
  /** Every settings file that applies, highest precedence first, whether or not it exists. */
  files: HookFile[];
  /** Every handler of every file, in the same order. */
  hooks: HookDefinition[];
  /** The file whose `disableAllHooks: true` is in force, or null when hooks may run. */
  disabledBy: string | null;
  /** The HTTP hook allowlists in force. */
  http: HttpHookPolicy;
  problems: SettingsProblem[];
}

export interface LoadHooksOptions {
  /** The project (absolute), or null for only the person's own files. */
  projectDir: string | null;
  /** Where the personal files are read from (a worktree's main project); default the project. */
  localDir?: string | null;
  homeDir: string;
}

/** Handler keys the hooks reference documents, by handler type ("*" for every type). */
const KNOWN_KEYS: Record<string, ReadonlySet<string>> = {
  "*": new Set(["type", "if", "timeout", "statusMessage", "once"]),
  command: new Set(["command", "args", "async", "asyncRewake", "shell", "onFailure"]),
  http: new Set(["url", "headers", "allowedEnvVars", "onFailure"]),
  mcp_tool: new Set(["server", "tool", "input", "onFailure"]),
  prompt: new Set(["prompt", "model", "continueOnBlock"]),
  agent: new Set(["prompt", "model"]),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** Shell quoting for showing an exec-form command line; plain words stay as they are. */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./~$-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A list of non-empty strings, or null when the value is not one. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return (value as string[]).map((v) => v.trim()).filter((v) => v !== "");
}

/** Reads one handler object. Null (with a problem) when it cannot be used at all. */
function readHandler(
  value: unknown,
  path: string,
  key: string,
  problems: SettingsProblem[],
): HookHandler | null {
  if (!isPlainObject(value)) {
    problems.push({
      path,
      key,
      message: `Expected a hook handler object, found ${describe(value)}.`,
    });
    return null;
  }
  const type = typeof value.type === "string" ? value.type : null;
  if (type === null || type.trim() === "") {
    problems.push({ path, key: `${key}.type`, message: "A hook handler needs a type." });
    return null;
  }
  const known = new Set([...(KNOWN_KEYS["*"] ?? []), ...(KNOWN_KEYS[type] ?? [])]);
  const unknownKeys = Object.keys(value).filter((k) => !known.has(k));

  let command: string | null = null;
  let args: string[] | null = null;
  if (type === "command") {
    command = stringOrNull(value.command);
    if (command === null) {
      problems.push({ path, key: `${key}.command`, message: "A command hook needs a command." });
      return null;
    }
    if (value.args !== undefined) {
      if (Array.isArray(value.args) && value.args.every((a) => typeof a === "string")) {
        args = value.args as string[];
      } else {
        problems.push({
          path,
          key: `${key}.args`,
          message: "Expected a list of strings; the hook is not run.",
        });
        return null;
      }
    }
  }

  let url: string | null = null;
  let headers: Record<string, string> = {};
  let allowedEnvVars: string[] = [];
  if (type === "http") {
    url = stringOrNull(value.url);
    let parsed: URL | null = null;
    try {
      parsed = url === null ? null : new URL(url);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      problems.push({
        path,
        key: `${key}.url`,
        message:
          url === null
            ? "An http hook needs a url."
            : `Expected an http or https address, found ${JSON.stringify(url)}; the hook is not run.`,
      });
      return null;
    }
    if (value.headers !== undefined) {
      if (
        isPlainObject(value.headers) &&
        Object.values(value.headers).every((v) => typeof v === "string")
      ) {
        headers = value.headers as Record<string, string>;
      } else {
        problems.push({
          path,
          key: `${key}.headers`,
          message: "Expected an object of text values; no headers are sent.",
        });
      }
    }
    if (value.allowedEnvVars !== undefined) {
      const list = stringList(value.allowedEnvVars);
      if (list !== null) allowedEnvVars = list;
      else {
        problems.push({
          path,
          key: `${key}.allowedEnvVars`,
          message: "Expected a list of variable names; headers read no variables.",
        });
      }
    }
  }

  let prompt: string | null = null;
  if (type === "prompt" || type === "agent") {
    prompt = stringOrNull(value.prompt);
    if (prompt === null) {
      problems.push({ path, key: `${key}.prompt`, message: `A ${type} hook needs a prompt.` });
      return null;
    }
  }

  let server: string | null = null;
  let tool: string | null = null;
  let input: Record<string, unknown> | null = null;
  if (type === "mcp_tool") {
    server = stringOrNull(value.server);
    tool = stringOrNull(value.tool);
    if (server === null || tool === null) {
      problems.push({
        path,
        key: `${key}.${server === null ? "server" : "tool"}`,
        message: "An mcp_tool hook needs a server and a tool.",
      });
      return null;
    }
    if (value.input !== undefined) {
      if (isPlainObject(value.input)) input = value.input;
      else {
        problems.push({
          path,
          key: `${key}.input`,
          message: `Expected an object of arguments, found ${describe(value.input)}; the hook is not run.`,
        });
        return null;
      }
    }
  }

  let timeout: number | null = null;
  if (value.timeout !== undefined) {
    if (typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0) {
      timeout = value.timeout;
    } else {
      problems.push({
        path,
        key: `${key}.timeout`,
        message: `Expected a positive number of seconds, found ${JSON.stringify(value.timeout) ?? describe(value.timeout)}; the default applies.`,
      });
    }
  }

  let onFailure: HookHandler["onFailure"] = null;
  if (value.onFailure !== undefined) {
    if (value.onFailure === "continue" || value.onFailure === "block") onFailure = value.onFailure;
    else {
      problems.push({
        path,
        key: `${key}.onFailure`,
        message: `Expected "continue" or "block", found ${JSON.stringify(value.onFailure) ?? describe(value.onFailure)}; ignored.`,
      });
    }
  }

  let target: string;
  switch (type) {
    case "command":
      target = args === null ? (command ?? "") : [command ?? "", ...args].map(quoteArg).join(" ");
      break;
    case "http":
      target = typeof value.url === "string" ? value.url : "";
      break;
    case "prompt":
    case "agent":
      target = typeof value.prompt === "string" ? value.prompt : "";
      break;
    case "mcp_tool":
      target = [value.server, value.tool].filter((p) => typeof p === "string").join(" ");
      break;
    default:
      target = "";
  }

  return {
    type,
    command,
    args,
    timeout,
    if: stringOrNull(value.if),
    async: value.async === true,
    asyncRewake: value.asyncRewake === true,
    shell: stringOrNull(value.shell),
    onFailure,
    statusMessage: stringOrNull(value.statusMessage),
    target,
    url,
    headers,
    allowedEnvVars,
    prompt,
    model: type === "prompt" || type === "agent" ? stringOrNull(value.model) : null,
    continueOnBlock: type === "prompt" && value.continueOnBlock === true,
    server,
    tool,
    input,
    once: value.once === true,
    unknownKeys,
    raw: value,
  };
}

/**
 * Reads the value of a settings file's `hooks` key. Never throws; every fault becomes a problem
 * and the entry it is in is skipped.
 */
export function parseHooksValue(
  value: unknown,
  source: CompatSource,
): { hooks: HookDefinition[]; problems: SettingsProblem[] } {
  const path = source.path;
  const problems: SettingsProblem[] = [];
  const hooks: HookDefinition[] = [];
  if (!isPlainObject(value)) {
    problems.push({ path, key: "hooks", message: `Expected an object, found ${describe(value)}.` });
    return { hooks, problems };
  }
  for (const [event, groups] of Object.entries(value)) {
    const eventKey = `hooks.${event}`;
    if (!Array.isArray(groups)) {
      problems.push({
        path,
        key: eventKey,
        message: `Expected a list of matcher groups, found ${describe(groups)}.`,
      });
      continue;
    }
    groups.forEach((group, g) => {
      const groupKey = `${eventKey}[${g}]`;
      if (!isPlainObject(group)) {
        problems.push({
          path,
          key: groupKey,
          message: `Expected a matcher group object, found ${describe(group)}.`,
        });
        return;
      }
      let matcher: string | null = null;
      if (group.matcher !== undefined && group.matcher !== null) {
        if (typeof group.matcher === "string") matcher = group.matcher;
        else {
          problems.push({
            path,
            key: `${groupKey}.matcher`,
            message: `Expected a string, found ${describe(group.matcher)}; the group is skipped.`,
          });
          return;
        }
      }
      if (!Array.isArray(group.hooks)) {
        problems.push({
          path,
          key: `${groupKey}.hooks`,
          message: "A matcher group needs a list of hooks.",
        });
        return;
      }
      group.hooks.forEach((entry, h) => {
        const location = `${groupKey}.hooks[${h}]`;
        const handler = readHandler(entry, path, location, problems);
        if (handler !== null) hooks.push({ event, matcher, handler, source, location });
      });
    });
  }
  return { hooks, problems };
}

/** Reads one settings file's hooks. A missing file is not a problem. Never throws. */
export async function readHookFile(source: CompatSource): Promise<HookFile> {
  const empty = (exists: boolean, problems: SettingsProblem[] = []): HookFile => ({
    source,
    exists,
    hooks: [],
    disableAllHooks: null,
    allowedHttpHookUrls: null,
    httpHookAllowedEnvVars: null,
    problems,
  });
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return empty(false);
    const detail = error instanceof Error ? error.message : String(error);
    return empty(true, [
      { path: source.path, key: null, message: `Could not read the file: ${detail}` },
    ]);
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (stripped.trim() === "") return empty(true);
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return empty(true, [
      { path: source.path, key: null, message: `Not valid JSON, file skipped: ${detail}` },
    ]);
  }
  if (!isPlainObject(data)) return empty(true);
  const file = empty(true);
  if (data.hooks !== undefined) {
    const parsed = parseHooksValue(data.hooks, source);
    file.hooks = parsed.hooks;
    file.problems.push(...parsed.problems);
  }
  if (data.disableAllHooks !== undefined) {
    if (typeof data.disableAllHooks === "boolean") file.disableAllHooks = data.disableAllHooks;
    else {
      file.problems.push({
        path: source.path,
        key: "disableAllHooks",
        message: `Expected true or false, found ${describe(data.disableAllHooks)}; ignored.`,
      });
    }
  }
  for (const key of ["allowedHttpHookUrls", "httpHookAllowedEnvVars"] as const) {
    if (data[key] === undefined) continue;
    const list = stringList(data[key]);
    if (list !== null) file[key] = list;
    else {
      file.problems.push({
        path: source.path,
        key,
        message: `Expected a list of strings, found ${describe(data[key])}; ignored.`,
      });
    }
  }
  return file;
}

/** The settings files hooks come from, highest precedence first, as sources. */
export function hookSources(options: LoadHooksOptions): CompatSource[] {
  const projectDir = options.projectDir === null ? null : resolve(options.projectDir);
  const localDir =
    options.localDir === undefined || options.localDir === null
      ? projectDir
      : resolve(options.localDir);
  return settingsFilePaths(projectDir, resolve(options.homeDir), localDir).map((spec) => ({
    path: spec.path,
    origin: spec.origin,
    scope: spec.source,
  }));
}

/** Reads the hooks of every settings file that applies. Never throws for a bad file. */
export async function loadHooks(options: LoadHooksOptions): Promise<LoadedHooks> {
  const files = await Promise.all(hookSources(options).map((source) => readHookFile(source)));
  const setting = files.find((file) => file.disableAllHooks !== null);
  return {
    files,
    hooks: files.flatMap((file) => file.hooks),
    disabledBy: setting?.disableAllHooks === true ? setting.source.path : null,
    http: httpPolicy(files),
    problems: files.flatMap((file) => file.problems),
  };
}

/** The HTTP hook allowlists of these files, merged ("Arrays merge across settings files"). */
export function httpPolicy(files: readonly HookFile[]): HttpHookPolicy {
  const merge = (key: "allowedHttpHookUrls" | "httpHookAllowedEnvVars"): string[] | null => {
    const lists = files.flatMap((file) => (file[key] === null ? [] : [file[key]]));
    return lists.length === 0 ? null : [...new Set(lists.flat())];
  };
  return {
    allowedUrls: merge("allowedHttpHookUrls"),
    allowedEnvVars: merge("httpHookAllowedEnvVars"),
  };
}
