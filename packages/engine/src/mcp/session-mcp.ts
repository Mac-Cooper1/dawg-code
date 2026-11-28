/**
 * One session's MCP servers (Phase 4 spec, MCP): which apply to it and may start, the running
 * servers it holds (shared through the manager), and how the model is told about them.
 *
 * Servers start when the session opens. The tool list is decided once, before the session's
 * first request (`decide`), after waiting a few seconds for servers still starting, as Claude
 * Code waits when the first prompt is built; the list never changes after that, so the prompt
 * cache holds. When the connected servers' schemas are small next to the context window they are
 * all in the list; otherwise the list holds `ToolSearch` and `CallMcpTool` and the prompt lists
 * the tools by name and first line. Servers that connect later (approved after the session
 * opened, or back after a failure) are reached through those two tools, which a session gets
 * whenever some server was not ready when the list was decided.
 */
import type { McpResourceInfo } from "@dawg/protocol";
import type { Prompt, Tool } from "@modelcontextprotocol/client";
import { splitArguments } from "../commands/registry.ts";
import { CommandError, type SlashCommand } from "../commands/types.ts";
import type { AnyTool, ToolContext, ToolOutput } from "../contracts/tools.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { McpConnection } from "./connection.ts";
import { callerFor, McpTimeoutError, withNotes } from "./elicitation.ts";
import type { McpManager, McpServerPlan } from "./manager.ts";
import { MAX_TOOL_NAME_CHARS, mcpPromptCommandName, mcpToolName, normalizeName } from "./names.ts";
import { renderMcpSegment } from "./prompt.ts";
import { MCP_RESOURCE_TOOLS } from "./resource-tools.ts";
import { resultCap, toolOutput } from "./result.ts";
import {
  callMcpTool,
  checkArguments,
  inputSchemaOf,
  MCP_SEARCH_DESCRIPTION_MAX_CHARS,
  mcpTool,
  toolSearchTool,
} from "./tools.ts";

/**
 * The share of the context window the connected servers' tool schemas may take before the
 * session searches for them instead (Claude Code's `ENABLE_TOOL_SEARCH=auto`: 10%). The evals
 * settle it (spec, open questions); `ENABLE_TOOL_SEARCH` (`true`, `false`, `auto`, `auto:N`)
 * overrides it.
 */
export const MCP_SCHEMA_SHARE = 0.1;
/** How long the first request waits for servers still starting. */
export const MCP_START_WAIT_MS = 5_000;
/** How long a tool call may take, unless the definition's `timeout` or `MCP_TOOL_TIMEOUT` says. */
export const MCP_TOOL_TIMEOUT_MS = 10 * 60_000;

export interface McpDecision {
  /** "none": no servers; "direct": their tools are in the list; "search": through ToolSearch. */
  mode: "none" | "direct" | "search";
  /** What the session's tool list gains, in order. */
  tools: AnyTool[];
  /** The prompt's MCP segment. */
  segment: string;
}

interface Held {
  plan: McpServerPlan;
  connection: McpConnection;
}

export interface SessionMcpOptions {
  sessionId: string;
  cwd: string;
  projectDir: string;
  /** The session's own servers. */
  sessionServers?: Readonly<Record<string, unknown>>;
  /** Added (round 3): only the session's own servers (`--strict-mcp-config`). */
  strictMcpConfig?: boolean;
  /** The settings' `env`, read when needed: variables expand from it too. */
  settingsEnv?: () => Readonly<Record<string, string>>;
  /** Added (round 3, subagents): only these servers and tools, for a typed subagent (../agents/mcp.ts). */
  filter?: McpToolFilter;
}

/** Which of the session's servers and tools a view offers. */
export interface McpToolFilter {
  allowsServer(server: string): boolean;
  /** `fullName` is `mcp__server__tool`. */
  allowsTool(fullName: string, server: string): boolean;
}

/** Resources that are pages for a host to draw, not content to read. */
function isUiResource(resource: { uri: string; mimeType?: string }): boolean {
  return resource.uri.startsWith("ui://") || resource.mimeType === "text/html;profile=mcp-app";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A tool search's wanted words: plain words score, `+word` must be in the name. */
function searchTerms(query: string): { required: string[]; words: string[] } {
  const required: string[] = [];
  const words: string[] = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (word.startsWith("+") && word.length > 1) required.push(word.slice(1));
    else words.push(word);
  }
  return { required, words };
}

export class SessionMcp {
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectDir: string;
  readonly #manager: McpManager | null;
  readonly #options: SessionMcpOptions;
  #plans: McpServerPlan[] = [];
  readonly #held = new Map<string, Held>();
  #decision: McpDecision | null = null;
  /** Tools made for calls, by full name, so one call and the next see the same object. */
  readonly #made = new Map<string, { tool: Tool; made: AnyTool }>();
  #unregister: () => void = () => {};
  #closed = false;
  /** How long reading the resources a message mentions may take. */
  readonly mentionTimeoutMs = 30_000;

  private constructor(manager: McpManager | null, options: SessionMcpOptions) {
    this.#manager = manager;
    this.#options = options;
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.projectDir = options.projectDir;
  }

  /** A view with no servers, for engines without MCP. */
  static none(options: SessionMcpOptions): SessionMcp {
    return new SessionMcp(null, options);
  }

  /** Reads which servers apply and starts those that may. Never throws. */
  static async open(manager: McpManager, options: SessionMcpOptions): Promise<SessionMcp> {
    const mcp = new SessionMcp(manager, options);
    mcp.#unregister = manager.register(mcp);
    await mcp.refresh();
    return mcp;
  }

  /**
   * Reads the definitions and consent again: a server allowed now starts, one no longer allowed
   * is let go. The tool list stays as decided; a server that starts now is reached by search.
   */
  async refresh(): Promise<void> {
    const manager = this.#manager;
    if (manager === null || this.#closed) return;
    let plans: McpServerPlan[];
    try {
      plans = await manager.plan({
        cwd: this.cwd,
        projectDir: this.projectDir,
        sessionId: this.sessionId,
        ...(this.#options.sessionServers === undefined
          ? {}
          : { sessionServers: this.#options.sessionServers }),
        ...(this.#options.strictMcpConfig === true ? { strict: true } : {}),
        ...(this.#options.settingsEnv === undefined
          ? {}
          : { settingsEnv: this.#options.settingsEnv() }),
      });
    } catch {
      return; // Unreadable configuration: keep what runs.
    }
    if (this.#closed) return;
    this.#plans = plans;
    const wanted = new Set<string>();
    for (const plan of plans) {
      if (plan.blocked !== null) continue;
      wanted.add(plan.name);
      const held = this.#held.get(plan.name);
      if (held !== undefined && held.plan.key === plan.key) {
        held.plan = plan;
        held.connection.start();
        continue;
      }
      if (held !== undefined) manager.release(held.plan.key, this.sessionId);
      this.#held.set(plan.name, {
        plan,
        connection: manager.acquire(plan, this.sessionId, this.cwd),
      });
    }
    for (const [name, held] of this.#held) {
      if (wanted.has(name)) continue;
      manager.release(held.plan.key, this.sessionId);
      this.#held.delete(name);
    }
  }

  /** True when any server is defined for the session, whatever its state. */
  get configured(): boolean {
    return this.#plans.length > 0;
  }

  get decision(): McpDecision | null {
    return this.#decision;
  }

  /** Connected servers and their tools, sorted by full name, long names left out. */
  #connectedTools(): { server: string; fullName: string; tool: Tool; alwaysLoad: boolean }[] {
    const out: { server: string; fullName: string; tool: Tool; alwaysLoad: boolean }[] = [];
    const filter = this.#options.filter;
    for (const { plan, connection } of this.#held.values()) {
      if (connection.state !== "connected") continue;
      if (filter !== undefined && !filter.allowsServer(plan.name)) continue;
      const serverAlways = plan.definition.parsed.alwaysLoad;
      for (const tool of connection.tools) {
        const fullName = mcpToolName(plan.name, tool.name);
        if (fullName.length > MAX_TOOL_NAME_CHARS) continue;
        if (filter !== undefined && !filter.allowsTool(fullName, plan.name)) continue;
        const marked = (tool._meta as Record<string, unknown> | undefined)?.[
          "anthropic/alwaysLoad"
        ];
        out.push({
          server: plan.name,
          fullName,
          tool,
          alwaysLoad: serverAlways ?? marked === true,
        });
      }
    }
    return out.sort((a, b) => compare(a.fullName, b.fullName));
  }

  /**
   * Decides the session's MCP tools and prompt segment, once: waits up to `waitMs` for servers
   * still starting, then compares the schemas' size with the window. Later calls return the
   * same decision.
   */
  async decide(input: {
    contextWindow: number;
    /** Tokens the tools' schemas take in a request. */
    estimate(tools: readonly AnyTool[]): number;
    waitMs?: number;
    env?: Readonly<Record<string, string | undefined>>;
  }): Promise<McpDecision> {
    if (this.#decision !== null) return this.#decision;
    const waitMs = input.waitMs ?? MCP_START_WAIT_MS;
    await Promise.all([...this.#held.values()].map((h) => h.connection.whenSettled(waitMs)));
    if (this.#decision !== null) return this.#decision;

    const filter = this.#options.filter;
    const connected = [...this.#held.values()].filter(
      (h) =>
        h.connection.state === "connected" &&
        (filter === undefined || filter.allowsServer(h.plan.name)),
    );
    // Servers that may still come: starting, failed and trying again, waiting for consent or
    // sign-in. Search reaches them once they connect.
    const pending = this.#plans.filter((plan) => {
      if (filter !== undefined && !filter.allowsServer(plan.name)) return false;
      if (plan.blocked !== null) return plan.blocked.state === "needs-approval";
      const held = this.#held.get(plan.name);
      return held === undefined || held.connection.state !== "connected";
    });
    if (connected.length === 0 && pending.length === 0) {
      this.#decision = { mode: "none", tools: [], segment: "" };
      return this.#decision;
    }
    const entries = this.#connectedTools();
    const direct = entries.map((e) => this.#make(e.server, e.fullName, e.tool));
    const setting = (input.env?.ENABLE_TOOL_SEARCH ?? "auto").trim().toLowerCase();
    let search: boolean;
    if (setting === "true" || setting === "1") search = entries.length > 0;
    else if (setting === "false" || setting === "0") search = false;
    else {
      const match = /^auto:(\d{1,3})$/.exec(setting);
      const share = match === null ? MCP_SCHEMA_SHARE : Math.min(100, Number(match[1])) / 100;
      search = direct.length > 0 && input.estimate(direct) >= input.contextWindow * share;
    }
    const tools: AnyTool[] = [];
    const listed: { name: string; description: string }[] = [];
    for (const [i, entry] of entries.entries()) {
      if (!search || entry.alwaysLoad) tools.push(direct[i] as AnyTool);
      else {
        const line =
          (entry.tool.description ?? entry.tool.title ?? "").split("\n")[0]?.trim() ?? "";
        listed.push({ name: entry.fullName, description: line });
      }
    }
    const reachLater = pending.length > 0 && setting !== "false" && setting !== "0";
    if (search || reachLater) tools.push(toolSearchTool, callMcpTool);
    // The resource tools come with any MCP server, decided here once like the rest.
    tools.push(...MCP_RESOURCE_TOOLS);
    this.#decision = {
      mode: search ? "search" : "direct",
      tools,
      segment: renderMcpSegment({
        instructions: connected
          .filter((h) => h.connection.instructions !== null)
          .map((h) => ({ server: h.plan.name, text: h.connection.instructions as string }))
          .sort((a, b) => compare(a.server, b.server)),
        listed,
        search,
        later: reachLater ? pending.map((p) => p.name).sort(compare) : [],
      }),
    };
    return this.#decision;
  }

  /** The tool object for a server tool, made once per schema. */
  #make(server: string, fullName: string, tool: Tool): AnyTool {
    const made = this.#made.get(fullName);
    if (made !== undefined && made.tool === tool) return made.made;
    const fresh = mcpTool(server, fullName, tool, this);
    this.#made.set(fullName, { tool, made: fresh });
    return fresh;
  }

  /** The server tool a full name names now, among connected servers. */
  #find(fullName: string): { server: string; tool: Tool; connection: McpConnection } | null {
    const filter = this.#options.filter;
    for (const { plan, connection } of this.#held.values()) {
      if (connection.state !== "connected") continue;
      if (filter !== undefined && !filter.allowsTool(fullName, plan.name)) continue;
      for (const tool of connection.tools) {
        if (mcpToolName(plan.name, tool.name) === fullName) {
          return { server: plan.name, tool, connection };
        }
      }
    }
    return null;
  }

  /** CallMcpTool's resolution: the tool a call names, with its arguments checked. */
  dispatch(
    fullName: string,
    args: Record<string, unknown>,
  ): { tool: AnyTool; input: Record<string, unknown> } | { error: string } {
    const found = this.#find(fullName);
    if (found === null) {
      const held = [...this.#held.values()].find((h) =>
        fullName.startsWith(`mcp__${normalizeName(h.plan.name)}__`),
      );
      if (held !== undefined && held.connection.state !== "connected") {
        return {
          error: `Error: the MCP server ${held.plan.name} is not connected now${held.connection.reason === null ? "" : ` (${held.connection.reason})`}. Try again later, or do without it.`,
        };
      }
      return {
        error: `Error: no MCP tool named ${fullName} is available. Use ToolSearch to find the tool's exact name.`,
      };
    }
    const checked = checkArguments(fullName, found.tool, args);
    if (!checked.ok) return { error: checked.error };
    return { tool: this.#make(found.server, fullName, found.tool), input: checked.value };
  }

  /** Calls a server tool, for the session's tools. */
  async callTool(
    server: string,
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const held = this.#held.get(server);
    if (held === undefined || held.connection.state !== "connected") {
      const reason = held?.connection.reason ?? null;
      return {
        content: [
          {
            type: "text",
            text: `Error: the MCP server ${server} is not connected now${reason === null ? "" : ` (${reason})`}.`,
          },
        ],
        isError: true,
      };
    }
    const env = this.#manager?.env() ?? process.env;
    const fromEnv = Number(env.MCP_TOOL_TIMEOUT);
    const timeoutMs =
      held.plan.definition.parsed.timeoutMs ??
      (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : MCP_TOOL_TIMEOUT_MS);
    // The call carries the session and the call, so a request for input it causes reaches
    // this session's person (elicitation.ts); what came of such requests is noted after.
    const { caller, notes } = callerFor(ctx);
    try {
      const result = await held.connection.callTool(toolName, input, {
        signal: ctx.signal,
        timeoutMs,
        caller,
      });
      return withNotes(
        await toolOutput(result, { server, tool: toolName, maxChars: resultCap(env) }, ctx),
        notes,
      );
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const said =
        error instanceof McpTimeoutError ? message : `the MCP server ${server} said: ${message}`;
      const failed: ToolOutput = {
        content: [{ type: "text", text: `Error: ${said}` }],
        isError: true,
        display: {
          kind: "mcp",
          server,
          tool: toolName,
          text: message,
          images: 0,
          isError: true,
          chars: message.length,
          savedTo: null,
        },
      };
      return withNotes(failed, notes);
    }
  }

  /** The size an MCP result may put in the conversation, in characters. */
  resultCap(): number {
    return resultCap(this.#manager?.env() ?? process.env);
  }

  /**
   * A server set up for the session, for the resource tools: its connection (null while it may
   * not start, with why), or null when no server has that name.
   */
  server(name: string): { connection: McpConnection | null; reason: string | null } | null {
    if (this.#options.filter !== undefined && !this.#options.filter.allowsServer(name)) return null;
    const held = this.#held.get(name);
    if (held !== undefined) return { connection: held.connection, reason: held.connection.reason };
    const plan = this.#plans.find((p) => p.name === name);
    return plan === undefined ? null : { connection: null, reason: plan.blocked?.reason ?? null };
  }

  /** The names of the session's servers, sorted. */
  serverNames(): string[] {
    const filter = this.#options.filter;
    return this.#plans
      .map((p) => p.name)
      .filter((name) => filter === undefined || filter.allowsServer(name))
      .sort(compare);
  }

  /** The connected servers, sorted by name. */
  connectedServers(): { server: string; connection: McpConnection }[] {
    const filter = this.#options.filter;
    return [...this.#held.values()]
      .filter(
        (h) =>
          h.connection.state === "connected" &&
          (filter === undefined || filter.allowsServer(h.plan.name)),
      )
      .map((h) => ({ server: h.plan.name, connection: h.connection }))
      .sort((a, b) => compare(a.server, b.server));
  }

  /** ToolSearch's answer: the matching tools with their full schemas. */
  searchText(query: string, max: number): string {
    const all = this.#connectedTools();
    if (all.length === 0) {
      const waiting = this.#plans.filter(
        (p) => this.#held.get(p.name)?.connection.state !== "connected",
      );
      return waiting.length === 0
        ? "No MCP servers are connected to this session."
        : `No MCP server is connected now. Not ready: ${waiting.map((p) => p.name).join(", ")}.`;
    }
    let found: typeof all;
    const trimmed = query.trim();
    if (trimmed.toLowerCase().startsWith("select:")) {
      const names = trimmed
        .slice("select:".length)
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      found = names.flatMap((name) => all.filter((e) => e.fullName === name));
    } else {
      const { required, words } = searchTerms(trimmed);
      const scored = all
        .map((entry) => {
          const name = entry.fullName.toLowerCase();
          const text = `${entry.tool.title ?? ""} ${entry.tool.description ?? ""}`.toLowerCase();
          if (required.some((word) => !name.includes(word))) return { entry, score: -1 };
          let score = required.length > 0 ? 1 : 0;
          for (const word of words) {
            if (name.includes(word)) score += 3;
            if (text.includes(word)) score += 1;
          }
          return { entry, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || compare(a.entry.fullName, b.entry.fullName));
      found = scored.map((s) => s.entry);
    }
    found = found.slice(0, Math.max(1, Math.min(20, max)));
    if (found.length === 0) {
      return `No MCP tool matches “${trimmed}”. ${all.length} tools are connected; search with other words, or with a server's name.`;
    }
    const blocks = found.map((entry) => {
      const description = (entry.tool.description ?? entry.tool.title ?? "").trim();
      return [
        entry.fullName,
        description.length > MCP_SEARCH_DESCRIPTION_MAX_CHARS
          ? `${description.slice(0, MCP_SEARCH_DESCRIPTION_MAX_CHARS - 1)}…`
          : description,
        `Input schema: ${JSON.stringify(inputSchemaOf(entry.tool))}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    });
    return `${found.length === 1 ? "1 tool" : `${found.length} tools`}. Call one with CallMcpTool: {"name": "<tool name>", "arguments": {...}}.\n\n${blocks.join("\n\n")}`;
  }

  /** The resources connected servers offer, for the composer's `@` menu. */
  resources(): McpResourceInfo[] {
    const out: McpResourceInfo[] = [];
    for (const { plan, connection } of this.#held.values()) {
      if (connection.state !== "connected") continue;
      for (const resource of connection.resources) {
        if (isUiResource(resource)) continue;
        out.push({
          server: plan.name,
          uri: resource.uri,
          name: resource.title ?? resource.name,
          description: (resource.description ?? "").trim(),
          mimeType: resource.mimeType ?? null,
          mention: `@${plan.name}:${resource.uri}`,
        });
      }
    }
    return out.sort((a, b) => compare(a.server, b.server) || compare(a.name, b.name));
  }

  /**
   * The text of every `@server:scheme://…` mention in a message whose server is connected, each
   * read from the server, at most `maxChars` characters each.
   */
  async mentionTexts(text: string, signal: AbortSignal, maxChars: number): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(/@([A-Za-z0-9_.-]+):([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]+)/g)) {
      const server = match[1] as string;
      const uri = (match[2] as string).replace(/[.,;:!?)\]}'"]+$/, "");
      const held = this.#held.get(server);
      if (held === undefined || seen.has(`${server}\n${uri}`)) continue;
      seen.add(`${server}\n${uri}`);
      try {
        // Counted as this session's request, though nobody can be asked during a mention.
        const result = await held.connection.readResource(uri, signal, {
          sessionId: this.sessionId,
          toolCallId: null,
          ask: null,
          note: () => {},
        });
        const parts = result.contents.map((content) =>
          "text" in content && typeof content.text === "string"
            ? content.text
            : `[Binary content (${content.mimeType ?? "unknown type"}), not shown.]`,
        );
        let body = parts.join("\n");
        const cut = body.length > maxChars;
        if (cut) body = body.slice(0, maxChars);
        out.push(
          `Contents of the MCP resource ${uri} from ${server}, mentioned by the person:\n\`\`\`\n${body}\n\`\`\`${cut ? `\n[cut at ${maxChars} characters]` : ""}`,
        );
      } catch (error) {
        out.push(
          `The person mentioned the MCP resource ${uri} from ${server}, which could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return out;
  }

  /** Each connected server's prompts as slash commands. */
  promptCommands(): SlashCommand[] {
    const out: SlashCommand[] = [];
    const taken = new Set<string>();
    for (const { plan, connection } of this.#held.values()) {
      if (connection.state !== "connected") continue;
      for (const prompt of connection.prompts) {
        const name = mcpPromptCommandName(plan.name, prompt.name);
        if (name === null || taken.has(name)) continue;
        taken.add(name);
        out.push(this.#promptCommand(name, plan, prompt));
      }
    }
    return out.sort((a, b) => compare(a.name, b.name));
  }

  #promptCommand(name: string, plan: McpServerPlan, prompt: Prompt): SlashCommand {
    const args = prompt.arguments ?? [];
    const hint = args.map((a) => (a.required === true ? `<${a.name}>` : `[${a.name}]`)).join(" ");
    const line = (prompt.description ?? prompt.title ?? "").split("\n")[0]?.trim() ?? "";
    const description = `${line === "" ? `A prompt from ${plan.name}` : line.replace(/[.!?…]+$/, "")} (MCP)`;
    return {
      name,
      description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
      argumentHint: hint === "" ? null : hint,
      source: plan.scope === "project" ? "project" : "user",
      kind: "command",
      run: async (ctx) => {
        if (ctx.session.busy) {
          throw new RuntimeError(
            "SessionBusy",
            `/${name} has to wait until the current turn ends.`,
          );
        }
        const words = splitArguments(ctx.args, name);
        const values: Record<string, string> = {};
        args.forEach((arg, i) => {
          const value =
            i === args.length - 1 && words.length > args.length
              ? words.slice(i).join(" ")
              : words[i];
          if (value !== undefined) values[arg.name] = value;
        });
        const missing = args.filter((a) => a.required === true && values[a.name] === undefined);
        if (missing.length > 0) {
          throw new CommandError(
            name,
            `/${name} needs ${missing.map((a) => a.name).join(" and ")}: /${name} ${hint}`,
          );
        }
        const held = this.#held.get(plan.name);
        if (held === undefined || held.connection.state !== "connected") {
          throw new CommandError(name, `The MCP server ${plan.name} is not connected now.`);
        }
        // Added (Phase 4, hooks): UserPromptExpansion hooks may stop it before it expands.
        const blocked = await ctx.session.commandExpansionHooks({
          expansionType: "mcp_prompt",
          name,
          args: ctx.args,
          source: "mcp",
        });
        if (blocked !== null) throw new CommandError(name, blocked);
        let result: Awaited<ReturnType<McpConnection["getPrompt"]>>;
        try {
          result = await held.connection.getPrompt(
            prompt.name,
            values,
            new AbortController().signal,
          );
        } catch (error) {
          throw new CommandError(
            name,
            `${plan.name} could not give the prompt: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const text = result.messages
          .map((message) => {
            const content = message.content as {
              type: string;
              text?: string;
              resource?: { uri: string; text?: string };
            };
            if (content.type === "text") return content.text ?? "";
            if (content.type === "resource" && content.resource !== undefined) {
              return content.resource.text ?? `[The resource ${content.resource.uri}.]`;
            }
            return `[${content.type} content, not shown.]`;
          })
          .filter((t) => t.trim() !== "")
          .join("\n\n");
        return {
          kind: "prompt",
          prompt: { content: [{ type: "text", text: text === "" ? `/${name}` : text }] },
          text: null,
          options: { command: { name, args: ctx.args } },
        };
      },
    };
  }

  /** Added (round 3, sign-in): a server of the session by name, with its connection. */
  planNamed(name: string): { plan: McpServerPlan; connection: McpConnection | null } | null {
    const plan = this.#plans.find((p) => p.name === name);
    if (plan === undefined) return null;
    return { plan, connection: this.#held.get(name)?.connection ?? null };
  }

  /** Added (round 3, sign-in): reads the servers' sign-ins, so `infos` says which hold one. */
  async loadSignIns(): Promise<void> {
    await this.#manager?.loadSignIns(this.#plans);
  }

  /** The session's servers as `/mcp` shows them. */
  infos() {
    const manager = this.#manager;
    if (manager === null) return [];
    return this.#plans
      .map((plan) => manager.info(plan, this.#held.get(plan.name)?.connection ?? null))
      .sort((a, b) => compare(a.name, b.name));
  }

  /**
   * Added (Phase 4, hooks): waits up to `ms` for one server that is still starting, for an
   * `mcp_tool` hook on an event that can block (../hooks/mcp-tool.ts).
   */
  async whenServerSettled(server: string, ms: number): Promise<void> {
    await this.#held.get(server)?.connection.whenSettled(ms);
  }

  /** Lets go of every server; the manager stops those no other session uses. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unregister();
    for (const held of this.#held.values()) this.#manager?.release(held.plan.key, this.sessionId);
    this.#held.clear();
  }
}
