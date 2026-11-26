/**
 * Open sessions pick up changes to the settings files from their next turn, so an edit made in
 * Settings → Permissions (or by hand) applies without reopening the session.
 *
 * At the start of each turn the session stats its settings files; only when one appeared,
 * disappeared or changed (modification time, size or inode) does it load them again. What is
 * live and what is not:
 *
 * - Permission rules (allow, ask, deny): live. Rules "always allow" added this session follow
 *   the file they were saved to, so removing one in Settings stops it; a rule that could not be
 *   saved stays for the rest of the session, as it was promised.
 * - `disableBypassPermissionsMode`: live. A session in bypassPermissions mode when it gets
 *   turned off drops to "default" and says so.
 * - `env`: live, for the commands and tools of the next turn.
 * - `additionalDirectories`: not live. They became part of the session's state, and of what the
 *   model was told, when it was created; `/add-dir` adds one to an open session.
 * - `defaultMode`: not live. It only chooses the mode a new session starts in.
 *
 * A file that was readable and now is not (half-saved, not JSON) would silently drop its rules,
 * deny rules included, so a reload that finds one keeps the settings the session had, says so
 * once, and tries again next turn.
 */
import { stat } from "node:fs/promises";
import {
  type LoadSettingsOptions,
  loadSettings,
  type Settings,
  type SettingsProblem,
  settingsFilePaths,
} from "@dawg/compat";

/**
 * What the files look like on disk, as one string that changes whenever any of them does: each
 * file's modification time, size and inode (an atomic save replaces the inode), or "-" when it
 * is missing.
 */
export async function settingsStamp(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path, { bigint: true });
        return `${info.mtimeNs}:${info.size}:${info.ino}`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === "ENOENT" || code === "ENOTDIR" ? "-" : `!${code ?? "error"}`;
      }
    }),
  );
  return parts.join("|");
}

/** Exactly the files `loadSettings(options)` reads, personal ones from `localDir` included. */
function sessionSettingsPaths(options: LoadSettingsOptions): string[] {
  return settingsFilePaths(options.projectDir, options.homeDir, options.localDir).map(
    (file) => file.path,
  );
}

/**
 * Loads the settings for a session together with the stamp of its files, taken first: a change
 * made while loading then shows as a difference at the next check, never as none.
 */
export async function loadSessionSettings(
  options: LoadSettingsOptions,
): Promise<{ settings: Settings; stamp: string }> {
  const paths = sessionSettingsPaths(options);
  const stamp = await settingsStamp(paths);
  const settings = await loadSettings(options);
  return { settings, stamp };
}

/** Problems that made a whole file unreadable (not one bad key), by path. */
function unreadable(settings: Settings): Map<string, SettingsProblem> {
  const out = new Map<string, SettingsProblem>();
  for (const problem of settings.problems) {
    if (problem.key === null && !out.has(problem.path)) out.set(problem.path, problem);
  }
  return out;
}

export type SettingsCheck =
  | { kind: "unchanged" }
  | { kind: "changed"; settings: Settings }
  /** A file became unreadable: keep the current settings. Reported once per state of the files. */
  | { kind: "unreadable"; problems: SettingsProblem[] };

/** Watches one session's settings files, checked at the start of each turn. */
export class SettingsReloader {
  readonly #options: LoadSettingsOptions;
  readonly #paths: readonly string[];
  /** The stamp of the settings in force; null to load on the first check. */
  #stamp: string | null;
  /** The stamp of files found unreadable and already reported. */
  #reported: string | null = null;

  constructor(options: LoadSettingsOptions, stamp: string | null) {
    this.#options = options;
    this.#paths = sessionSettingsPaths(options);
    this.#stamp = stamp;
  }

  /** Never throws: a failure to look counts as no change. */
  async check(current: Settings): Promise<SettingsCheck> {
    try {
      const stamp = await settingsStamp(this.#paths);
      if (stamp === this.#stamp) return { kind: "unchanged" };
      const settings = await loadSettings(this.#options);
      const before = unreadable(current);
      const lost = [...unreadable(settings)].filter(([path]) => !before.has(path));
      if (lost.length > 0) {
        if (this.#reported === stamp) return { kind: "unchanged" };
        this.#reported = stamp;
        return { kind: "unreadable", problems: lost.map(([, problem]) => problem) };
      }
      this.#stamp = stamp;
      this.#reported = null;
      return { kind: "changed", settings };
    } catch {
      return { kind: "unchanged" };
    }
  }
}
