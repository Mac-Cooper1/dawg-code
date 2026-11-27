import { readFile } from "node:fs/promises";
import { type PermissionMode, PermissionModeSchema } from "@dawg/protocol";
import { parseSandboxSettings, type SandboxFileSettings } from "../sandbox/settings.ts";
import type { SettingsOrigin, SettingsProblem } from "../types.ts";

/** The parts of one settings file this version uses, after lenient validation. */
export interface ParsedSettings {
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode: PermissionMode | null;
  /** As written in the file; resolved later, when the file's level is known. */
  additionalDirectories: string[];
  bypassDisabled: boolean;
  env: Record<string, string>;
  /** Added (Phase 4, sandbox): the file's `sandbox` key, or null when it has none. */
  sandbox: SandboxFileSettings | null;
  ignoredKeys: string[];
  problems: SettingsProblem[];
}

export interface ReadSettingsResult extends ParsedSettings {
  exists: boolean;
}

export const PERMISSION_LISTS = ["allow", "ask", "deny"] as const;
export type PermissionListName = (typeof PERMISSION_LISTS)[number];

/** The documented value of `permissions.disableBypassPermissionsMode`. */
const BYPASS_DISABLE_VALUE = "disable";

/**
 * Environment variables that configure Claude Code itself or Anthropic's API (keys, endpoints,
 * model names). They mean nothing to a local model and can hold secrets, so they are never taken
 * from `.claude` files into our sessions or their child processes.
 */
const HOSTED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];

/** Keys that describe the file rather than configure anything. Not reported as ignored. */
const METADATA_KEYS = new Set(["$schema"]);

function emptyParsed(): ParsedSettings {
  return {
    allow: [],
    ask: [],
    deny: [],
    defaultMode: null,
    additionalDirectories: [],
    bypassDisabled: false,
    env: {},
    sandbox: null,
    ignoredKeys: [],
    problems: [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Turns a permission mode as written in settings or on the command line into ours. Accepts the
 * documented `manual` alias for `default`. Returns null for anything we do not support.
 */
export function parsePermissionMode(value: string): PermissionMode | null {
  if (value === "manual") return "default";
  const parsed = PermissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readStringList(
  value: unknown,
  key: string,
  path: string,
  problems: SettingsProblem[],
): string[] {
  if (!Array.isArray(value)) {
    problems.push({ path, key, message: `Expected a list of strings, found ${describe(value)}.` });
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, i) => {
    if (typeof entry !== "string") {
      problems.push({
        path,
        key: `${key}[${i}]`,
        message: `Expected a string, found ${describe(entry)}.`,
      });
    } else if (entry.trim() === "") {
      problems.push({ path, key: `${key}[${i}]`, message: "Empty entry skipped." });
    } else {
      out.push(entry);
    }
  });
  return out;
}

function parsePermissions(value: unknown, path: string, into: ParsedSettings): void {
  if (!isPlainObject(value)) {
    into.problems.push({
      path,
      key: "permissions",
      message: `Expected an object, found ${describe(value)}.`,
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const dotted = `permissions.${key}`;
    switch (key) {
      case "allow":
      case "ask":
      case "deny":
        into[key] = readStringList(entry, dotted, path, into.problems);
        break;
      case "additionalDirectories":
        into.additionalDirectories = readStringList(entry, dotted, path, into.problems);
        break;
      case "defaultMode": {
        if (typeof entry !== "string") {
          into.problems.push({
            path,
            key: dotted,
            message: `Expected a string, found ${describe(entry)}.`,
          });
          break;
        }
        const mode = parsePermissionMode(entry);
        if (mode === null) {
          into.problems.push({
            path,
            key: dotted,
            message: `Permission mode "${entry}" is not supported; ignored.`,
          });
        } else {
          into.defaultMode = mode;
        }
        break;
      }
      case "disableBypassPermissionsMode":
        if (entry === BYPASS_DISABLE_VALUE) {
          into.bypassDisabled = true;
        } else {
          into.problems.push({
            path,
            key: dotted,
            message: `Expected "${BYPASS_DISABLE_VALUE}", found ${JSON.stringify(entry) ?? describe(entry)}; ignored.`,
          });
        }
        break;
      default:
        into.ignoredKeys.push(dotted);
    }
  }
}

function parseEnv(value: unknown, path: string, origin: SettingsOrigin, into: ParsedSettings) {
  if (!isPlainObject(value)) {
    into.problems.push({
      path,
      key: "env",
      message: `Expected an object, found ${describe(value)}.`,
    });
    return;
  }
  // Built with fromEntries so that a name such as `__proto__` stays an ordinary key.
  const entries: [string, string][] = [];
  for (const [name, entry] of Object.entries(value)) {
    const dotted = `env.${name}`;
    if (origin === "claude" && HOSTED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
      into.ignoredKeys.push(dotted);
      continue;
    }
    if (typeof entry !== "string") {
      into.problems.push({
        path,
        key: dotted,
        message: `Expected a string, found ${describe(entry)}.`,
      });
      continue;
    }
    entries.push([name, entry]);
  }
  into.env = Object.fromEntries(entries);
}

/** Parses the text of one settings file. Never throws; every fault becomes a problem. */
export function parseSettingsText(
  text: string,
  path: string,
  origin: SettingsOrigin,
): ParsedSettings {
  const out = emptyParsed();
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // An empty file is a file someone created and has not filled in yet, not a broken one.
  if (stripped.trim() === "") return out;

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    out.problems.push({ path, key: null, message: `Not valid JSON, file skipped: ${detail}` });
    return out;
  }
  if (!isPlainObject(data)) {
    out.problems.push({
      path,
      key: null,
      message: `Expected a JSON object at the top level, found ${describe(data)}; file skipped.`,
    });
    return out;
  }

  for (const [key, value] of Object.entries(data)) {
    if (key === "permissions") parsePermissions(value, path, out);
    else if (key === "env") parseEnv(value, path, origin, out);
    else if (key === "sandbox") {
      const read = parseSandboxSettings(value, path);
      out.sandbox = read.settings;
      out.problems.push(...read.problems);
    } else if (!METADATA_KEYS.has(key)) out.ignoredKeys.push(key);
  }
  return out;
}

/** Reads and parses one settings file. A missing file is not a problem. Never throws. */
export async function readSettingsFile(
  path: string,
  origin: SettingsOrigin,
): Promise<ReadSettingsResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ...emptyParsed(), exists: false };
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...emptyParsed(),
      exists: true,
      problems: [{ path, key: null, message: `Could not read the file: ${detail}` }],
    };
  }
  return { ...parseSettingsText(text, path, origin), exists: true };
}
