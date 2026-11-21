import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ApiKeyFile {
  key: string;
  /** Path to the key file (mode 0600, inside a private 0700 directory). */
  path: string;
  /** Deletes the file and its directory. Safe to call more than once. */
  dispose(): Promise<void>;
}

export function generateApiKey(): string {
  // base64url never starts with "#", which llama-server would read as a comment line.
  return randomBytes(32).toString("base64url");
}

/**
 * Writes a fresh per-launch key to a new 0600 file. The key is handed to llama-server by path
 * (`--api-key-file`), so it never appears in argv, `ps` output or logs.
 */
export async function createApiKeyFile(parentDir: string = tmpdir()): Promise<ApiKeyFile> {
  const key = generateApiKey();
  const dir = await mkdtemp(join(parentDir, "dawg-runtime-key-"));
  await chmod(dir, 0o700);
  const path = join(dir, "api-key");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${key}\n`, "utf8");
  } finally {
    await handle.close();
  }
  // The process umask can only remove bits; make the mode explicit regardless.
  await chmod(path, 0o600);
  let disposed = false;
  return {
    key,
    path,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
