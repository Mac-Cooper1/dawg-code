/**
 * `/mcp`: the session's MCP servers and their state; `/mcp restart|on|off <name>`; signing in to
 * a remote server and out again (`/mcp login|logout <name>`, round 3: the address to open in the
 * browser; the command line opens it itself); and the import of Claude Code's own servers, which
 * first shows what would be copied and copies only when run again with the code that list ends
 * with (spec, MCP: an explicit, one-time action).
 */
import { applyMcpImport, McpImportError, planMcpImport } from "@dawg/compat";
import type { McpImportPlan, McpServerInfo } from "@dawg/protocol";
import { CommandError, type SlashCommand } from "../commands/types.ts";
import { McpManagerError, type McpServerPlan } from "./manager.ts";
import { SIGN_IN_TIMEOUT_MS } from "./oauth.ts";

const STATE_WORDS: Record<McpServerInfo["state"], string> = {
  connected: "connected",
  starting: "starting",
  failed: "failed",
  "needs-approval": "waits for your approval",
  "needs-sign-in": "needs sign-in",
  off: "off",
};

const SCOPE_WORDS: Record<McpServerInfo["scope"], string> = {
  session: "this session's",
  local: "yours, for this project",
  project: "the project's .mcp.json",
  user: "yours",
};

/** One server as a Markdown list item. */
export function serverLine(server: McpServerInfo): string {
  const transport = server.transport ?? "not runnable";
  const tools =
    server.state === "connected"
      ? `, ${server.tools.length === 1 ? "1 tool" : `${server.tools.length} tools`}`
      : "";
  const reason = server.reason === null ? "" : `: ${server.reason}`;
  const signIn =
    server.signIn?.status === "signing-in"
      ? " Signing in: waiting for the browser."
      : server.signIn?.status === "signed-in" && server.state !== "needs-sign-in"
        ? " Signed in."
        : "";
  // After a reason, which ends a sentence; otherwise the state's words need their full stop.
  const tail = signIn === "" || reason !== "" ? signIn : `.${signIn}`;
  return `- **${server.name}** (${SCOPE_WORDS[server.scope]}, ${transport}): ${STATE_WORDS[server.state]}${tools}${reason}${tail}`;
}

/** The words for a sign-in's address, in Markdown, with what happens next. */
export function signInText(name: string, url: string): string {
  const minutes = Math.round(SIGN_IN_TIMEOUT_MS / 60_000);
  return [
    `Open this address in your browser to sign in to **${name}**:`,
    "",
    `<${url}>`,
    "",
    `dawg waits ${minutes} minutes for the browser to come back, then connects to ${name}.`,
  ].join("\n");
}

/** The code `/mcp import <code>` takes: the start of the plan's hash. */
function codeOf(plan: McpImportPlan): string | null {
  return plan.hash === null ? null : plan.hash.replace(/^sha256:/, "").slice(0, 8);
}

/** What an import would copy, as Markdown. */
export function importText(plan: McpImportPlan): string {
  if (plan.items.length === 0) return `Claude Code's ${plan.from} holds no MCP servers.`;
  const lines = [`From ${plan.from} (read, never changed) into ${plan.to}:`, ""];
  for (const item of plan.items) {
    const where = item.project === null ? "every project" : item.project;
    const what = `**${item.name}** (${where}): ${item.target === "" ? "no target" : item.target}`;
    if (item.action === "skip") {
      lines.push(`- Left out: ${what}. ${item.reason ?? ""}`.trimEnd());
      continue;
    }
    const secrets =
      item.secrets.length === 0
        ? ""
        : ` Copies values that may be secrets: ${item.secrets.join(", ")}.`;
    lines.push(`- Copies ${what}.${secrets}`);
  }
  const code = codeOf(plan);
  lines.push(
    "",
    code === null
      ? "There is nothing to copy."
      : `To copy them, run \`/mcp import ${code}\`. Sessions opened afterwards start them.`,
  );
  return lines.join("\n");
}

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description:
    "Show the MCP servers, sign in to one, restart or turn one off, or import Claude Code's",
  argumentHint: "[login <name> | logout <name> | restart <name> | on <name> | off <name> | import]",
  async run(ctx) {
    const manager = ctx.engine.mcp;
    const [verb = "", ...rest] = ctx.args.split(/\s+/).filter(Boolean);
    const name = rest.join(" ");
    const projectDir = ctx.session.projectDir;
    /** The session's server of that name (its own ones included), or the project's. */
    const planOf = async (): Promise<McpServerPlan> =>
      ctx.session.mcp.planNamed(name)?.plan ?? (await manager.findPlan(projectDir, name));
    try {
      switch (verb.toLowerCase()) {
        case "": {
          await ctx.session.mcp.loadSignIns();
          const servers = ctx.session.mcp.infos();
          const plan = await planMcpImport(manager.homeDir);
          const importable = plan.items.filter((i) => i.action === "copy").length;
          const lines =
            servers.length === 0
              ? [
                  "No MCP servers are set up for this session. Add them to the project's .mcp.json or to ~/.dawg/mcp.json.",
                ]
              : ["MCP servers of this session:", "", ...servers.map(serverLine)];
          const waiting = servers.filter((s) => s.state === "needs-sign-in" && s.signIn !== null);
          if (waiting.length > 0) {
            lines.push(
              "",
              `To sign in, run ${waiting.map((s) => `\`/mcp login ${s.name}\``).join(" or ")}.`,
            );
          }
          if (importable > 0) {
            lines.push(
              "",
              `Claude Code's own settings hold ${importable === 1 ? "1 server" : `${importable} servers`} dawg has not imported. Run \`/mcp import\` to see what would be copied.`,
            );
          }
          return { kind: "output", text: lines.join("\n") };
        }
        case "import": {
          const plan = await planMcpImport(manager.homeDir);
          if (name === "") return { kind: "output", text: importText(plan) };
          const code = codeOf(plan);
          if (code === null || name !== code || plan.hash === null) {
            throw new CommandError(
              "mcp",
              "That code does not match what there is to import now. Run /mcp import to see the list again.",
            );
          }
          const result = await applyMcpImport(manager.homeDir, plan.hash);
          return {
            kind: "output",
            text: `Copied ${result.imported === 1 ? "1 server" : `${result.imported} servers`} into ${result.path}. Sessions opened from now on start them.`,
          };
        }
        case "login":
        case "sign-in": {
          if (name === "") throw new CommandError("mcp", `Name the server: /mcp ${verb} <name>`);
          if (
            ctx.capabilities.permissionPrompts === false &&
            ctx.capabilities.questions === false
          ) {
            throw new CommandError(
              "mcp",
              `Nobody is here to finish signing in, so this run does not start one. Sign in to ${name} from dawg or Settings → MCP servers first.`,
            );
          }
          const url = await manager.signIn(await planOf(), ctx.session.mcp.cwd);
          return { kind: "output", text: signInText(name, url) };
        }
        case "logout":
        case "sign-out": {
          if (name === "") throw new CommandError("mcp", `Name the server: /mcp ${verb} <name>`);
          await manager.signOut(await planOf());
          return {
            kind: "output",
            text: `Signed out of ${name}: dawg forgot its tokens and its registration with the server.`,
          };
        }
        case "restart": {
          if (name === "") throw new CommandError("mcp", "Name the server: /mcp restart <name>");
          const server = await manager.restart(projectDir, name);
          await ctx.session.mcp.refresh();
          return { kind: "output", text: serverLine(server) };
        }
        case "on":
        case "off": {
          if (name === "") throw new CommandError("mcp", `Name the server: /mcp ${verb} <name>`);
          const enabled = verb.toLowerCase() === "on";
          await manager.setEnabled(projectDir, name, enabled);
          return {
            kind: "output",
            text: enabled
              ? `${name} is on again. A session reaches its tools through ToolSearch until a new one lists them.`
              : `${name} is off: it stopped, and it does not start until you turn it on.`,
          };
        }
        default:
          throw new CommandError(
            "mcp",
            `Unknown /mcp ${verb}. Use /mcp, /mcp login <name>, /mcp logout <name>, /mcp restart <name>, /mcp on <name>, /mcp off <name> or /mcp import.`,
          );
      }
    } catch (error) {
      if (error instanceof McpImportError || error instanceof McpManagerError) {
        throw new CommandError("mcp", error.message);
      }
      throw error;
    }
  },
};
