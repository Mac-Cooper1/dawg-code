import { randomBytes } from "node:crypto";
import { chmod, lstat, open, readlink, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteOptions {
  /** Permission bits for the file. Defaults to the usual mode for a new file. */
  mode?: number;
  /** For tests: runs after the temporary file is complete, just before it replaces the target. */
  beforeRename?: (tempPath: string) => Promise<void> | void;
}

/**
 * Writes `data` to `target` so that readers see either the old file or the new one, never a
 * partial write: the bytes go to a temporary file in the same directory, which then replaces the
 * target in one rename. A symbolic link is written through, so the link itself survives.
 *
 * Returns the path actually written (the link's target for a symbolic link).
 */
export async function atomicWriteFile(
  target: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<string> {
  const real = await followLink(target);
  const temp = path.join(
    path.dirname(real),
    `.${path.basename(real)}.${randomBytes(6).toString("hex")}.dawg-tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", options.mode ?? 0o666);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The mode given to open() is reduced by the umask; set it exactly so it matches the old file.
    if (options.mode !== undefined) await chmod(temp, options.mode);
    await options.beforeRename?.(temp);
    await rename(temp, real);
    return real;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function followLink(target: string): Promise<string> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(target);
  } catch {
    return target;
  }
  if (!stats.isSymbolicLink()) return target;
  try {
    return await realpath(target);
  } catch {
    // A dangling link: create the file it points at.
    return path.resolve(path.dirname(target), await readlink(target));
  }
}
