/**
 * Settings → Permissions without main: the settings files as an in-memory map, for the
 * in-memory bridge (the browser preview) and the store and page tests. It follows main's rules
 * (src/main/permissions.ts): the same files in the same order, Claude Code's read-only, a file
 * that does not parse read-only, new rules checked before anything is written, and the project
 * scopes needing a project. Its rule check is a small copy of the engine's syntax rules, enough
 * to show the page's messages; main uses the engine's own parser.
 */
import {
  type DawgBridge,
  type DefaultMode,
  type PermissionScope,
  type PermissionSettingsFile,
  type PermissionSettingsState,
  type PermissionsWriteInput,
  PermissionsWriteInputSchema,
  type SandboxFileSettings,
  type SandboxSettingsSummary,
} from "../../shared/bridge.ts";
import { validate } from "./validate.ts";

/** What one settings file holds, as far as the page is concerned. */
export interface FakeSettingsFile {
  defaultMode?: DefaultMode | null;
  allow?: string[];
  ask?: string[];
  deny?: string[];
  /** `permissions.disableBypassPermissionsMode`. */
  bypassDisabled?: boolean;
  /** Sentences shown with the file. */
  problems?: string[];
  /** False for a file that does not parse: shown, never written. Default true. */
  parses?: boolean;
  /** Added (Phase 4, sandbox): the file's `sandbox` key, as far as the page shows it. */
  sandbox?: Partial<SandboxFileSettings>;
}

export interface FakePermissionsOptions {
  homeDir: string;
  /** Files that exist, by absolute path. */
  files?: Record<string, FakeSettingsFile>;
}

export interface FakePermissions {
  readonly api: DawgBridge["permissions"];
  /** The files as they are now, by absolute path. */
  readonly files: Map<string, FakeSettingsFile>;
  /** Every write asked for, in order, including refused ones. */
  readonly writes: PermissionsWriteInput[];
  /** Makes the next write fail with `message`, as a full disk or a locked file would. */
  failNextWrite(message: string): void;
}

interface Spec {
  scope: PermissionScope;
  origin: "dawg" | "claude";
  path: string;
}

/** The files main lists, highest precedence first (see `settingsFilePaths` in @dawg/compat). */
export function permissionFilePaths(projectDir: string | null, homeDir: string): Spec[] {
  const user: Spec[] = [
    { scope: "user", origin: "dawg", path: `${homeDir}/.dawg/settings.json` },
    { scope: "user", origin: "claude", path: `${homeDir}/.claude/settings.json` },
  ];
  if (projectDir === null) return user;
  const project: Spec[] = [
    { scope: "local", origin: "dawg", path: `${projectDir}/.dawg/settings.local.json` },
    { scope: "local", origin: "claude", path: `${projectDir}/.claude/settings.local.json` },
    { scope: "project", origin: "dawg", path: `${projectDir}/.dawg/settings.json` },
    { scope: "project", origin: "claude", path: `${projectDir}/.claude/settings.json` },
  ];
  const userPaths = new Set(user.map((spec) => spec.path));
  return [...project.filter((spec) => !userPaths.has(spec.path)), ...user];
}

const TOOL_NAME = /^[A-Za-z0-9_*-]+$/;

/** The engine's syntax rules for one rule (`parseRuleText`), as sentences. */
export function fakeRuleError(
  text: string,
  list: "allow" | "ask" | "deny" = "deny",
): string | null {
  const rule = text.trim();
  if (rule === "") return "The rule is empty.";
  const open = rule.indexOf("(");
  if (open === -1) {
    if (rule.includes(")")) return 'Malformed rule: ")" without "(".';
    return TOOL_NAME.test(rule) ? null : `"${rule}" is not a tool name.`;
  }
  if (!rule.endsWith(")")) {
    return 'Malformed rule: rules take the form Tool or Tool(content) and must end at the closing ")".';
  }
  const tool = rule.slice(0, open);
  if (!TOOL_NAME.test(tool)) return `"${tool}" is not a tool name.`;
  const specifier = rule.slice(open + 1, -1);
  if (specifier.trim() === "") return "The part in parentheses is empty.";
  if (tool.startsWith("mcp__")) return "Rules for MCP tools take no part in parentheses.";
  if (list === "allow" && ["Glob", "Grep", "LS"].includes(tool)) {
    return `${tool}(path) allow rules never match; use Read(...) instead.`;
  }
  return null;
}

const LISTS = ["allow", "ask", "deny"] as const;

export function createFakePermissions(options: FakePermissionsOptions): FakePermissions {
  const { homeDir } = options;
  const files = new Map<string, FakeSettingsFile>(
    Object.entries(options.files ?? {}).map(([path, file]) => [path, structuredClone(file)]),
  );
  const writes: PermissionsWriteInput[] = [];
  let nextFailure: string | null = null;

  function fileState(spec: Spec, bypassDisabled: boolean): PermissionSettingsFile {
    const file = files.get(spec.path);
    const problems = [...(file?.problems ?? [])];
    const mode = file?.defaultMode ?? null;
    if (mode === "bypassPermissions" && spec.scope !== "user") {
      problems.push(
        "permissions.defaultMode: A project's own settings cannot start sessions in bypassPermissions mode; ignored.",
      );
    } else if (mode === "bypassPermissions" && bypassDisabled) {
      problems.push(
        "permissions.defaultMode: bypassPermissions mode is disabled by permissions.disableBypassPermissionsMode; ignored.",
      );
    }
    return {
      scope: spec.scope,
      origin: spec.origin,
      path: spec.path,
      exists: file !== undefined,
      writable: spec.origin === "dawg" && file?.parses !== false,
      defaultMode: mode,
      allow: [...(file?.allow ?? [])],
      ask: [...(file?.ask ?? [])],
      deny: [...(file?.deny ?? [])],
      problems,
      sandbox: file?.sandbox === undefined ? null : fileSandbox(file.sandbox),
    };
  }

  async function read(projectDir: string | null): Promise<PermissionSettingsState> {
    const specs = permissionFilePaths(projectDir, homeDir);
    const bypassDisabled = specs.some((spec) => files.get(spec.path)?.bypassDisabled === true);
    const listed = specs.map((spec) => fileState(spec, bypassDisabled));
    const source = listed.find(
      (file) =>
        file.defaultMode !== null &&
        !(file.defaultMode === "bypassPermissions" && (file.scope !== "user" || bypassDisabled)),
    );
    return {
      projectDir,
      files: listed,
      defaultMode: source?.defaultMode ?? "default",
      bypassDisabled,
      sandbox: mergedSandbox(listed),
    };
  }

  async function write(raw: PermissionsWriteInput): Promise<PermissionSettingsState> {
    writes.push(structuredClone(raw));
    const input = validate(PermissionsWriteInputSchema, raw, "permission settings");
    if (input.scope !== "user" && input.projectDir === null) {
      throw new Error("Choose a project to change its settings.");
    }
    if (input.defaultMode === "bypassPermissions" && input.scope !== "user") {
      throw new Error(
        "Only your own settings can start sessions in bypassPermissions mode; a project's settings cannot.",
      );
    }
    const spec = permissionFilePaths(
      input.scope === "user" ? null : input.projectDir,
      homeDir,
    ).find((candidate) => candidate.scope === input.scope && candidate.origin === "dawg");
    const path = spec?.path ?? `${homeDir}/.dawg/settings.json`;
    const current = files.get(path);
    if (current?.parses === false) {
      throw new Error(`${path} is not valid JSON; fix it by hand first.`);
    }
    const next: FakeSettingsFile = structuredClone(current ?? {});
    for (const list of LISTS) {
      const rules = input[list];
      if (rules === undefined) continue;
      const existing = new Set(current?.[list] ?? []);
      for (const rule of rules) {
        if (existing.has(rule)) continue;
        const error = fakeRuleError(rule, list);
        if (error !== null) throw new Error(`${rule}: ${error}`);
      }
      next[list] = [...new Set(rules)];
    }
    if (nextFailure !== null) {
      const message = nextFailure;
      nextFailure = null;
      throw new Error(message);
    }
    if (input.defaultMode !== undefined) next.defaultMode = input.defaultMode;
    if (input.sandbox !== undefined) {
      if (input.sandbox.autoAllowBashIfSandboxed === true && input.scope === "project") {
        throw new Error(
          "Only your own settings can run sandboxed commands without asking; a project's shared settings cannot.",
        );
      }
      const sandbox: Partial<SandboxFileSettings> = { ...next.sandbox };
      for (const key of [
        "enabled",
        "autoAllowBashIfSandboxed",
        "allowUnsandboxedCommands",
      ] as const) {
        const value = input.sandbox[key];
        if (value === null) delete sandbox[key];
        else if (value !== undefined) sandbox[key] = value;
      }
      if (input.sandbox.allowedDomains !== undefined) {
        const bad = input.sandbox.allowedDomains.find((d) => !FAKE_DOMAIN.test(d));
        if (bad !== undefined)
          throw new Error(`"${bad}" is not a host name, a "*." wildcard or an IP address.`);
        sandbox.allowedDomains = [
          ...new Set(input.sandbox.allowedDomains.map((d) => d.toLowerCase())),
        ];
      }
      next.sandbox = sandbox;
    }
    files.set(path, next);
    return read(input.projectDir);
  }

  return {
    api: {
      read: async (projectDir) => read(projectDir),
      write,
      checkRule: async (rule) => fakeRuleError(rule),
    },
    files,
    writes,
    failNextWrite(message) {
      nextFailure = message;
    },
  };
}

/** A rough copy of compat's check of an allowed-domain entry, enough for the page's messages. */
const FAKE_DOMAIN = /^(?:\*\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?::\d{1,5})?$/i;

function fileSandbox(sandbox: Partial<SandboxFileSettings>): SandboxFileSettings {
  return {
    enabled: sandbox.enabled ?? null,
    autoAllowBashIfSandboxed: sandbox.autoAllowBashIfSandboxed ?? null,
    allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands ?? null,
    allowedDomains: [...(sandbox.allowedDomains ?? [])],
    excludedCommands: [...(sandbox.excludedCommands ?? [])],
  };
}

/** The files merged as compat merges them: the first that sets a switch decides; lists join. */
function mergedSandbox(listed: readonly PermissionSettingsFile[]): SandboxSettingsSummary {
  const first = <K extends "enabled" | "autoAllowBashIfSandboxed" | "allowUnsandboxedCommands">(
    key: K,
  ) =>
    listed.find(
      (file) =>
        file.sandbox?.[key] !== null &&
        file.sandbox?.[key] !== undefined &&
        // A project's shared file cannot turn auto-allow on.
        !(key === "autoAllowBashIfSandboxed" && file.scope === "project" && file.sandbox?.[key]),
    );
  const enabledBy = first("enabled");
  const join = (key: "allowedDomains" | "excludedCommands") => [
    ...new Set(listed.flatMap((file) => file.sandbox?.[key] ?? [])),
  ];
  return {
    enabled: enabledBy?.sandbox?.enabled ?? false,
    enabledBy: enabledBy?.path ?? null,
    autoAllowBashIfSandboxed:
      first("autoAllowBashIfSandboxed")?.sandbox?.autoAllowBashIfSandboxed ?? false,
    allowUnsandboxedCommands:
      first("allowUnsandboxedCommands")?.sandbox?.allowUnsandboxedCommands ?? true,
    allowedDomains: join("allowedDomains"),
    deniedDomains: [],
    excludedCommands: join("excludedCommands"),
    available: true,
    unavailableReason: null,
  };
}

/** Files that make the browser preview's Settings → Permissions look lived-in. */
export function browserPermissionFiles(homeDir: string): Record<string, FakeSettingsFile> {
  return {
    [`${homeDir}/.dawg/settings.json`]: {
      allow: ["Bash(git status)", "Bash(git diff *)", "Read(~/code/**)"],
      deny: ["Read(~/.ssh/**)"],
    },
    [`${homeDir}/.claude/settings.json`]: {
      defaultMode: "acceptEdits",
      allow: ["Bash(npm run lint)", "WebFetch(domain:docs.python.org)"],
      ask: ["Bash(git push *)"],
    },
    [`${homeDir}/code/tally/.dawg/settings.local.json`]: {
      allow: ["Bash(uv run pytest *)"],
    },
    [`${homeDir}/code/tally/.dawg/settings.json`]: {
      defaultMode: "default",
      deny: ["Read(./.env)", "Bash(rm -rf *)"],
    },
  };
}
