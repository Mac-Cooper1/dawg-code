/**
 * Keeping the panes' file access inside a session's folders. Every path from the renderer is
 * resolved with `realpath` (symlinks followed, `..` gone) and must land inside one of the session's
 * folders, themselves resolved. Paths go back to the renderer in the form it knows (macOS's
 * `/tmp` is really `/private/tmp`), so a session's own paths compare equal on both sides.
 */
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";

/** One of a session's folders: as the renderer names it, and resolved. */
export interface Root {
  logical: string;
  real: string;
}

const MAX_LINKS = 40;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Resolves symlinks in an absolute path, also when the path does not exist yet: the part that
 * exists is resolved and the rest appended. A link to something missing is followed, so a dangling
 * link cannot point a later write outside the session.
 */
export async function realPathOf(input: string): Promise<string> {
  return resolveReal(path.resolve(input), 0);
}

async function resolveReal(absolute: string, links: number): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  let target: string | null = null;
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) target = await readlink(absolute);
  } catch {
    // Missing: resolved through its parent below.
  }
  const realParent = await resolveReal(parent, links);
  if (target === null) return path.join(realParent, path.basename(absolute));
  if (links >= MAX_LINKS) throw new Error(`Too many links in ${absolute}`);
  return resolveReal(path.resolve(realParent, target), links + 1);
}

export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(prefix);
}

/** The deepest root containing a resolved path, or null. */
export function rootContaining(roots: readonly Root[], real: string): Root | null {
  let best: Root | null = null;
  for (const root of roots) {
    if (isInside(real, root.real) && (best === null || root.real.length > best.real.length)) {
      best = root;
    }
  }
  return best;
}

/** A resolved path in the form the renderer knows, when it is inside one of the roots. */
export function toLogical(roots: readonly Root[], real: string): string {
  const root = rootContaining(roots, real);
  if (root === null) return real;
  return real === root.real ? root.logical : path.join(root.logical, real.slice(root.real.length));
}

export class OutsideSessionError extends Error {
  constructor(input: string) {
    super(`${input} is outside this session's folders.`);
    this.name = "OutsideSessionError";
  }
}

/**
 * Resolves a path from the renderer, refusing anything outside the roots. Returns the resolved
 * path (for reading and writing) and the normalised path the renderer gave (for answers).
 */
export async function resolveInside(
  roots: readonly Root[],
  input: string,
): Promise<{ real: string; logical: string }> {
  if (!path.isAbsolute(input)) throw new OutsideSessionError(input);
  const logical = path.resolve(input);
  const real = await realPathOf(logical);
  if (rootContaining(roots, real) === null) throw new OutsideSessionError(input);
  return { real, logical };
}
