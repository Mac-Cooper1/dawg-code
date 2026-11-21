/**
 * Paths as the permission engine sees them: where a path really leads (following symbolic links
 * the way the kernel does), whether it is inside the working directories, and whether it is one
 * of the paths whose changes always need approval.
 *
 * Resolving links is the only place the engine touches the file system, and it only reads.
 */
import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

/** The read-only file system calls the engine makes. Injectable for tests. */
export interface FsProbe {
  /** `lstat`, or undefined when nothing exists at the path. Throws for other errors. */
  lstat(p: string): { isSymbolicLink(): boolean; isDirectory(): boolean } | undefined;
  readlink(p: string): string;
}

export const nodeFsProbe: FsProbe = {
  lstat(p) {
    try {
      return lstatSync(p, { throwIfNoEntry: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw err;
    }
  },
  readlink: (p) => readlinkSync(p),
};

const MAX_LINK_HOPS = 40;

/**
 * Resolves paths to where they really lead. Results are remembered for the life of the object,
 * which is one decision.
 */
export class PathResolver {
  private readonly fs: FsProbe;
  private readonly memo = new Map<string, string | null>();

  constructor(fs: FsProbe) {
    this.fs = fs;
  }

  /**
   * The real path of an absolute path, resolving symbolic links and `..` as the kernel would:
   * `..` after a link goes to the parent of the link's target. The part that does not exist yet
   * is appended as written. Null when the path cannot be resolved (a link loop, an unreadable
   * directory on the way).
   */
  real(p: string): string | null {
    const cached = this.memo.get(p);
    if (cached !== undefined) return cached;
    let result: string | null;
    try {
      result = this.resolve(p);
    } catch {
      result = null;
    }
    this.memo.set(p, result);
    return result;
  }

  private resolve(p: string): string | null {
    const queue = p.split("/").filter((s) => s !== "" && s !== ".");
    let current = "/";
    let hops = 0;
    while (queue.length > 0) {
      const seg = queue.shift() as string;
      if (seg === "..") {
        current = path.dirname(current);
        continue;
      }
      const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
      const st = this.fs.lstat(next);
      if (st === undefined) {
        // Nothing exists from here on; the rest is resolved as written.
        return path.resolve(current, seg, ...queue);
      }
      if (st.isSymbolicLink()) {
        hops++;
        if (hops > MAX_LINK_HOPS) return null;
        const target = this.fs.readlink(next);
        if (target.startsWith("/")) current = "/";
        queue.unshift(...target.split("/").filter((s) => s !== "" && s !== "."));
        continue;
      }
      current = next;
    }
    return current;
  }

  /** Whether the path exists and is a directory (following links). */
  isDirectory(p: string): boolean {
    const real = this.real(p);
    if (real === null) return false;
    try {
      return this.fs.lstat(real)?.isDirectory() ?? false;
    } catch {
      return false;
    }
  }
}

/** `child` is `parent` or inside it. */
export function isWithin(child: string, parent: string, ignoreCase = false): boolean {
  const c = ignoreCase ? child.toLowerCase() : child;
  const p = ignoreCase ? parent.toLowerCase() : parent;
  if (c === p) return true;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

/** The path relative to `parent` when it is within it, else null. "" for `parent` itself. */
export function relativeWithin(child: string, parent: string, ignoreCase = false): string | null {
  if (!isWithin(child, parent, ignoreCase)) return null;
  if (child.length === parent.length) return "";
  const offset = parent.endsWith("/") ? parent.length : parent.length + 1;
  return child.slice(offset);
}

// ---------------------------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------------------------

/**
 * Directories that hold repository state or tool configuration that can run code: changes
 * anywhere inside them always need approval. The list follows the public documentation's
 * protected paths, plus `.dawg`.
 */
const GIT_DIRECTORIES = new Set([".git", ".husky"]);
const SETTINGS_DIRECTORIES = new Set([
  ".dawg",
  ".claude",
  ".vscode",
  ".idea",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);
const GIT_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
]);
const SETTINGS_FILES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  ".ripgreprc",
  "pyrightconfig.json",
  ".mcp.json",
  ".claude.json",
]);

/**
 * A file name as the file system compares it: case folded (macOS and Windows ignore case by
 * default) and without the invisible characters some file systems ignore.
 */
function comparable(name: string): string {
  return name.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").toLowerCase();
}

export type ProtectedKind = "git" | "settings";

/** Why changes to this absolute path always need approval, or null. */
export function protectedKind(p: string): ProtectedKind | null {
  const segs = p
    .split("/")
    .filter((s) => s !== "")
    .map(comparable);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    if (
      (seg === ".dawg" || seg === ".claude") &&
      segs[i + 1] === "worktrees" &&
      i + 3 < segs.length
    ) {
      // Session worktrees are ordinary checkouts: skip to inside the worktree.
      i += 2;
      continue;
    }
    if (GIT_DIRECTORIES.has(seg)) return "git";
    if (seg === ".config" && segs[i + 1] === "git") return "git";
    if (SETTINGS_DIRECTORIES.has(seg)) return "settings";
  }
  const last = segs[segs.length - 1];
  if (last === undefined) return null;
  if (GIT_FILES.has(last)) return "git";
  if (SETTINGS_FILES.has(last)) return "settings";
  return null;
}

/** The working directory roots and their real locations, for containment checks. */
export class WorkingDirectories {
  private readonly roots: string[];

  constructor(dirs: readonly string[], resolver: PathResolver) {
    const roots = new Set<string>();
    for (const d of dirs) {
      const lexical = path.resolve(d);
      const real = resolver.real(lexical);
      // Only the real location counts: a path is inside when where it really leads is inside.
      roots.add(real ?? lexical);
    }
    this.roots = [...roots];
  }

  /** Whether a real path is inside a working directory. */
  contains(realPath: string): boolean {
    return this.roots.some((r) => isWithin(realPath, r));
  }

  /** Whether a real path is strictly inside a working directory (not a root itself). */
  containsStrictly(realPath: string): boolean {
    return this.roots.some((r) => realPath !== r && isWithin(realPath, r));
  }

  /** Whether removing this real path would remove a working directory or one of its parents. */
  isRootOrAncestor(realPath: string): boolean {
    return this.roots.some((r) => isWithin(r, realPath));
  }

  list(): readonly string[] {
    return this.roots;
  }
}
