/**
 * `/agents`: the subagents sessions in this project can start, and this session's own agents.
 * Claude Code's `/agents` now prints where to put agent files (its older versions opened a
 * wizard with a Running tab and a Library tab); here the listing does both jobs in text. The
 * app opens Settings → Subagents instead, with a form for a new one; `dawg` prints this.
 */
import path from "node:path";
import type { SubagentDefinition, SubagentInfo } from "@dawg/protocol";
import { CommandError, type SlashCommand } from "../commands/types.ts";
import { projectSubagents } from "./list.ts";

const STATUS: Partial<Record<SubagentDefinition["status"], string>> = {
  "partly-supported": "partly supported",
  "needs-approval": "waits for approval",
  invalid: "cannot be used",
  overridden: "not used",
};

const RUNNING: Record<SubagentInfo["status"], string> = {
  queued: "queued",
  running: "running",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

/** A path as a person reads it: relative inside the project, `~/` inside home, else absolute. */
function show(file: string, projectDir: string, homeDir: string): string {
  const inside = (base: string) => {
    const rel = path.relative(base, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
  };
  const rel = projectDir === homeDir ? null : inside(projectDir);
  if (rel !== null) return rel.split(path.sep).join("/");
  const home = inside(homeDir);
  return home === null ? file : `~/${home.split(path.sep).join("/")}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The lines for one definition: its name, state and file, then what it is for. */
function definitionLines(agent: SubagentDefinition, projectDir: string, homeDir: string): string[] {
  const status = STATUS[agent.status];
  const file = agent.source === null ? "" : `  ${show(agent.source.path, projectDir, homeDir)}`;
  const head = `  ${agent.name}${status === undefined ? "" : ` (${status})`}${file}`;
  const lines = [head];
  if (agent.description !== "") lines.push(`    ${oneLine(agent.description, 160)}`);
  const facts: string[] = [];
  if (agent.tools !== null) facts.push(`tools: ${agent.tools.join(", ")}`);
  if (agent.memory !== null) facts.push(`memory: ${agent.memory}`);
  if (agent.mcpServers.length > 0) {
    facts.push(
      `MCP: ${agent.mcpServers.map((s) => (s.inline ? `${s.name} (own)` : s.name)).join(", ")}`,
    );
  }
  if (agent.background) facts.push("background");
  if (agent.isolation !== null) facts.push(`isolation: ${agent.isolation}`);
  if (facts.length > 0) lines.push(`    ${facts.join("; ")}`);
  if (agent.status !== "loaded") {
    for (const note of agent.notes.slice(0, 2)) lines.push(`    ${note}`);
  }
  return lines;
}

export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "List the subagents sessions here can start, and this session's agents",
  argumentHint: null,
  async run(ctx) {
    if (ctx.args !== "") throw new CommandError(ctx.name, "/agents takes no arguments.");
    const session = ctx.session;
    const projectDir = session.projectDir;
    const listing = await projectSubagents({
      homeDir: ctx.homeDir,
      storeRoot: ctx.engine.storeRoot,
      projectDir,
      trust: ctx.engine.trust,
    });
    const groups: [string, SubagentDefinition[]][] = [
      ["Built in", listing.agents.filter((a) => a.builtIn)],
      [
        "Yours (~/.claude/agents, ~/.dawg/agents)",
        listing.agents.filter((a) => a.source?.scope === "user"),
      ],
      [
        "This project's (.claude/agents, .dawg/agents)",
        listing.agents.filter((a) => !a.builtIn && a.source?.scope !== "user"),
      ],
    ];
    const lines = ["Subagents for new sessions here:"];
    for (const [title, agents] of groups) {
      if (agents.length === 0) continue;
      lines.push("", title);
      for (const agent of agents) lines.push(...definitionLines(agent, projectDir, ctx.homeDir));
    }
    const own = session.agents?.list() ?? [];
    if (own.length > 0) {
      lines.push("", "This session's agents:");
      for (const info of own) {
        lines.push(
          `  ${info.agentId} ${info.agentType}: ${oneLine(info.description, 80)} (${RUNNING[info.status]}${info.background ? ", background" : ""})`,
        );
      }
    }
    lines.push(
      "",
      `To add one, write a Markdown file with front matter in ${show(listing.folders.user, projectDir, ctx.homeDir)}/ or the project's .dawg/agents/, or use Settings → Subagents in the app. New sessions pick up changes; this one keeps the agents it started with.`,
    );
    return { kind: "output", text: lines.join("\n") };
  },
};
