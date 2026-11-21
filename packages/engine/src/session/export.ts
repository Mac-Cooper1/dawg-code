/**
 * A session as readable Markdown, for `/export`. Shows the whole transcript, including what
 * compaction later removed from the model's view.
 */
import type { ContentPart } from "@dawg/protocol";
import type { MetaRecord, SessionRecord, StateChanges } from "./records.ts";
import { replay } from "./replay.ts";

export interface ExportOptions {
  /** Characters of each tool result kept; the rest is cut with a note. Default 2,000. */
  maxResultChars?: number;
  /** Include reasoning text. Default true. */
  reasoning?: boolean;
}

/** A code fence longer than any run of backticks in `text`, so the text cannot close it. */
function fenced(text: string, language = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function trimmed(text: string, max: number): string {
  if (text.length <= max) return text;
  // Cut at a line end near the limit when there is one, so the kept part reads cleanly.
  const lineEnd = text.lastIndexOf("\n", max);
  const cut = lineEnd > max * 0.6 ? lineEnd : max;
  const dropped = text.length - cut;
  return `${text.slice(0, cut)}\n… [${dropped.toLocaleString("en-US")} more characters]`;
}

function imageLine(part: Extract<ContentPart, { type: "image" }>): string {
  const bytes = Math.floor((part.data.length * 3) / 4);
  const size =
    bytes >= 1024 ? `${Math.round(bytes / 1024).toLocaleString("en-US")} KB` : `${bytes} B`;
  return `_[image: ${part.mediaType}, ${size}]_`;
}

function partsAsMarkdown(parts: ContentPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : imageLine(part)))
    .filter((s) => s !== "")
    .join("\n\n");
}

function prettyArguments(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function describeState(changes: StateChanges): string[] {
  const lines: string[] = [];
  if (changes.title !== undefined) {
    lines.push(changes.title === null ? "Title cleared." : `Renamed to “${changes.title}”.`);
  }
  if (changes.mode !== undefined) lines.push(`Mode set to \`${changes.mode}\`.`);
  if (changes.model !== undefined) {
    lines.push(
      changes.model === null ? "Model reset to default." : `Model set to \`${changes.model}\`.`,
    );
  }
  if (changes.effort !== undefined) {
    lines.push(
      changes.effort === null ? "Effort reset to default." : `Effort set to \`${changes.effort}\`.`,
    );
  }
  if (changes.archived !== undefined) lines.push(changes.archived ? "Archived." : "Unarchived.");
  if (changes.additionalDirectories !== undefined) {
    lines.push(
      changes.additionalDirectories.length === 0
        ? "Additional directories cleared."
        : `Additional directories: ${changes.additionalDirectories.map((d) => `\`${d}\``).join(", ")}.`,
    );
  }
  if (changes.tasks !== undefined) {
    if (changes.tasks.length === 0) {
      lines.push("Task list cleared.");
    } else {
      const items = changes.tasks.map((task) => {
        const box = task.status === "completed" ? "[x]" : "[ ]";
        const suffix = task.status === "in_progress" ? " _(in progress)_" : "";
        return `- ${box} ${task.content}${suffix}`;
      });
      lines.push(`Task list:\n\n${items.join("\n")}`);
    }
  }
  return lines;
}

function header(meta: MetaRecord, title: string | null): string {
  const lines = [`# ${title ?? "Untitled session"}`, ""];
  lines.push(`- Session: \`${meta.sessionId}\``);
  lines.push(`- Directory: \`${meta.cwd}\``);
  lines.push(`- Started: ${meta.time}`);
  if (meta.forkedFrom) {
    lines.push(`- Forked from: \`${meta.forkedFrom.sessionId}\` at record ${meta.forkedFrom.seq}`);
  }
  return lines.join("\n");
}

export function renderMarkdown(
  records: readonly SessionRecord[],
  options: ExportOptions = {},
): string {
  const maxResult = options.maxResultChars ?? 2000;
  const showReasoning = options.reasoning ?? true;
  const snapshot = replay(records);
  const blocks: string[] = [header(snapshot.meta, snapshot.state.title)];

  for (const record of records) {
    switch (record.type) {
      case "meta":
        break;
      case "user":
        blocks.push(`## Prompt\n\n${partsAsMarkdown(record.message.content)}`);
        break;
      case "note": {
        const text =
          record.message.role === "system"
            ? record.message.content
            : partsAsMarkdown(record.message.content);
        blocks.push(quoted(`**Note**\n\n${text}`));
        break;
      }
      case "assistant": {
        const parts: string[] = ["## Reply"];
        const { reasoning, content, toolCalls } = record.message;
        if (showReasoning && reasoning) {
          parts.push(`<details>\n<summary>Reasoning</summary>\n\n${reasoning}\n\n</details>`);
        }
        if (content !== "") parts.push(content);
        for (const call of toolCalls) {
          parts.push(
            `**Tool call:** \`${call.name}\` (\`${call.id}\`)\n\n${fenced(prettyArguments(call.arguments), "json")}`,
          );
        }
        blocks.push(parts.join("\n\n"));
        break;
      }
      case "tool_result": {
        const { toolName, toolCallId, isError, content } = record.message;
        const label = isError ? "**Tool error:**" : "**Tool result:**";
        const pieces = content.map((part) =>
          part.type === "text" ? fenced(trimmed(part.text, maxResult)) : imageLine(part),
        );
        blocks.push(
          `${label} \`${toolName}\` (\`${toolCallId}\`)\n\n${pieces.join("\n\n") || "_(empty)_"}`,
        );
        break;
      }
      case "state": {
        const lines = describeState(record.changes);
        if (lines.length > 0) blocks.push(`_${record.time}_ — ${lines.join(" ")}`);
        break;
      }
      case "compact": {
        const how = record.trigger === "manual" ? "on request" : "automatically";
        const focus = record.focus ? ` (focus: ${record.focus})` : "";
        blocks.push(
          `---\n\n**Context compacted ${how}${focus}.** Summary:\n\n${quoted(record.summary)}\n\n---`,
        );
        break;
      }
    }
  }
  // A lone UTF-16 surrogate (legal in a JS string, and kept exactly in the transcript) has no
  // UTF-8 form, and control characters make tools treat the file as binary. Show the controls as
  // their Unicode pictures (NUL becomes U+2400) and replace lone surrogates.
  return `${blocks.join("\n\n")}\n`
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(CONTROL, (c) => String.fromCharCode(0x2400 + c.charCodeAt(0)));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
