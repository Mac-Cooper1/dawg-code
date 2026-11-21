import { join, resolve } from "node:path";
import type { PermissionMode } from "@dawg/protocol";
import { resolveUserPath } from "../internal/paths.ts";
import type {
  LoadedSettingsFile,
  PermissionRule,
  Settings,
  SettingsFileRef,
  SettingsOrigin,
  SettingsProblem,
} from "../types.ts";
import type { SettingsFlags } from "./flags.ts";
import { PERMISSION_LISTS, type ReadSettingsResult, readSettingsFile } from "./parse.ts";

export interface LoadSettingsOptions {
  /** The project's root directory (absolute). */
  projectDir: string;
  /** The user's home directory (absolute). Tests point this at a temporary directory. */
  homeDir: string;
  flags?: SettingsFlags;
}

type FileSource = "local" | "project" | "user";

interface FileSpec {
  source: FileSource;
  origin: SettingsOrigin;
  path: string;
}

/** Shown as the `path` of a problem that comes from command-line flags rather than a file. */
export const FLAGS_PROBLEM_PATH = "<command line>";

const FLAGS_REF: SettingsFileRef = { source: "flags", origin: null, path: null };

/**
 * Every settings file, highest precedence first. Within one level our own file outranks the
 * Claude Code file, so a project can override an inherited `.claude` value from `.dawg`.
 */
export function settingsFilePaths(projectDir: string, homeDir: string): FileSpec[] {
  const project = resolve(projectDir);
  const home = resolve(homeDir);
  const user: FileSpec[] = [
    { source: "user", origin: "dawg", path: join(home, ".dawg", "settings.json") },
    { source: "user", origin: "claude", path: join(home, ".claude", "settings.json") },
  ];
  const userPaths = new Set(user.map((f) => f.path));
  const projectLevels: FileSpec[] = [
    { source: "local", origin: "dawg", path: join(project, ".dawg", "settings.local.json") },
    { source: "local", origin: "claude", path: join(project, ".claude", "settings.local.json") },
    { source: "project", origin: "dawg", path: join(project, ".dawg", "settings.json") },
    { source: "project", origin: "claude", path: join(project, ".claude", "settings.json") },
  ];
  // When the project is the home directory its shared files are the user's files. Reading them
  // once, as the user's, keeps the user's own choices (such as bypass) usable there.
  return [...projectLevels.filter((f) => !userPaths.has(f.path)), ...user];
}

/**
 * Loads and merges every settings level. Never throws for a bad file: faults are reported in
 * `problems` and the faulty file or key is skipped.
 */
export async function loadSettings(options: LoadSettingsOptions): Promise<Settings> {
  const projectDir = resolve(options.projectDir);
  const homeDir = resolve(options.homeDir);
  const flags = options.flags ?? {};
  const specs = settingsFilePaths(projectDir, homeDir);
  const parsed: ReadSettingsResult[] = await Promise.all(
    specs.map((spec) => readSettingsFile(spec.path, spec.origin)),
  );

  const problems: SettingsProblem[] = [];
  const files: LoadedSettingsFile[] = [];
  const lists: Record<(typeof PERMISSION_LISTS)[number], PermissionRule[]> = {
    allow: [],
    ask: [],
    deny: [],
  };
  const seenRules = { allow: new Set<string>(), ask: new Set<string>(), deny: new Set<string>() };
  const addRule = (list: keyof typeof lists, rule: string, from: SettingsFileRef) => {
    if (seenRules[list].has(rule)) return;
    seenRules[list].add(rule);
    lists[list].push({ rule, from });
  };
  const directories: string[] = [];
  const seenDirs = new Set<string>();
  const addDir = (dir: string) => {
    if (seenDirs.has(dir)) return;
    seenDirs.add(dir);
    directories.push(dir);
  };
  // Candidate modes, highest precedence first, so a rejected one falls through to the next.
  const modes: { mode: PermissionMode; path: string; key: string }[] = [];
  let bypassDisabled = false;
  const envLayers: Readonly<Record<string, string>>[] = [];

  // Flags.
  for (const rule of flags.allowedTools ?? [])
    if (rule.trim() !== "") addRule("allow", rule, FLAGS_REF);
  for (const rule of flags.disallowedTools ?? [])
    if (rule.trim() !== "") addRule("deny", rule, FLAGS_REF);
  for (const dir of flags.addDirs ?? []) {
    if (dir.trim() !== "") addDir(resolveUserPath(dir, projectDir, homeDir));
  }
  if (flags.permissionMode !== undefined) {
    modes.push({ mode: flags.permissionMode, path: FLAGS_PROBLEM_PATH, key: "--permission-mode" });
  }
  if (flags.env) envLayers.push(flags.env);

  // Files, highest precedence first.
  specs.forEach((spec, i) => {
    const result = parsed[i];
    if (!result) return;
    const ref: SettingsFileRef = { source: spec.source, origin: spec.origin, path: spec.path };
    files.push({ ...ref, path: spec.path, exists: result.exists, ignoredKeys: result.ignoredKeys });
    problems.push(...result.problems);

    for (const list of PERMISSION_LISTS) for (const rule of result[list]) addRule(list, rule, ref);

    // Relative entries in project files are relative to the project; in the user's files, to
    // the home directory, since those files apply to every project.
    const base = spec.source === "user" ? homeDir : projectDir;
    for (const dir of result.additionalDirectories) addDir(resolveUserPath(dir, base, homeDir));

    if (result.defaultMode !== null) {
      if (result.defaultMode === "bypassPermissions" && spec.source !== "user") {
        problems.push({
          path: spec.path,
          key: "permissions.defaultMode",
          message:
            "A project's own settings cannot start sessions in bypassPermissions mode; ignored. " +
            "Set it in your user settings or pass it on the command line.",
        });
      } else {
        modes.push({ mode: result.defaultMode, path: spec.path, key: "permissions.defaultMode" });
      }
    }
    if (result.bypassDisabled) bypassDisabled = true;
    envLayers.push(result.env);
  });

  let defaultMode: PermissionMode | null = null;
  for (const candidate of modes) {
    if (candidate.mode === "bypassPermissions" && bypassDisabled) {
      problems.push({
        path: candidate.path,
        key: candidate.key,
        message:
          "bypassPermissions mode is disabled by permissions.disableBypassPermissionsMode; ignored.",
      });
      continue;
    }
    defaultMode = candidate.mode;
    break;
  }

  const merged = new Map<string, string>();
  for (let i = envLayers.length - 1; i >= 0; i--) {
    for (const [name, value] of Object.entries(envLayers[i] ?? {})) merged.set(name, value);
  }
  const env: Record<string, string> = Object.fromEntries(merged);

  return {
    permissions: {
      allow: lists.allow,
      ask: lists.ask,
      deny: lists.deny,
      defaultMode,
      additionalDirectories: directories,
      bypassDisabled,
    },
    env,
    files,
    problems,
  };
}
