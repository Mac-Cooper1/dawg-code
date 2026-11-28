/**
 * The engine's MCP servers: which definition of each applies to a session (compat's readers),
 * whether it may start (the person's consent for a project's servers, the settings keys, the
 * person's switches), and the running servers themselves, shared between sessions.
 *
 * Sharing. One connection per server is shared by the sessions that need the same one: same
 * working directory, same name, and the same definition once variables are expanded (so the same
 * environment and headers). That is safe because MCP lets one client make many calls at once,
 * each matched by its request id, and a server sees no difference between two sessions' calls
 * and one session's. It is not shared where it would not be the same server:
 *
 * - a worktree session has its own working directory, so a local server that reads "the current
 *   folder" runs there, not in the main checkout;
 * - a session's own additions are its alone;
 * - a definition that expands differently (another token in the environment) is another server.
 *
 * Servers keep state of their own (a browser page, an open database connection), and sessions of
 * one folder share it, as two tabs of one app would. Requests a server makes of the client
 * (elicitation, next round) belong to the call in progress that caused them.
 *
 * A server starts when the first session that uses it opens, and stops a few seconds after the
 * last one closes (`lingerMs`), so `/clear`, which closes one session and opens the next, does
 * not restart it.
 *
 * Signing in (round 3, oauth.ts): a remote server without an Authorization header of its own
 * gets its token from the credential store; `signIn` starts the browser step, and once it
 * finishes every connection to that server starts again with the token.
 */
import {
  approvedBySettings,
  blockedBySettings,
  effectiveDefinitions,
  type McpDefinition,
  type McpScope,
  readMcpSettings,
  readMcpSources,
} from "@dawg/compat";
import type { McpServerInfo, McpServerState } from "@dawg/protocol";
import type { CodeTrust } from "../trust/index.ts";
import { McpConnection } from "./connection.ts";
import { credentialId, type McpCredentialStore, MemoryCredentialStore } from "./credentials.ts";
import { mcpToolName } from "./names.ts";
import { authTarget, McpAuth, type McpAuthTarget, McpSignInError } from "./oauth.ts";
import { McpSwitches } from "./switches.ts";

/** How long connecting to a server may take (`MCP_TIMEOUT` in the environment overrides it). */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;
/** The pauses before each new start of a server that failed; then it stays failed. */
export const MCP_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
/** How long a server no session uses keeps running. */
export const MCP_LINGER_MS = 5_000;
/** How long a restart waits for the server to settle before it answers. */
export const MCP_RESTART_WAIT_MS = 20_000;
/** How long a server started from Settings to check it keeps running with no session. */
export const MCP_CHECK_LINGER_MS = 60_000;

export interface McpManagerOptions {
  homeDir: string;
  /** The engine's data root, where the person's switches are kept. */
  storeRoot: string;
  /** Consent for a project's servers. */
  trust: CodeTrust;
  /** The environment variables are expanded from and local servers start with. */
  env?: () => Readonly<Record<string, string | undefined>>;
  connectTimeoutMs?: number;
  restartDelaysMs?: readonly number[];
  lingerMs?: number;
  clientInfo?: { name: string; version: string };
  /**
   * Where sign-ins are kept (credentials.ts). The app and the command line pass the Keychain
   * store (`createCredentialStore`); without one they last as long as the engine.
   */
  credentials?: McpCredentialStore;
  /** How long a sign-in waits for the browser's return (oauth.ts: five minutes). */
  signInTimeoutMs?: number;
}

/** A server that applies to a session or a project, and whether it may start. */
export interface McpServerPlan {
  name: string;
  scope: McpScope;
  definition: McpDefinition;
  /** Null when it may start; otherwise its state and why. */
  blocked: { state: Exclude<McpServerState, "connected" | "starting">; reason: string } | null;
  /** False when the person turned it off. */
  enabled: boolean;
  /** Which connection it is: equal keys share one. */
  key: string;
  notes: string[];
}

interface Entry {
  connection: McpConnection;
  holders: Set<string>;
  linger: ReturnType<typeof setTimeout> | null;
  cwd: string;
  name: string;
  scope: McpScope;
  /** The sign-in it uses (`credentialId`), or null for a server that signs in no way. */
  authId: string | null;
}

/** What a session's MCP view needs from the manager (session.ts). */
export interface McpSessionLink {
  refresh(): Promise<void>;
  readonly cwd: string;
  readonly projectDir: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, sortKeys(record[k])]),
    );
  }
  return value;
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

export class McpManager {
  readonly homeDir: string;
  readonly #options: McpManagerOptions;
  readonly #switches: McpSwitches;
  readonly #connections = new Map<string, Entry>();
  readonly #sessions = new Set<McpSessionLink>();
  /** Signing in to remote servers, and their tokens (oauth.ts). */
  readonly #auth: McpAuth;
  /** The server a sign-in on its way is for, to start once it finishes: by `credentialId`. */
  readonly #signingIn = new Map<string, { plan: McpServerPlan; cwd: string }>();
  #closed = false;

  constructor(options: McpManagerOptions) {
    this.homeDir = options.homeDir;
    this.#options = options;
    this.#switches = new McpSwitches(options.storeRoot);
    this.#auth = new McpAuth({
      store: options.credentials ?? new MemoryCredentialStore(),
      env: () => this.env(),
      ...(options.signInTimeoutMs === undefined ? {} : { timeoutMs: options.signInTimeoutMs }),
      onSignedIn: (target) => this.#signedIn(target),
    });
  }

  /** Where sign-ins are kept. */
  get credentials(): McpCredentialStore {
    return this.#auth.store;
  }

  env(): Readonly<Record<string, string | undefined>> {
    return this.#options.env?.() ?? process.env;
  }

  get connectTimeoutMs(): number {
    const fromEnv = Number(this.env().MCP_TIMEOUT);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return this.#options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  }

  /** Every server that applies to a session in `cwd` (of `projectDir`), with what may start. */
  async plan(input: {
    cwd: string | null;
    projectDir: string | null;
    sessionId?: string;
    sessionServers?: Readonly<Record<string, unknown>>;
    /** Only the session's own servers (`--strict-mcp-config`). */
    strict?: boolean;
    settingsEnv?: Readonly<Record<string, string>>;
  }): Promise<McpServerPlan[]> {
    const env = { ...this.env(), ...input.settingsEnv };
    const sources = await readMcpSources({
      cwd: input.cwd,
      projectDir: input.projectDir,
      homeDir: this.homeDir,
      env,
      ...(input.sessionServers === undefined ? {} : { sessionServers: input.sessionServers }),
      ...(input.strict === true ? { strict: true } : {}),
    });
    const settings = await readMcpSettings({
      projectDir: input.cwd,
      localDir: input.projectDir,
      homeDir: this.homeDir,
    });
    const off = await this.#switches.off(input.projectDir);
    const plans: McpServerPlan[] = [];
    for (const definition of effectiveDefinitions(sources)) {
      const { name, scope, parsed } = definition;
      const notes = [...parsed.notes];
      for (const other of sources.definitions) {
        if (other.shadowedBy === definition) {
          notes.push(`Takes the place of the definition in ${other.source.path}.`);
        }
      }
      const key = JSON.stringify([
        scope === "session" ? (input.sessionId ?? "") : "",
        input.cwd,
        name,
        sortKeys(parsed.config),
      ]);
      let blocked: McpServerPlan["blocked"] = null;
      let enabled = true;
      if (parsed.status === "invalid") {
        blocked = {
          state: "failed",
          reason: `Its definition is not valid: ${notes[0] ?? ""}`.trim(),
        };
      } else if (parsed.status === "not-supported") {
        blocked = { state: "off", reason: notes[0] ?? "dawg cannot run this server." };
      } else if ((scope === "user" ? off.user : off.project).has(name) && scope !== "session") {
        enabled = false;
        blocked = { state: "off", reason: "Turned off in Settings → MCP servers." };
      } else {
        const why = blockedBySettings(settings, name, parsed.config, scope === "project");
        if (why !== null) blocked = { state: "off", reason: why };
        else if (scope === "project") {
          const allowed =
            approvedBySettings(settings, name) ||
            (await this.#options.trust.allows(definition.source, input.projectDir));
          if (!allowed) {
            blocked = {
              state: "needs-approval",
              reason:
                "Defined in the project's .mcp.json, so it starts once you approve the project's code.",
            };
          }
        }
      }
      plans.push({ name, scope, definition, blocked, enabled, key, notes });
    }
    return plans;
  }

  /** Starts a server for `holder` (a session), or joins the one already running. */
  acquire(plan: McpServerPlan, holder: string, cwd: string): McpConnection {
    if (this.#closed) throw new Error("The engine is closing.");
    const config = plan.definition.parsed.config;
    if (config === null) throw new Error(`The MCP server ${plan.name} cannot start.`);
    let entry = this.#connections.get(plan.key);
    if (entry === undefined) {
      const target = authTarget(plan.name, plan.scope, config);
      entry = {
        connection: new McpConnection({
          name: plan.name,
          config,
          cwd,
          env: definedEnv(this.env()),
          connectTimeoutMs: this.connectTimeoutMs,
          restartDelaysMs: this.#options.restartDelaysMs ?? MCP_RESTART_DELAYS_MS,
          clientInfo: this.#options.clientInfo ?? { name: "dawg-code", version: "0.0.0" },
          ...(target === null
            ? {}
            : {
                authProvider: this.#auth.transportProvider(target),
                signInReason: () => this.#auth.reason(target),
              }),
        }),
        holders: new Set(),
        linger: null,
        cwd,
        name: plan.name,
        scope: plan.scope,
        authId: target === null ? null : credentialId(target.key),
      };
      this.#connections.set(plan.key, entry);
    }
    if (entry.linger !== null) clearTimeout(entry.linger);
    entry.linger = null;
    entry.holders.add(holder);
    entry.connection.start();
    return entry.connection;
  }

  /** `holder` no longer needs the server; it stops once nobody has for `lingerMs`. */
  release(key: string, holder: string, lingerMs?: number): void {
    const entry = this.#connections.get(key);
    if (entry === undefined || !entry.holders.delete(holder) || entry.holders.size > 0) return;
    const wait = lingerMs ?? this.#options.lingerMs ?? MCP_LINGER_MS;
    const stop = () => {
      if (entry.holders.size > 0 || this.#connections.get(key) !== entry) return;
      this.#connections.delete(key);
      void entry.connection.stop();
    };
    if (wait <= 0) {
      stop();
      return;
    }
    entry.linger = setTimeout(stop, wait);
    entry.linger.unref?.();
  }

  /** The running connection of a plan, if any. */
  connection(plan: McpServerPlan): McpConnection | null {
    return this.#connections.get(plan.key)?.connection ?? null;
  }

  register(session: McpSessionLink): () => void {
    this.#sessions.add(session);
    return () => this.#sessions.delete(session);
  }

  /**
   * Open sessions look again at what may start, after a decision that changes it (consent given
   * in the trust dialog, a switch): a server allowed now starts, one turned off stops.
   */
  async refresh(projectDir: string | null = null): Promise<void> {
    const sessions = [...this.#sessions].filter(
      (s) => projectDir === null || s.projectDir === projectDir || s.cwd === projectDir,
    );
    await Promise.all(sessions.map((s) => s.refresh().catch(() => {})));
  }

  /** A server as Settings → MCP servers and `/mcp` show it. */
  info(
    plan: McpServerPlan,
    connection: McpConnection | null = this.connection(plan),
  ): McpServerInfo {
    const { definition } = plan;
    let state: McpServerState;
    let reason: string | null;
    if (plan.blocked !== null) {
      state = plan.blocked.state;
      reason = plan.blocked.reason;
    } else if (connection === null || connection.state === "stopped") {
      state = "off";
      reason = "Not running: it starts with a session in this folder.";
    } else {
      state = connection.state;
      reason = connection.reason;
    }
    const live = state === "connected" || state === "starting" || state === "failed";
    const tools =
      live && connection !== null
        ? connection.tools
            .map((tool) => ({
              name: mcpToolName(plan.name, tool.name),
              tool: tool.name,
              description: (tool.description ?? "").split("\n")[0]?.trim() ?? "",
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        : [];
    const target = authTarget(plan.name, plan.scope, definition.parsed.config);
    return {
      name: plan.name,
      scope: plan.scope,
      source: definition.source,
      transport: definition.parsed.transport,
      target: definition.parsed.target,
      state,
      reason,
      tools,
      prompts: live && connection !== null ? connection.prompts.length : 0,
      resources: live && connection !== null ? connection.resources.length : 0,
      enabled: plan.enabled,
      notes: plan.notes,
      signIn: target === null ? null : this.#auth.status(target),
    };
  }

  /** Reads the sign-ins of these plans' servers, so `info` can say which are signed in. */
  async loadSignIns(plans: readonly McpServerPlan[]): Promise<void> {
    await Promise.all(
      plans.map((plan) => {
        const target = authTarget(plan.name, plan.scope, plan.definition.parsed.config);
        return target === null ? null : this.#auth.load(target);
      }),
    );
  }

  /** Settings → MCP servers: the servers of a project's sessions (or only the person's). */
  async list(projectDir: string | null): Promise<McpServerInfo[]> {
    const plans = await this.plan({ cwd: projectDir, projectDir });
    await this.loadSignIns(plans);
    return plans.map((plan) => this.info(plan)).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** A server a project's sessions get, by name; InvalidParams when there is none. */
  findPlan(projectDir: string | null, name: string): Promise<McpServerPlan> {
    return this.#find(projectDir, name);
  }

  async #find(projectDir: string | null, name: string): Promise<McpServerPlan> {
    const plans = await this.plan({ cwd: projectDir, projectDir });
    const plan = plans.find((p) => p.name === name);
    if (plan === undefined)
      throw new McpManagerError("InvalidParams", `No MCP server is named ${name}.`);
    return plan;
  }

  /**
   * Stops a server and starts it again. One that no session uses is started to check it, and
   * keeps running for a minute. Resolves once it has settled (or the connect timeout passed).
   */
  async restart(projectDir: string | null, name: string): Promise<McpServerInfo> {
    const plan = await this.#find(projectDir, name);
    if (plan.blocked !== null) return this.info(plan);
    const entry = this.#connections.get(plan.key);
    let connection: McpConnection;
    if (entry !== undefined) {
      connection = entry.connection;
      await connection.restart();
    } else {
      connection = this.acquire(plan, "settings", projectDir ?? this.homeDir);
      this.release(plan.key, "settings", MCP_CHECK_LINGER_MS);
    }
    // Within a client's usual request time; a slower one shows as starting.
    await connection.whenSettled(Math.min(this.connectTimeoutMs, MCP_RESTART_WAIT_MS));
    return this.info(plan, connection);
  }

  /** The person's switch: off stops the server now and keeps it from starting. */
  async setEnabled(projectDir: string | null, name: string, enabled: boolean): Promise<boolean> {
    const plan = await this.#find(projectDir, name);
    if (plan.scope === "session") {
      throw new McpManagerError(
        "InvalidParams",
        `${name} belongs to one session; it has no switch.`,
      );
    }
    await this.#switches.set({
      projectDir,
      name,
      scope: plan.scope === "user" ? "user" : "project",
      enabled,
    });
    if (!enabled) {
      for (const entry of this.#connections.values()) {
        const same =
          entry.name === name &&
          entry.scope === plan.scope &&
          (plan.scope === "user" || entry.cwd === (projectDir ?? this.homeDir));
        if (same) await entry.connection.stop();
      }
    }
    await this.refresh(plan.scope === "user" ? null : projectDir);
    return enabled;
  }

  /** The sign-in of a plan's server, or InvalidState with why it has none. */
  #target(plan: McpServerPlan): McpAuthTarget {
    const config = plan.definition.parsed.config;
    if (plan.blocked !== null) {
      throw new McpManagerError(
        "InvalidState",
        plan.blocked.state === "needs-approval"
          ? `${plan.name} waits for your approval of the project's code; approve it, then sign in.`
          : `${plan.name} cannot sign in now: ${plan.blocked.reason}`,
      );
    }
    if (config === null || config.type === "stdio") {
      throw new McpManagerError(
        "InvalidState",
        `${plan.name} runs on this computer; only remote servers sign in.`,
      );
    }
    const target = authTarget(plan.name, plan.scope, config);
    if (target === null) {
      throw new McpManagerError(
        "InvalidState",
        `${plan.name} sends its own Authorization header, so dawg does not sign in to it. Remove the header to sign in with OAuth.`,
      );
    }
    return target;
  }

  /**
   * Starts signing in to a plan's server (`cwd`: where a server started to check it runs) and
   * resolves with the address for the browser. It finishes in the background: then the server's
   * connections start again, and one no session uses is started to show it connected.
   */
  async signIn(plan: McpServerPlan, cwd: string | null): Promise<string> {
    if (this.#closed) throw new McpManagerError("InvalidState", "The engine is closing.");
    const target = this.#target(plan);
    const id = credentialId(target.key);
    this.#signingIn.set(id, { plan, cwd: cwd ?? this.homeDir });
    try {
      const { url, finished } = await this.#auth.signIn(target);
      void finished.then(() => {
        if (this.#signingIn.get(id)?.plan === plan) this.#signingIn.delete(id);
      });
      return url;
    } catch (error) {
      if (this.#signingIn.get(id)?.plan === plan) this.#signingIn.delete(id);
      if (error instanceof McpSignInError) throw new McpManagerError("InvalidState", error.message);
      throw error;
    }
  }

  /** Stops a sign-in on its way, if any. */
  cancelSignIn(plan: McpServerPlan): void {
    const target = this.#target(plan);
    this.#signingIn.delete(credentialId(target.key));
    this.#auth.cancel(target);
  }

  /** Forgets the server's tokens and registration; its connections start again signed out. */
  async signOut(plan: McpServerPlan): Promise<void> {
    const config = plan.definition.parsed.config;
    const target = authTarget(plan.name, plan.scope, config);
    if (target === null) {
      throw new McpManagerError("InvalidState", `${plan.name} has no sign-in to forget.`);
    }
    this.#signingIn.delete(credentialId(target.key));
    await this.#auth.signOut(target);
    await this.#restartSignIn(credentialId(target.key));
  }

  /** Every connection using a sign-in starts again; resolves with them once they are on their way. */
  async #restartSignIn(id: string): Promise<McpConnection[]> {
    const connections = [...this.#connections.values()]
      .filter((entry) => entry.authId === id)
      .map((entry) => entry.connection);
    await Promise.all(connections.map((c) => c.restart()));
    return connections;
  }

  /** A sign-in finished: the server's connections start again with the token. */
  async #signedIn(target: McpAuthTarget): Promise<void> {
    const id = credentialId(target.key);
    const waiting = this.#signingIn.get(id);
    this.#signingIn.delete(id);
    if (this.#closed) return;
    const restarted = await this.#restartSignIn(id);
    if (restarted.length === 0 && waiting !== undefined && waiting.plan.blocked === null) {
      // No session uses it: start it, as a restart from Settings does, so it shows connected.
      this.acquire(waiting.plan, "settings", waiting.cwd);
      this.release(waiting.plan.key, "settings", MCP_CHECK_LINGER_MS);
    }
  }

  /** Stops every server. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#auth.close();
    const entries = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.linger !== null) clearTimeout(entry.linger);
        await entry.connection.stop();
      }),
    );
  }
}

export class McpManagerError extends Error {
  override name = "McpManagerError";
  readonly code: "InvalidParams" | "InvalidState";
  constructor(code: "InvalidParams" | "InvalidState", message: string) {
    super(message);
    this.code = code;
  }
}
