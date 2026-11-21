import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { realpathLoose } from "../internal/paths.ts";
import type { PermissionListName } from "./parse.ts";

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

  await mkdir(dirname(real), { recursive: true });
  const tmp = `${real}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, real);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return { path, added };
}
