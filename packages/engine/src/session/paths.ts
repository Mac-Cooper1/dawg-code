/**
 * Where session data lives:
 *
 *   <root>/projects/<project-key>/project.json            which project path owns this folder
 *   <root>/projects/<project-key>/sessions/<id>.jsonl     the transcript
 *   <root>/projects/<project-key>/sessions/<id>.lock      present while a writer has it open
 *   <root>/projects/<project-key>/sessions/<id>/tool-results/
 *   <root>/projects/<project-key>/sessions/index.json     the listing cache
 *
 * The project key is the project path with every character other than ASCII letters and digits
 * replaced by "-". That mapping is lossy ("/a/b c", "/a/b_c" and "/a/b-c" share a key, and so do
 * "/a/Proj" and "/a/proj" on a case-insensitive disk), so each project folder records the path
 * that claimed it in `project.json`. A second path that maps to an occupied key gets the key with
 * a hash of its full path appended.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SessionStoreError } from "./errors.ts";

/** Folder names stay well under the 255-byte limit of macOS file systems. */
const MAX_KEY_LENGTH = 200;
const HASH_LENGTH = 16;

export interface HomeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
}

/** `$DAWG_HOME` when set, otherwise `~/.dawg`. */
export function resolveDawgHome(options: HomeOptions = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = env.DAWG_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(options.homeDir ?? homedir(), ".dawg");
}

function pathHash(projectPath: string): string {
  return createHash("sha256").update(projectPath, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/**
 * The folder name for a project path, before collision handling. Paths are resolved lexically
 * (no symlink resolution), so the same directory reached two ways is two projects.
 */
export function projectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  const key = resolved.replace(/[^A-Za-z0-9]/g, "-");
  if (key.length <= MAX_KEY_LENGTH) return key;
  return `${key.slice(0, MAX_KEY_LENGTH - HASH_LENGTH - 1)}-${pathHash(resolved)}`;
}

/** The key used when the plain key is already taken by a different path. */
export function hashedProjectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  const base = projectKey(resolved);
  const trimmed = base.slice(0, MAX_KEY_LENGTH - HASH_LENGTH - 1);
  return `${trimmed}-${pathHash(resolved)}`;
}

type Claim =
  /** No folder for this key. */
  | { kind: "missing" }
  /** A folder with no readable `project.json`: nobody has claimed it. */
  | { kind: "unclaimed"; damaged: boolean }
  | { kind: "claimed"; path: string };

async function readClaim(dir: string): Promise<Claim> {
  let text: string;
  try {
    text = await readFile(path.join(dir, "project.json"), "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    try {
      await stat(dir);
      return { kind: "unclaimed", damaged: false };
    } catch (statError) {
      if (isErrno(statError, "ENOENT")) return { kind: "missing" };
      throw statError;
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const claimed = (parsed as { path?: unknown } | null)?.path;
    if (typeof claimed === "string") return { kind: "claimed", path: claimed };
  } catch {
    // Falls through: a claim nobody can read is no claim, and the next writer replaces it.
  }
  return { kind: "unclaimed", damaged: true };
}

/**
 * Writes `content` to `file` only if `file` does not exist, so that no reader ever sees it half
 * written: the text goes to a private temporary file first and is then hard-linked into place,
 * which fails atomically when the name is taken.
 */
export async function createExclusive(file: string, content: string): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, { flag: "wx" });
  try {
    await link(tmp, file);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Finds the folder for a project. With `create`, claims one when the project has none. Without,
 * returns where the folder is or would be; it may not exist.
 */
export async function resolveProjectDir(
  root: string,
  projectPath: string,
  options: { create: boolean },
): Promise<string> {
  const resolved = path.resolve(projectPath);
  // For a long path the plain key already ends in the hash, so there is only one candidate.
  const keys = [...new Set([projectKey(resolved), hashedProjectKey(resolved)])];
  const dirs = keys.map((key) => path.join(root, "projects", key));
  const claims = await Promise.all(dirs.map(readClaim));

  const owned = claims.findIndex((c) => c.kind === "claimed" && c.path === resolved);
  if (owned >= 0) return dirs[owned] as string;

  for (const [i, dir] of dirs.entries()) {
    const claim = claims[i] as Claim;
    if (claim.kind === "claimed") continue;
    if (!options.create) return dir;
    await mkdir(dir, { recursive: true });
    if (claim.kind === "unclaimed" && claim.damaged) {
      await unlink(path.join(dir, "project.json")).catch(() => {});
    }
    const body = `${JSON.stringify({ path: resolved })}\n`;
    if (await createExclusive(path.join(dir, "project.json"), body)) return dir;
    // Another process claimed it first; it may have been for this same path.
    const now = await readClaim(dir);
    if (now.kind === "claimed" && now.path === resolved) return dir;
  }
  throw new SessionStoreError(
    "invalid-argument",
    `No free session folder for ${resolved}: ${keys.join(" and ")} belong to other paths.`,
  );
}

export interface SessionPaths {
  /** The transcript. */
  file: string;
  /** The folder for this session's side files. */
  dir: string;
  toolResults: string;
  lock: string;
}

export function sessionsDir(projectDir: string): string {
  return path.join(projectDir, "sessions");
}

export function sessionPaths(projectDir: string, sessionId: string): SessionPaths {
  assertSessionId(sessionId);
  const base = sessionsDir(projectDir);
  const dir = path.join(base, sessionId);
  return {
    file: path.join(base, `${sessionId}.jsonl`),
    dir,
    toolResults: path.join(dir, "tool-results"),
    lock: path.join(base, `${sessionId}.lock`),
  };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Ids become file names, so anything that could step out of the folder is refused. */
export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionStoreError(
      "invalid-argument",
      `Not a valid session id: ${JSON.stringify(sessionId)}`,
    );
  }
}

let lastMs = -1;
let counter = 0;

/**
 * A UUIDv7: the creation time in milliseconds, then randomness. Ids made in this process are
 * strictly increasing even within one millisecond (the 12-bit field after the version holds a
 * counter), so sorting ids sorts sessions by creation time.
 */
export function newSessionId(now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      ms += 1;
      counter = 0;
    }
  } else {
    // Start low in the field so many ids can share a millisecond before it overflows.
    counter = randomBytes(1)[0] ?? 0;
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
