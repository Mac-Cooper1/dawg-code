/**
 * Changes the `sandbox` key of one of dawg's settings files, for Settings → Permissions: the
 * switch, auto-allow, the retry outside the sandbox, allowed domains and excluded commands.
 * Every other key of the file, and of its `sandbox` object, is kept in its place.
 */
import {
  editDawgSettingsFile,
  SettingsWriteError,
  type UpdatePermissionSettingsResult,
} from "../settings/write.ts";
import { domainEntryProblem } from "./settings.ts";

export interface UpdateSandboxSettingsOptions {
  /** One of dawg's settings files, absolute (see `dawgSettingsPath`). */
  file: string;
  /** Each boolean given sets the key; null removes it; left out keeps it. */
  enabled?: boolean | null;
  autoAllowBashIfSandboxed?: boolean | null;
  allowUnsandboxedCommands?: boolean | null;
  /** Each list given replaces the file's list (an empty one removes it); left out keeps it. */
  allowedDomains?: readonly string[];
  excludedCommands?: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `object` with `updates` applied, keys in their places; `undefined` removes a key. */
function withUpdates(
  object: Record<string, unknown>,
  updates: Map<string, unknown>,
): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  const pending = new Map(updates);
  for (const [key, value] of Object.entries(object)) {
    entries.push([key, pending.has(key) ? pending.get(key) : value]);
    pending.delete(key);
  }
  for (const [key, value] of pending) entries.push([key, value]);
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function cleanList(list: readonly string[], what: string): string[] {
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new SettingsWriteError(`${what} must be non-empty text.`);
    }
    const trimmed = entry.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Writes the given sandbox settings into one of dawg's settings files. Refuses, with a
 * SettingsWriteError sentence, a domain that is not a host name, wildcard or address, and
 * anything `editDawgSettingsFile` refuses.
 */
export async function updateSandboxSettings(
  options: UpdateSandboxSettingsOptions,
): Promise<UpdatePermissionSettingsResult> {
  const top = new Map<string, unknown>();
  for (const key of ["enabled", "autoAllowBashIfSandboxed", "allowUnsandboxedCommands"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "boolean") {
      throw new SettingsWriteError(`"${key}" must be true or false.`);
    }
    top.set(key, value ?? undefined);
  }
  if (options.excludedCommands !== undefined) {
    const list = cleanList(options.excludedCommands, "Excluded commands");
    top.set("excludedCommands", list.length === 0 ? undefined : list);
  }
  let domains: string[] | undefined;
  if (options.allowedDomains !== undefined) {
    domains = cleanList(
      options.allowedDomains.map((d) => (typeof d === "string" ? d.toLowerCase() : d)),
      "Allowed domains",
    );
    for (const domain of domains) {
      const problem = domainEntryProblem(domain);
      if (problem !== null) throw new SettingsWriteError(problem);
    }
  }
  return editDawgSettingsFile(options.file, (data) => {
    const current = data.sandbox;
    if (current !== undefined && !isPlainObject(current)) {
      throw new SettingsWriteError(
        `${options.file} has a "sandbox" value that is not an object; fix it by hand first.`,
      );
    }
    const sandbox = { ...(current ?? {}) };
    if (domains !== undefined) {
      const network = sandbox.network;
      if (network !== undefined && !isPlainObject(network)) {
        throw new SettingsWriteError(
          `${options.file} has a "sandbox.network" value that is not an object; fix it by hand first.`,
        );
      }
      const nextNetwork = withUpdates(
        network ?? {},
        new Map([["allowedDomains", domains.length === 0 ? undefined : domains]]),
      );
      top.set("network", Object.keys(nextNetwork).length === 0 ? undefined : nextNetwork);
    }
    const next = withUpdates(sandbox, top);
    if (Object.keys(next).length === 0) {
      if (current !== undefined) delete data.sandbox;
      return;
    }
    data.sandbox = next;
  });
}
