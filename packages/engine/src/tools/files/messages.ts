/** Wording shared by the file tools for the mistakes they all see. */
import { readdir } from "node:fs/promises";
import type { ContentPart } from "@dawg/protocol";
import type { ToolOutput } from "../../contracts/index.ts";
import { helpForMissingPath } from "./suggest.ts";

export function errorResult(text: string): ToolOutput {
  return { content: [{ type: "text", text }], isError: true };
}

export function textParts(text: string): ContentPart[] {
  return [{ type: "text", text }];
}

/** "File does not exist: <path>." plus what the caller may have meant. */
export async function missingFileMessage(
  filePath: string,
  rawInput: string,
  workingDirectories: readonly string[],
): Promise<string> {
  const help = await helpForMissingPath(filePath, { rawInput, workingDirectories });
  const lines = [`File does not exist: ${filePath}`];
  if (help.missingDirectory !== null) {
    lines.push(`The directory ${help.missingDirectory} does not exist either.`);
  }
  if (help.suggestions.length === 1) {
    lines.push(`Did you mean ${help.suggestions[0]}?`);
  } else if (help.suggestions.length > 1) {
    lines.push("Did you mean one of these?", ...help.suggestions.map((s) => `  ${s}`));
  } else {
    lines.push("No similarly named file was found nearby. Use Glob to search for it.");
  }
  return lines.join("\n");
}

/** "<path> is a directory" with a short listing, which often saves the model a call. */
export async function directoryMessage(dirPath: string, tool: string): Promise<string> {
  const head = `${dirPath} is a directory, not a file. ${tool} works on files only.`;
  let names: string[];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return `${head} To see what it contains, use Glob or run ls.`;
  }
  if (names.length === 0) return `${head} It is empty.`;
  const max = 30;
  const shown = names.slice(0, max).join(", ");
  const more = names.length > max ? ` and ${names.length - max} more` : "";
  return `${head} It contains: ${shown}${more}.`;
}
