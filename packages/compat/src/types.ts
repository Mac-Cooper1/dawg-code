/**
 * Shared types for settings. See docs/specs/phase-2-engine-core.md, "Settings" and "Permissions".
 *
 * This file is a contract between the settings loader in this package and the permission engine
 * in @dawg/engine. Change it deliberately.
 */
import type { PermissionMode } from "@dawg/protocol";

/**
 * Where a setting came from, highest precedence first:
 * command-line flags, rules added during the session, the project's personal file, the project's
 * shared file, the user's file.
 */
export type SettingsSource = "flags" | "session" | "local" | "project" | "user";

/** Which config family a file belongs to. `.claude` files are read, never written. */
export type SettingsOrigin = "dawg" | "claude";

export interface SettingsFileRef {
  source: SettingsSource;
  /** Null for sources that are not files (flags, session). */
  origin: SettingsOrigin | null;
  /** Absolute path, or null for sources that are not files. */
  path: string | null;
}

/** One permission rule exactly as written, for example `Bash(npm run test *)`. */
export interface PermissionRule {
  rule: string;
  from: SettingsFileRef;
}

export interface PermissionSettings {
  /** Combined across every level. Order: highest-precedence source first. */
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
  /** The mode a session starts in, when a level sets one. Highest precedence wins. */
  defaultMode: PermissionMode | null;
  /** Extra working directories, absolute, combined across levels, no duplicates. */
  additionalDirectories: string[];
  /** True when any level turns the bypass mode off. */
  bypassDisabled: boolean;
}

/** A problem found in one settings file. The loader never throws for a bad file. */
export interface SettingsProblem {
  path: string;
  /** Dotted path of the offending key, when the problem is about one key. */
  key: string | null;
  message: string;
}

export interface LoadedSettingsFile extends SettingsFileRef {
  path: string;
  exists: boolean;
  /** Keys present in the file that this version does not use. */
  ignoredKeys: string[];
}

/** The merged result of every settings level. */
export interface Settings {
  permissions: PermissionSettings;
  /** Environment variables for the session and its child processes. Higher levels override. */
  env: Record<string, string>;
  /** Every file that was looked at, highest precedence first, whether or not it exists. */
  files: LoadedSettingsFile[];
  problems: SettingsProblem[];
}
