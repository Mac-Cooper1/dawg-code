import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Expands a leading `~` or `~/` to the home directory; anything else is returned unchanged. */
export function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return join(homeDir, p.slice(2));
  return p;
}

/** Resolves `p` against `baseDir` after expanding `~`. Always absolute and normalised. */
export function resolveUserPath(p: string, baseDir: string, homeDir: string): string {
  const expanded = expandHome(p, homeDir);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/** True when `child` is `parent` or lies below it. Both must be absolute. Lexical only. */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The real path of `p`, following symbolic links. When `p` does not exist yet, the nearest
 * existing ancestor is resolved and the missing tail appended, so callers can judge where a file
 * that is about to be created would really land.
 */
export async function realpathLoose(p: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(p);
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Every directory from the filesystem root down to `dir`, inclusive, root first. */
export function ancestorsRootFirst(dir: string): string[] {
  const out: string[] = [];
  let current = resolve(dir);
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out.reverse();
}

/** Byte-wise string comparison, so ordering never depends on the locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
