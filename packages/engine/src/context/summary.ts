/**
 * The text compaction sends and writes: the request for a summary, the note that carries the
 * summary into the new view, the note with the recently used files, and the fallback used when
 * the model gives no summary at all. All of it uses the note format from prompt/notes.ts.
 */
import type { TaskItem } from "@dawg/protocol";
import type { Message, UserMessage } from "../contracts/messages.ts";
import { DEFAULT_TOOL_LIMITS } from "../contracts/tools.ts";
import { noteMessage } from "../prompt/notes.ts";
import { displayLines, formatNumberedLines } from "../tools/files/index.ts";

/** The sections the summary must have, in order of importance (a cut-off summary keeps the first). */
const SECTIONS = `## Goal
What the user wants overall, in a sentence or two.

## User instructions
Every instruction, preference, correction and constraint from the user that still applies, quoted where the wording matters. Include anything the user said must not be forgotten.

## Current state
What is done and checked, what is in progress, and the last thing you did.

## Next steps
What remains, in order, specific enough to start on the first one at once.

## Decisions
Choices made and why, and approaches that failed and should not be tried again.

## Files
Each file read or changed: its path, and what changed in it or matters about it.

## Key facts
Commands that build, test or run the project, and the names, values, errors and code you will need again.`;

export function summaryRequestBody(focus: string | null, retry: boolean): string {
  const parts = [
    "This conversation is being compacted: everything above will be replaced by the summary you write now, and you will continue the work from it. Write it for yourself.",
    "Do not call any tools. Reply with only the summary, as plain text with these sections in this order:",
    SECTIONS,
    "Be specific: exact names, paths, commands and error messages. Leave out what no longer matters. Keep it under about 1,500 words. If the instruction files say what a summary should keep, follow them.",
  ];
  if (focus !== null && focus.trim() !== "") {
    parts.push(
      `The user asked this summary to concentrate on: ${focus.trim()}\nGive that the most detail, and keep the other sections short.`,
    );
  }
  if (retry) {
    parts.push(
      "Your previous reply did not contain the summary. Write it now as plain text, without calling tools, and keep your thinking short.",
    );
  }
  return parts.join("\n\n");
}

export function summaryRequestMessage(focus: string | null, retry: boolean): UserMessage {
  return noteMessage(summaryRequestBody(focus, retry));
}

function taskLines(tasks: readonly TaskItem[]): string {
  return tasks.map((task) => `- ${task.status}: ${task.content}`).join("\n");
}

/** The note that replaces the summarised conversation. */
export function summaryNote(
  summary: string,
  tasks: readonly TaskItem[],
  recentFollow: boolean,
): UserMessage {
  const lead = recentFollow
    ? "This session was compacted to save context. The summary below, which you wrote, replaces the earlier conversation. The most recent messages follow it unchanged."
    : "This session was compacted to save context. The summary below, which you wrote, replaces the earlier conversation.";
  const parts = [lead, summary];
  if (tasks.length > 0)
    parts.push(`Your task list at the time of compaction:\n${taskLines(tasks)}`);
  return noteMessage(parts.join("\n\n"));
}

export interface FilesNotePlan {
  shown: { path: string; content: string }[];
  /** Left out because they are too large, or because there was no room. */
  omitted: string[];
}

/** The note with fresh copies of recently used files, numbered as Read numbers lines. */
export function filesNote(plan: FilesNotePlan): UserMessage | null {
  if (plan.shown.length === 0 && plan.omitted.length === 0) return null;
  const parts: string[] = [];
  if (plan.shown.length > 0) {
    parts.push(
      "Files you worked with recently, as they are now, with line numbers as Read shows them:",
    );
    for (const file of plan.shown) {
      const lines = displayLines(file.content);
      const body =
        lines.length === 0
          ? "(empty file)"
          : formatNumberedLines(lines, 1, DEFAULT_TOOL_LIMITS.readMaxLineChars).text;
      parts.push(`<file path="${file.path}">\n${body}\n</file>`);
    }
  }
  if (plan.omitted.length > 0) {
    parts.push(
      `Also used recently, but not shown here to save space; Read them again if you need them: ${plan.omitted.join(", ")}`,
    );
  }
  return noteMessage(parts.join("\n\n"));
}

function textOf(message: Message): string {
  if (message.role === "system" || message.role === "assistant") return message.content;
  return message.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
}

function filePathOf(argumentsJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed === "object" && parsed !== null && "file_path" in parsed) {
      const value = (parsed as { file_path: unknown }).file_path;
      return typeof value === "string" ? value : null;
    }
  } catch {
    // Arguments are always valid JSON in history; anything else just has no path.
  }
  return null;
}

/**
 * A summary built from the history itself, for when the model gives none twice: the user's own
 * words and the files touched. Thin, but it keeps the session going with nothing invented.
 */
export function fallbackSummary(history: readonly Message[]): string {
  const prompts: string[] = [];
  const files = new Map<string, Set<string>>();
  for (const message of history) {
    if (message.role === "user" && message.kind === "prompt") {
      const text = textOf(message).trim();
      prompts.push(text.length > 1_000 ? `${text.slice(0, 999)}…` : text);
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        const file = filePathOf(call.arguments);
        if (file === null) continue;
        const verbs = files.get(file) ?? new Set<string>();
        verbs.add(call.name);
        files.set(file, verbs);
      }
    }
  }
  const parts = [
    "No written summary could be made, so this records what is known from the conversation itself.",
  ];
  if (prompts.length > 0) {
    const recent = prompts.slice(-10);
    const skipped = prompts.length - recent.length;
    parts.push(
      `## What the user asked${skipped > 0 ? ` (the last ${recent.length} of ${prompts.length} messages)` : ""}\n${recent.map((p) => `- ${p.replace(/\n/g, "\n  ")}`).join("\n")}`,
    );
  }
  if (files.size > 0) {
    parts.push(
      `## Files used\n${[...files].map(([file, verbs]) => `- ${file} (${[...verbs].join(", ")})`).join("\n")}`,
    );
  }
  parts.push(
    "## Next steps\nCheck the current state of the files and the task list before continuing.",
  );
  return parts.join("\n\n");
}
