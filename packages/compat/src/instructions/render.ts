import { attr } from "./read.ts";
import type { InstructionFile } from "./types.ts";

const LEAD =
  "Instruction files written by the user and the project follow, broadest scope first. " +
  "Treat them as standing guidance for this session.";

/**
 * Renders instruction files as one text block for the prompt. The output depends only on the
 * files given, in the order given: no times, counters or other volatile text, so the same files
 * always produce the same bytes and the prompt prefix stays cacheable. An empty list renders as
 * an empty string.
 */
export function renderInstructions(files: readonly InstructionFile[]): string {
  if (files.length === 0) return "";
  const blocks = [LEAD];
  for (const file of files) {
    const scope = file.paths === null ? "" : ` applies-to="${attr(file.paths.join(", "))}"`;
    const body = file.content.replace(/\s+$/, "");
    blocks.push(
      `<instructions source="${attr(file.path)}" kind="${file.kind}"${scope}>\n${body}\n</instructions>`,
    );
  }
  return `${blocks.join("\n\n")}\n`;
}
