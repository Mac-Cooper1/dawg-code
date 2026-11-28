/**
 * The `sandbox` key of the settings files, in its documented form
 * (code.claude.com/docs/en/sandboxing and the settings reference, "sandbox.*"): what one file
 * says, and the settings a session runs with once every file is merged.
 *
 * - The sandbox is off unless a file (or `--sandbox`) turns it on: `sandbox.enabled` defaults to
 *   false, as documented.
 * - Booleans: the highest-precedence file that sets one decides (flags, local, project, user;
 *   dawg's file before Claude Code's within a level). `allowUnsandboxedCommands: false` in the
 *   person's own settings beats a project's `true`, as documented.
 * - Lists merge across every file, duplicates dropped.
 * - Relative filesystem paths resolve as documented: in a project's files against the project,
 *   in the person's files against the folder the file is in (`~/.claude`, `~/.dawg`).
 *
 * Lenient like the rest of the settings reader: a bad value is a problem and is skipped, never
 * thrown. Keys dawg does not apply are listed with the reason, for the compatibility report.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SettingsProblem } from "../types.ts";

/** What one file's `sandbox` key says, after checking types. Null where the file is silent. */
export interface SandboxFileSettings {
  enabled: boolean | null;
  failIfUnavailable: boolean | null;
  autoAllowBashIfSandboxed: boolean | null;
  allowUnsandboxedCommands: boolean | null;
  /** `Bash(...)` rule contents: "docker *", "npm run e2e". */
  excludedCommands: string[];
  /** Command substring (or "*") → substrings of violations not to report. */
  ignoreViolations: Record<string, string[]>;
  enableWeakerNestedSandbox: boolean | null;
  enableWeakerNetworkIsolation: boolean | null;
  allowAppleEvents: boolean | null;
  allowNestedUserNamespaces: boolean | null;
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean | null;
    allowLocalBinding: boolean | null;
    allowMachLookup: string[];
    strictAllowlist: boolean | null;
  };
  /** Paths exactly as written; `mergeSandboxSettings` resolves them. */
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
    disabled: boolean | null;
  };
  /** Credentials kept from sandboxed commands: file paths as written, variable names. */
  credentials: { files: string[]; envVars: string[] };
  /** Keys in the file that dawg reads but does not apply, each with why. */
  ignored: SandboxIgnoredKey[];
}

export interface SandboxIgnoredKey {
  /** Dotted, from the top of the file: "sandbox.network.httpProxyPort". */
  key: string;
  /** A sentence. */
  why: string;
}

/** The settings a session's sandbox runs with, every file merged. */
export interface SandboxSettings {
  /** Default false: the sandbox is off until the person turns it on. */
  enabled: boolean;
  /** Default false: when the sandbox cannot run, commands run without it (and say so). */
  failIfUnavailable: boolean;
  /** Default false: sandboxed commands still follow the permission rules and mode. */
  autoAllowBashIfSandboxed: boolean;
  /** Default true: a command the sandbox blocked may be retried outside it, after a prompt. */
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  ignoreViolations: Record<string, string[]>;
  enableWeakerNestedSandbox: boolean;
  enableWeakerNetworkIsolation: boolean;
  allowAppleEvents: boolean;
  allowNestedUserNamespaces: boolean;
  network: {
    allowedDomains: string[];
    /**
     * Where each allowed host came from, file by file (highest precedence first), so hosts a
     * project's files supply can wait for the person's approval (the engine's trust store).
     */
    allowedDomainsFrom: SandboxHostsFrom[];
    deniedDomains: string[];
    /** Absolute. */
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
    allowLocalBinding: boolean;
    allowMachLookup: string[];
  };
  /** Every path absolute (globs kept as globs, anchored). */
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
    disabled: boolean;
  };
  credentials: { files: string[]; envVars: string[] };
  /** The file (or "<command line>") whose `enabled` is in force; null when none sets it. */
  enabledBy: string | null;
}

/** The hosts one settings file adds to `sandbox.network.allowedDomains`. */
export interface SandboxHostsFrom {
  path: string;
  source: "local" | "project" | "user";
  origin: "dawg" | "claude";
  domains: string[];
}

/** The documented defaults: the sandbox off, nothing listed. */
export function defaultSandboxSettings(): SandboxSettings {
  return {
    enabled: false,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    excludedCommands: [],
    ignoreViolations: {},
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowNestedUserNamespaces: false,
    network: {
      allowedDomains: [],
      allowedDomainsFrom: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [], disabled: false },
    credentials: { files: [], envVars: [] },
    enabledBy: null,
  };
}

function emptyFile(): SandboxFileSettings {
  return {
    enabled: null,
    failIfUnavailable: null,
    autoAllowBashIfSandboxed: null,
    allowUnsandboxedCommands: null,
    excludedCommands: [],
    ignoreViolations: {},
    enableWeakerNestedSandbox: null,
    enableWeakerNetworkIsolation: null,
    allowAppleEvents: null,
    allowNestedUserNamespaces: null,
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: null,
      allowLocalBinding: null,
      allowMachLookup: [],
      strictAllowlist: null,
    },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [], disabled: null },
    credentials: { files: [], envVars: [] },
    ignored: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Why keys are not applied
// ---------------------------------------------------------------------------------------------

const MANAGED_ONLY =
  "Only managed settings can set it, and dawg has no managed settings, so it is ignored.";
const LINUX_ONLY = "Applies to the Linux sandbox; dawg's sandbox runs on macOS, so it is ignored.";

/** Documented keys dawg reads but does not apply, by dotted name under `sandbox`. */
const NOT_APPLIED: Readonly<Record<string, string>> = {
  bwrapPath: MANAGED_ONLY,
  socatPath: MANAGED_ONLY,
  "network.allowManagedDomainsOnly": MANAGED_ONLY,
  "filesystem.allowManagedReadPathsOnly": MANAGED_ONLY,
  ripgrep: LINUX_ONLY,
  "network.httpProxyPort":
    "dawg's own proxy always filters sandboxed traffic; a proxy of your own is not supported yet, so it is ignored.",
  "network.socksProxyPort":
    "dawg's own proxy always filters sandboxed traffic; a proxy of your own is not supported yet, so it is ignored.",
  "network.tlsTerminate":
    "dawg's proxy checks host names only and does not decrypt traffic, so it is ignored.",
  "credentials.allowPlaintextInject": "Credential masking is not supported, so it is ignored.",
  "credentials.awsPairs": "Credential masking is not supported, so it is ignored.",
  "credentials.sigv4": "Credential masking is not supported, so it is ignored.",
};

/**
 * Documented as "User or managed": a project's files (shared or personal) cannot set them.
 * `strictAllowlist` is here too, though dawg refuses unlisted hosts whatever it says.
 */
const USER_ONLY = new Set([
  "allowAppleEvents",
  "allowNestedUserNamespaces",
  "filesystem.disabled",
  "network.strictAllowlist",
]);

/**
 * dawg's own rule: keys that loosen the sandbox or skip its prompts count only from the
 * person's own files (theirs, a project's personal file, the command line), never from a
 * project's shared file, which arrives with a clone and could otherwise open the sandbox up for
 * whoever opens the project.
 */
const PERSONAL_ONLY = new Set([
  "autoAllowBashIfSandboxed",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
  "network.allowLocalBinding",
  "network.allowUnixSockets",
  "network.allowAllUnixSockets",
  "network.allowMachLookup",
]);

const USER_ONLY_WHY =
  "Only your own settings (~/.dawg or ~/.claude) can set it, so it is ignored in a project's files.";
const PERSONAL_ONLY_WHY =
  "It loosens the sandbox, so dawg takes it only from your own settings, not from a project's shared file (stricter than Claude Code, on purpose); ignored here.";

// ---------------------------------------------------------------------------------------------
// Reading one file
// ---------------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

interface Reader {
  path: string;
  problems: SettingsProblem[];
}

function readBoolean(value: unknown, key: string, r: Reader): boolean | null {
  if (typeof value === "boolean") return value;
  r.problems.push({
    path: r.path,
    key,
    message: `Expected true or false, found ${describe(value)}.`,
  });
  return null;
}

function readStrings(value: unknown, key: string, r: Reader): string[] {
  if (!Array.isArray(value)) {
    r.problems.push({
      path: r.path,
      key,
      message: `Expected a list of strings, found ${describe(value)}.`,
    });
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, i) => {
    if (typeof entry !== "string") {
      r.problems.push({
        path: r.path,
        key: `${key}[${i}]`,
        message: `Expected a string, found ${describe(entry)}.`,
      });
    } else if (entry.trim() === "") {
      r.problems.push({ path: r.path, key: `${key}[${i}]`, message: "Empty entry skipped." });
    } else if (!out.includes(entry.trim())) {
      out.push(entry.trim());
    }
  });
  return out;
}

/**
 * A network entry as documented: a host name, `*.` and a domain, an IP address (IPv6 in
 * brackets), each with an optional `:port`. The engine checks entries again with the sandbox
 * runtime's own rules before using them.
 */
const DOMAIN_ENTRY =
  /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?::\d{1,5})?$/i;
const IPV6_ENTRY = /^\[[0-9a-f:.]+\](?::\d{1,5})?$/i;

export function domainEntryProblem(entry: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
    return `"${entry}" is a URL; list the host name alone, such as "example.com".`;
  }
  if (entry === "*" || entry.startsWith("*:")) {
    return `"${entry}" would allow every host, which the sandbox does not accept.`;
  }
  const port = /:(\d+)$/.exec(entry)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) {
    return `"${entry}" has a port outside 1 to 65535.`;
  }
  if (DOMAIN_ENTRY.test(entry) || IPV6_ENTRY.test(entry)) return null;
  return `"${entry}" is not a host name, a "*." wildcard or an IP address.`;
}

function readDomains(value: unknown, key: string, r: Reader): string[] {
  const out: string[] = [];
  readStrings(value, key, r).forEach((entry) => {
    const problem = domainEntryProblem(entry);
    if (problem === null) out.push(entry.toLowerCase());
    else r.problems.push({ path: r.path, key, message: `${problem} Skipped.` });
  });
  return out;
}

function readCredentialEntries(
  value: unknown,
  key: string,
  field: "path" | "name",
  r: Reader,
  notes: SandboxIgnoredKey[],
): string[] {
  if (!Array.isArray(value)) {
    r.problems.push({ path: r.path, key, message: `Expected a list, found ${describe(value)}.` });
    return [];
  }
  const out: string[] = [];
  let masked = false;
  value.forEach((entry, i) => {
    const at = `${key}[${i}]`;
    if (!isPlainObject(entry) || typeof entry[field] !== "string" || entry[field].trim() === "") {
      r.problems.push({ path: r.path, key: at, message: `Expected an object with a "${field}".` });
      return;
    }
    const mode = entry.mode;
    if (mode !== "deny" && mode !== "mask") {
      r.problems.push({
        path: r.path,
        key: `${at}.mode`,
        message: `Expected "deny" or "mask", found ${JSON.stringify(mode) ?? describe(mode)}; skipped.`,
      });
      return;
    }
    if (mode === "mask") masked = true;
    const name = (entry[field] as string).trim();
    if (!out.includes(name)) out.push(name);
  });
  if (masked) {
    notes.push({
      key,
      why: 'Masking needs a proxy that decrypts traffic, which dawg does not have, so "mask" entries are kept from commands entirely, as "deny" is.',
    });
  }
  return out;
}

function readIgnoreViolations(value: unknown, key: string, r: Reader): Record<string, string[]> {
  if (!isPlainObject(value)) {
    r.problems.push({
      path: r.path,
      key,
      message: `Expected an object, found ${describe(value)}.`,
    });
    return {};
  }
  const entries: [string, string[]][] = [];
  for (const [command, list] of Object.entries(value)) {
    const paths = readStrings(list, `${key}.${command}`, r);
    if (command.trim() !== "" && paths.length > 0) entries.push([command, paths]);
  }
  return Object.fromEntries(entries);
}

/**
 * Reads one file's `sandbox` value. Never throws: a bad value is a problem and is skipped, and
 * a key dawg does not apply is listed in `ignored`.
 */
export function parseSandboxSettings(
  value: unknown,
  path: string,
): { settings: SandboxFileSettings; problems: SettingsProblem[] } {
  const out = emptyFile();
  const r: Reader = { path, problems: [] };
  if (!isPlainObject(value)) {
    r.problems.push({
      path,
      key: "sandbox",
      message: `Expected an object, found ${describe(value)}.`,
    });
    return { settings: out, problems: r.problems };
  }
  const unknown = (key: string) =>
    out.ignored.push({ key, why: "Not a documented sandbox setting, so it is ignored." });

  for (const [name, entry] of Object.entries(value)) {
    const key = `sandbox.${name}`;
    const notApplied = NOT_APPLIED[name];
    if (notApplied !== undefined) {
      out.ignored.push({ key, why: notApplied });
      continue;
    }
    switch (name) {
      case "enabled":
      case "failIfUnavailable":
      case "autoAllowBashIfSandboxed":
      case "allowUnsandboxedCommands":
      case "enableWeakerNestedSandbox":
      case "enableWeakerNetworkIsolation":
      case "allowAppleEvents":
      case "allowNestedUserNamespaces":
        out[name] = readBoolean(entry, key, r);
        break;
      case "excludedCommands":
        out.excludedCommands = readStrings(entry, key, r);
        break;
      case "ignoreViolations":
        out.ignoreViolations = readIgnoreViolations(entry, key, r);
        break;
      case "network":
        readNetwork(entry, key, r, out);
        break;
      case "filesystem":
        readFilesystem(entry, key, r, out);
        break;
      case "credentials":
        readCredentials(entry, key, r, out);
        break;
      default:
        unknown(key);
    }
  }
  return { settings: out, problems: r.problems };
}

function readNetwork(value: unknown, key: string, r: Reader, out: SandboxFileSettings): void {
  if (!isPlainObject(value)) {
    r.problems.push({
      path: r.path,
      key,
      message: `Expected an object, found ${describe(value)}.`,
    });
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    const dotted = `${key}.${name}`;
    const notApplied = NOT_APPLIED[`network.${name}`];
    if (notApplied !== undefined) {
      out.ignored.push({ key: dotted, why: notApplied });
      continue;
    }
    switch (name) {
      case "allowedDomains":
      case "deniedDomains":
        out.network[name] = readDomains(entry, dotted, r);
        break;
      case "allowUnixSockets":
      case "allowMachLookup":
        out.network[name] = readStrings(entry, dotted, r);
        break;
      case "allowAllUnixSockets":
      case "allowLocalBinding":
      case "strictAllowlist":
        out.network[name] = readBoolean(entry, dotted, r);
        break;
      default:
        out.ignored.push({
          key: dotted,
          why: "Not a documented sandbox setting, so it is ignored.",
        });
    }
  }
}

function readFilesystem(value: unknown, key: string, r: Reader, out: SandboxFileSettings): void {
  if (!isPlainObject(value)) {
    r.problems.push({
      path: r.path,
      key,
      message: `Expected an object, found ${describe(value)}.`,
    });
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    const dotted = `${key}.${name}`;
    const notApplied = NOT_APPLIED[`filesystem.${name}`];
    if (notApplied !== undefined) {
      out.ignored.push({ key: dotted, why: notApplied });
      continue;
    }
    switch (name) {
      case "allowWrite":
      case "denyWrite":
      case "denyRead":
      case "allowRead":
        out.filesystem[name] = readStrings(entry, dotted, r);
        break;
      case "disabled":
        out.filesystem.disabled = readBoolean(entry, dotted, r);
        break;
      default:
        out.ignored.push({
          key: dotted,
          why: "Not a documented sandbox setting, so it is ignored.",
        });
    }
  }
}

function readCredentials(value: unknown, key: string, r: Reader, out: SandboxFileSettings): void {
  if (!isPlainObject(value)) {
    r.problems.push({
      path: r.path,
      key,
      message: `Expected an object, found ${describe(value)}.`,
    });
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    const dotted = `${key}.${name}`;
    const notApplied = NOT_APPLIED[`credentials.${name}`];
    if (notApplied !== undefined) {
      out.ignored.push({ key: dotted, why: notApplied });
      continue;
    }
    if (name === "files") {
      out.credentials.files = readCredentialEntries(entry, dotted, "path", r, out.ignored);
    } else if (name === "envVars") {
      out.credentials.envVars = readCredentialEntries(entry, dotted, "name", r, out.ignored);
    } else {
      out.ignored.push({ key: dotted, why: "Not a documented sandbox setting, so it is ignored." });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Merging every file
// ---------------------------------------------------------------------------------------------

/** One file's sandbox settings with where the file sits. */
export interface SandboxFileInput {
  /** "local" and "project" are a project's files; "user" the person's own. */
  source: "local" | "project" | "user";
  origin: "dawg" | "claude";
  path: string;
  settings: SandboxFileSettings | null;
}

export interface SandboxMergeInput {
  /** Highest precedence first, as `settingsFilePaths` lists them. */
  files: readonly SandboxFileInput[];
  /** Absolute: relative paths in a project's files resolve against it. */
  projectDir: string;
  /** Absolute: `~` expands to it. */
  homeDir: string;
  /** `--sandbox` on the command line: turns the sandbox on for the session. */
  flagEnabled?: boolean;
  /** Shown as the file of a value that came from the command line. */
  flagsPath?: string;
}

/** Where a relative path in a file resolves against, as documented. */
function relativeBase(file: SandboxFileInput, projectDir: string): string {
  if (file.source !== "user") return projectDir;
  // "./ or no prefix: ... User settings: relative to ~/.claude", so the folder the file is in.
  return dirname(file.path);
}

/**
 * A sandbox path as documented: `/` and `//` absolute, `~/` the home folder, anything else
 * relative to `base`. A trailing slash is dropped. Glob characters are kept as they are.
 */
export function resolveSandboxPath(entry: string, base: string, homeDir: string): string {
  let p = entry.trim();
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  if (p.startsWith("//")) p = p.slice(1);
  if (p === "~") return resolve(homeDir);
  if (p.startsWith("~/")) return join(resolve(homeDir), p.slice(2));
  if (isAbsolute(p)) return p === "/" ? "/" : resolve(p);
  return join(base, p);
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/**
 * Whether a key is taken from this file: "user only" keys from the person's files, "personal
 * only" keys from anything but a project's shared file.
 */
export function sandboxKeyApplies(key: string, source: SandboxFileInput["source"]): string | null {
  const name = key.replace(/^sandbox\./, "");
  if (USER_ONLY.has(name) && source !== "user") return USER_ONLY_WHY;
  if (PERSONAL_ONLY.has(name) && source === "project") return PERSONAL_ONLY_WHY;
  return null;
}

/**
 * The keys a file sets that this file's place keeps from applying, each with why, for the
 * report. A key the file sets to its safe value (`autoAllowBashIfSandboxed: false`) applies.
 */
export function sandboxScopeNotes(
  file: SandboxFileInput,
  dirs: { projectDir: string; homeDir: string },
): SandboxIgnoredKey[] {
  const s = file.settings;
  if (s === null) return [];
  const notes: SandboxIgnoredKey[] = [];
  const check = (key: string, set: boolean) => {
    if (!set) return;
    const why = sandboxKeyApplies(key, file.source);
    if (why !== null) notes.push({ key: `sandbox.${key}`, why });
  };
  check("allowAppleEvents", s.allowAppleEvents === true);
  check("allowNestedUserNamespaces", s.allowNestedUserNamespaces === true);
  check("filesystem.disabled", s.filesystem.disabled === true);
  check("network.strictAllowlist", s.network.strictAllowlist !== null);
  check("autoAllowBashIfSandboxed", s.autoAllowBashIfSandboxed === true);
  check("enableWeakerNestedSandbox", s.enableWeakerNestedSandbox === true);
  check("enableWeakerNetworkIsolation", s.enableWeakerNetworkIsolation === true);
  check("network.allowLocalBinding", s.network.allowLocalBinding === true);
  check("network.allowUnixSockets", s.network.allowUnixSockets.length > 0);
  check("network.allowAllUnixSockets", s.network.allowAllUnixSockets === true);
  check("network.allowMachLookup", s.network.allowMachLookup.length > 0);
  if (file.source === "project") {
    const projectDir = resolve(dirs.projectDir);
    const base = relativeBase(file, projectDir);
    const outside = s.filesystem.allowWrite.filter(
      (entry) => !isWithin(resolveSandboxPath(entry, base, dirs.homeDir), projectDir),
    );
    if (outside.length > 0) {
      notes.push({
        key: "sandbox.filesystem.allowWrite",
        why: `A project's shared file can open writes inside the project only (stricter than Claude Code, on purpose), so these are ignored: ${outside.join(", ")}.`,
      });
    }
  }
  return notes;
}

function pushUnique(list: string[], items: readonly string[]): void {
  for (const item of items) if (!list.includes(item)) list.push(item);
}

/** Merges every file's `sandbox` key into the settings a session runs with. */
export function mergeSandboxSettings(input: SandboxMergeInput): SandboxSettings {
  const projectDir = resolve(input.projectDir);
  const homeDir = resolve(input.homeDir);
  const out = defaultSandboxSettings();
  // Highest precedence first: the first file that sets a boolean decides.
  const decided = new Set<string>();
  const decide = <K extends string>(key: K, value: boolean | null, apply: (v: boolean) => void) => {
    if (value === null || decided.has(key)) return;
    decided.add(key);
    apply(value);
  };
  if (input.flagEnabled === true) {
    decided.add("enabled");
    out.enabled = true;
    out.enabledBy = input.flagsPath ?? "<command line>";
  }
  let personalForbidsRetry = false;

  for (const file of input.files) {
    const s = file.settings;
    if (s === null) continue;
    const allowed = (key: string) => sandboxKeyApplies(key, file.source) === null;
    const base = relativeBase(file, projectDir);
    const resolvePath = (entry: string) => resolveSandboxPath(entry, base, homeDir);

    decide("enabled", s.enabled, (v) => {
      out.enabled = v;
      out.enabledBy = file.path;
    });
    decide("failIfUnavailable", s.failIfUnavailable, (v) => {
      out.failIfUnavailable = v;
    });
    if (s.autoAllowBashIfSandboxed === false || allowed("autoAllowBashIfSandboxed")) {
      decide("autoAllowBashIfSandboxed", s.autoAllowBashIfSandboxed, (v) => {
        out.autoAllowBashIfSandboxed = v;
      });
    }
    decide("allowUnsandboxedCommands", s.allowUnsandboxedCommands, (v) => {
      out.allowUnsandboxedCommands = v;
    });
    if (file.source === "user" && s.allowUnsandboxedCommands === false) personalForbidsRetry = true;
    for (const key of [
      "enableWeakerNestedSandbox",
      "enableWeakerNetworkIsolation",
      "allowAppleEvents",
      "allowNestedUserNamespaces",
    ] as const) {
      if (s[key] === false || allowed(key)) decide(key, s[key], (v) => (out[key] = v));
    }
    if (s.network.allowAllUnixSockets === false || allowed("network.allowAllUnixSockets")) {
      decide("network.allowAllUnixSockets", s.network.allowAllUnixSockets, (v) => {
        out.network.allowAllUnixSockets = v;
      });
    }
    if (s.network.allowLocalBinding === false || allowed("network.allowLocalBinding")) {
      decide("network.allowLocalBinding", s.network.allowLocalBinding, (v) => {
        out.network.allowLocalBinding = v;
      });
    }
    if (s.filesystem.disabled === false || allowed("filesystem.disabled")) {
      decide("filesystem.disabled", s.filesystem.disabled, (v) => {
        out.filesystem.disabled = v;
      });
    }

    pushUnique(out.excludedCommands, s.excludedCommands);
    for (const [command, paths] of Object.entries(s.ignoreViolations)) {
      const current = out.ignoreViolations[command] ?? [];
      pushUnique(current, paths);
      out.ignoreViolations[command] = current;
    }
    pushUnique(out.network.allowedDomains, s.network.allowedDomains);
    if (s.network.allowedDomains.length > 0) {
      out.network.allowedDomainsFrom.push({
        path: file.path,
        source: file.source,
        origin: file.origin,
        domains: [...s.network.allowedDomains],
      });
    }
    pushUnique(out.network.deniedDomains, s.network.deniedDomains);
    if (allowed("network.allowUnixSockets")) {
      pushUnique(out.network.allowUnixSockets, s.network.allowUnixSockets.map(resolvePath));
    }
    if (allowed("network.allowMachLookup")) {
      pushUnique(out.network.allowMachLookup, s.network.allowMachLookup);
    }

    const allowWrite = s.filesystem.allowWrite.map(resolvePath);
    pushUnique(
      out.filesystem.allowWrite,
      file.source === "project" ? allowWrite.filter((p) => isWithin(p, projectDir)) : allowWrite,
    );
    pushUnique(out.filesystem.denyWrite, s.filesystem.denyWrite.map(resolvePath));
    pushUnique(out.filesystem.denyRead, s.filesystem.denyRead.map(resolvePath));
    pushUnique(out.filesystem.allowRead, s.filesystem.allowRead.map(resolvePath));
    pushUnique(out.credentials.files, s.credentials.files.map(resolvePath));
    pushUnique(out.credentials.envVars, s.credentials.envVars);
  }
  // Documented: "A false in user settings overrides a project's true".
  if (personalForbidsRetry) out.allowUnsandboxedCommands = false;
  return out;
}
