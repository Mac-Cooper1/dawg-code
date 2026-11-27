/**
 * Where a subagent's transcript lives: beside its parent's, in the parent's side folder.
 *
 *   <parent dir>/subagents/<agent session id>.jsonl     the agent's transcript
 *   <parent dir>/subagents/<agent session id>.lock      while a writer has it open
 *   <parent dir>/subagents/<agent session id>/          its events, tool results, file history
 *
 * The files are the same format as any session's, written by the same writer, so the runtime
 * that runs a subagent is an ordinary session runtime. They are not under `sessions/`, so no
 * listing ever shows them; deleting the parent's folder deletes them with it.
 */

import { randomBytes } from "node:crypto";
import { link, mkdir, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../contracts/messages.ts";
import { readSessionFile } from "../session/file.ts";
import { acquireLock } from "../session/lock.ts";
import {
  CURRENT_PROTOCOL_VERSION,
  type MetaRecord,
  SESSION_FORMAT_VERSION,
  type SessionRecord,
  type StateChanges,
} from "../session/records.ts";
import { replay } from "../session/replay.ts";
import { type Durability, SessionWriter } from "../session/writer.ts";

/** The folder of a session's subagents, from its side folder. */
export function subagentsDir(parentSessionDir: string): string {
  return path.join(parentSessionDir, "subagents");
}

export interface ChildPaths {
  file: string;
  dir: string;
  lock: string;
  toolResults: string;
}

export function childPaths(parentSessionDir: string, childId: string): ChildPaths {
  const base = subagentsDir(parentSessionDir);
  const dir = path.join(base, childId);
  return {
    file: path.join(base, `${childId}.jsonl`),
    dir,
    lock: path.join(base, `${childId}.lock`),
    toolResults: path.join(dir, "tool-results"),
  };
}

/** A subagent's session id: its parent's, then its number. Never the id of a top-level session. */
export function childSessionId(parentId: string, number: number): string {
  return `${parentId}-agent-${number}`;
}

/** The parent of a subagent's session id, or null when the id is not one. */
export function parentOfChild(childId: string): { parentId: string; number: number } | null {
  const match = /^(.+)-agent-(\d+)$/.exec(childId);
  if (match === null) return null;
  return { parentId: match[1] as string, number: Number(match[2]) };
}

interface WriterOptions {
  now: () => Date;
  durability: Durability;
}

async function openWriter(paths: ChildPaths, options: WriterOptions): Promise<SessionWriter> {
  const lock = await acquireLock(paths.lock, `Subagent ${path.basename(paths.dir)}`);
  try {
    const contents = await readSessionFile(paths.file);
    const handle = await open(paths.file, "a");
    return new SessionWriter({
      file: paths.file,
      toolResultsDir: paths.toolResults,
      handle,
      lock,
      snapshot: replay(contents.records),
      host: {
        now: options.now,
        durability: options.durability,
        flushDelayMs: 1000,
        // Subagents are never listed.
        updateIndex: async () => {},
        onClose: () => {},
      },
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/**
 * Creates a subagent's transcript and opens it. `records` are copied after the meta record (a
 * fork's copy of its parent); then the initial state and messages are appended.
 */
export async function createChild(input: {
  parentSessionDir: string;
  childId: string;
  cwd: string;
  title: string;
  forkedFrom: { sessionId: string; seq: number } | null;
  initialState: StateChanges;
  initialMessages: readonly Message[];
  options: WriterOptions;
}): Promise<{ writer: SessionWriter; paths: ChildPaths }> {
  const paths = childPaths(input.parentSessionDir, input.childId);
  await mkdir(path.dirname(paths.file), { recursive: true });
  const meta: MetaRecord = {
    type: "meta",
    v: SESSION_FORMAT_VERSION,
    seq: 0,
    time: input.options.now().toISOString(),
    sessionId: input.childId,
    cwd: input.cwd,
    title: input.title,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    forkedFrom: input.forkedFrom,
  };
  await writeWhole(paths.file, [meta]);
  const writer = await openWriter(paths, input.options);
  try {
    await writer.setState(input.initialState);
    for (const message of input.initialMessages) await writer.appendMessage(message);
    await writer.setStatus("idle");
    return { writer, paths };
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

/** Opens an existing subagent's transcript for another task. */
export async function openChild(
  parentSessionDir: string,
  childId: string,
  options: WriterOptions,
): Promise<{ writer: SessionWriter; paths: ChildPaths; records: SessionRecord[] }> {
  const paths = childPaths(parentSessionDir, childId);
  const writer = await openWriter(paths, options);
  const { records } = await readSessionFile(paths.file);
  return { writer, paths, records };
}

/** Writes a new file whole: it appears complete or not at all. */
async function writeWhole(file: string, records: readonly SessionRecord[]): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), { flag: "wx" });
  try {
    await link(tmp, file);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
