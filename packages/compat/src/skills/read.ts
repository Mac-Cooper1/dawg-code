/**
 * One skill or command file into a definition: its fields as Claude Code documents them
 * (code.claude.com/docs/en/skills, "Frontmatter reference"), and a note for each field dawg
 * ignores, maps or runs differently.
 */
import type { CompatSource } from "@dawg/protocol";
import { readTextFile } from "../instructions/read.ts";
import {
  booleanField,
  listField,
  parseSkillFrontMatter,
  SKILL_KEYS,
  SKILL_ONLY_KEYS,
  textField,
} from "./frontmatter.ts";
import { parseInjections } from "./substitute.ts";
import type { SkillDefinition, SkillKind } from "./types.ts";

/** Scopes whose files the project supplies: its own, its personal ones, its folders'. */
const PROJECT_SCOPES: ReadonlySet<CompatSource["scope"]> = new Set(["project", "local", "nested"]);

/**
 * Whether a definition is code the project supplies (spec, principle 3): from the project's
 * files, with inline shell or `allowed-tools`. Its shell runs, and its grants apply, only once
 * the person has approved the project's code; the person's own skills need no approval.
 */
export function isProjectCode(
  def: Pick<SkillDefinition, "source" | "inlineShell" | "allowedTools">,
): boolean {
  return PROJECT_SCOPES.has(def.source.scope) && (def.inlineShell || def.allowedTools.length > 0);
}

/** Documented: the description and `when_to_use` together are cut at this many characters in the listing. */
export const MAX_LISTING_DESCRIPTION_CHARS = 1536;

const KNOWN_KEYS: ReadonlySet<string> = new Set(SKILL_KEYS);

/**
 * Characters a skill's name may not hold, as documented: control, invisible, private-use and
 * unassigned characters, and `<` or `>`. Blanks are checked apart (one plain space between
 * words is allowed).
 */
const REFUSED = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}<>]/u;

/** Why a name cannot be used, or null when it can. */
export function refusedName(name: string): string | null {
  if (name === "") return "The name is empty";
  if (REFUSED.test(name)) return `The name “${name}” has a character Claude Code refuses`;
  if (/\s/.test(name.replace(/(\S) (?=\S)/g, "$1"))) {
    return `The name “${name}” has blanks other than single spaces between words`;
  }
  return null;
}

/** The first line of the body with text in it, without Markdown heading marks, for a missing description. */
function firstLine(body: string): string | null {
  for (const line of body.split("\n")) {
    const text = line.replace(/^\s{0,3}#{1,6}\s+/, "").trim();
    if (text !== "" && !/^(`{3,}|~{3,})/.test(text)) return text;
  }
  return null;
}

/** A note collector that remembers whether any note means the item is only partly supported. */
class Notes {
  readonly list: string[] = [];
  partial = false;

  add(text: string, partial: boolean): void {
    this.list.push(text);
    if (partial) this.partial = true;
  }
}

export interface ReadSkillInput {
  kind: SkillKind;
  path: string;
  /** The skill's folder, or the command file's folder. */
  dir: string;
  /** The name the file's place gives it: the folder's name, or the command's path with colons. */
  defaultName: string;
  source: CompatSource;
}

/** Reads one file. Never throws: a file that cannot be used comes back `invalid`, with why. */
export async function readSkillFile(input: ReadSkillInput): Promise<SkillDefinition> {
  const base: SkillDefinition = {
    kind: input.kind,
    name: input.defaultName,
    description: "",
    descriptionFrom: "none",
    whenToUse: null,
    argumentHint: null,
    argumentNames: [],
    allowedTools: [],
    disallowedTools: [],
    model: null,
    fork: false,
    userInvocable: true,
    modelInvocable: true,
    body: "",
    path: input.path,
    dir: input.dir,
    source: input.source,
    status: "loaded",
    notes: [],
    shadowedBy: null,
    inlineShell: false,
  };
  const read = await readTextFile(input.path);
  if (!read.ok) {
    return { ...base, status: "invalid", notes: [`Could not read the file: ${read.detail}.`] };
  }
  return defineSkill(base, read.text);
}

/** The definition a file's text makes, on top of what its place says (`base`). */
export function defineSkill(base: SkillDefinition, text: string): SkillDefinition {
  const notes = new Notes();
  const parsed = parseSkillFrontMatter(text);
  const fields = parsed.fields;
  const isCommand = base.kind === "command";
  if (parsed.error !== null) {
    notes.add(`${parsed.error}; the file loads with no fields, as Claude Code loads it.`, true);
  }

  for (const key of Object.keys(fields)) {
    if (!KNOWN_KEYS.has(key)) {
      notes.add(`Unknown field “${key}” is ignored, as Claude Code ignores it.`, false);
    } else if (isCommand && SKILL_ONLY_KEYS.has(key)) {
      notes.add(
        `${key} is not used in a command file, as documented: ${
          key === "name" ? "its path under commands/ names it" : "it applies to skills only"
        }.`,
        false,
      );
    }
  }

  let name = base.name;
  const written = isCommand ? null : textField(fields, "name");
  if (written !== null) name = written;
  const refused = refusedName(name);
  if (refused !== null) {
    return {
      ...base,
      name,
      body: parsed.body,
      status: "invalid",
      notes: [`${refused}, so it does not load.`],
    };
  }

  const description = textField(fields, "description");
  const fallback = description === null ? firstLine(parsed.body) : null;

  const flag = (key: string, fallbackValue: boolean): boolean => {
    const value = booleanField(fields, key);
    if (value === undefined) {
      notes.add(`${key} is not true or false, so it is left at ${fallbackValue}.`, true);
      return fallbackValue;
    }
    return value ?? fallbackValue;
  };
  const userInvocable = flag("user-invocable", true);
  const modelInvocable = !flag("disable-model-invocation", false);

  const rawModel = textField(fields, "model");
  const model = rawModel === null || rawModel.toLowerCase() === "inherit" ? null : rawModel;
  if (model !== null) {
    notes.add(
      `model “${model}” is mapped to the session's model: model names are mapped, not obeyed.`,
      false,
    );
  }

  const context = textField(fields, "context");
  const fork = context?.toLowerCase() === "fork";
  if (context !== null && !fork) {
    notes.add(`context “${context}” is not a documented value, so it is ignored.`, true);
  }
  const agent = textField(fields, "agent");
  if (agent !== null && !fork) {
    notes.add("agent is ignored: it applies only with context: fork.", false);
  }
  if (fork) {
    notes.add(
      "When you run it yourself, the agent is asked to start the subagent; when the agent loads it, it runs as one directly.",
      false,
    );
  }
  if ("background" in fields) {
    notes.add("background is ignored: a forked skill's subagent runs in the foreground.", true);
  }
  if (textField(fields, "effort") !== null) {
    notes.add("effort is ignored: the session's effort applies.", true);
  }
  if ("hooks" in fields) notes.add("hooks in a skill are not run yet.", true);
  if (!isCommand && "paths" in fields) {
    notes.add("paths is ignored: the skill is available whatever files are open.", true);
  }
  const shell = textField(fields, "shell");
  if (shell !== null && shell.toLowerCase() === "powershell") {
    notes.add("shell: powershell is not available, so its ! commands run in bash.", true);
  } else if (shell !== null && shell.toLowerCase() !== "bash") {
    notes.add(`shell “${shell}” is not a documented value, so commands run in bash.`, true);
  }

  const allowedTools = listField(fields, "allowed-tools");
  const inlineShell = parseInjections(parsed.body).some((segment) => segment.type === "command");
  // Written for the older docs, where $1 was the first argument: it uses $1 and up, never $0.
  const positional = /(?<!\\)\$[1-9]/.test(parsed.body) && !/(?<!\\)\$0(?!\d)/.test(parsed.body);
  if (isCommand && positional) {
    notes.add(
      "Uses $N placeholders: arguments count from 0, as Claude Code's docs now say ($0 is the first), so a file written when $1 was the first gets the second.",
      false,
    );
  }
  if (isProjectCode({ source: base.source, inlineShell, allowedTools })) {
    const what = [
      inlineShell ? "inline shell commands" : "",
      allowedTools.length > 0 ? "allowed-tools" : "",
    ]
      .filter((part) => part !== "")
      .join(" and ");
    notes.add(
      `Project code: its ${what} take effect only once you approve the project's code.`,
      false,
    );
  }

  return {
    ...base,
    name,
    description: description ?? fallback ?? "",
    descriptionFrom: description !== null ? "front-matter" : fallback !== null ? "body" : "none",
    whenToUse: textField(fields, "when_to_use"),
    argumentHint: textField(fields, "argument-hint"),
    argumentNames: listField(fields, "arguments"),
    allowedTools,
    disallowedTools: listField(fields, "disallowed-tools"),
    model,
    fork,
    agent: fork ? agent : null,
    userInvocable,
    modelInvocable,
    body: parsed.body,
    inlineShell,
    status: notes.partial ? "partly-supported" : "loaded",
    notes: notes.list,
  };
}

/** The description and `when_to_use` on one line, cut at the documented length, for the listing. */
export function listingDescription(
  skill: Pick<SkillDefinition, "description" | "whenToUse">,
): string {
  const joined = [skill.description, skill.whenToUse ?? ""]
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part !== "")
    .join(" ");
  if (joined.length <= MAX_LISTING_DESCRIPTION_CHARS) return joined;
  return `${joined.slice(0, MAX_LISTING_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}
