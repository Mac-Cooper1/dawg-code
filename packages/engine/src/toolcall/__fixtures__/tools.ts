/**
 * Tool schemas shaped like the phase-2 tool set, for the pipeline tests. They are hand-written
 * here so the tests do not depend on the real tools, which are built separately.
 */
import type { ToolSchema } from "../../contracts/model.ts";

export const Read: ToolSchema = {
  name: "Read",
  description: "Reads a file.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path." },
      offset: { type: "integer", minimum: 1, description: "First line." },
      limit: { type: "integer", minimum: 1, description: "Number of lines." },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
};

export const Write: ToolSchema = {
  name: "Write",
  description: "Writes a file.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path." },
      content: { type: "string", description: "The whole file." },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
};

export const Edit: ToolSchema = {
  name: "Edit",
  description: "Replaces text in a file.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path." },
      old_string: { type: "string", description: "Text to replace." },
      new_string: { type: "string", description: "Replacement." },
      replace_all: { type: "boolean", description: "Replace every match." },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

export const Bash: ToolSchema = {
  name: "Bash",
  description: "Runs a shell command.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command." },
      timeout: { type: "integer", maximum: 600000, description: "Milliseconds." },
      run_in_background: { type: "boolean", description: "Run without waiting." },
      description: { type: "string", description: "What it does." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const Glob: ToolSchema = {
  name: "Glob",
  description: "Finds files by pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Directory." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const Grep: ToolSchema = {
  name: "Grep",
  description: "Searches file contents.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression." },
      path: { type: "string", description: "File or directory." },
      glob: { type: "string", description: "File filter." },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "What to return.",
      },
      "-i": { type: "boolean", description: "Ignore case." },
      "-n": { type: "boolean", description: "Line numbers." },
      "-C": { type: "integer", description: "Context lines." },
      head_limit: { type: "integer", description: "Cap on results." },
      multiline: { type: "boolean", description: "Patterns span lines." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const TodoWrite: ToolSchema = {
  name: "TodoWrite",
  description: "Replaces the task list.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The whole list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string", minLength: 1 },
          },
          required: ["content", "status", "activeForm"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
};

export const EnterPlanMode: ToolSchema = {
  name: "EnterPlanMode",
  description: "Switches to planning.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const ExitPlanMode: ToolSchema = {
  name: "ExitPlanMode",
  description: "Presents the plan.",
  parameters: {
    type: "object",
    properties: { plan: { type: "string", description: "The plan." } },
    required: ["plan"],
    additionalProperties: false,
  },
};

/** A tool with the shapes the phase-2 tools do not use: lists of scalars, nullables, objects. */
export const Search: ToolSchema = {
  name: "web_search",
  description: "Searches the web.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Query." },
      domains: { type: "array", items: { type: "string" }, description: "Allowed domains." },
      years: { type: "array", items: { type: "integer" }, description: "Years." },
      max_results: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Cap." },
      region: { type: ["string", "null"], description: "Region code." },
      filters: {
        type: "object",
        properties: { safe: { type: "boolean" }, lang: { type: "string" } },
        additionalProperties: false,
        description: "Filters.",
      },
      ratio: { type: "number", description: "A fraction." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const TOOLS: readonly ToolSchema[] = [
  Read,
  Write,
  Edit,
  Bash,
  Glob,
  Grep,
  TodoWrite,
  EnterPlanMode,
  ExitPlanMode,
  Search,
];
