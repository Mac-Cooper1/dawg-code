import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves a path given by the model, lexically: absolute, relative to `cwd`, or starting with
 * `~`. Symbolic links are left alone; judging where they lead is the permission engine's job.
 *
 * Models sometimes wrap a path in quotes or backticks, pad it with whitespace or send a
 * `file://` URL. Those wrappers are removed, since a real file name almost never has them.
 */
export function resolveToolPath(input: string, cwd: string, home: string = homedir()): string {
  let p = input.trim();
  const quoted = /^(["'`])(.*)\1$/.exec(p);
  if (quoted?.[2] !== undefined) p = quoted[2].trim();
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p);
    } catch {
      // Not a valid file URL: treat it as an ordinary path.
    }
  }
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = path.join(home, p.slice(2));
  return path.resolve(cwd, p);
}
