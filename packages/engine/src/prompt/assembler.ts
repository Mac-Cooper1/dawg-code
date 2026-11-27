/**
 * Builds the static prefix every request starts with: one system message made of three segments
 * in a fixed order, and the tool schemas beside it.
 *
 *   1. core instructions        (core.ts; changes only with an app update)
 *   2. tool guidance            (guidance.ts; changes only when the tool set changes)
 *   3. skill listing            (../skills/listing.ts; fixed for a session; absent when empty)
 *   3b. MCP servers             (../mcp/prompt.ts; fixed for a session; absent without servers)
 *   4. instruction files        (the caller's rendered text; absent when empty)
 *   5. memory                   (../memory: how to keep it, and MEMORY.md as the session opened;
 *                                fixed for a session; absent when auto memory is off)
 *
 * Segments are joined by one blank line. The output depends only on the tools (names,
 * descriptions, schemas, in the order given) and the instruction text: nothing is read from the
 * clock, the environment or the machine, and the key order of the input objects does not matter.
 * See docs/specs/phase-2-engine-core.md, "Prompt assembly and cache stability".
 */
import { createHash } from "node:crypto";
import type { ToolSchema } from "../contracts/model.ts";
import type { PromptAssembler, PromptPrefix } from "../contracts/prompt.ts";
import type { AnyTool } from "../contracts/tools.ts";
import { CORE_INSTRUCTIONS } from "./core.ts";
import { ALL_GUIDANCE_TEXT, renderToolGuidance } from "./guidance.ts";
import { quoteNoteMarkers, renderNote, renderSessionContext } from "./notes.ts";
import { canonicalizeSchema } from "./schema.ts";

const SEGMENT_SEPARATOR = "\n\n";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Identifies the core instructions and tool guidance (everything in the prefix that comes from
 * this app rather than from the tools or the user's files). A saved prompt cache can be keyed on
 * it together with `promptPrefixKey`. It is a hash of the text, so it changes whenever the text
 * does and cannot be forgotten.
 */
export const CORE_INSTRUCTIONS_VERSION = `core-${sha256(
  `${CORE_INSTRUCTIONS}\u0000${ALL_GUIDANCE_TEXT}\u0000${SEGMENT_SEPARATOR}`,
).slice(0, 16)}`;

export function toToolSchema(tool: AnyTool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: canonicalizeSchema(tool.inputSchema),
  };
}

export function buildPromptPrefix(input: {
  tools: readonly AnyTool[];
  instructions: string;
  skills?: string;
  mcp?: string;
  memory?: string;
  /** A subagent's own instructions, in place of the core instructions (../agents). */
  agent?: string;
}): PromptPrefix {
  const seen = new Set<string>();
  for (const tool of input.tools) {
    if (seen.has(tool.name)) throw new TypeError(`Two tools are named ${tool.name}.`);
    seen.add(tool.name);
  }
  const agent = input.agent ?? "";
  const segments = [agent !== "" ? agent : CORE_INSTRUCTIONS];
  const guidance = renderToolGuidance(seen);
  if (guidance !== "") segments.push(guidance);
  if (input.skills !== undefined && input.skills.trim() !== "") segments.push(input.skills);
  if (input.mcp !== undefined && input.mcp.trim() !== "") segments.push(input.mcp);
  if (input.instructions.trim() !== "") segments.push(input.instructions);
  if (input.memory !== undefined && input.memory.trim() !== "") segments.push(input.memory);
  return {
    system: { role: "system", content: segments.join(SEGMENT_SEPARATOR) },
    tools: input.tools.map(toToolSchema),
  };
}

/**
 * A digest of the exact bytes of a prefix: the key under which its warmed or saved prompt cache
 * can be found again. Equal prefixes always give equal keys.
 */
export function promptPrefixKey(prefix: PromptPrefix): string {
  const tools = prefix.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: canonicalizeSchema(t.parameters),
  }));
  return sha256(JSON.stringify({ system: prefix.system.content, tools }));
}

export function createPromptAssembler(): PromptAssembler {
  return {
    prefix: buildPromptPrefix,
    sessionContext: renderSessionContext,
    note: renderNote,
    prompt: (content) => ({
      role: "user",
      content: content.map((part) =>
        part.type === "text" ? { type: "text", text: quoteNoteMarkers(part.text) } : part,
      ),
      kind: "prompt",
    }),
    quote: quoteNoteMarkers,
  };
}
