/**
 * The protocol server: serves the whole engine protocol to one client over one transport. A thin
 * mapping onto the engine and its session runtimes, which already speak the protocol's shapes.
 * See README.md in this folder for what happens to sessions when the connection closes.
 */
import { homedir } from "node:os";
import path from "node:path";
import { buildCompatReport, type SettingsFlags } from "@dawg/compat";
import {
  type ClientCapabilities,
  createServer,
  ErrorCodes,
  EVENT_NAMES,
  type EventName,
  type EventPayloadInput,
  type Handler,
  type Handlers,
  METHOD_NAMES,
  type MethodName,
  RpcError,
  type Server,
  type SessionSnapshot,
  type Transport,
} from "@dawg/protocol";
import { type CommandRegistry, createCommandRegistry } from "../commands/index.ts";
import type { EndpointDescription } from "../commands/types.ts";
import { listHooks, setHookEnabled } from "../hooks/list.ts";
import { mcpHandlers, withMcpPrompts } from "../mcp/host-handlers.ts";
import type { Engine } from "../runtime/engine.ts";
import { RuntimeError } from "../runtime/errors.ts";
import { rewindSession } from "../runtime/rewind.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import { projectSkills, sessionCommandRegistry } from "../skills/index.ts";
import { withApproval } from "../trust/report.ts";
import { attachmentsFor } from "./attachments.ts";
import { toRpcError } from "./errors.ts";

/** Ten minutes: long enough to reopen a closed window and answer what the turn is waiting on. */
export const DEFAULT_DETACH_GRACE_MS = 10 * 60_000;

export interface HostProblem {
  kind: "server" | "handler_error" | "notify_failed" | "close_failed";
  message: string;
  detail?: unknown;
}

export interface EngineHostOptions {
  /** What `initialize` reports as the engine. */
  engineInfo?: { name: string; version: string };
  /** Slash commands. Defaults to a registry of the built-in commands. */
  commands?: CommandRegistry;
  /** The person's home directory, for `/permissions` and `/init`. Defaults to the OS's. */
  homeDir?: string;
  /** The command-line settings the engine was created with, for `/permissions`. */
  settingsFlags?: SettingsFlags;
  /** Describes the endpoint behind a session's model, for `/status` and `/model`. */
  describeEndpoint?: (session: SessionRuntime) => EndpointDescription | null;
  /**
   * How long a turn left running by a closed connection may go on with nobody attached before
   * it is interrupted. 0 interrupts it at once. Default `DEFAULT_DETACH_GRACE_MS`.
   */
  detachGraceMs?: number;
  /** Reported by `initialize`: the largest message the transport accepts, or null. */
  maxMessageLength?: number | null;
  /** Check outgoing results and events against their schemas. Default: unless in production. */
  validateOutgoing?: boolean;
  /** Failures worth logging. Never sent to the client. */
  onProblem?: (problem: HostProblem) => void;
}

export interface EngineHost {
  readonly server: Server;
  /** Ids of the sessions open on this connection. */
  openSessions(): string[];
  /** Closes the connection; resolves once its sessions have been dealt with. */
  close(): Promise<void>;
  /** Resolves once the connection has closed and its sessions have been dealt with. */
  readonly done: Promise<void>;
}

const ALL_ANSWERABLE: ClientCapabilities = {
  permissionPrompts: true,
  questions: true,
  planApproval: true,
};

export function createEngineHost(
  engine: Engine,
  transport: Transport,
  options: EngineHostOptions = {},
): EngineHost {
  const holder = Symbol("connection");
  const attachments = attachmentsFor(engine);
  const commands = options.commands ?? createCommandRegistry();
  const homeDir = options.homeDir ?? homedir();
  const graceMs = Math.max(0, options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS);
  const describeEndpoint = options.describeEndpoint ?? (() => null);
  const report = (problem: HostProblem) => {
    try {
      options.onProblem?.(problem);
    } catch {
      // A failing logger must not break the connection.
    }
  };

  /** Sessions open on this connection, in the order they were opened. */
  const open = new Set<string>();
  let capabilities: ClientCapabilities = { ...ALL_ANSWERABLE };

  // -------------------------------------------------------------------------------------------

  function knownRoots(extra: readonly string[] = []): string[] {
    const roots = [...extra];
    for (const id of open) {
      const runtime = engine.get(id);
      if (runtime !== undefined) roots.push(runtime.cwd, ...runtime.additionalDirectories);
    }
    return roots;
  }

  /** Each session's commands: dawg's own, then its skills and custom commands (../skills). */
  const sessionCommands = new WeakMap<SessionRuntime, CommandRegistry>();
  function commandsOf(runtime: SessionRuntime): CommandRegistry {
    let registry = sessionCommands.get(runtime);
    if (registry === undefined) {
      registry = sessionCommandRegistry(commands, runtime.skills);
      sessionCommands.set(runtime, registry);
    }
    // The prompts of its MCP servers, which may connect after it opened (../mcp).
    return withMcpPrompts(registry, runtime);
  }

  function snapshotOf(runtime: SessionRuntime): SessionSnapshot {
    return { ...runtime.snapshot(), commands: commandsOf(runtime).info() };
  }

  function attach(runtime: SessionRuntime): SessionSnapshot {
    open.add(runtime.id);
    attachments.attach(runtime, holder, capabilities);
    return snapshotOf(runtime);
  }

  /** The runtime of a session open on this connection, or the protocol's error for it. */
  async function requireOpen(sessionId: string): Promise<SessionRuntime> {
    const runtime = engine.get(sessionId);
    if (open.has(sessionId)) {
      if (runtime !== undefined && !runtime.closed) return runtime;
      // Closed underneath this connection, for example by `/clear` in another window.
      open.delete(sessionId);
      attachments.detach(sessionId, holder);
      throw new RuntimeError("InvalidState", `Session ${sessionId} was closed; resume it first.`);
    }
    const stored =
      runtime !== undefined ||
      (await engine.replay(sessionId, Number.MAX_SAFE_INTEGER, 1).then(
        () => true,
        () => false,
      ));
    if (!stored) throw new RuntimeError("SessionNotFound", `No session ${sessionId}.`);
    throw new RuntimeError(
      "InvalidState",
      `Session ${sessionId} is not open on this connection; resume it first.`,
    );
  }

  function absolute(value: string, field: string): void {
    if (!path.isAbsolute(value)) {
      throw new RpcError(ErrorCodes.InvalidParams, `${field} must be an absolute path.`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------------------------

  const handlers: Handlers = {
    initialize: (params) => {
      capabilities = { ...ALL_ANSWERABLE, ...params.capabilities };
      return {
        protocolVersion: params.protocolVersion,
        engine: options.engineInfo ?? { name: "dawg-engine", version: "0.0.0" },
        capabilities: {
          methods: [...METHOD_NAMES],
          events: [...EVENT_NAMES],
          maxMessageLength: options.maxMessageLength ?? null,
        },
      };
    },

    "session.create": async (params) => {
      absolute(params.cwd, "cwd");
      if (params.projectDir !== undefined) absolute(params.projectDir, "projectDir");
      const runtime = await engine.createSession({
        cwd: params.cwd,
        capabilities,
        ...(params.projectDir === undefined ? {} : { projectDir: params.projectDir }),
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.mode === undefined ? {} : { mode: params.mode }),
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.effort === undefined ? {} : { effort: params.effort }),
        ...(params.additionalDirectories === undefined
          ? {}
          : { additionalDirectories: params.additionalDirectories }),
      });
      return attach(runtime);
    },

    "session.resume": async (params) => {
      const runtime = await engine.resumeSession(params.sessionId, { capabilities });
      return attach(runtime);
    },

    "session.fork": async (params) => {
      if (params.cwd !== undefined) absolute(params.cwd, "cwd");
      const runtime = await engine.forkSession(params.sessionId, {
        capabilities,
        ...(params.point === undefined ? {} : { point: params.point }),
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      });
      return attach(runtime);
    },

    "session.list": (params) => engine.listSessions(params),

    "session.rename": async (params) => ({
      session: await engine.renameSession(params.sessionId, params.title),
    }),

    "session.archive": async (params) => ({
      session: await engine.archiveSession(params.sessionId, params.archived ?? true),
    }),

    "session.delete": async (params) => {
      // Every connection holding the session, this one included, drops it on `session.deleted`.
      await engine.deleteSession(params.sessionId);
      return {};
    },

    "session.prompt": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return runtime.prompt(params.prompt);
    },

    "session.interrupt": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return { interrupted: runtime.interrupt() };
    },

    "session.setMode": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return { mode: runtime.setMode(params.mode) };
    },

    "session.setModel": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return runtime.setModel(params.model);
    },

    "session.setEffort": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return { effort: runtime.setEffort(params.effort) };
    },

    "session.command": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      const result = await commandsOf(runtime).run(params.name, {
        args: params.args,
        session: runtime,
        engine,
        homeDir,
        settingsFlags: options.settingsFlags,
        capabilities,
        describeEndpoint,
      });
      switch (result.kind) {
        case "output":
          return { output: result.text, turnId: null, openedSession: null };
        case "prompt": {
          // The turn shows the command as typed; the model is sent what it expands to.
          const typed = {
            name: params.name.replace(/^\//, "").toLowerCase(),
            args: params.args.trim(),
          };
          const { turnId } = await runtime.prompt(
            result.prompt,
            result.options ?? { command: typed },
          );
          return { output: result.text, turnId, openedSession: null };
        }
        case "session": {
          if (result.replaces !== null) {
            open.delete(result.replaces);
            attachments.detach(result.replaces, holder);
          }
          return { output: result.text, turnId: null, openedSession: attach(result.session) };
        }
      }
    },

    "session.replay": async (params) => {
      const page = await engine.replay(params.sessionId, params.afterSeq, params.limit);
      return { events: page.events, lastSeq: page.lastSeq, hasMore: page.hasMore };
    },

    // Checkpoints and rewind (../runtime/rewind.ts).
    "session.checkpoints": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return runtime.checkpoints();
    },

    "session.rewind": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      const outcome = await rewindSession(
        engine,
        runtime,
        {
          checkpointId: params.checkpointId,
          action: params.action,
          overwrite: params.overwrite,
          instructions: params.instructions ?? null,
        },
        { capabilities },
      );
      return {
        outcome: outcome.outcome,
        conflicts: outcome.conflicts,
        files: outcome.files,
        // The conversation goes on in the fork, open here like any session this connection forks.
        session: outcome.session === null ? null : attach(outcome.session),
        prompt: outcome.prompt,
      };
    },

    "background.output": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return runtime.readBackgroundOutput(params.taskId, params.offset, params.limit);
    },

    "background.stop": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      return { stopped: await runtime.stopBackground(params.taskId) };
    },

    "subagent.stop": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      const agents = runtime.agents;
      if (agents === null || !agents.list().some((a) => a.agentId === params.agentId)) {
        throw new RuntimeError(
          "InvalidParams",
          `There is no agent ${params.agentId} in this session.`,
        );
      }
      return { stopped: await agents.stop(params.agentId) };
    },

    // The compatibility report (compat's providers) with the engine's consent for the code it
    // supplies (trust/index.ts).
    "project.inspect": async (params) => {
      if (params.projectDir !== null) absolute(params.projectDir, "projectDir");
      const report = await buildCompatReport({ projectDir: params.projectDir, homeDir });
      const approval = await engine.trust.approval(params.projectDir);
      // Items that would run but wait for consent say so (../trust/report.ts).
      return { ...report, items: withApproval(report.items, approval), approval };
    },

    "project.trust": async (params) => {
      absolute(params.projectDir, "projectDir");
      try {
        const approved = await engine.trust.decide(params.projectDir, params.hash, params.approved);
        // The project's MCP servers start (or stop) in its open sessions now.
        await engine.mcp.refresh(params.projectDir);
        return { approved };
      } catch (error) {
        throw new RuntimeError(
          "InvalidState",
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    // Settings → Hooks: every hook, its consent and the person's switch (../hooks/list.ts).
    "hooks.list": async (params) => {
      if (params.projectDir !== null) absolute(params.projectDir, "projectDir");
      return listHooks(engine.trust, { projectDir: params.projectDir, homeDir });
    },

    "hooks.setEnabled": async (params) => {
      if (params.projectDir !== null) absolute(params.projectDir, "projectDir");
      const enabled = await setHookEnabled(engine.trust, {
        projectDir: params.projectDir,
        homeDir,
        id: params.id,
        enabled: params.enabled,
      });
      return { enabled };
    },

    // Settings → Skills and commands: what a project's sessions get (../skills/info.ts).
    "project.skills": async (params) => {
      if (params.projectDir !== null) absolute(params.projectDir, "projectDir");
      return projectSkills({ homeDir, projectDir: params.projectDir, builtins: commands });
    },

    // Settings → MCP servers, the import of Claude Code's, and the composer's (../mcp).
    ...mcpHandlers(engine, requireOpen),

    "permission.respond": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      runtime.respondPermission(params.requestId, params.response);
      return {};
    },

    "question.respond": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      runtime.respondQuestion(params.requestId, params.response);
      return {};
    },

    "plan.respond": async (params) => {
      const runtime = await requireOpen(params.sessionId);
      runtime.respondPlan(params.requestId, params.response);
      return {};
    },
  };

  /** Every handler's failures become protocol errors with nothing internal in them. */
  function guarded<M extends MethodName>(method: M, handler: Handler<M>): Handler<M> {
    return async (params, context) => {
      try {
        return await handler(params, context);
      } catch (error) {
        const extra = (params as { cwd?: unknown }).cwd;
        throw toRpcError(error, {
          method,
          allowedRoots: knownRoots(typeof extra === "string" ? [extra] : []),
          report: (message, detail) => report({ kind: "handler_error", message, detail }),
        });
      }
    };
  }

  const wrapped = Object.fromEntries(
    METHOD_NAMES.map((name) => [name, guarded(name, handlers[name] as Handler<typeof name>)]),
  ) as unknown as Handlers;

  const server = createServer(transport, wrapped, {
    ...(options.validateOutgoing === undefined
      ? {}
      : { validateOutgoing: options.validateOutgoing }),
    onProblem: (problem) =>
      report({ kind: "server", message: problem.message, detail: problem.detail }),
  });

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  // One subscription for the whole engine; only sessions open here are forwarded. Events reach
  // this listener synchronously as they are emitted, so they go out in `seq` order.
  const stopEvents = engine.subscribe((event) => {
    const sessionId = event.payload.sessionId;
    if (!open.has(sessionId)) return;
    if (event.event === "session.deleted") {
      // The session's last event: it is no longer open here, and requests on it find nothing.
      open.delete(sessionId);
      attachments.detach(sessionId, holder);
    }
    try {
      server.notify(event.event, event.payload as EventPayloadInput<EventName>);
    } catch (error) {
      report({
        kind: "notify_failed",
        message: `Could not send ${event.event} #${event.payload.seq}`,
        detail: error,
      });
    }
  });

  // -------------------------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------------------------

  async function release(sessionId: string): Promise<void> {
    const remaining = attachments.detach(sessionId, holder);
    const runtime = engine.get(sessionId);
    if (runtime === undefined || runtime.closed) return;
    if (remaining > 0) {
      // Another window still has it: it now answers alone.
      runtime.setCapabilities(attachments.capabilities(sessionId));
      return;
    }
    if (runtime.busy && graceMs > 0) {
      attachments.orphan(runtime, graceMs);
      return;
    }
    // Idle, or nobody may be left waiting: close (which interrupts a running turn first).
    await runtime.close();
  }

  let releasing: Promise<void> | null = null;
  const releaseAll = (): Promise<void> => {
    if (releasing !== null) return releasing;
    stopEvents();
    const ids = [...open];
    open.clear();
    releasing = Promise.all(
      ids.map((id) =>
        release(id).catch((error) =>
          report({ kind: "close_failed", message: `Could not close session ${id}`, detail: error }),
        ),
      ),
    ).then(() => {});
    return releasing;
  };

  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  server.onClose(() => {
    void releaseAll().then(resolveDone);
  });
  if (server.closed) void releaseAll().then(resolveDone);

  return {
    server,
    openSessions: () => [...open],
    async close() {
      server.close();
      await releaseAll();
      resolveDone();
    },
    done,
  };
}
