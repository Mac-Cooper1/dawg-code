/**
 * Rules offered for "allow always". They are saved to the project's personal settings file, so
 * a `/path` rule there is relative to the primary working directory.
 *
 * Command suggestions are made per part by the analyser (see `suggestCommandRule`); these are the
 * file ones. Every suggestion is checked before it is offered: the decision is run again with it
 * added, and it is dropped unless the call would then be allowed.
 */
import path from "node:path";
import { isWithin, type PathResolver, relativeWithin } from "./paths.ts";

/** Escapes a path so a gitignore pattern matches it literally. */
export function escapeGitignore(p: string): string {
  let out = p.replace(/[\\*?[\]]/g, "\\$&");
  out = out
    .split("/")
    .map((seg) => (seg.startsWith("!") || seg.startsWith("#") ? `\\${seg}` : seg))
    .join("/");
  if (out.endsWith(" ")) out = `${out.slice(0, -1)}\\ `;
  return out;
}

/**
 * For an edit inside the working directories: the file's directory under the primary working
 * directory (`Edit(/src/components/**)`), or the file itself when it sits at the top. Broader
 * than one file, so repeated edits nearby stop asking; narrower than everything.
 */
export function editRuleFor(file: string, cwd: string): string {
  const rel = relativeWithin(file, cwd);
  if (rel !== null && rel !== "") {
    const dir = path.posix.dirname(rel);
    return dir === "." ? `Edit(/${escapeGitignore(rel)})` : `Edit(/${escapeGitignore(dir)}/**)`;
  }
  // In an added working directory: anchor at the filesystem root.
  return `Edit(//${escapeGitignore(path.dirname(file).slice(1))}/**)`;
}

/**
 * For a read outside the working directories: the directory it is in (or is), never all of home
 * or the whole disk. Null when no rule would be narrow enough.
 */
export function readRuleFor(
  target: string,
  homeDir: string,
  resolver: PathResolver,
): string | null {
  const home = path.resolve(homeDir);
  if (target === "/") return null;
  const dir = resolver.isDirectory(target) ? target : path.dirname(target);
  if (dir === "/" || dir === home || isWithin(home, dir)) {
    // Too broad as a directory rule: name the path itself.
    return isWithin(target, home) && target !== home
      ? `Read(~/${escapeGitignore(relativeWithin(target, home) ?? "")})`
      : `Read(//${escapeGitignore(target.slice(1))})`;
  }
  if (isWithin(dir, home)) return `Read(~/${escapeGitignore(relativeWithin(dir, home) ?? "")}/**)`;
  return `Read(//${escapeGitignore(dir.slice(1))}/**)`;
}
