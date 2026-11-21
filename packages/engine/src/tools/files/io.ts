import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

export type PathProbe =
  | { kind: "missing" }
  | { kind: "directory"; stats: Stats }
  /** A pipe, socket or device: reading it could block forever. */
  | { kind: "special"; stats: Stats }
  | { kind: "file"; stats: Stats };

/** What is at `filePath`, following symbolic links. Throws only for unexpected errors. */
export async function probePath(filePath: string): Promise<PathProbe> {
  let stats: Stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
  if (stats.isDirectory()) return { kind: "directory", stats };
  if (!stats.isFile()) return { kind: "special", stats };
  return { kind: "file", stats };
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * A sentence for a file-system error the model can act on, or null for one it cannot (which the
 * caller rethrows as a bug).
 */
export function describeFsError(error: unknown, action: string, filePath: string): string | null {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM":
      return `Permission denied: cannot ${action} ${filePath}.`;
    case "EROFS":
      return `Cannot ${action} ${filePath}: the file system is read-only.`;
    case "ENOSPC":
      return `Cannot ${action} ${filePath}: no space left on the device.`;
    case "EDQUOT":
      return `Cannot ${action} ${filePath}: the disk quota is exhausted.`;
    case "ENAMETOOLONG":
      return `Cannot ${action} ${filePath}: the path is too long.`;
    case "ELOOP":
      return `Cannot ${action} ${filePath}: it goes through a loop of symbolic links.`;
    case "ENOTDIR":
      return `Cannot ${action} ${filePath}: part of the path is a file, not a directory.`;
    case "EISDIR":
      return `Cannot ${action} ${filePath}: it is a directory.`;
    case "EBUSY":
    case "ETXTBSY":
      return `Cannot ${action} ${filePath}: the file is busy.`;
    case "EMFILE":
    case "ENFILE":
      return `Cannot ${action} ${filePath}: too many files are open. Try again.`;
    default:
      return null;
  }
}
