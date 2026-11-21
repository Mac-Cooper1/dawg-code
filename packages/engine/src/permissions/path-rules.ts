/**
 * `Read(path)` and `Edit(path)` patterns: gitignore-style patterns anchored the documented ways.
 *
 * | Written       | Relative to                                                     |
 * | ------------- | --------------------------------------------------------------- |
 * | `//path`      | the filesystem root                                             |
 * | `~/path`      | the home directory                                              |
 * | `/path`       | the settings source: the user settings file's directory for     |
 * |               | user settings, the primary working directory for everything else |
 * | `path`, `./p` | the primary working directory                                   |
 *
 * Bare file names match at any depth. A relative pattern of one directory segment (`src/**`)
 * matches only at the top as an allow rule but at any depth as a deny or ask rule. A deny or ask
 * pattern starting with `!` carves exceptions out of the relative rules listed before it in the
 * same settings file.
 *
 * Deny and ask rules are matched without regard to case (the default macOS file system ignores
 * it), and a directory counts as matched when everything inside it would be. Allow rules are
 * matched exactly.
 */
import path from "node:path";
import type { PermissionRule } from "@dawg/compat";
import ignore, { type Ignore } from "ignore";
import { type PathResolver, relativeWithin } from "./paths.ts";
import type { CompiledRule, RuleList } from "./rules.ts";

export interface PathAnchorContext {
  cwd: string;
  homeDir: string;
}

export interface CompiledPathRule {
  rule: CompiledRule;
  /** The directories the pattern is relative to: as written and where they really lead. */
  anchors: string[];
  /** A gitignore pattern relative to the anchors. */
  pattern: string;
  /** Relative to the working directory (eligible for `!` carve-outs). */
  cwdRelative: boolean;
  negated: boolean;
}

/** A name no pattern written for real files is likely to single out. */
const PROBE = "dawg-probe-entry";

const ignoreCache = new Map<string, Ignore | null>();

function matcher(patterns: readonly string[], ignoreCase: boolean): Ignore | null {
  const key = `${ignoreCase ? "i" : "s"}\u0000${patterns.join("\u0000")}`;
  let ig = ignoreCache.get(key);
  if (ig === undefined) {
    try {
      ig = ignore({ ignorecase: ignoreCase }).add(
        patterns.map((pattern, index) => ({ pattern, mark: String(index) })),
      );
      ig.ignores("x");
    } catch {
      ig = null;
    }
    if (ignoreCache.size > 2000) ignoreCache.clear();
    ignoreCache.set(key, ig);
  }
  return ig;
}

/** The directory a `/path` rule is relative to, which depends on the file the rule came from. */
function settingsAnchor(from: PermissionRule["from"], ctx: PathAnchorContext): string {
  if (from.source === "user") {
    if (from.path !== null) return path.dirname(from.path);
    return path.join(ctx.homeDir, ".dawg");
  }
  return ctx.cwd;
}

const GLOB_CHARS = /[*?[\]\\!]/;

/** Compiles the path part of a `Read(...)`/`Edit(...)` rule. Returns null when it is unusable. */
export function compilePathRule(
  rule: CompiledRule,
  ctx: PathAnchorContext,
  resolver: PathResolver,
): CompiledPathRule | null {
  const spec = rule.parsed.specifier;
  if (spec === null) return null;
  const list: RuleList = rule.list;
  const negated = spec.startsWith("!");
  const body = negated ? spec.slice(1) : spec;

  let anchor: string;
  let pattern: string;
  let anchored: boolean;
  if (negated) {
    // A carve-out is read relative to the working directory, whatever follows the `!`.
    anchor = ctx.cwd;
    pattern = body.replace(/^\.\//, "");
    anchored = false;
  } else if (body.startsWith("//")) {
    anchor = "/";
    pattern = body.slice(2);
    anchored = true;
  } else if (body === "~" || body.startsWith("~/")) {
    anchor = ctx.homeDir;
    pattern = body.slice(2);
    anchored = true;
  } else if (body.startsWith("/")) {
    anchor = settingsAnchor(rule.source.from, ctx);
    pattern = body.slice(1);
    anchored = true;
  } else if (body.startsWith("./")) {
    anchor = ctx.cwd;
    pattern = body.slice(2);
    // `./x` names the file in the working directory. As a deny or ask rule it is read with
    // gitignore's meaning instead, which also covers nested copies: the safer reading of each.
    anchored = list === "allow";
  } else {
    anchor = ctx.cwd;
    pattern = body;
    anchored = false;
  }
  if (pattern === "" || pattern === ".") pattern = "**";

  if (!anchored && list !== "allow" && /^[^/*?[\]\\!]+\/\*\*?$/.test(pattern)) {
    // Documented: a single directory segment matches at any depth in deny and ask rules.
    pattern = `**/${pattern}`;
  }

  if (anchored) {
    // Move the leading literal directories into the anchor, so the anchor can be resolved to
    // where it really leads (`//etc/**` must also cover `/private/etc` on macOS).
    const segments = pattern.split("/");
    const literal: string[] = [];
    while (segments.length > 1 && segments[0] !== undefined && !GLOB_CHARS.test(segments[0])) {
      if (segments[0] === "" || segments[0] === "." || segments[0] === "..") break;
      literal.push(segments.shift() as string);
    }
    anchor = path.join(anchor, ...literal);
    pattern = `/${segments.join("/")}`;
  }

  if (matcher([pattern], false) === null) return null;
  const anchors = [path.resolve(anchor)];
  const real = resolver.real(anchors[0] as string);
  if (real !== null && real !== anchors[0]) anchors.push(real);
  return { rule, anchors, pattern, cwdRelative: !anchored, negated };
}

/** Whether a compiled path rule matches a path (absolute, normalised). */
export function pathRuleMatches(
  compiled: CompiledPathRule,
  candidate: string,
  options: { ignoreCase: boolean; directoryContents: boolean },
): boolean {
  const ig = matcher([compiled.pattern], options.ignoreCase);
  if (ig === null) return false;
  for (const anchor of compiled.anchors) {
    if (testUnder(ig, anchor, candidate, options)) return true;
  }
  return false;
}

function testUnder(
  ig: Ignore,
  anchor: string,
  candidate: string,
  options: { ignoreCase: boolean; directoryContents: boolean },
): boolean {
  const rel = relativeWithin(candidate, anchor, options.ignoreCase);
  if (rel === null) return false;
  try {
    if (rel !== "" && ig.ignores(rel)) return true;
    if (options.directoryContents && ig.ignores(rel === "" ? PROBE : `${rel}/${PROBE}`))
      return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Deny or ask path rules from one settings file, relative to the working directory, with their
 * `!` carve-outs: gitignore semantics over the whole group, so a later `!` pattern re-includes
 * what earlier patterns matched, but cannot reopen a path inside a directory matched as a whole.
 */
export interface PathRuleGroup {
  anchors: string[];
  members: CompiledPathRule[];
}

/** Returns the positive rule that makes the group match the path, or null. */
export function groupMatch(
  group: PathRuleGroup,
  candidate: string,
  options: { ignoreCase: boolean; directoryContents: boolean },
): CompiledPathRule | null {
  const ig = matcher(
    group.members.map((m) => (m.negated ? `!${m.pattern}` : m.pattern)),
    options.ignoreCase,
  );
  if (ig === null) return null;
  for (const anchor of group.anchors) {
    const rel = relativeWithin(candidate, anchor, options.ignoreCase);
    if (rel === null) continue;
    const probes = rel === "" ? [] : [rel];
    if (options.directoryContents) probes.push(rel === "" ? PROBE : `${rel}/${PROBE}`);
    for (const p of probes) {
      try {
        const result = ig.test(p);
        if (result.ignored) {
          const index = Number(result.rule?.mark ?? "-1");
          const member = group.members[index];
          if (member !== undefined && !member.negated) return member;
          return group.members.find((m) => !m.negated) ?? null;
        }
      } catch {
        // An unusable path matches nothing.
      }
    }
  }
  return null;
}
