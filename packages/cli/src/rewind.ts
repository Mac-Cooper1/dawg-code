/**
 * `/rewind` and `/memory` in the interactive session (Phase 4 spec, "Checkpoints and rewind",
 * "Memory"). Plain lines, like the rest of interactive mode, so a script can answer them.
 *
 * `/rewind` lists the conversation's checkpoints (`session.checkpoints`), newest first, asks which
 * one and what to do (`session.rewind`), and asks again before overwriting files changed outside
 * dawg since. Restoring the conversation moves the session to the fork; the original is kept.
 *
 * `/memory` prints where the memory folder and instruction files are (the engine's `memory`
 * command) and opens MEMORY.md in `$VISUAL` or `$EDITOR` when one is set and the terminal is
 * interactive.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { SHELL_CAVEAT } from "@dawg/engine";
import type { Checkpoint, Client, RewindAction, SessionSnapshot } from "@dawg/protocol";

export interface RewindIo {
  /** Writes a question and reads the answer; null at the end of input. */
  ask(question: string): Promise<string | null>;
  line(text: string): void;
  cwd: string;
}

export interface RewindDone {
  /** The fork the conversation goes on in, or null. */
  session: SessionSnapshot | null;
  /** The message to offer again: it was rewound or summarised. */
  prompt: string | null;
  /** A summary is being written: follow the compaction. */
  summarizing: boolean;
}

const ACTIONS: { action: RewindAction; label: string; files: boolean }[] = [
  { action: "both", label: "Restore files and conversation", files: true },
  {
    action: "conversation",
    label: "Restore the conversation (files stay as they are)",
    files: false,
  },
  { action: "files", label: "Restore files (the conversation goes on)", files: true },
  { action: "summarize", label: "Summarise from here", files: false },
];

function when(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shown(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no text)";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Asks for a number from 1 to `count`; null when the person gives none (Enter, end of input). */
async function choose(io: RewindIo, question: string, count: number): Promise<number | null> {
  for (;;) {
    const answer = await io.ask(question);
    if (answer === null || answer.trim() === "") return null;
    const n = Number(answer.trim());
    if (Number.isInteger(n) && n >= 1 && n <= count) return n;
    io.line(`Give a number from 1 to ${count}, or press Enter to cancel.`);
  }
}

/** Runs `/rewind`; null when the person cancelled or there was nothing to rewind to. */
export async function rewindInteractively(
  client: Client,
  sessionId: string,
  io: RewindIo,
): Promise<RewindDone | null> {
  const { checkpoints } = await client.request("session.checkpoints", { sessionId });
  if (checkpoints.length === 0) {
    io.line("Nothing to rewind to yet: no messages in this conversation.");
    return null;
  }
  const newest = [...checkpoints].reverse();
  io.line("Rewind to the point just before one of your messages (newest first):");
  newest.forEach((c, i) => {
    io.line(`  ${i + 1}. ${when(c.time)}  ${oneLine(c.prompt, 70)}`);
    const files = c.files.map(
      (f) =>
        `${shown(f.path, io.cwd)}${f.agents.length > 0 ? ` (by ${f.agents.map((a) => `${a.agentId}, ${a.agentType}`).join("; ")})` : ""}`,
    );
    if (files.length > 0) io.line(`       changed ${files.join(", ")}`);
    else if (!c.tracked) io.line("       (its files are no longer kept)");
  });
  io.line(SHELL_CAVEAT);
  const picked = await choose(io, "Which point? Number, or Enter to cancel: ", newest.length);
  if (picked === null) return cancelled(io);
  const checkpoint = newest[picked - 1] as Checkpoint;

  const offered = ACTIONS.filter((a) => !a.files || checkpoint.restore.length > 0);
  if (checkpoint.restore.length > 0) {
    io.line("Restoring files would:");
    for (const step of checkpoint.restore) {
      const what = step.action === "delete" ? "remove" : "put back";
      const outside = step.changedOutside ? " (changed outside dawg since)" : "";
      io.line(`  ${what} ${shown(step.path, io.cwd)}${outside}`);
    }
  } else {
    io.line("No files to put back from this point.");
  }
  offered.forEach((a, i) => {
    io.line(`  ${i + 1}. ${a.label}`);
  });
  const chosen = await choose(io, "What to do? Number, or Enter to cancel: ", offered.length);
  if (chosen === null) return cancelled(io);
  const action = (offered[chosen - 1] as (typeof ACTIONS)[number]).action;

  let instructions: string | null = null;
  if (action === "summarize") {
    const answer = await io.ask("What should the summary concentrate on? (Enter for nothing): ");
    instructions = answer?.trim() || null;
  }

  const request = (overwrite: boolean) =>
    client.request("session.rewind", {
      sessionId,
      checkpointId: checkpoint.id,
      action,
      ...(overwrite ? { overwrite } : {}),
      ...(instructions === null ? {} : { instructions }),
    });
  let result = await request(false);
  if (result.outcome === "conflicts") {
    io.line("These files changed outside dawg since its file tools last wrote them:");
    for (const file of result.conflicts) io.line(`  ${shown(file, io.cwd)}`);
    const answer = await io.ask("Overwrite them with how they were? [y/N]: ");
    if (answer === null || !/^y(es)?$/i.test(answer.trim())) return cancelled(io);
    result = await request(true);
  }

  if (result.files !== null) {
    const { restored, deleted, skipped } = result.files;
    if (restored.length + deleted.length === 0 && skipped.length === 0) {
      io.line("The files were already as they were at that point.");
    }
    for (const file of restored) io.line(`Put back ${shown(file, io.cwd)}.`);
    for (const file of deleted) io.line(`Removed ${shown(file, io.cwd)}.`);
    for (const skip of skipped) io.line(`Left ${shown(skip.path, io.cwd)}: ${skip.reason}.`);
  }
  if (result.session !== null) {
    io.line(
      `The conversation goes on in session ${result.session.session.id}, from before that message. The original, ${sessionId}, is kept as it was.`,
    );
  }
  if (result.prompt !== null && action !== "files") {
    io.line(`Your message was: ${oneLine(result.prompt, 200)}`);
  }
  return {
    session: result.session,
    prompt: action === "files" ? null : result.prompt,
    summarizing: action === "summarize",
  };
}

function cancelled(io: RewindIo): null {
  io.line("Nothing was changed.");
  return null;
}

/** The editor the person set (`$VISUAL`, else `$EDITOR`), split into command and arguments. */
export function editorCommand(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env.VISUAL?.trim() || env.EDITOR?.trim() || "";
  if (raw === "") return null;
  const words = raw.split(/\s+/);
  return words.length > 0 ? words : null;
}

/** Opens a file in the person's editor and waits for it to close. Resolves with the exit code. */
export function openInEditor(command: readonly string[], file: string): Promise<number | null> {
  const [program, ...args] = command;
  if (program === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(program, [...args, file], { stdio: "inherit" });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}
