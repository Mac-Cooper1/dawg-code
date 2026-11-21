/**
 * `<session dir>/runtime.json`: what a session listing needs that the transcript index does not
 * hold (mode, model, effort, the last event number, whether the last turn failed), so listing
 * never has to replay transcripts. It is a cache: losing it only makes a listing less detailed,
 * and opening the session rewrites it.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ForkPoint, PermissionMode } from "@dawg/protocol";

export interface Sidecar {
  v: 1;
  lastSeq: number;
  projectDir: string;
  mode: PermissionMode | null;
  model: string | null;
  effort: string | null;
  lastTurnFailed: boolean;
  forkPoint: ForkPoint | null;
}

export function sidecarPath(sessionDir: string): string {
  return path.join(sessionDir, "runtime.json");
}

export async function readSidecar(sessionDir: string): Promise<Sidecar | null> {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(sessionDir), "utf8")) as Partial<Sidecar>;
    if (parsed.v !== 1 || typeof parsed.lastSeq !== "number") return null;
    return parsed as Sidecar;
  } catch {
    return null;
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Replaces the file atomically. Writes to one file are queued; a failed write is ignored. */
export function writeSidecar(sessionDir: string, data: Sidecar): Promise<void> {
  const file = sidecarPath(sessionDir);
  const previous = queues.get(file) ?? Promise.resolve();
  const run = previous.then(async () => {
    await mkdir(sessionDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data)}\n`, "utf8");
    try {
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  });
  const settled = run.catch(() => {});
  queues.set(file, settled);
  void settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file);
  });
  return settled;
}
