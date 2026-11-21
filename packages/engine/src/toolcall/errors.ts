/**
 * The tool-result texts given to the model when a call cannot run.
 *
 * Each one names the tool and what went wrong, shows what the model sent, and says what to do.
 * The wording is fixed (no dates, counters or random ids), so the same mistake always produces the
 * same text and history stays byte-stable for the prompt cache.
 */
import type { ToolSchema } from "../contracts/model.ts";
import type { ParseFailure } from "./json-parse.ts";
import { describeFields } from "./schema.ts";
import type { ValidationIssue } from "./validate.ts";

const MAX_ISSUES_SHOWN = 10;
const MAX_PREVIEW = 800;
const MAX_STRING = 60;
const MAX_ITEMS = 5;
const MAX_DEPTH = 3;

/**
 * Compact JSON of what the model sent, with long strings and arrays shortened, so the model can
 * see its own fields without the whole of a large file being repeated back.
 */
export function previewArguments(value: unknown): string {
  const text = render(value, 0);
  return text.length <= MAX_PREVIEW ? text : `${text.slice(0, MAX_PREVIEW)}… (cut)`;
}

function render(v: unknown, depth: number): string {
  if (typeof v === "string") {
    if (v.length <= MAX_STRING) return JSON.stringify(v);
    return `${JSON.stringify(v.slice(0, MAX_STRING)).slice(0, -1)}…" (${v.length} characters)`;
  }
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return v.length === 0 ? "[]" : "[…]";
    const shown = v.slice(0, MAX_ITEMS).map((x) => render(x, depth + 1));
    if (v.length > MAX_ITEMS) shown.push(`… ${v.length - MAX_ITEMS} more`);
    return `[${shown.join(",")}]`;
  }
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    if (depth >= MAX_DEPTH) return keys.length === 0 ? "{}" : "{…}";
    const obj = v as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${render(obj[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function takesLine(tool: ToolSchema): string {
  return `${tool.name} takes: ${describeFields(tool.parameters)}.`;
}

/** The arguments parsed but do not fit the schema. */
export function invalidArgumentsMessage(
  tool: ToolSchema,
  issues: readonly ValidationIssue[],
  sent: Record<string, unknown>,
): string {
  const lines = [`${tool.name} was not run: its arguments do not match its input schema.`];
  for (const issue of issues.slice(0, MAX_ISSUES_SHOWN)) {
    lines.push(issue.path === "" ? `- ${issue.problem}` : `- \`${issue.path}\`: ${issue.problem}`);
  }
  if (issues.length > MAX_ISSUES_SHOWN) {
    lines.push(`- and ${issues.length - MAX_ISSUES_SHOWN} more problems`);
  }
  lines.push(takesLine(tool));
  lines.push(`You sent: ${previewArguments(sent)}`);
  lines.push(`Fix the arguments and call ${tool.name} again.`);
  return lines.join("\n");
}

/** The arguments could not be read as a JSON object, even after the safe repairs. */
export function unparseableArgumentsMessage(
  tool: ToolSchema,
  failure: ParseFailure,
  raw: string,
): string {
  const near = failure.near === null ? "" : ` (near \`${failure.near}\`)`;
  let problem: string;
  switch (failure.kind) {
    case "not_object":
      problem = `its arguments must be a JSON object ({...}), but ${failure.detail}.`;
      break;
    case "multiple_objects":
      problem = `its arguments hold more than one JSON object${near}. Send one object per call, and make a separate call for each action.`;
      break;
    case "duplicate_key":
      problem = `its arguments are ambiguous: ${failure.detail}${near}.`;
      break;
    default:
      problem = `its arguments are not valid JSON: ${failure.detail}${near}.`;
  }
  const lines = [`${tool.name} was not run: ${problem}`, takesLine(tool)];
  const shown = raw.trim();
  if (shown !== "") {
    const head =
      shown.length > 120 ? `${shown.slice(0, 120)}… (${shown.length} characters)` : shown;
    lines.push(`You sent: ${head}`);
  }
  lines.push(`Send the arguments as one JSON object and call ${tool.name} again.`);
  return lines.join("\n");
}

/** The reply hit the output token limit while this call was being written. */
export function truncatedCallMessage(toolName: string): string {
  return [
    `${toolName} was not run: the reply reached the output length limit while this call was being written, so its arguments are incomplete.`,
    "Send less in one call: split long content over several calls (for example, write the first part of a file, then add the rest with further edits).",
  ].join("\n");
}

/** The model named a tool that does not exist. */
export function unknownToolMessage(
  name: string,
  tools: readonly ToolSchema[],
  suggestion: string | null,
): string {
  const hint = suggestion === null ? "" : ` Did you mean ${suggestion}?`;
  const available =
    tools.length === 0
      ? "No tools are available."
      : `Available tools: ${tools.map((t) => t.name).join(", ")}.`;
  return `There is no tool named ${JSON.stringify(name)}, so nothing was run.${hint}\n${available}`;
}

/** A call written in the reply's text was recognised, but its contents could not be read. */
export function unreadableProseCallMessage(tool: ToolSchema, detail: string): string {
  return [
    `${tool.name} was not run: a call to it was found in the reply's text, but it could not be read (${detail}).`,
    takesLine(tool),
    `Call ${tool.name} again with all of its arguments.`,
  ].join("\n");
}

/**
 * For the turn loop to give the model when the reply was cut off inside call markup that named no
 * tool yet, so no call could be recorded.
 */
export const TRUNCATED_UNNAMED_CALL_NOTICE =
  "Your last reply reached the output length limit while it was starting a tool call, so no tool was run. Send less in one call: split long content over several calls.";
