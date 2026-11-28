/**
 * One session's skills and custom commands (Phase 4 spec, Skills and Custom commands), as Claude
 * Code documents them (code.claude.com/docs/en/skills):
 *
 * - Loaded once when the session opens; the listing built from them is part of the static
 *   prompt. Folders inside the project add theirs once the agent works there, as a note.
 * - A body is rendered when the skill runs, by the person (`/name args`) or the agent (the
 *   `Skill` tool): arguments, `${CLAUDE_*}` variables, `!` commands (through the permission
 *   engine, never asking) and the files `@path` names (when reading them needs no asking).
 * - `allowed-tools` and `disallowed-tools` become allow and deny rules until the person's next
 *   message, whoever ran the skill; never past it.
 * - The latest invocation of each skill is attached again after compaction, within a budget.
 *
 * The session hands itself in through `bind`; the `Skill` tool finds this object in the
 * session's state bag.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  expandSkillBody,
  fileReferences,
  isProjectCode,
  loadNestedSkills,
  loadSkills,
  type PermissionRule,
  type SettingsFileRef,
  type SkillDefinition,
} from "@dawg/compat";
import type { CompatSource } from "@dawg/protocol";
import type { Message } from "../contracts/messages.ts";
import type { PermissionEngine, PermissionState } from "../contracts/permissions.ts";
import type { SessionStateBag, ToolLimits } from "../contracts/tools.ts";
import { describeReason } from "../permissions/index.ts";
import { listingBudgetChars, renderSkillListing } from "./listing.ts";
import { runInjectedCommand } from "./shell.ts";

export const SKILLS_STATE_KEY = "skills.session";

/** What the session lends its skills: who it is, where it runs, and its permissions as they are now. */
export interface SkillHost {
  sessionId: string;
  cwd: string;
  /** The project for `${CLAUDE_PROJECT_DIR}`. */
  projectDir: string;
  homeDir: string;
  permissions: PermissionEngine;
  /** The rules and mode in force now, the turn's grants included. */
  permissionState(): PermissionState;
  /** Environment variables from settings, for `!` commands. */
  env(): Readonly<Record<string, string>>;
  /** The session's effort level, or null for the model's default. */
  effort(): string | null;
  limits: ToolLimits;
  /** Estimated tokens of a text. */
  tokens(text: string): number;
  /** The model's context window in tokens, or 0 when unknown. */
  contextWindow(): number;
  /**
   * Whether code from this file may run now (the engine's `CodeTrust.allows` for the session's
   * project). Asked only about project code; the person's own skills need no approval.
   */
  allows(source: CompatSource): Promise<boolean>;
}

/**
 * A rendered body. `grants` is false when the skill's `allowed-tools` must not apply: project
 * code (`isProjectCode`) the person has not approved (spec, principle 3).
 */
export type RenderOutcome =
  | { ok: true; body: string; grants: boolean }
  | { ok: false; message: string };

type CommandOutcome = { ok: true; body: string } | { ok: false; message: string };

/** How a turn started by a skill or command the person ran differs from a plain prompt. */
export interface SkillPromptOptions {
  /** The command as typed: `turn.started` shows it instead of the expanded prompt. */
  command?: { name: string; args: string };
  /** The skill that ran: its grants apply to the turn, and its body is now in context. */
  invocation?: { skill: SkillDefinition; body: string; grants: boolean };
}

/** Rules from a skill's front matter, for one turn. Not from a file the person can edit. */
const GRANTED: SettingsFileRef = { source: "session", origin: null, path: null };

/** Documented: each re-attached skill keeps at most its first 5,000 tokens, 25,000 in all. */
export const REATTACH_TOKENS_EACH = 5000;
export const REATTACH_TOKENS_TOTAL = 25_000;
/** On a small window the budget shrinks with it, so a summary is not followed by a wall of skills. */
const REATTACH_WINDOW_SHARE_EACH = 0.05;
const REATTACH_WINDOW_SHARE_TOTAL = 0.15;

/** Characters of one file a skill names with `@path` that are attached. */
const MAX_REFERENCE_CHARS = 50_000;

const REATTACH_HEADER =
  "Skills loaded earlier in this conversation, attached again after it was summarised. Keep following them where they apply.";

const TOOL_RESULT_PREFIX = 'Loaded the skill "';

function key(name: string): string {
  return name.replace(/^\//, "").toLowerCase();
}

function textOf(message: Message): string {
  if (message.role === "system" || message.role === "assistant") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export class SessionSkills {
  /** The skills found when the session opened: the listing and the `/` commands come from these. */
  readonly initial: readonly SkillDefinition[];
  /** The static prompt's skills segment, or "" when no skill is listed. */
  readonly listing: string;
  #definitions: SkillDefinition[];
  #host: SkillHost | null = null;
  #grants: { allow: PermissionRule[]; deny: PermissionRule[] } = { allow: [], deny: [] };
  /** The person's latest message, for skills only they may start. */
  #turnText = "";
  /** The latest invocation of each skill, by lowercase name, for re-attachment. */
  #invocations = new Map<string, { name: string; body: string; order: number }>();
  /** Bodies in the model's view now (`name\0body`), for the "already loaded" answer. */
  #inContext = new Set<string>();
  #order = 0;
  /** Folders inside the project already looked in, relative with `/`. */
  #checked = new Set<string>();

  constructor(definitions: readonly SkillDefinition[], contextWindow: number | null) {
    this.initial = [...definitions];
    this.#definitions = [...definitions];
    this.listing = renderSkillListing(definitions, listingBudgetChars(contextWindow));
  }

  /** Loads a session's skills: the person's, then the project's from its root to `cwd`. */
  static async load(input: {
    homeDir: string;
    cwd: string;
    projectDir: string;
    contextWindow: number | null;
  }): Promise<SessionSkills> {
    const set = await loadSkills({
      homeDir: input.homeDir,
      cwd: input.cwd,
      projectDir: input.projectDir,
    });
    return new SessionSkills(set.active, input.contextWindow);
  }

  bind(host: SkillHost): void {
    this.#host = host;
  }

  #requireHost(): SkillHost {
    if (this.#host === null) throw new Error("The session's skills are not bound to it yet.");
    return this.#host;
  }

  /** Every skill the session knows now, those found inside the project later included. */
  get definitions(): readonly SkillDefinition[] {
    return this.#definitions;
  }

  /** Whether the session offers the `Skill` tool: when the agent may load at least one skill. */
  get offersTool(): boolean {
    return this.initial.some((skill) => skill.modelInvocable);
  }

  /** A skill by name, case-insensitively, with or without its slash. */
  find(name: string): SkillDefinition | undefined {
    const wanted = key(name.trim());
    return this.#definitions.find((skill) => key(skill.name) === wanted);
  }

  // -------------------------------------------------------------------------------------------
  // Turns and grants
  // -------------------------------------------------------------------------------------------

  /**
   * A message from the person starts a turn: last turn's grants end. When the message is a
   * skill the person ran (`/name`), its grants apply to this turn and its body is in context.
   */
  startTurn(
    text: string,
    invocation: { skill: SkillDefinition; body: string; grants: boolean } | null,
  ): void {
    this.#turnText = text;
    this.#grants = { allow: [], deny: [] };
    if (invocation !== null) {
      this.grant(invocation.skill, invocation.grants);
      this.record(invocation.skill, invocation.body);
    }
  }

  /**
   * Applies a skill's `allowed-tools` (unless `allowTools` is false: project code not approved)
   * and `disallowed-tools` until the person's next message.
   */
  grant(skill: SkillDefinition, allowTools: boolean): void {
    const allowed = allowTools ? skill.allowedTools : [];
    this.#grants = {
      allow: [...allowed.map((rule) => ({ rule, from: GRANTED })), ...this.#grants.allow],
      deny: [
        ...skill.disallowedTools.map((rule) => ({ rule, from: GRANTED })),
        ...this.#grants.deny,
      ],
    };
  }

  /** The session's rules with the turn's grants added. */
  withGrants(rules: PermissionState["rules"]): PermissionState["rules"] {
    if (this.#grants.allow.length === 0 && this.#grants.deny.length === 0) return rules;
    return {
      allow: [...this.#grants.allow, ...rules.allow],
      ask: rules.ask,
      deny: [...this.#grants.deny, ...rules.deny],
    };
  }

  /**
   * Whether the person's latest message names `/name` as a word of its own, which lets the
   * agent load a skill it may not load on its own (documented: "with no punctuation attached").
   */
  personNamed(skill: SkillDefinition): boolean {
    const wanted = `/${key(skill.name)}`;
    return this.#turnText.split(/\s+/).some((word) => word.toLowerCase() === wanted);
  }

  /**
   * Whether a permission rule names this call (`Skill(name)` in deny or ask), so it must go
   * through the permission engine even for a skill that grants nothing.
   */
  ruleNames(specifier: string): boolean {
    const host = this.#host;
    if (host === null) return false;
    const state = { ...host.permissionState(), mode: "bypassPermissions" as const };
    const decision = host.permissions.decide(
      { toolName: "Skill", subject: { kind: "other", specifier } },
      state,
    );
    return decision.behavior !== "allow";
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  /**
   * A skill's body for this run: arguments and variables replaced, `!` commands run and their
   * output put in their place, and the files `@path` names attached. Fails (with a sentence for
   * whoever ran it) when a command is refused or fails, as documented.
   */
  async render(skill: SkillDefinition, args: string, signal: AbortSignal): Promise<RenderOutcome> {
    const host = this.#requireHost();
    const expanded = expandSkillBody(
      skill.body,
      { raw: args, names: skill.argumentNames },
      {
        skillDir: skill.dir,
        projectDir: host.projectDir,
        sessionId: host.sessionId,
        effort: host.effort() ?? "",
      },
    );
    // Project code runs, and its grants apply, only with the person's approval (principle 3).
    const approved = isProjectCode(skill)
      ? await host.allows(skill.source).catch(() => false)
      : true;
    let body = "";
    let prose = "";
    for (const segment of expanded.segments) {
      if (segment.type === "text") {
        body += segment.text;
        prose += segment.text;
        continue;
      }
      if (!approved) return { ok: false, message: needsApproval(skill) };
      const ran = await this.#runCommand(skill, segment.command, signal);
      if (!ran.ok) return ran;
      body += ran.body;
      prose += "\n";
    }
    if (expanded.appendix !== null) {
      body = `${body.trimEnd()}\n\n${expanded.appendix}`;
      prose += `\n${expanded.appendix}`;
    }
    const attached = await this.#attachReferences(skill, fileReferences(prose));
    const text = [body.trim(), ...attached].filter((part) => part !== "").join("\n\n");
    return { ok: true, body: text, grants: approved };
  }

  async #runCommand(
    skill: SkillDefinition,
    command: string,
    signal: AbortSignal,
  ): Promise<CommandOutcome> {
    const host = this.#requireHost();
    const shown = command.includes("\n") ? command.split("\n")[0]?.concat(" …") : command;
    const state = host.permissionState();
    // The skill's own allowed-tools pre-approve its commands (documented); nothing else does.
    const rules = {
      ...state.rules,
      allow: [...skill.allowedTools.map((rule) => ({ rule, from: GRANTED })), ...state.rules.allow],
    };
    const query = {
      toolName: "Bash",
      subject: { kind: "command" as const, command, cwd: host.cwd },
    };
    const decision = host.permissions.decide(query, { ...state, rules });
    const who = `/${skill.name}`;
    if (decision.behavior === "deny") {
      const why = describeReason(decision.reason, query, { cwd: host.cwd, homeDir: host.homeDir });
      return {
        ok: false,
        message: `The command \`${shown}\` in ${who} is not allowed (${why}), so ${who} did not run.`,
      };
    }
    if (decision.behavior === "ask") {
      return {
        ok: false,
        message: `The command \`${shown}\` in ${who} needs permission, and a skill's commands cannot ask for it, so ${who} did not run. Allow it with a permission rule, or in the skill's allowed-tools.`,
      };
    }
    const result = await runInjectedCommand({
      command,
      cwd: host.cwd,
      env: host.env(),
      timeoutMs: host.limits.bashDefaultTimeoutMs,
      maxChars: host.limits.bashMaxOutputChars,
      signal,
    });
    if (result.ok) return { ok: true, body: result.output };
    const how =
      result.reason === "timeout"
        ? `did not finish within ${Math.round(host.limits.bashDefaultTimeoutMs / 1000)} seconds`
        : result.reason === "interrupted"
          ? "was interrupted"
          : result.reason === "start"
            ? `could not start (${result.output})`
            : `failed with exit code ${result.code ?? "unknown"}`;
    const tail =
      result.reason === "failed" && result.output !== "" ? `:\n${result.output.slice(-2000)}` : ".";
    return {
      ok: false,
      message: `The command \`${shown}\` in ${who} ${how}, so ${who} did not run${tail}`,
    };
  }

  /** The files a body names with `@path`, attached when reading them needs no asking. */
  async #attachReferences(skill: SkillDefinition, refs: readonly string[]): Promise<string[]> {
    const host = this.#requireHost();
    const out: string[] = [];
    for (const ref of refs) {
      const absolute = ref.startsWith("~/")
        ? path.join(host.homeDir, ref.slice(2))
        : path.resolve(host.cwd, ref);
      const info = await stat(absolute).catch(() => null);
      // Not a file: a package name or a handle in prose, not worth a word.
      if (info === null || !info.isFile()) continue;
      const decision = host.permissions.decide(
        { toolName: "Read", subject: { kind: "read", paths: [absolute] } },
        host.permissionState(),
      );
      if (decision.behavior !== "allow") {
        out.push(
          `/${skill.name} refers to ${absolute}, which was not attached: reading it needs permission. Read it with Read if you need it.`,
        );
        continue;
      }
      const text = await readFile(absolute, "utf8").catch(() => null);
      if (text === null || text.includes("\u0000")) continue;
      const cut = text.length > MAX_REFERENCE_CHARS;
      const shown = cut ? text.slice(0, MAX_REFERENCE_CHARS) : text;
      out.push(
        `Contents of ${absolute}, which /${skill.name} refers to:\n\`\`\`\n${shown.replace(/\n$/, "")}\n\`\`\`${
          cut ? `\n[cut at ${MAX_REFERENCE_CHARS} characters; read the rest with Read]` : ""
        }`,
      );
    }
    return out;
  }

  /** The person's message when they run a skill or command: what they typed, then the body. */
  promptText(skill: SkillDefinition, args: string, body: string): string {
    const typed = `/${skill.name}${args.trim() === "" ? "" : ` ${args.trim()}`}`;
    return `${typed}\n\n${body}`;
  }

  /** The `Skill` tool's result: where the skill is, then its body. */
  toolResultText(skill: SkillDefinition, body: string): string {
    const where =
      skill.kind === "skill"
        ? ` Its folder is ${skill.dir}: read the supporting files its instructions name from there, with Read, when you need them.`
        : "";
    return `${TOOL_RESULT_PREFIX}${skill.name}" from ${skill.path}.${where}\n\n${body}`;
  }

  /**
   * Notes that a skill's body is now in context. True when that exact body was already there,
   * so the caller answers with a short note instead of a second copy (documented).
   */
  record(skill: SkillDefinition, body: string): boolean {
    const name = key(skill.name);
    const id = `${name}\u0000${body}`;
    const already = this.#inContext.has(id);
    this.#order += 1;
    this.#invocations.set(name, { name: skill.name, body, order: this.#order });
    this.#inContext.add(id);
    return already;
  }

  // -------------------------------------------------------------------------------------------
  // Compaction and resume
  // -------------------------------------------------------------------------------------------

  /**
   * The note that re-attaches skills after compaction, or null when none needs it: the latest
   * invocation of each, newest first until the budget is spent, each cut to its share. Skills
   * whose body survived in `kept` (the turns the compactor kept) are not repeated.
   */
  reattachment(kept: readonly Message[]): string | null {
    const host = this.#requireHost();
    const window = host.contextWindow();
    const each =
      window > 0
        ? Math.min(REATTACH_TOKENS_EACH, Math.floor(window * REATTACH_WINDOW_SHARE_EACH))
        : REATTACH_TOKENS_EACH;
    let budget =
      window > 0
        ? Math.min(REATTACH_TOKENS_TOTAL, Math.floor(window * REATTACH_WINDOW_SHARE_TOTAL))
        : REATTACH_TOKENS_TOTAL;
    const keptText = kept.map(textOf).join("\n");
    const newestFirst = [...this.#invocations.values()].sort((a, b) => b.order - a.order);
    const chosen: { name: string; body: string; order: number; whole: boolean }[] = [];
    const inContext = new Set<string>();
    for (const invocation of newestFirst) {
      const id = `${key(invocation.name)}\u0000${invocation.body}`;
      if (keptText.includes(invocation.body)) {
        inContext.add(id);
        continue;
      }
      let body = invocation.body;
      let tokens = host.tokens(body);
      let whole = true;
      if (tokens > each) {
        body = `${body.slice(0, Math.floor((body.length * each) / tokens)).trimEnd()}\n[The rest of this skill was not attached again; load it again to see all of it.]`;
        tokens = host.tokens(body);
        whole = false;
      }
      if (tokens > budget) break;
      budget -= tokens;
      chosen.push({ ...invocation, body, whole });
      if (whole) inContext.add(id);
    }
    this.#inContext = inContext;
    if (chosen.length === 0) return null;
    const blocks = chosen
      .sort((a, b) => a.order - b.order)
      .map((skill) => `<skill name="${skill.name}">\n${skill.body}\n</skill>`);
    return `${REATTACH_HEADER}\n\n${blocks.join("\n\n")}`;
  }

  /**
   * Rebuilds what is in context from a reopened session's view: the `Skill` tool's results, the
   * skills the person ran, and the last re-attachment.
   */
  restore(view: readonly Message[]): void {
    for (const message of view) {
      if (message.role === "tool" && message.toolName === "Skill" && !message.isError) {
        const text = textOf(message);
        const match = /^Loaded the skill "([^"]+)"/.exec(text);
        const split = text.indexOf("\n\n");
        if (match?.[1] && split !== -1) this.#remember(match[1], text.slice(split + 2));
      } else if (message.role === "user" && message.kind === "prompt") {
        const text = textOf(message);
        const match = /^\/(\S+)[^\n]*\n\n/.exec(text);
        const skill = match?.[1] === undefined ? undefined : this.find(match[1]);
        if (match && skill) this.#remember(skill.name, text.slice(match[0].length));
      } else if (message.role === "user" && message.kind === "note") {
        const text = textOf(message);
        if (!text.includes(REATTACH_HEADER)) continue;
        for (const block of text.matchAll(/<skill name="([^"]+)">\n([\s\S]*?)\n<\/skill>/g)) {
          if (block[1] && block[2] !== undefined) this.#remember(block[1], block[2]);
        }
      }
    }
  }

  #remember(name: string, body: string): void {
    this.#order += 1;
    this.#invocations.set(key(name), { name, body, order: this.#order });
    this.#inContext.add(`${key(name)}\u0000${body}`);
  }

  // -------------------------------------------------------------------------------------------
  // Folders inside the project
  // -------------------------------------------------------------------------------------------

  /**
   * The skills of the folders between the working directory and a file the agent has just read
   * or changed, not looked at before (documented: nested skills load the first time the agent
   * works in that folder). They join the session's skills; the listing stays as it was.
   */
  async forFile(file: string): Promise<SkillDefinition[]> {
    const host = this.#host;
    if (host === null) return [];
    const rel = path.relative(host.cwd, path.dirname(path.resolve(file)));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return [];
    const parts = rel.split(path.sep);
    const found: SkillDefinition[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const part = parts[i - 1] ?? "";
      // Hidden folders and dependencies are not the project's own folders.
      if (part.startsWith(".") || part === "node_modules") break;
      const sub = parts.slice(0, i).join("/");
      if (this.#checked.has(sub)) continue;
      this.#checked.add(sub);
      const taken = new Set(this.#definitions.map((skill) => key(skill.name)));
      const added = await loadNestedSkills({
        homeDir: host.homeDir,
        cwd: host.cwd,
        rel: sub,
        taken,
      });
      this.#definitions.push(...added);
      found.push(...added);
    }
    return found.filter((skill) => skill.modelInvocable);
  }

  /** The note telling the agent about skills found inside the project. */
  nestedNote(skills: readonly SkillDefinition[]): string {
    const how = this.offersTool
      ? "Load one with the Skill tool when a task matches it."
      : "To use one, read its SKILL.md with Read and follow it.";
    const lines = skills.map((skill) => {
      const description = skill.description.replace(/\s+/g, " ").trim();
      return `- ${skill.name}${description === "" ? "" : `: ${description}`} (${skill.path})`;
    });
    return `More skills apply in the folder you are working in. ${how}\n${lines.join("\n")}`;
  }
}

/**
 * A compacted view with the skills note placed right after the summary (and the notes that come
 * with it), before the turns the compactor kept, as documented. Unchanged when there is nothing
 * to re-attach.
 */
export function withSkillsReattached(
  messages: readonly Message[],
  skills: SessionSkills,
  note: (text: string) => Message,
): Message[] {
  let start = 0;
  while (start < messages.length) {
    const message = messages[start];
    if (message?.role !== "user" || message.kind !== "note") break;
    start += 1;
  }
  const text = skills.reattachment(messages.slice(start));
  if (text === null) return [...messages];
  return [...messages.slice(0, start), note(text), ...messages.slice(start)];
}

/** Why project code did not run: one sentence, saying where to approve it. */
export function needsApproval(skill: SkillDefinition): string {
  return `/${skill.name} runs commands from the project's files, which need your approval of the project's code first: give it in Settings → Project setup, or when dawg asks about this project.`;
}

/** The session's skills, for the `Skill` tool. */
export function skillsOf(state: SessionStateBag): SessionSkills | null {
  return state.get<SessionSkills | null>(SKILLS_STATE_KEY, () => null);
}
