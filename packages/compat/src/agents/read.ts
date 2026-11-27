/**
 * One subagent file into a definition: its front matter as Claude Code documents it
 * (code.claude.com/docs/en/sub-agents, "Supported frontmatter fields"), and a note for every
 * field dawg ignores, maps or runs differently (principle 2).
 *
 * Claude Code skips a file without a `name`, with front matter that is not valid YAML, or with a
 * name but no description; here such a file is `invalid`, with why.
 */
import type { CompatSource, PermissionMode } from "@dawg/protocol";
import { readFrontMatter } from "../report/files.ts";
import { booleanField, listField, textField } from "../skills/frontmatter.ts";
import type { AgentDefinition } from "./types.ts";

/** Every field the documentation lists. */
export const AGENT_KEYS = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "maxTurns",
  "autoCompactWindow",
  "skills",
  "mcpServers",
  "hooks",
  "memory",
  "background",
  "omitClaudeMd",
  "effort",
  "isolation",
  "color",
  "initialPrompt",
  "experimental",
] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set(AGENT_KEYS);

/** The names of dawg's built-in agents; a file with one of these names takes its place. */
export const BUILT_IN_AGENT_NAMES: readonly string[] = ["Explore", "Plan", "general-purpose"];

/** Documented: a name may be up to 256 characters, may not start with "-" or hold ":". */
export function refusedAgentName(name: string): string | null {
  if (name.length > 256) return "The name is longer than 256 characters";
  if (name.startsWith("-")) return `The name “${name}” starts with “-”`;
  if (name.includes(":")) return `The name “${name}” has a “:”, which names plugin agents`;
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return `The name “${name}” has an invisible character`;
  return null;
}

/** Scopes whose files the project supplies. */
const PROJECT_SCOPES: ReadonlySet<CompatSource["scope"]> = new Set(["project", "local", "nested"]);

/** Modes looser than asking first: from a project file they are project-supplied power. */
const LOOSE_MODES: ReadonlySet<PermissionMode> = new Set(["acceptEdits", "bypassPermissions"]);

/** A `tools` entry written as a permission rule, `Tool(specifier)`. */
const RULE_ENTRY = /^([A-Za-z_][\w-]*)\((.*)\)$/s;

/** The tool an entry of `tools` or `disallowedTools` names: "Bash" for `Bash(npm test *)`. */
export function toolNameOf(entry: string): string {
  const match = RULE_ENTRY.exec(entry.trim());
  return match?.[1] ?? entry.trim();
}

/**
 * The entries of `tools` that are granted as allow rules while the agent runs: those written
 * with a specifier, apart from `Agent(...)`, which only says which agents it may start.
 */
export function toolGrants(def: Pick<AgentDefinition, "tools">): string[] {
  return (def.tools ?? []).filter((entry) => {
    const match = RULE_ENTRY.exec(entry.trim());
    return match !== null && match[1] !== "Agent";
  });
}

/**
 * Whether a definition is power the project supplies (spec, principle 3): a project file that
 * grants its agent tools (`tools` entries with a specifier) or sets a mode looser than asking
 * first. Its grants and its mode apply only once the person has approved the project's code;
 * until then the agent runs with the parent's mode and rules, which is still safe. The prompt
 * itself is text, not code, and loads either way.
 */
export function isProjectAgentCode(
  def: Pick<AgentDefinition, "source" | "tools" | "permissionMode">,
): boolean {
  if (!PROJECT_SCOPES.has(def.source.scope)) return false;
  const loose = def.permissionMode !== null && LOOSE_MODES.has(def.permissionMode);
  return loose || toolGrants(def).length > 0;
}

class Notes {
  readonly list: string[] = [];
  partial = false;
  add(text: string, partial: boolean): void {
    this.list.push(text);
    if (partial) this.partial = true;
  }
}

const MODES: Readonly<Record<string, PermissionMode>> = {
  default: "default",
  manual: "default",
  acceptedits: "acceptEdits",
  plan: "plan",
  dontask: "dontAsk",
  bypasspermissions: "bypassPermissions",
};

/** Reads one file. Never throws: a file that cannot be used comes back `invalid`, with why. */
export async function readAgentFile(path: string, source: CompatSource): Promise<AgentDefinition> {
  const base = emptyAgent(path, source);
  const read = await readFrontMatter(path);
  if (read.kind === "missing") {
    return { ...base, status: "invalid", notes: ["The file could not be read."] };
  }
  if (read.kind === "invalid") return { ...base, status: "invalid", notes: [read.message] };
  return defineAgent(base, read.fields, read.body);
}

/** A definition with nothing set, named after its file. */
export function emptyAgent(path: string, source: CompatSource): AgentDefinition {
  const file = path.split(/[\\/]/).pop() ?? path;
  return {
    name: file.replace(/\.md$/, ""),
    description: "",
    tools: null,
    disallowedTools: [],
    model: null,
    permissionMode: null,
    maxTurns: null,
    skills: [],
    background: false,
    isolation: null,
    prompt: "",
    path,
    source,
    status: "loaded",
    notes: [],
    shadowedBy: null,
  };
}

/** The definition front matter and a body make, on top of what the file's place says. */
export function defineAgent(
  base: AgentDefinition,
  fields: Record<string, unknown> | null,
  body: string,
): AgentDefinition {
  const name = fields === null ? null : textField(fields, "name");
  const description = fields === null ? null : textField(fields, "description");
  if (fields === null || name === null || description === null) {
    const missing = [name === null && "a name", description === null && "a description"]
      .filter((part): part is string => typeof part === "string")
      .join(" and ");
    return {
      ...base,
      name: name ?? base.name,
      status: "invalid",
      notes: [`Needs ${missing} in its front matter, as Claude Code requires.`],
    };
  }
  const refused = refusedAgentName(name);
  if (refused !== null) {
    return { ...base, name, status: "invalid", notes: [`${refused}, so it does not load.`] };
  }

  const notes = new Notes();
  for (const key of Object.keys(fields)) {
    if (!KNOWN_KEYS.has(key)) notes.add(`Unknown field “${key}” is ignored.`, false);
  }
  if (BUILT_IN_AGENT_NAMES.includes(name)) {
    notes.add(`Takes the place of dawg's built-in ${name} agent.`, false);
  }

  const tools = "tools" in fields ? listField(fields, "tools") : null;
  const agentEntries = (tools ?? []).filter((entry) => toolNameOf(entry) === "Agent");
  if (agentEntries.length > 0) {
    notes.add("Agent in tools is ignored: a subagent cannot start other agents in dawg.", true);
  }

  const rawModel = textField(fields, "model");
  const model = rawModel === null || rawModel.toLowerCase() === "inherit" ? null : rawModel;
  if (model !== null) {
    notes.add(
      `model “${model}” is mapped to the session's model: model names are mapped, not obeyed.`,
      false,
    );
  }

  let permissionMode: PermissionMode | null = null;
  const rawMode = textField(fields, "permissionMode");
  if (rawMode !== null) {
    permissionMode = MODES[rawMode.toLowerCase()] ?? null;
    if (permissionMode === null) {
      notes.add(
        rawMode.toLowerCase() === "auto"
          ? "permissionMode auto is not available in dawg, so the parent's mode applies."
          : `permissionMode “${rawMode}” is not a documented mode, so the parent's mode applies.`,
        true,
      );
    }
  }

  let maxTurns: number | null = null;
  if ("maxTurns" in fields) {
    const value = Number(fields.maxTurns);
    if (Number.isInteger(value) && value > 0) maxTurns = value;
    else notes.add("maxTurns is not a positive whole number, so it is ignored.", true);
  }

  const background = booleanField(fields, "background");
  if (background === undefined) {
    notes.add("background is not true or false, so it is left at false.", true);
  }

  let isolation: "worktree" | null = null;
  const rawIsolation = textField(fields, "isolation");
  if (rawIsolation !== null) {
    if (rawIsolation.toLowerCase() === "worktree") isolation = "worktree";
    else
      notes.add(`isolation “${rawIsolation}” is not a documented value, so it is ignored.`, true);
  }

  const ignored: [key: string, why: string][] = [
    ["mcpServers", "mcpServers is ignored: subagents do not get MCP tools in dawg yet."],
    ["hooks", "hooks in an agent file are not run yet; hooks from settings still apply."],
    ["memory", "memory is ignored: subagents have no memory folder of their own yet."],
    ["omitClaudeMd", "omitClaudeMd is ignored: the instruction files are always loaded."],
    ["effort", "effort is ignored: the session's effort applies."],
    ["autoCompactWindow", "autoCompactWindow is ignored: the session's compaction limit applies."],
    ["initialPrompt", "initialPrompt is ignored: it applies to an agent run as the main session."],
    ["experimental", "experimental settings are ignored."],
  ];
  for (const [key, why] of ignored) if (key in fields) notes.add(why, true);
  if ("color" in fields) notes.add("color is not shown.", false);

  const def: AgentDefinition = {
    ...base,
    name,
    description,
    tools,
    disallowedTools: listField(fields, "disallowedTools"),
    model,
    permissionMode,
    maxTurns,
    skills: listField(fields, "skills"),
    background: background ?? false,
    isolation,
    prompt: body.trim(),
  };
  if (isProjectAgentCode(def)) {
    const what = [
      toolGrants(def).length > 0 ? "tool grants" : "",
      def.permissionMode !== null && LOOSE_MODES.has(def.permissionMode)
        ? `permissionMode ${def.permissionMode}`
        : "",
    ]
      .filter((part) => part !== "")
      .join(" and ");
    notes.add(
      `Project code: its ${what} take effect only once you approve the project's code.`,
      false,
    );
  }
  return { ...def, status: notes.partial ? "partly-supported" : "loaded", notes: notes.list };
}
