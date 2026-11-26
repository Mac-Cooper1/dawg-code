import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type PermissionMode, PermissionModeSchema } from "@dawg/protocol";
import { realpathLoose } from "../internal/paths.ts";
import { PERMISSION_LISTS, type PermissionListName } from "./parse.ts";

export interface AddPermissionRulesOptions {
  /** The project's root directory (absolute). */
  projectDir: string;
  list: PermissionListName;
  rules: readonly string[];
}

export interface AddPermissionRulesResult {
  /** The file written (or that would have been, when nothing was new). */
  path: string;
  /** Rules that were not already in the list, in the order given. */
  added: string[];
}

/** Thrown when a write would land in a place we must not touch or a file we cannot safely edit. */
export class SettingsWriteError extends Error {
  override name = "SettingsWriteError";
}

/** The personal project settings file that "allow always" writes to. */
export function localSettingsPath(projectDir: string): string {
  return join(resolve(projectDir), ".dawg", "settings.local.json");
}

/** Which of dawg's own settings files: the user's, the project's shared one, its personal one. */
export type DawgSettingsScope = "user" | "project" | "local";

/**
 * dawg's own settings file for a scope: `~/.dawg/settings.json`, `<project>/.dawg/settings.json`
 * or `<project>/.dawg/settings.local.json`. The project scopes need a project.
 */
export function dawgSettingsPath(
  scope: DawgSettingsScope,
  dirs: { projectDir: string | null; homeDir: string },
): string {
  if (scope === "user") return join(resolve(dirs.homeDir), ".dawg", "settings.json");
  if (dirs.projectDir === null) {
    throw new SettingsWriteError("Choose a project to change its settings.");
  }
  if (scope === "local") return localSettingsPath(dirs.projectDir);
  return join(resolve(dirs.projectDir), ".dawg", "settings.json");
}

function touchesClaudeDir(p: string): boolean {
  return p.split(sep).includes(".claude");
}

// Read-modify-write is not atomic across callers, so writes to one file are queued in-process.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

/**
 * Appends permission rules to `<project>/.dawg/settings.local.json`, creating it when needed.
 * Every other key in the file is kept, rules already present are skipped, and the file is
 * replaced atomically. Refuses to write anywhere under a `.claude` directory, including through
 * a symbolic link, and refuses to overwrite a file it cannot parse.
 */
export async function addPermissionRules(
  options: AddPermissionRulesOptions,
): Promise<AddPermissionRulesResult> {
  const path = localSettingsPath(options.projectDir);
  const real = await realpathLoose(path);
  if (touchesClaudeDir(path) || touchesClaudeDir(real)) {
    throw new SettingsWriteError(`Refusing to write under a .claude directory: ${real}`);
  }
  for (const rule of options.rules) {
    if (typeof rule !== "string" || rule.trim() === "") {
      throw new SettingsWriteError("Permission rules must be non-empty strings.");
    }
  }
  return enqueue(real, () => appendRules(path, real, options.list, options.rules));
}

async function appendRules(
  path: string,
  real: string,
  list: PermissionListName,
  rules: readonly string[],
): Promise<AddPermissionRulesResult> {
  let data: Record<string, unknown> = {};
  try {
    const text = await readFile(real, "utf8");
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (body.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new SettingsWriteError(`${path} is not valid JSON; fix it before adding rules.`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SettingsWriteError(`${path} does not hold a JSON object.`);
      }
      data = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const permissions = data.permissions ?? {};
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    throw new SettingsWriteError(`${path}: "permissions" is not an object.`);
  }
  const perms = permissions as Record<string, unknown>;
  const current = perms[list] ?? [];
  if (!Array.isArray(current)) {
    throw new SettingsWriteError(`${path}: "permissions.${list}" is not a list.`);
  }

  const present = new Set(current.filter((r): r is string => typeof r === "string"));
  const added: string[] = [];
  for (const rule of rules) {
    if (!present.has(rule)) {
      present.add(rule);
      added.push(rule);
    }
  }
  if (added.length === 0) return { path, added };

  perms[list] = [...current, ...added];
  data.permissions = perms;

  await writeAtomic(real, data, 0o600);
  return { path, added };
}

/**
 * Replaces `real` with `data` as 2-space JSON: written to a temporary file beside it, then
 * renamed over it, so a reader never sees half a file. Creates the folder when needed.
 */
async function writeAtomic(real: string, data: unknown, mode: number): Promise<void> {
  await mkdir(dirname(real), { recursive: true });
  const tmp = `${real}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
    await rename(tmp, real);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Editing a whole file's permissions (Settings → Permissions)
// ---------------------------------------------------------------------------------------------

export interface UpdatePermissionSettingsOptions {
  /**
   * One of dawg's settings files, absolute: `<dir>/.dawg/settings.json` or
   * `<dir>/.dawg/settings.local.json` (see `dawgSettingsPath`).
   */
  file: string;
  /** Sets `permissions.defaultMode`; null removes it; left out keeps it. */
  defaultMode?: PermissionMode | null;
  /** Each list given replaces the file's list (an empty one removes it); a list left out is kept. */
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}

export interface UpdatePermissionSettingsResult {
  /** The file as given. */
  path: string;
  /** False when the file already said exactly this, so nothing was written. */
  changed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What stops a settings file's parsed content from being edited safely, as words that follow its
 * path ("does not hold a JSON object"), or null.
 */
function editProblemOf(data: unknown): string | null {
  if (!isPlainObject(data)) return "does not hold a JSON object";
  const permissions = data.permissions;
  if (permissions === undefined) return null;
  if (!isPlainObject(permissions)) return 'has a "permissions" value that is not an object';
  for (const list of PERMISSION_LISTS) {
    const value = permissions[list];
    if (value !== undefined && !Array.isArray(value)) {
      return `has a "permissions.${list}" value that is not a list`;
    }
  }
  return null;
}

/** A settings file's text as an object to edit, or a SettingsWriteError saying why it cannot be. */
function parseForEdit(text: string, path: string): Record<string, unknown> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SettingsWriteError(`${path} is not valid JSON; fix it by hand first.`);
  }
  const problem = editProblemOf(parsed);
  if (problem !== null) throw new SettingsWriteError(`${path} ${problem}; fix it by hand first.`);
  return parsed as Record<string, unknown>;
}

/** Refuses a path that is not one of dawg's settings files. */
function assertDawgSettingsFile(file: string): string {
  if (typeof file !== "string" || !isAbsolute(file)) {
    throw new SettingsWriteError("A settings file must be given by its absolute path.");
  }
  const path = resolve(file);
  const name = basename(path);
  if (
    basename(dirname(path)) !== ".dawg" ||
    (name !== "settings.json" && name !== "settings.local.json")
  ) {
    throw new SettingsWriteError(`${path} is not one of dawg's settings files.`);
  }
  return path;
}

/** The real path a write to `path` lands on, refusing anywhere under a `.claude` directory. */
async function writeTarget(path: string): Promise<string> {
  const real = await realpathLoose(path);
  if (touchesClaudeDir(path) || touchesClaudeDir(real)) {
    throw new SettingsWriteError(`Refusing to write under a .claude directory: ${real}`);
  }
  return real;
}

async function readIfPresent(real: string, path: string): Promise<string | null> {
  try {
    return await readFile(real, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new SettingsWriteError(`Could not read ${path}: ${detail}`);
  }
}

/**
 * Why `updatePermissionSettings` would refuse to write `file`, as a sentence, or null when it
 * would write it. A missing file can be written: it is created.
 */
export async function settingsWriteProblem(file: string): Promise<string | null> {
  try {
    const path = assertDawgSettingsFile(file);
    const real = await writeTarget(path);
    const text = await readIfPresent(real, path);
    if (text !== null) parseForEdit(text, path);
    return null;
  } catch (error) {
    if (error instanceof SettingsWriteError) return error.message;
    throw error;
  }
}

/**
 * Changes the permissions of one of dawg's settings files: sets or removes
 * `permissions.defaultMode` and replaces the lists given, in one atomic write through the same
 * per-file queue as `addPermissionRules`. Every other key is kept, in its place; the file and
 * its `.dawg` folder are created when needed (but not just to remove something). Refuses, with
 * a SettingsWriteError sentence, anything under a `.claude` directory (symbolic links
 * included), a file it cannot parse, and empty rules. Rules are kept as given, duplicates
 * dropped; checking their syntax is the caller's job.
 */
export async function updatePermissionSettings(
  options: UpdatePermissionSettingsOptions,
): Promise<UpdatePermissionSettingsResult> {
  const path = assertDawgSettingsFile(options.file);
  const mode = options.defaultMode;
  if (mode !== undefined && mode !== null && !PermissionModeSchema.safeParse(mode).success) {
    throw new SettingsWriteError(`"${String(mode)}" is not a permission mode.`);
  }
  const lists: [PermissionListName, string[]][] = [];
  for (const list of PERMISSION_LISTS) {
    const given = options[list];
    if (given === undefined) continue;
    if (!Array.isArray(given)) throw new SettingsWriteError(`"${list}" must be a list of rules.`);
    const unique: string[] = [];
    for (const rule of given) {
      if (typeof rule !== "string" || rule.trim() === "") {
        throw new SettingsWriteError("Permission rules must be non-empty strings.");
      }
      if (!unique.includes(rule)) unique.push(rule);
    }
    lists.push([list, unique]);
  }
  const real = await writeTarget(path);
  return enqueue(real, () => applyUpdate(path, real, mode, lists));
}

async function applyUpdate(
  path: string,
  real: string,
  mode: PermissionMode | null | undefined,
  lists: readonly [PermissionListName, string[]][],
): Promise<UpdatePermissionSettingsResult> {
  const text = await readIfPresent(real, path);
  const data = text === null ? {} : parseForEdit(text, path);
  const before = JSON.stringify(data);

  // Built as entries so that every key keeps its place and a key such as `__proto__` stays an
  // ordinary key. `undefined` removes a key.
  const updates = new Map<string, unknown>();
  if (mode !== undefined) updates.set("defaultMode", mode ?? undefined);
  for (const [list, rules] of lists) updates.set(list, rules.length === 0 ? undefined : rules);
  const current = (data.permissions ?? {}) as Record<string, unknown>;
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(current)) {
    entries.push([key, updates.has(key) ? updates.get(key) : value]);
    updates.delete(key);
  }
  for (const [key, value] of updates) entries.push([key, value]);
  const permissions = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
  if (data.permissions !== undefined || Object.keys(permissions).length > 0) {
    data.permissions = permissions;
  }

  // Nothing to do, including removing something from a file that does not exist.
  if (JSON.stringify(data) === before) return { path, changed: false };
  // An existing file keeps its permission bits; a new one is readable by its owner only.
  const fileMode = await stat(real).then(
    (info) => info.mode & 0o777,
    () => 0o600,
  );
  await writeAtomic(real, data, fileMode);
  return { path, changed: true };
}
