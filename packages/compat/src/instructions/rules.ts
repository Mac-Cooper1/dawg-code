import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { compareCodeUnits } from "../internal/paths.ts";
import { splitFrontMatter, splitPatternList } from "./markdown.ts";
import type { InstructionProblem } from "./types.ts";

/**
 * Every `.md` file under a rules directory, recursively, following symbolic links (with loop
 * protection). Sorted by relative path, byte-wise, so the result never depends on the order the
 * filesystem lists entries in.
 */
export async function listRuleFiles(rulesDir: string): Promise<string[]> {
  const found: { rel: string; abs: string }[] = [];
  const visited = new Set<string>();

  async function walk(dir: string, rel: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort(compareCodeUnits)) {
      const abs = join(dir, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue; // A dangling link.
      }
      if (info.isDirectory()) await walk(abs, childRel);
      else if (info.isFile() && name.endsWith(".md")) found.push({ rel: childRel, abs });
    }
  }

  await walk(rulesDir, "");
  return found.sort((a, b) => compareCodeUnits(a.rel, b.rel)).map((f) => f.abs);
}

export interface ParsedRule {
  /** The body with front matter removed. */
  body: string;
  /** Glob patterns from `paths:`, or null when the rule always applies. */
  paths: string[] | null;
}

/**
 * Splits a rule file into its body and its `paths:` patterns. `paths` may be a YAML list or a
 * comma-separated string. Other front-matter fields are ignored. Front matter that does not
 * parse is ignored and the rule treated as always applying, as documented.
 */
export function parseRule(text: string, path: string, problems: InstructionProblem[]): ParsedRule {
  const { yaml, body } = splitFrontMatter(text);
  if (yaml === null) return { body, paths: null };
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    problems.push({
      kind: "front-matter",
      path,
      target: null,
      message: `Front matter is not valid YAML, so the rule always applies: ${detail}`,
    });
    return { body, paths: null };
  }
  if (typeof data !== "object" || data === null || !("paths" in data)) return { body, paths: null };
  const raw = (data as { paths: unknown }).paths;
  let patterns: string[];
  if (typeof raw === "string") {
    patterns = splitPatternList(raw);
  } else if (Array.isArray(raw)) {
    patterns = raw
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p !== "");
  } else {
    problems.push({
      kind: "front-matter",
      path,
      target: null,
      message: "`paths` must be a list or a comma-separated string, so the rule always applies.",
    });
    return { body, paths: null };
  }
  return { body, paths: patterns.length > 0 ? patterns : null };
}

/**
 * A `[` that cannot start a bracket expression makes the pattern invalid, and an invalid pattern
 * matches nothing (documented). The glob library would read it literally instead.
 */
function hasUnclosedBracket(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) return true;
      i = close;
    }
  }
  return false;
}

/**
 * Builds a matcher for a rule's patterns, taking paths relative to the rule's base directory
 * with `/` separators. Gitignore-like, as documented: a pattern without a slash matches the file
 * name at any depth, a leading `/` anchors the pattern to the base directory, and braces expand.
 */
export function compileRulePatterns(patterns: readonly string[]): (relPath: string) => boolean {
  const matchers: ((p: string) => boolean)[] = [];
  for (const raw of patterns) {
    if (hasUnclosedBracket(raw)) continue;
    let pattern = raw;
    let anchored = false;
    if (pattern.startsWith("/")) {
      anchored = true;
      pattern = pattern.slice(1);
    } else if (pattern.startsWith("./")) {
      pattern = pattern.slice(2);
    }
    if (pattern === "") continue;
    const anywhere = !anchored && !pattern.includes("/");
    try {
      matchers.push(picomatch(pattern, { dot: true, basename: anywhere }));
    } catch {
      // An invalid pattern matches nothing; the rule's other patterns keep working.
    }
  }
  return (relPath) => matchers.some((m) => m(relPath));
}

/** The path of `file` relative to `base` with `/` separators, or null when it is not below it. */
export function relativeInside(base: string, file: string): string | null {
  const rel = relative(base, file);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join("/");
}
