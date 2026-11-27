/**
 * Permission rules the sandbox takes in, as documented ("Permission rules and the sandbox",
 * code.claude.com/docs/en/sandboxing): `WebFetch(domain:…)` allow rules add to the hosts
 * sandboxed commands may reach and its deny rules to those they may not; `Read(…)` deny rules
 * keep sandboxed commands from reading those paths, and `Read(…)` and `Edit(…)` deny rules from
 * writing them. So a deny rule holds even for a command whose effect no analysis can see.
 *
 * Paths follow the rules' own anchors (`//` root, `~/` home, `/` the settings file's place, else
 * the working directory) and become sandbox patterns: a bare name matches at any depth below the
 * working directory, and a directory covers what is inside it. `Edit(…)` allow rules are not
 * turned into writable places: the sandbox's writable places are its own settings.
 */
import path from "node:path";
import type { PermissionRule } from "@dawg/compat";
import { parseRuleText } from "../permissions/rules.ts";

export interface RulesForSandbox {
  allowedDomains: string[];
  /** Where each allowed host's rule came from, so a project's can wait for approval. */
  allowedDomainsFrom: { domain: string; from: PermissionRule["from"] }[];
  deniedDomains: string[];
  denyRead: string[];
  denyWrite: string[];
}

const GLOB = /[*?[\]]/;

/** Sandbox patterns for one `Read`/`Edit` rule's specifier, or none when it cannot be mapped. */
export function sandboxPathsForRule(
  specifier: string,
  from: PermissionRule["from"],
  dirs: { cwd: string; homeDir: string },
): string[] {
  // Carve-outs (`!x`) refine other rules; the sandbox has no such thing, so they are skipped.
  if (specifier.startsWith("!") || specifier.trim() === "") return [];
  let anchor: string;
  let pattern: string;
  let anyDepth = false;
  if (specifier.startsWith("//")) {
    anchor = "/";
    pattern = specifier.slice(2);
  } else if (specifier === "~" || specifier.startsWith("~/")) {
    anchor = dirs.homeDir;
    pattern = specifier.slice(2);
  } else if (specifier.startsWith("/")) {
    anchor =
      from.source === "user"
        ? from.path !== null
          ? path.dirname(from.path)
          : path.join(dirs.homeDir, ".dawg")
        : dirs.cwd;
    pattern = specifier.slice(1);
  } else {
    anchor = dirs.cwd;
    pattern = specifier.replace(/^\.\//, "");
    // A name of one segment matches at any depth, as in .gitignore (deny rules read it so).
    anyDepth = !pattern.replace(/\/\*\*$/, "").includes("/");
  }
  pattern = pattern.replace(/\/+$/, "");
  if (pattern === "" || pattern === "**") return [anchor];
  const out = [path.join(anchor, pattern)];
  if (anyDepth) out.push(path.join(anchor, "**", pattern));
  // A directory counts as matched when everything inside it would be.
  if (!pattern.endsWith("/**")) {
    for (const p of [...out]) if (GLOB.test(p)) out.push(`${p}/**`);
  }
  return out;
}

/** WebFetch's `domain:` pattern as a sandbox network entry, or null when it has no such form. */
export function sandboxDomainForRule(specifier: string): string | null {
  const m = /^domain:(.+)$/i.exec(specifier.trim());
  if (!m?.[1]) return null;
  const domain = m[1].trim().toLowerCase().replace(/\.$/, "");
  return domain === "" ? null : domain;
}

/** What the session's permission rules add to its sandbox. */
export function rulesForSandbox(
  rules: { allow: readonly PermissionRule[]; deny: readonly PermissionRule[] },
  dirs: { cwd: string; homeDir: string },
): RulesForSandbox {
  const out: RulesForSandbox = {
    allowedDomains: [],
    allowedDomainsFrom: [],
    deniedDomains: [],
    denyRead: [],
    denyWrite: [],
  };
  const add = (list: string[], items: readonly string[]) => {
    for (const item of items) if (!list.includes(item)) list.push(item);
  };
  for (const [list, entries] of [
    ["allow", rules.allow],
    ["deny", rules.deny],
  ] as const) {
    for (const entry of entries) {
      const parsed = parseRuleText(entry.rule);
      if (!parsed.ok || parsed.rule.specifier === null) continue;
      const { toolName, specifier } = parsed.rule;
      if (toolName === "WebFetch") {
        const domain = sandboxDomainForRule(specifier);
        if (domain === null) continue;
        // A bare "*" allows every host for WebFetch; the sandbox refuses so wide an entry.
        if (list === "allow" && domain !== "*") {
          add(out.allowedDomains, [domain]);
          out.allowedDomainsFrom.push({ domain, from: entry.from });
        }
        if (list === "deny") add(out.deniedDomains, [domain]);
        continue;
      }
      if (list !== "deny") continue;
      if (toolName === "Read") {
        const paths = sandboxPathsForRule(specifier, entry.from, dirs);
        add(out.denyRead, paths);
        add(out.denyWrite, paths);
      } else if (toolName === "Edit") {
        add(out.denyWrite, sandboxPathsForRule(specifier, entry.from, dirs));
      }
    }
  }
  return out;
}
