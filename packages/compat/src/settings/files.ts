/**
 * Every settings file on its own, for Settings → Permissions: what each one says, whether dawg
 * may change it, and what is wrong with it. `loadSettings` merges the same files for sessions;
 * both come from the same parsing, and the merged mode here is the one a new session gets.
 */
import { resolve } from "node:path";
import type { PermissionMode } from "@dawg/protocol";
import { defaultSandboxSettings, type SandboxSettings } from "../sandbox/settings.ts";
import type { SettingsProblem } from "../types.ts";
import { mergeSettings, type SettingsFileSpec, settingsFilePaths } from "./load.ts";
import { type ParsedSettings, type ReadSettingsResult, readSettingsFile } from "./parse.ts";
import { settingsWriteProblem } from "./write.ts";

export interface SettingsFileState extends SettingsFileSpec, Omit<ParsedSettings, "problems"> {
  exists: boolean;
  /** `updatePermissionSettings` would write it: one of dawg's files that it can parse. */
  writable: boolean;
  /** Why it is not writable, as a sentence; null when it is. */
  readOnlyReason: string | null;
  /**
   * What is wrong with the file or one of its keys, including values it holds that sessions
   * ignore (such as bypassPermissions as a project's default mode).
   */
  problems: SettingsProblem[];
}

export interface SettingsFilesState {
  /** Absolute, or null when only the user's own files are listed. */
  projectDir: string | null;
  /** Every file that applies, highest precedence first, whether or not it exists. */
  files: SettingsFileState[];
  /** The mode a new session starts in with every file merged; null when none sets one. */
  defaultMode: PermissionMode | null;
  /** A file turns the bypass mode off. */
  bypassDisabled: boolean;
  /** Added (Phase 4, sandbox): the sandbox settings a new session gets, every file merged. */
  sandbox: SandboxSettings;
}

export interface ReadSettingsFilesOptions {
  /** The project's root directory (absolute), or null for only the user's own files. */
  projectDir: string | null;
  /** Where the personal files are read from (see `LoadSettingsOptions.localDir`); default the project. */
  localDir?: string | null;
  /** The user's home directory (absolute). */
  homeDir: string;
}

/** Claude Code's files are read for compatibility and never written. */
const CLAUDE_READ_ONLY = "dawg reads Claude Code's settings files but never changes them.";

/** Reads every settings file that applies to a project, one by one. Never throws for a bad file. */
export async function readSettingsFiles(
  options: ReadSettingsFilesOptions,
): Promise<SettingsFilesState> {
  const projectDir = options.projectDir === null ? null : resolve(options.projectDir);
  const homeDir = resolve(options.homeDir);
  const localDir =
    options.localDir === undefined || options.localDir === null
      ? projectDir
      : resolve(options.localDir);
  const specs = settingsFilePaths(projectDir, homeDir, localDir);
  const [parsed, writeProblems] = await Promise.all([
    Promise.all(specs.map((spec) => readSettingsFile(spec.path, spec.origin))),
    Promise.all(
      specs.map((spec) =>
        spec.origin === "dawg"
          ? settingsWriteProblem(spec.path)
          : Promise.resolve(CLAUDE_READ_ONLY),
      ),
    ),
  ]);
  // Without a project only the user's files are listed, so nothing resolves against it.
  const merged = mergeSettings({
    projectDir: projectDir ?? homeDir,
    localDir: localDir ?? homeDir,
    homeDir,
    flags: {},
    specs,
    parsed,
  });

  const files = specs.map((spec, i): SettingsFileState => {
    const read = parsed[i] ?? emptyRead();
    const readOnlyReason = writeProblems[i] ?? null;
    return {
      ...spec,
      exists: read.exists,
      writable: readOnlyReason === null,
      readOnlyReason,
      defaultMode: read.defaultMode,
      allow: read.allow,
      ask: read.ask,
      deny: read.deny,
      additionalDirectories: read.additionalDirectories,
      bypassDisabled: read.bypassDisabled,
      env: read.env,
      sandbox: read.sandbox,
      ignoredKeys: read.ignoredKeys,
      // The merged list holds each file's own problems and those found while merging.
      problems: merged.problems.filter((problem) => problem.path === spec.path),
    };
  });
  return {
    projectDir,
    files,
    defaultMode: merged.permissions.defaultMode,
    bypassDisabled: merged.permissions.bypassDisabled,
    sandbox: merged.sandbox ?? defaultSandboxSettings(),
  };
}

function emptyRead(): ReadSettingsResult {
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
    exists: false,
  };
}
