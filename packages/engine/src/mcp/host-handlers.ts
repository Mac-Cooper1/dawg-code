/**
 * The protocol's MCP methods, for the host (../host/host.ts): Settings → MCP servers
 * (`mcp.list`, `mcp.restart`, `mcp.setEnabled`), the import of Claude Code's servers
 * (`mcp.importPreview`, `mcp.import`), what a session's composer offers (`mcp.session`), and
 * signing in to remote servers (`mcp.signIn`, `mcp.signOut`, `mcp.cancelSignIn`, round 3).
 */
import path from "node:path";
import { applyMcpImport, McpImportError, planMcpImport } from "@dawg/compat";
import { type ClientCapabilities, ErrorCodes, type Handlers, RpcError } from "@dawg/protocol";
import { CommandRegistry } from "../commands/registry.ts";
import type { SlashCommand } from "../commands/types.ts";
import type { Engine } from "../runtime/engine.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import type { McpConnection } from "./connection.ts";
import { McpManagerError, type McpServerPlan } from "./manager.ts";

type McpHandlers = Pick<
  Handlers,
  | "mcp.list"
  | "mcp.restart"
  | "mcp.setEnabled"
  | "mcp.importPreview"
  | "mcp.import"
  | "mcp.session"
  | "mcp.signIn"
  | "mcp.signOut"
  | "mcp.cancelSignIn"
>;

function absoluteOrNull(value: string | null): void {
  if (value !== null && !path.isAbsolute(value)) {
    throw new RpcError(ErrorCodes.InvalidParams, "projectDir must be an absolute path.");
  }
}

function asRuntimeError(error: unknown): never {
  if (error instanceof McpManagerError) throw new RuntimeError(error.code, error.message);
  if (error instanceof McpImportError) throw new RuntimeError("InvalidState", error.message);
  throw error;
}

export function mcpHandlers(
  engine: Engine,
  requireOpen: (sessionId: string) => Promise<SessionRuntime>,
  /** What the connected client can answer: a run with nobody there never signs in. */
  capabilities: () => Partial<ClientCapabilities> = () => ({}),
): McpHandlers {
  const manager = engine.mcp;
  /** The server a sign-in method names: the session's, or the project's. */
  const serverOf = async (params: {
    projectDir: string | null;
    name: string;
    sessionId?: string | undefined;
  }): Promise<{ plan: McpServerPlan; connection: McpConnection | null; cwd: string | null }> => {
    absoluteOrNull(params.projectDir);
    if (params.sessionId !== undefined) {
      const runtime = await requireOpen(params.sessionId);
      const found = runtime.mcp.planNamed(params.name);
      if (found === null) {
        throw new RuntimeError("InvalidParams", `No MCP server is named ${params.name}.`);
      }
      return { ...found, cwd: runtime.mcp.cwd };
    }
    try {
      const plan = await manager.findPlan(params.projectDir, params.name);
      return { plan, connection: manager.connection(plan), cwd: params.projectDir };
    } catch (error) {
      return asRuntimeError(error);
    }
  };
  return {
    "mcp.list": async (params) => {
      absoluteOrNull(params.projectDir);
      const servers = async () => {
        if (params.sessionId === undefined) return manager.list(params.projectDir);
        const runtime = await requireOpen(params.sessionId);
        await runtime.mcp.loadSignIns();
        return runtime.mcp.infos();
      };
      const [listed, plan] = await Promise.all([
        servers(),
        planMcpImport(manager.homeDir).catch(() => null),
      ]);
      return {
        projectDir: params.projectDir,
        servers: listed,
        importable: plan?.items.filter((item) => item.action === "copy").length ?? 0,
      };
    },
    "mcp.signIn": async (params) => {
      const now = capabilities();
      if (now.permissionPrompts === false && now.questions === false) {
        throw new RuntimeError(
          "InvalidState",
          "Nobody is here to finish signing in, so this run does not start one. Sign in from dawg or Settings → MCP servers first.",
        );
      }
      const { plan, cwd } = await serverOf(params);
      try {
        return { url: await manager.signIn(plan, cwd) };
      } catch (error) {
        return asRuntimeError(error);
      }
    },
    "mcp.signOut": async (params) => {
      const { plan, connection } = await serverOf(params);
      try {
        await manager.signOut(plan);
      } catch (error) {
        return asRuntimeError(error);
      }
      return { server: manager.info(plan, connection ?? manager.connection(plan)) };
    },
    "mcp.cancelSignIn": async (params) => {
      const { plan, connection } = await serverOf(params);
      try {
        manager.cancelSignIn(plan);
      } catch (error) {
        return asRuntimeError(error);
      }
      return { server: manager.info(plan, connection ?? manager.connection(plan)) };
    },
    "mcp.restart": async (params) => {
      absoluteOrNull(params.projectDir);
      try {
        const server = await manager.restart(params.projectDir, params.name);
        await manager.refresh(params.projectDir);
        return { server };
      } catch (error) {
        return asRuntimeError(error);
      }
    },
    "mcp.setEnabled": async (params) => {
      absoluteOrNull(params.projectDir);
      try {
        return {
          enabled: await manager.setEnabled(params.projectDir, params.name, params.enabled),
        };
      } catch (error) {
        return asRuntimeError(error);
      }
    },
    "mcp.importPreview": async () => {
      try {
        return await planMcpImport(manager.homeDir);
      } catch (error) {
        return asRuntimeError(error);
      }
    },
    "mcp.import": async (params) => {
      try {
        return await applyMcpImport(manager.homeDir, params.hash);
      } catch (error) {
        return asRuntimeError(error);
      }
    },
    "mcp.session": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return {
        resources: runtime.mcp.resources(),
        prompts: runtime.mcp.promptCommands().map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint,
          source: command.source ?? "user",
          kind: "command" as const,
        })),
      };
    },
  };
}

/**
 * A session's commands with its connected servers' prompts added (`/mcp__server__prompt`).
 * Servers connect after the registry is made, so they are added each time it is used.
 */
export function withMcpPrompts(
  registry: CommandRegistry,
  runtime: SessionRuntime,
): CommandRegistry {
  const prompts: SlashCommand[] = runtime.mcp.promptCommands().filter((c) => !registry.has(c.name));
  if (prompts.length === 0) return registry;
  return new CommandRegistry([...registry.list(), ...prompts]);
}
