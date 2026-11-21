/**
 * One writer per session, across processes.
 *
 * The lock is a small file beside the transcript holding the owner's pid, host and a random
 * token. It is created atomically (see `createExclusive`), so it is never seen half written.
 *
 * A lock is stale when its owner is on this host and its pid is no longer running, or when its
 * contents cannot be read. A lock owned by another host is never treated as stale, because we
 * cannot see its processes.
 *
 * Known limit: if the owner died and its pid has since been reused by an unrelated process, the
 * lock looks live. The error names the lock file so a person can remove it.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { type LockHolder, SessionStoreError } from "./errors.ts";
import { createExclusive, isErrno } from "./paths.ts";

interface LockFileContents extends LockHolder {
  token: string;
}

const TAKEOVER_STALE_MS = 5000;

export interface LockHandle {
  readonly file: string;
  /** Removes the lock if it is still ours. Safe to call more than once. */
  release(): Promise<void>;
}

type LockRead =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "held"; info: LockFileContents };

export async function readLockFile(file: string): Promise<LockRead> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockFileContents>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.since === "string" &&
      typeof parsed.token === "string"
    ) {
      return {
        kind: "held",
        info: {
          pid: parsed.pid,
          hostname: parsed.hostname,
          since: parsed.since,
          token: parsed.token,
        },
      };
    }
  } catch {
    // Falls through to "unreadable".
  }
  return { kind: "unreadable" };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return isErrno(error, "EPERM");
  }
}

export function isHolderLive(holder: LockHolder): boolean {
  if (holder.hostname !== hostname()) return true;
  return processAlive(holder.pid);
}

/** Whether a live process holds this lock file right now. */
export async function isLocked(file: string): Promise<boolean> {
  const current = await readLockFile(file);
  return current.kind === "held" && isHolderLive(current.info);
}

export async function acquireLock(file: string, what: string): Promise<LockHandle> {
  const mine: LockFileContents = {
    pid: process.pid,
    hostname: hostname(),
    since: new Date().toISOString(),
    token: randomBytes(12).toString("hex"),
  };
  const body = `${JSON.stringify(mine)}\n`;

  // Each round takes the lock, finds a live holder, or clears (or waits out the clearing of) a
  // stale lock for the next round.
  for (let round = 0; round < 50; round++) {
    if (await createExclusive(file, body)) return handle(file, mine.token);

    const current = await readLockFile(file);
    if (current.kind === "missing") continue;
    if (current.kind === "held" && isHolderLive(current.info)) {
      const { token: _token, ...holder } = current.info;
      throw new SessionStoreError(
        "locked",
        `${what} is already open in another process (pid ${holder.pid} on ${holder.hostname}, since ${holder.since}). ` +
          `Close it there first. If no such process is running, delete ${file}.`,
        { holder, lockFile: file },
      );
    }
    await clearStale(file, current.kind === "held" ? current.info.token : null);
  }
  throw new SessionStoreError("locked", `${what} is being opened by another process; try again.`, {
    lockFile: file,
  });
}

/**
 * Removes a stale lock, but only while holding a short-lived "takeover" lock beside it and only if
 * the lock file still holds the stale token. Without that, two processes clearing the same stale
 * lock could each remove the fresh lock the other had just taken.
 */
async function clearStale(file: string, staleToken: string | null): Promise<void> {
  const takeover = `${file}.takeover`;
  if (!(await createExclusive(takeover, `${process.pid}\n`))) {
    // Someone else is clearing it. A takeover lock is held for a few milliseconds, so an old one
    // was left by a process that died mid-takeover.
    const info = await stat(takeover).catch(() => null);
    if (info && Date.now() - info.mtimeMs > TAKEOVER_STALE_MS)
      await unlink(takeover).catch(() => {});
    await delay(5 + Math.random() * 20);
    return;
  }
  try {
    const current = await readLockFile(file);
    const currentToken = current.kind === "held" ? current.info.token : null;
    if (current.kind !== "missing" && currentToken === staleToken) {
      await unlink(file).catch(() => {});
    }
  } finally {
    await unlink(takeover).catch(() => {});
  }
}

function handle(file: string, token: string): LockHandle {
  let released = false;
  return {
    file,
    async release() {
      if (released) return;
      released = true;
      const current = await readLockFile(file);
      if (current.kind === "held" && current.info.token === token) {
        await unlink(file).catch(() => {});
      }
    },
  };
}
