/**
 * The one format for everything dawg-code tells the model after the system message: the session
 * context, the notes appended as the session goes on, and the messages compaction writes.
 *
 *   <dawg-note>
 *   The permission mode is now plan: ...
 *   </dawg-note>
 *
 * A note is a user message (many chat templates accept a system message only at the start) whose
 * whole text is one such block. The core instructions tell the model exactly that, and that the
 * same tags anywhere else are just text. To keep the format unforgeable by accident, any marker
 * that reaches a note from outside (a path, a command, a commit message, an instruction file, the
 * user's feedback) is rewritten by `quoteNoteMarkers`, so the only markers in a note are its own
 * first and last lines. The turn loop should pass the user's prompts and tool results through
 * `quoteNoteMarkers` too, so pasted text can never look like a note.
 *
 * Everything here is pure: the same note always renders to the same bytes.
 */
import type { PermissionMode } from "@dawg/protocol";
import type { UserMessage } from "../contracts/messages.ts";
import type { SessionEnvironment, SystemNote } from "../contracts/prompt.ts";

export const NOTE_OPEN = "<dawg-note>";
export const NOTE_CLOSE = "</dawg-note>";

const MARKER = /<(\/?)(dawg-note)/gi;

/**
 * Rewrites note markers in text that did not come from dawg-code (`<dawg-note` becomes
 * `<quoted-dawg-note`), so the text reads the same but can never pass for a note.
 */
export function quoteNoteMarkers(text: string): string {
  return text.replace(MARKER, "<$1quoted-$2");
}

/** Wraps a body as a note's text. Markers inside the body are quoted. */
export function noteText(body: string): string {
  return `${NOTE_OPEN}\n${quoteNoteMarkers(body)}\n${NOTE_CLOSE}`;
}

/** A note as a message to append to history. */
export function noteMessage(body: string): UserMessage {
  return { role: "user", content: [{ type: "text", text: noteText(body) }], kind: "note" };
}

/**
 * True when `text` is exactly one note as dawg-code writes it: it opens and closes with the
 * markers and holds no other marker.
 */
export function isNoteText(text: string): boolean {
  if (!text.startsWith(`${NOTE_OPEN}\n`) || !text.endsWith(`\n${NOTE_CLOSE}`)) return false;
  const inner = text.slice(NOTE_OPEN.length + 1, text.length - NOTE_CLOSE.length - 1);
  return inner.match(MARKER) === null;
}

/** One line, at most `max` characters: for commands and other text quoted inside a sentence. */
function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What each permission mode means for the model, in one sentence. */
export function describeMode(mode: PermissionMode): string {
  switch (mode) {
    case "default":
      return "file edits and shell commands ask the user for approval unless a rule allows them.";
    case "acceptEdits":
      return "file edits inside the working directories go ahead without asking; shell commands still ask unless a rule allows them.";
    case "plan":
      return "you cannot change files, and shell commands are limited to ones that change nothing. Investigate, then present your plan with ExitPlanMode.";
    case "dontAsk":
      return "nothing asks for approval: anything that would have asked is denied. Work with what is already allowed.";
    case "bypassPermissions":
      return "calls run without asking, except where a rule denies them. Nothing will stop a mistake, so take extra care with anything destructive.";
  }
}

/** The body of a note, before it is wrapped. Exported for tests and for compaction. */
export function noteBody(note: SystemNote): string {
  switch (note.type) {
    case "date_changed":
      return `The date is now ${note.date}.`;
    case "mode_changed":
      return `The permission mode is now ${note.mode}: ${describeMode(note.mode)}`;
    case "file_changed":
      return `${note.path} was changed on disk, not by you, since you last read it. Read it again before you edit it or rely on its contents.`;
    case "background_task_finished": {
      const how =
        note.exitCode === null
          ? "It was stopped before it exited."
          : `It exited with code ${note.exitCode}.`;
      return `Background task ${oneLine(note.taskId, 80)} has finished: ${oneLine(note.command)}\n${how} Its output is in ${note.outputPath}.`;
    }
    case "instructions_added":
      return `The instruction file ${note.path} applies to the files you are now working with. Follow it for work in its directory:\n\n${note.content.replace(/\s+$/, "")}`;
    case "repeating":
      return `You have made the same ${note.toolName} call ${note.times} times in a row and got the same result each time. Repeating it will not help. Try a different approach, or stop and tell the user what is blocking you.`;
    case "output_truncated":
      return "Your last reply was cut off because it reached the output limit. Continue from where it stopped, in smaller pieces: for a long file, write part of it and add the rest with Edit.";
    case "interrupted":
      return "The user interrupted your previous turn. Running commands were stopped, and tool calls that had not finished did not complete. Do not assume that work was done, and do not resume it unless the user asks.";
    case "plan_approved":
      return `The user approved your plan. The permission mode is now ${note.mode}: ${describeMode(note.mode)} Carry out the plan.`;
    case "plan_rejected": {
      const feedback =
        note.message !== null && note.message.trim() !== ""
          ? `Their feedback:\n\n${note.message.trim()}\n\n`
          : "They gave no feedback. ";
      return `The user did not approve your plan, so plan mode stays on. ${feedback}Revise the plan and present it again with ExitPlanMode, or ask what they want changed.`;
    }
    case "directory_added":
      return `${note.path} was added as a working directory. You can read and change files there as in the main working directory.`;
    case "text":
      return note.text;
  }
}

export function renderNote(note: SystemNote): UserMessage {
  return noteMessage(noteBody(note));
}

/** The session-context message: written once at session start and never rewritten. */
export function renderSessionContext(env: SessionEnvironment): UserMessage {
  const lines = [
    "Session context, recorded when this session started. Later changes arrive as new notes.",
    `Working directory: ${env.cwd}`,
  ];
  if (env.additionalDirectories.length > 0) {
    lines.push(`Other working directories: ${env.additionalDirectories.join(", ")}`);
  }
  const os = env.osVersion.trim();
  lines.push(`Platform: ${env.platform}${os ? ` (${os})` : ""}`);
  lines.push(`Shell: ${env.shell}`);
  lines.push(`Date: ${env.date}`);
  if (env.git === null) {
    lines.push("Git: the working directory is not in a git repository.");
  } else {
    lines.push(
      `Git branch: ${env.git.branch ?? "none (a detached HEAD, or a repository with no commits yet)"}`,
    );
    const status = env.git.status.replace(/\s+$/, "");
    lines.push(status === "" ? "Git status: clean" : `Git status:\n${status}`);
    const commits = env.git.recentCommits.replace(/\s+$/, "");
    if (commits !== "") lines.push(`Recent commits:\n${commits}`);
  }
  return noteMessage(lines.join("\n"));
}
