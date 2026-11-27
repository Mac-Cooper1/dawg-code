/**
 * The protocol's MCP methods, for the host (../host/host.ts): Settings → MCP servers
 * (`mcp.list`, `mcp.restart`, `mcp.setEnabled`), the import of Claude Code's servers
 * (`mcp.importPreview`, `mcp.import`), and what a session's composer offers (`mcp.session`).
 */
import path from "node:path";
import { applyMcpImport, McpImportError, planMcpImport } from "@dawg/compat";
import { ErrorCodes, type Handlers, RpcError } from "@dawg/protocol";
import { CommandRegistry } from "../commands/registry.ts";
import type { SlashCommand } from "../commands/types.ts";
import type { Engine } from "../runtime/engine.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import { McpManagerError } from "./manager.ts";

type McpHandlers = Pick<
  Handlers,
  "mcp.list" | "mcp.restart" | "mcp.setEnabled" | "mcp.importPreview" | "mcp.import" | "mcp.session"
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
): McpHandlers {
  const manager = engine.mcp;
  return {
    "mcp.list": async (params) => {
      absoluteOrNull(params.projectDir);
      const [servers, plan] = await Promise.all([
        manager.list(params.projectDir),
        planMcpImport(manager.homeDir).catch(() => null),
      ]);
      return {
        projectDir: params.projectDir,
        servers,
        importable: plan?.items.filter((item) => item.action === "copy").length ?? 0,
      };
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
