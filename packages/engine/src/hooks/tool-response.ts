/**
 * `tool_response` for PostToolUse: "structure depends on the tool" (hooks reference). Our tools
 * keep Claude Code's names and inputs; their results are our own, so the shapes scripts read
 * most are rebuilt from what the call reported: a command's output as `stdout`, a written file as
 * `filePath` and `success`. Anything else is the result's text.
 */
import type { ContentPart, ToolDisplay } from "@dawg/protocol";

export function toolResponse(
  content: readonly ContentPart[],
  display: ToolDisplay | null,
): unknown {
  const text = content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  if (display?.kind === "command") {
    return {
      stdout: display.output ?? text,
      stderr: "",
      interrupted: display.interrupted,
      isImage: false,
      ...(display.exitCode === null ? {} : { exitCode: display.exitCode }),
    };
  }
  if (display?.kind === "diff") return { filePath: display.filePath, success: true };
  if (display?.kind === "file") return { filePath: display.filePath, content: text };
  return text;
}
