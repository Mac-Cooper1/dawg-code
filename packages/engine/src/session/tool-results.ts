/**
 * Large tool outputs spilled to files under a session's `tool-results/` folder. This is the real
 * implementation behind `ToolContext.saveOutput`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isErrno } from "./paths.ts";

const MAX_NAME_LENGTH = 100;
const MAX_EXTENSION_LENGTH = 12;

/**
 * Turns a suggested name into a plain file name: only the last path segment, only ASCII letters,
 * digits, ".", "_" and "-", no leading dots (so never "." or ".." or a hidden file), at most
 * 100 characters with the extension kept.
 */
export function safeOutputName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  let safe = last
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/_+$/, "");
  if (safe === "" || /^[.-]*$/.test(safe)) safe = "output";
  if (safe.length <= MAX_NAME_LENGTH) return safe;
  const dot = safe.lastIndexOf(".");
  const ext = dot > 0 && safe.length - dot <= MAX_EXTENSION_LENGTH ? safe.slice(dot) : "";
  return safe.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/**
 * Writes `content` to a new file in `dir` and returns its absolute path. The name is made safe;
 * when it is taken, "-2", "-3" and so on are added before the extension. Files are created with
 * exclusive mode, so concurrent saves never overwrite each other.
 */
export async function saveToolOutput(
  dir: string,
  name: string,
  content: string | Uint8Array,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safe = safeOutputName(name);
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = path.resolve(dir, n === 1 ? safe : `${stem}-${n}${ext}`);
    try {
      await writeFile(candidate, content, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}
