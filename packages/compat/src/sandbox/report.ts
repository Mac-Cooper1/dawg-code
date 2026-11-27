/**
 * The report's sandbox items: one for each settings file with a `sandbox` key, saying what dawg
 * applies from it and what it does not, and why. The settings file's own item leaves these keys
 * to this one.
 */
import { resolve } from "node:path";
import type { CompatItem } from "@dawg/protocol";
import { sentence } from "../report/files.ts";
import type { ReportProvider } from "../report/types.ts";
import { settingsFilePaths } from "../settings/load.ts";
import { readSettingsFile } from "../settings/parse.ts";
import { domainEntryProblem, type SandboxFileSettings, sandboxScopeNotes } from "./settings.ts";

/** What a file's sandbox key does, in a few words, for the item's first note. */
function summary(s: SandboxFileSettings): string | null {
  if (s.enabled === true) return "Turns the sandbox on for shell commands.";
  if (s.enabled === false) return "Turns the sandbox off.";
  return null;
}

/** How a host a project's settings open to sandboxed commands is named, here and for consent. */
export function sandboxHostItemName(host: string): string {
  return `Network access to ${host} (sandbox)`;
}

/** The note on such a host: what it does and that it waits for the person. */
export const SANDBOX_HOST_NOTE =
  "Lets the project's sandboxed shell commands reach this host; until you approve it, they cannot.";

/**
 * The hosts one of a project's settings files opens to sandboxed commands, as compat reads them:
 * `sandbox.network.allowedDomains` and `WebFetch(domain:…)` allow rules (a bare `*` opens
 * nothing). The engine checks them against the sandbox runtime's own rules too.
 */
export function projectSandboxHosts(read: {
  sandbox: SandboxFileSettings | null;
  allow: readonly string[];
}): string[] {
  const hosts = [...(read.sandbox?.network.allowedDomains ?? [])];
  for (const rule of read.allow) {
    const m = /^WebFetch\(domain:(.+)\)$/i.exec(rule.trim());
    const host = m?.[1]?.trim().toLowerCase().replace(/\.$/, "");
    if (host === undefined || host === "" || host === "*" || domainEntryProblem(host) !== null) {
      continue;
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

export const sandboxReportProvider: ReportProvider = async (context) => {
  const homeDir = resolve(context.homeDir);
  const projectDir = context.projectDir === null ? null : resolve(context.projectDir);
  const specs = settingsFilePaths(projectDir, homeDir);
  const items: CompatItem[] = [];
  for (const spec of specs) {
    const read = await readSettingsFile(spec.path, spec.origin);
    if (!read.exists) continue;
    // A project's hosts, one item each: the engine's trust store marks those waiting for consent.
    const hosts = spec.source === "user" ? [] : projectSandboxHosts(read);
    const hostItems: CompatItem[] = hosts.map((host) => ({
      kind: "other",
      name: sandboxHostItemName(host),
      source: { path: spec.path, origin: spec.origin, scope: spec.source },
      status: "loaded",
      notes: [SANDBOX_HOST_NOTE],
    }));
    if (read.sandbox === null) {
      items.push(...hostItems);
      continue;
    }
    const notes: string[] = [];
    const lead = summary(read.sandbox);
    if (lead !== null) notes.push(lead);
    let partly = false;
    for (const ignored of [
      ...read.sandbox.ignored,
      ...sandboxScopeNotes(
        { ...spec, settings: read.sandbox },
        { projectDir: projectDir ?? homeDir, homeDir },
      ),
    ]) {
      notes.push(`${ignored.key}: ${ignored.why}`);
      partly = true;
    }
    for (const problem of read.problems) {
      if (problem.key === null || !problem.key.startsWith("sandbox")) continue;
      notes.push(sentence(`${problem.key}: ${problem.message}`));
      partly = true;
    }
    items.push({
      kind: "other",
      name: "sandbox",
      source: { path: spec.path, origin: spec.origin, scope: spec.source },
      status: partly ? "partly-supported" : "loaded",
      notes,
    });
    items.push(...hostItems);
  }
  return items;
};
