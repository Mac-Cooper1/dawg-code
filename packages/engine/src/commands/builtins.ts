/**
 * The built-in slash commands. Names, arguments and behaviour follow the public command reference
 * where it has the command (`/mode` is our own); all wording is ours.
 *
 * Commands that change something while a turn runs (`/model`, `/compact`, `/clear`, and those that
 * start a turn) refuse with SessionBusy; reading commands work at any time.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSettings, type PermissionRule, type SettingsFileRef } from "@dawg/compat";
import {
  type PermissionMode,
  PermissionModeSchema,
  type SessionSummary,
  type Usage,
} from "@dawg/protocol";
import { mcpCommand } from "../mcp/command.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import { chooseInstructionFile, initPrompt } from "./init.ts";
import { memoryCommand } from "./memory.ts";
import { splitArguments } from "./registry.ts";
import { rewindCommand } from "./rewind.ts";
import {
  type CommandContext,
  CommandError,
  type CommandResult,
  type SlashCommand,
} from "./types.ts";

function output(text: string): CommandResult {
  return { kind: "output", text };
}

function n(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "–";
  return `${Math.round((part / whole) * 100)}%`;
}

/** A path as a person reads it: relative inside the project, `~/` inside home, else absolute. */
export function showPath(file: string, cwd: string, homeDir: string): string {
  const abs = path.resolve(file);
  const rel = path.relative(cwd, abs);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const fromHome = path.relative(homeDir, abs);
  if (fromHome !== "" && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
    return `~/${fromHome}`;
  }
  return abs;
}

function noArguments(ctx: CommandContext): void {
  if (ctx.args !== "") {
    throw new CommandError(ctx.name, `/${ctx.name} takes no arguments.`);
  }
}

function assertIdle(session: SessionRuntime, what: string): void {
  if (session.busy) {
    throw new RuntimeError("SessionBusy", `${what} has to wait until the current turn ends.`);
  }
}

function textPrompt(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Replaces control and invisible characters with spaces, as titles are shown on one line. */
function cleanName(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .trim();
}

function resolveUserPath(input: string, cwd: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2));
  return path.resolve(cwd, input);
}

function describeUsage(usage: Usage | null): string | null {
  if (usage === null) return null;
  const last = usage.last;
  const parts: string[] = [];
  if (last.promptTokens !== null) {
    const cached =
      last.cachedTokens === null
        ? ""
        : ` (${n(last.cachedTokens)} reused from the cache, ${percent(last.cachedTokens, last.promptTokens)})`;
    parts.push(`last request read ${n(last.promptTokens)} prompt tokens${cached}`);
  }
  parts.push(
    `${n(usage.totals.requests)} requests so far, ${n(usage.totals.promptTokens)} prompt and ${n(
      usage.totals.completionTokens,
    )} completion tokens`,
  );
  return `Usage: ${parts.join("; ")}.`;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Where a custom command or skill comes from, for `/help <name>`; "" for dawg's own. */
function sourceLine(command: SlashCommand): string {
  const what = command.kind === "skill" ? "A skill" : "A custom command";
  if (command.source === "user") return `${what} from your own files (~/.claude or ~/.dawg).`;
  if (command.source === "project") return `${what} from the project's files.`;
  return "";
}

const help: SlashCommand = {
  name: "help",
  description: "Show the commands, or details of one",
  argumentHint: "[command]",
  run(ctx) {
    const wanted = ctx.args.replace(/^\//, "");
    if (wanted !== "") {
      const command = ctx.registry.get(wanted);
      if (command === undefined) {
        throw new CommandError(
          ctx.name,
          `There is no command /${wanted}. Type /help for the list.`,
        );
      }
      const usage = `/${command.name}${command.argumentHint === null ? "" : ` ${command.argumentHint}`}`;
      const aliases =
        command.aliases && command.aliases.length > 0
          ? `\nAlso: ${command.aliases.map((a) => `/${a}`).join(", ")}`
          : "";
      const from = sourceLine(command);
      return output(`${usage}\n${command.description}.${aliases}${from === "" ? "" : `\n${from}`}`);
    }
    const rows = ctx.registry.list().map((c) => {
      const usage = `/${c.name}${c.argumentHint === null ? "" : ` ${c.argumentHint}`}`;
      const tag = c.source === "user" ? " (personal)" : c.source === "project" ? " (project)" : "";
      return { usage, description: `${c.description}${tag}` };
    });
    const width = Math.max(...rows.map((r) => r.usage.length));
    const lines = rows.map((r) => `  ${r.usage.padEnd(width)}  ${r.description}`);
    return output(
      [
        "Commands:",
        ...lines,
        "",
        "Anything that does not start with a slash is sent to the model.",
      ].join("\n"),
    );
  },
};

const status: SlashCommand = {
  name: "status",
  description: "Show the model, endpoint, mode, directories and session",
  argumentHint: null,
  async run(ctx) {
    noArguments(ctx);
    const s = ctx.session;
    const info = s.modelInfo();
    const summary = s.summary();
    const endpoint = ctx.describeEndpoint(s);
    const paths = await ctx.engine.store.paths(s.cwd, s.id);
    const usage = s.snapshot().usage;
    const show = (p: string) => showPath(p, s.cwd, ctx.homeDir);
    const lines = [
      `Session: ${s.id}${summary.title === null ? "" : ` (${summary.title})`}`,
      `Transcript: ${show(paths.file)}`,
      `Model: ${info.id}`,
      `Endpoint: ${endpoint === null ? "unknown" : `${endpoint.kind}${endpoint.url === null ? "" : ` at ${endpoint.url}`}`}`,
      `Context window: ${n(info.contextWindow)} tokens`,
      `Effort: ${s.effort ?? "model default"}`,
      `Mode: ${s.mode}`,
      `Working directory: ${s.cwd}`,
    ];
    if (s.additionalDirectories.length > 0) {
      lines.push(`Also: ${s.additionalDirectories.join(", ")}`);
    }
    const position = summary.queuePosition;
    lines.push(
      position === null
        ? `Status: ${s.status}`
        : `Status: ${s.status}, waiting for the model (${position === 1 ? "next" : `number ${position}`} in line)`,
    );
    if (usage !== null) {
      lines.push(
        `Context used: ${n(usage.contextUsed)} (${percent(usage.contextUsed, usage.contextWindow)})`,
      );
    }
    return output(lines.join("\n"));
  },
};

const context: SlashCommand = {
  name: "context",
  description: "Show where the context window is going",
  argumentHint: null,
  run(ctx) {
    noArguments(ctx);
    const s = ctx.session;
    // The same numbers as the session's `usage.breakdown`: the endpoint's count at the last
    // request is the truth for the whole; only the split between the parts is estimated.
    const {
      contextWindow: window,
      contextUsed: total,
      measured,
      compactAt,
      breakdown,
    } = s.contextUsage();
    const usage = s.snapshot().usage;
    const free = Math.max(0, window - total);
    const parts: [string, string, number][] = [
      ["S", "System prompt", breakdown.systemPrompt],
      ["I", "Instruction files", breakdown.instructions],
      ["T", "Tool definitions", breakdown.tools],
      ["C", "Conversation", breakdown.messages],
    ];
    const rows: [string, number][] = [
      ...parts.map(([, label, value]): [string, number] => [label, value]),
      ["Free", free],
    ];
    const cells = 40;
    const bar = parts
      .map(([ch, , value]) => ch.repeat(window > 0 ? Math.round((value / window) * cells) : 0))
      .join("")
      .slice(0, cells)
      .padEnd(cells, ".");
    const width = Math.max(...rows.map(([label]) => label.length));
    const lines = [
      `Context: ${n(total)} of ${n(window)} tokens (${percent(total, window)}), ${
        measured ? "as counted by the endpoint at the last request" : "estimated"
      }`,
      `[${bar}]`,
      ...rows.map(
        ([label, value]) =>
          `  ${label.padEnd(width)}  ${n(value).padStart(9)}  ${percent(value, window).padStart(4)}`,
      ),
      "S system prompt, I instruction files, T tools, C conversation, . free",
    ];
    if (total > window && window > 0) {
      lines.push("The conversation no longer fits: run /compact or /clear.");
    } else if (compactAt !== null) {
      lines.push(
        `Compaction runs before a turn once the context passes ${n(compactAt)} tokens (${percent(compactAt, window)}).`,
      );
    }
    const described = describeUsage(usage);
    if (described !== null) lines.push(described);
    return output(lines.join("\n"));
  },
};

function ruleSource(from: SettingsFileRef, cwd: string, homeDir: string): string {
  switch (from.source) {
    case "flags":
      return "command line";
    case "session":
      return "this session";
    default: {
      const where = from.path === null ? "" : ` (${showPath(from.path, cwd, homeDir)})`;
      const level =
        from.source === "local"
          ? "personal project settings"
          : from.source === "project"
            ? "shared project settings"
            : "user settings";
      return `${level}${where}`;
    }
  }
}

const permissions: SlashCommand = {
  name: "permissions",
  description: "List the permission rules in force and where each comes from",
  argumentHint: null,
  aliases: ["allowed-tools"],
  async run(ctx) {
    noArguments(ctx);
    const s = ctx.session;
    const settings = await loadSettings({
      projectDir: s.cwd,
      homeDir: ctx.homeDir,
      ...(ctx.settingsFlags === undefined ? {} : { flags: ctx.settingsFlags }),
    });
    const p = settings.permissions;
    const list = (title: string, rules: PermissionRule[]) => {
      if (rules.length === 0) return [`${title}: none`];
      const width = Math.max(...rules.map((r) => r.rule.length));
      return [
        `${title}:`,
        ...rules.map(
          (r) => `  ${r.rule.padEnd(width)}  from ${ruleSource(r.from, s.cwd, ctx.homeDir)}`,
        ),
      ];
    };
    const lines = [
      `Mode: ${s.mode}${p.bypassDisabled ? " (bypassPermissions is turned off by settings)" : ""}`,
      "Rules are checked in this order: deny, then ask, then allow, then the mode's default.",
      ...list("Deny", p.deny),
      ...list("Ask", p.ask),
      ...list("Allow", p.allow),
      `Working directories: ${[s.cwd, ...s.additionalDirectories].join(", ")}`,
    ];
    if (settings.problems.length > 0) {
      lines.push("Problems in settings:");
      for (const problem of settings.problems) {
        const file = problem.path.startsWith("<")
          ? problem.path
          : showPath(problem.path, s.cwd, ctx.homeDir);
        lines.push(`  ${file}${problem.key === null ? "" : ` ${problem.key}`}: ${problem.message}`);
      }
    }
    lines.push("Answering “allow always” adds a rule to .dawg/settings.local.json.");
    return output(lines.join("\n"));
  },
};

// ---------------------------------------------------------------------------------------------
// Session settings
// ---------------------------------------------------------------------------------------------

const MODES = PermissionModeSchema.options;

function parseMode(ctx: CommandContext, word: string): PermissionMode {
  const key = word.toLowerCase().replace(/[-_\s]/g, "");
  if (key === "manual") return "default";
  const found = MODES.find((m) => m.toLowerCase() === key);
  if (found === undefined) {
    throw new CommandError(ctx.name, `Unknown mode "${word}". Choose one of: ${MODES.join(", ")}.`);
  }
  return found;
}

const mode: SlashCommand = {
  name: "mode",
  description: "Show or change the permission mode",
  argumentHint: "[mode]",
  run(ctx) {
    const s = ctx.session;
    if (ctx.args === "") {
      return output(
        [`Mode: ${s.mode}`, `Modes: ${MODES.join(", ")}`, "Change it with /mode <mode>."].join(
          "\n",
        ),
      );
    }
    const words = splitArguments(ctx.args, ctx.name);
    if (words.length !== 1) throw new CommandError(ctx.name, "Usage: /mode <mode>");
    const next = parseMode(ctx, words[0] as string);
    if (next === s.mode) return output(`Already in ${next} mode.`);
    s.setMode(next);
    return output(`Mode: ${s.mode}.`);
  },
};

const plan: SlashCommand = {
  name: "plan",
  description: "Switch to plan mode, optionally starting on a task",
  argumentHint: "[task]",
  run(ctx) {
    const s = ctx.session;
    if (ctx.args !== "") assertIdle(s, "Starting a task");
    if (s.mode !== "plan") s.setMode("plan");
    if (ctx.args === "")
      return output(
        "Plan mode: the model reads and plans, and changes nothing until you approve its plan.",
      );
    return { kind: "prompt", prompt: textPrompt(ctx.args), text: "Plan mode." };
  },
};

const model: SlashCommand = {
  name: "model",
  description: "Show or change the model",
  argumentHint: "[model]",
  async run(ctx) {
    const s = ctx.session;
    if (ctx.args === "") {
      const info = s.modelInfo();
      const endpoint = ctx.describeEndpoint(s);
      const lines = [
        `Model: ${info.id}`,
        `Context window: ${n(info.contextWindow)} tokens`,
        `Vision: ${info.vision ? "yes" : "no"}. Reasoning: ${info.reasoning ? "yes" : "no"}.`,
        `Effort levels: ${info.effortLevels.length === 0 ? "none" : info.effortLevels.join(", ")}`,
      ];
      if (endpoint !== null) {
        lines.push(
          `Endpoint: ${endpoint.kind}${endpoint.url === null ? "" : ` at ${endpoint.url}`}`,
        );
      }
      lines.push("Change it with /model <model>.");
      return output(lines.join("\n"));
    }
    const words = splitArguments(ctx.args, ctx.name);
    if (words.length !== 1) throw new CommandError(ctx.name, "Usage: /model <model>");
    assertIdle(s, "Changing the model");
    const before = s.effort;
    const result = await s.setModel(words[0] as string);
    const reset =
      before !== null && result.effort === null ? ` Effort reset to the model default.` : "";
    return output(
      `Model: ${result.model} (context window ${n(result.modelInfo.contextWindow)} tokens).${reset}`,
    );
  },
};

const effort: SlashCommand = {
  name: "effort",
  description: "Show or set the reasoning effort",
  argumentHint: "[level|auto]",
  run(ctx) {
    const s = ctx.session;
    const levels = s.modelInfo().effortLevels;
    const word = ctx.args.toLowerCase();
    if (word === "" || word === "status") {
      if (levels.length === 0) return output("This model has no effort levels.");
      return output(
        `Effort: ${s.effort ?? "model default"}. Levels, weakest first: ${levels.join(", ")}. Use /effort auto for the model default.`,
      );
    }
    if (word === "auto" || word === "default") {
      s.setEffort(null);
      return output("Effort: model default.");
    }
    if (levels.length === 0) throw new CommandError(ctx.name, "This model has no effort levels.");
    const level = levels.find((l) => l.toLowerCase() === word);
    if (level === undefined) {
      throw new CommandError(
        ctx.name,
        `Unknown effort "${ctx.args}". Choose one of: ${levels.join(", ")}, or auto.`,
      );
    }
    s.setEffort(level);
    return output(`Effort: ${level}.`);
  },
};

const addDir: SlashCommand = {
  name: "add-dir",
  description: "Add a working directory the agent may read and edit",
  argumentHint: "<path>",
  async run(ctx) {
    const words = splitArguments(ctx.args, ctx.name);
    if (words.length !== 1) throw new CommandError(ctx.name, "Usage: /add-dir <path>");
    const target = resolveUserPath(words[0] as string, ctx.session.cwd, ctx.homeDir);
    let dirs: string[];
    try {
      dirs = await ctx.session.addDirectory(target);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "InvalidState") {
        throw new CommandError(ctx.name, `${target} is not a directory.`);
      }
      throw error;
    }
    return output(`Working directories: ${[ctx.session.cwd, ...dirs].join(", ")}`);
  },
};

// ---------------------------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------------------------

const compact: SlashCommand = {
  name: "compact",
  description: "Summarise the conversation to free context, optionally with a focus",
  argumentHint: "[focus]",
  run(ctx) {
    const s = ctx.session;
    assertIdle(s, "Compacting");
    // Started, not awaited: summarising can take minutes and no request is held open that long.
    // The session is busy from this point; `compaction.*` events report the outcome.
    const running = s.compact(ctx.args === "" ? null : ctx.args);
    running.catch(() => {});
    return output(
      ctx.args === ""
        ? "Compacting the conversation."
        : `Compacting the conversation, focusing on: ${ctx.args}`,
    );
  },
};

const clear: SlashCommand = {
  name: "clear",
  description: "Start a new conversation; the current one stays saved",
  argumentHint: "[name]",
  aliases: ["reset", "new"],
  async run(ctx) {
    const s = ctx.session;
    assertIdle(s, "Clearing");
    const oldId = s.id;
    if (ctx.args !== "") {
      const name = cleanName(ctx.args);
      if (name === "") throw new CommandError(ctx.name, "That name is empty.");
      await s.rename(name);
    }
    const next = await ctx.engine.clearSession(oldId);
    return {
      kind: "session",
      session: next,
      text: `New conversation. The previous one is saved; /resume ${oldId} returns to it.`,
      replaces: oldId,
    };
  },
};

function sessionLine(s: SessionSummary): string {
  const when = new Date(s.lastActivityAt).toISOString().replace("T", " ").slice(0, 16);
  return `  ${s.id}  ${when}  ${s.title ?? "(untitled)"}`;
}

const resume: SlashCommand = {
  name: "resume",
  description: "Open a saved conversation by id or title, or list recent ones",
  argumentHint: "[session]",
  aliases: ["continue"],
  async run(ctx) {
    const s = ctx.session;
    const wanted = ctx.args;
    if (wanted === "") {
      const { sessions } = await ctx.engine.listSessions({ projectDir: s.cwd, limit: 11 });
      const others = sessions.filter((x) => x.id !== s.id).slice(0, 10);
      if (others.length === 0) return output("No other saved conversations in this project.");
      return output(
        [
          "Recent conversations in this project:",
          ...others.map(sessionLine),
          "",
          "Open one with /resume <id>.",
        ].join("\n"),
      );
    }
    if (wanted === s.id) return output("That is the current conversation.");
    let id: string | null = null;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(wanted)) {
      const found = await ctx.engine.replay(wanted, Number.MAX_SAFE_INTEGER, 1).then(
        () => true,
        () => false,
      );
      if (found) id = wanted;
    }
    if (id === null) {
      const { sessions } = await ctx.engine.listSessions({ projectDir: s.cwd, query: wanted });
      const exact = sessions.filter((x) => (x.title ?? "").toLowerCase() === wanted.toLowerCase());
      const matches = exact.length > 0 ? exact : sessions;
      if (matches.length === 0) {
        throw new CommandError(ctx.name, `No saved conversation has the id or title "${wanted}".`);
      }
      if (matches.length > 1) {
        throw new CommandError(
          ctx.name,
          [
            "Several conversations match; give the id:",
            ...matches.slice(0, 10).map(sessionLine),
          ].join("\n"),
        );
      }
      id = (matches[0] as SessionSummary).id;
    }
    const opened = await ctx.engine.resumeSession(id, { capabilities: ctx.capabilities });
    const title = opened.summary().title;
    return {
      kind: "session",
      session: opened,
      text: `Resumed ${opened.id}${title === null ? "" : ` (${title})`}.`,
      replaces: null,
    };
  },
};

const rename: SlashCommand = {
  name: "rename",
  description: "Rename the conversation",
  argumentHint: "<name>",
  async run(ctx) {
    if (ctx.args === "") throw new CommandError(ctx.name, "Usage: /rename <name>");
    const name = cleanName(ctx.args);
    if (name === "") {
      throw new CommandError(ctx.name, "That name is empty once invisible characters are removed.");
    }
    await ctx.session.rename(name);
    return output(`Renamed to “${name}”.`);
  },
};

/** Directories a person's export must not land in: read-only config, and git's own data. */
function forbiddenExportTarget(file: string): string | null {
  const parts = path.resolve(file).split(path.sep);
  if (parts.includes(".claude")) return ".claude/ is read, never written";
  if (parts.includes(".git")) return "files under .git/ belong to git";
  return null;
}

const exportCommand: SlashCommand = {
  name: "export",
  description: "Write the conversation as Markdown to a file",
  argumentHint: "[path]",
  async run(ctx) {
    const s = ctx.session;
    const words = splitArguments(ctx.args, ctx.name);
    if (words.length > 1) throw new CommandError(ctx.name, "Usage: /export [path]");
    const given = words[0];
    let file =
      given === undefined
        ? path.join(s.cwd, `dawg-session-${s.id}.md`)
        : resolveUserPath(given, s.cwd, ctx.homeDir);
    if (given !== undefined && (given.endsWith("/") || given.endsWith(path.sep))) {
      file = path.join(file, `dawg-session-${s.id}.md`);
    }
    const refused = forbiddenExportTarget(file);
    if (refused !== null) throw new CommandError(ctx.name, `Not writing ${file}: ${refused}.`);
    const markdown = await ctx.engine.store.exportMarkdown(s.cwd, s.id);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, markdown, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CommandError(
          ctx.name,
          `${showPath(file, s.cwd, ctx.homeDir)} already exists; give another path.`,
        );
      }
      throw error;
    }
    return output(`Exported the conversation to ${showPath(file, s.cwd, ctx.homeDir)}.`);
  },
};

const init: SlashCommand = {
  name: "init",
  description: "Study the project and write an instruction file for agents",
  argumentHint: "[notes]",
  async run(ctx) {
    const s = ctx.session;
    assertIdle(s, "/init");
    const target = await chooseInstructionFile(s.cwd, ctx.homeDir);
    const verb = target.exists ? "Improving" : "Writing";
    return {
      kind: "prompt",
      prompt: textPrompt(initPrompt(target, s.cwd, ctx.args)),
      text: `${verb} ${showPath(target.path, s.cwd, ctx.homeDir)}. ${target.reason}`,
    };
  },
};

/** The commands every session has, in no particular order (the registry sorts them). */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  help,
  clear,
  compact,
  context,
  model,
  effort,
  mode,
  plan,
  resume,
  rename,
  exportCommand,
  addDir,
  init,
  status,
  permissions,
  rewindCommand,
  memoryCommand,
  mcpCommand,
].map((c) => ({ ...c, source: "builtin" }));
