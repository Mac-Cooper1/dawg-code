/**
 * One running MCP server, through the official SDK's client: stdio (a child process), streamable
 * HTTP, or the older HTTP with server-sent events. It connects, lists its tools, resources and
 * prompts (and lists them again when the server says they changed), and when it fails or its
 * process exits it is started again after a growing pause, a few times, before it stays failed.
 *
 * A remote server that answers 401 or 403 is "needs sign-in", as Claude Code's `/mcp` shows it,
 * unless the definition sends its own Authorization header (then the header was refused, and it
 * failed). Signing in with OAuth arrives later: `authProvider` is where it plugs in.
 */
import type { McpServerConfig } from "@dawg/compat";
import {
  type AuthProvider,
  type CallToolResult,
  Client,
  type FetchLike,
  type GetPromptResult,
  type OAuthClientProvider,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type ConnectionState = "starting" | "connected" | "failed" | "needs-sign-in" | "stopped";

export interface ConnectionOptions {
  name: string;
  config: McpServerConfig;
  /** Where a local server runs, and what `CLAUDE_PROJECT_DIR` and `DAWG_PROJECT_DIR` name. */
  cwd: string;
  /** The environment a local server starts with, before its own `env`. */
  env: Readonly<Record<string, string>>;
  /** How long connecting may take. */
  connectTimeoutMs: number;
  /** The pauses before each new start after a failure; once they run out it stays failed. */
  restartDelaysMs: readonly number[];
  clientInfo: { name: string; version: string };
  /** For signing in (later): the SDK's provider for a remote server's tokens. */
  authProvider?: AuthProvider | OAuthClientProvider;
}

/** A call to a server that is not connected. */
export class McpUnavailableError extends Error {
  override name = "McpUnavailableError";
}

/** Lines of a local server's standard error kept, to say why it stopped. */
const STDERR_LINES = 5;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === "" ? "No reason was given." : text.trim();
}

function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function hasAuthorizationHeader(config: McpServerConfig): boolean {
  return (
    config.type !== "stdio" &&
    Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")
  );
}

export class McpConnection {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly #options: ConnectionOptions;

  #state: ConnectionState = "stopped";
  #reason: string | null = null;
  tools: Tool[] = [];
  resources: Resource[] = [];
  prompts: Prompt[] = [];
  /** What the server asked to be told to the model, or null. */
  instructions: string | null = null;

  #client: Client | null = null;
  /** Each start gets a number, so callbacks of an older one are ignored. */
  #generation = 0;
  /** Failures since the last successful start. */
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #stderr: string[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(options: ConnectionOptions) {
    this.name = options.name;
    this.config = options.config;
    this.#options = options;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Why it failed or needs sign-in; null otherwise. */
  get reason(): string | null {
    return this.#reason;
  }

  /** Called on every change of state or of the lists. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  }

  #set(state: ConnectionState, reason: string | null): void {
    this.#state = state;
    this.#reason = reason;
    this.#changed();
  }

  /** Starts it, unless it runs or is starting already. */
  start(): void {
    if (this.#state === "starting" || this.#state === "connected") return;
    if (this.#retry !== null) return; // A new start is already on its way.
    this.#failures = 0;
    void this.#connect();
  }

  /**
   * Resolves once it is connected, or has failed, needs sign-in or was stopped, or after `ms`.
   * Never rejects.
   */
  whenSettled(ms: number): Promise<void> {
    if (this.#state !== "starting") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const stop = this.onChange(() => {
        if (this.#state !== "starting") done();
      });
    });
  }

  /** Stops it and starts it again, as if new: the pauses between tries start over. */
  async restart(): Promise<void> {
    await this.stop();
    this.#failures = 0;
    void this.#connect();
  }

  /** Stops it. Calls on their way fail. */
  async stop(): Promise<void> {
    this.#generation += 1;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    const client = this.#client;
    this.#client = null;
    this.#set("stopped", null);
    if (client !== null) await client.close().catch(() => {});
  }

  #transport(): Transport {
    const config = this.config;
    if (config.type === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          ...this.#options.env,
          CLAUDE_PROJECT_DIR: this.#options.cwd,
          DAWG_PROJECT_DIR: this.#options.cwd,
          ...config.env,
        },
        cwd: this.#options.cwd,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const lines = String(chunk)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        this.#stderr = [...this.#stderr, ...lines].slice(-STDERR_LINES);
      });
      return transport;
    }
    // The definition's headers go with every request, the event stream's included; those the
    // transport manages itself (a token from `authProvider`, the session id) take precedence.
    const fixed = config.headers;
    const withHeaders: FetchLike = (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(fixed))
        if (!headers.has(key)) headers.set(key, value);
      return fetch(input, { ...init, headers });
    };
    const auth = this.#options.authProvider;
    const options = {
      requestInit: { headers: fixed },
      fetch: withHeaders,
      ...(auth === undefined ? {} : { authProvider: auth }),
    };
    const url = new URL(config.url);
    return config.type === "sse"
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options);
  }

  async #connect(): Promise<void> {
    const generation = ++this.#generation;
    this.#retry = null;
    this.#stderr = [];
    this.#set("starting", null);
    const client = new Client(this.#options.clientInfo, {
      capabilities: {},
      listChanged: {
        tools: {
          onChanged: (error, items) => {
            if (generation !== this.#generation || error !== null || items === null) return;
            this.tools = items;
            this.#changed();
          },
        },
        prompts: {
          onChanged: (error, items) => {
            if (generation !== this.#generation || error !== null || items === null) return;
            this.prompts = items;
            this.#changed();
          },
        },
        resources: {
          onChanged: (error, items) => {
            if (generation !== this.#generation || error !== null || items === null) return;
            this.resources = items;
            this.#changed();
          },
        },
      },
    });
    client.onclose = () => {
      if (generation !== this.#generation || this.#state !== "connected") return;
      this.#client = null;
      this.#failed(`It stopped${this.#stderrNote()}.`);
    };
    // Errors after the start are reported by the calls they break; nothing more to do here.
    client.onerror = () => {};
    let transport: Transport;
    try {
      transport = this.#transport();
      await client.connect(transport, { timeout: this.#options.connectTimeoutMs });
      if (generation !== this.#generation) {
        await client.close().catch(() => {});
        return;
      }
      const capabilities = client.getServerCapabilities() ?? {};
      const [tools, resources, prompts] = await Promise.all([
        capabilities.tools ? client.listTools().then((r) => r.tools) : [],
        capabilities.resources
          ? client.listResources().then(
              (r) => r.resources,
              () => [],
            )
          : [],
        capabilities.prompts
          ? client.listPrompts().then(
              (r) => r.prompts,
              () => [],
            )
          : [],
      ]);
      if (generation !== this.#generation) {
        await client.close().catch(() => {});
        return;
      }
      this.tools = tools;
      this.resources = resources;
      this.prompts = prompts;
      this.instructions = client.getInstructions()?.trim() || null;
      this.#client = client;
      this.#failures = 0;
      this.#set("connected", null);
    } catch (error) {
      await client.close().catch(() => {});
      if (generation !== this.#generation) return;
      const status = httpStatus(error);
      if (
        error instanceof UnauthorizedError ||
        ((status === 401 || status === 403) && !hasAuthorizationHeader(this.config))
      ) {
        this.#set(
          "needs-sign-in",
          "The server wants you to sign in first. Signing in to MCP servers arrives later in dawg.",
        );
        return;
      }
      if (status === 401 || status === 403) {
        this.#failed(`The server refused the Authorization header it was sent (HTTP ${status}).`);
        return;
      }
      this.#failed(`Could not start it: ${errorText(error)}${this.#stderrNote()}`);
    }
  }

  #stderrNote(): string {
    const last = this.#stderr.at(-1);
    return last === undefined ? "" : ` (it said: ${last})`;
  }

  #failed(reason: string): void {
    const delays = this.#options.restartDelaysMs;
    const delay = delays[this.#failures];
    this.#failures += 1;
    if (delay === undefined) {
      this.#set("failed", reason);
      return;
    }
    const generation = this.#generation;
    this.#retry = setTimeout(() => {
      if (generation === this.#generation) void this.#connect();
    }, delay);
    this.#retry.unref?.();
    const seconds = Math.max(1, Math.round(delay / 1000));
    this.#set("failed", `${reason} dawg tries again in ${seconds} s.`);
  }

  #connected(): Client {
    if (this.#client === null || this.#state !== "connected") {
      throw new McpUnavailableError(
        this.#state === "starting"
          ? `The MCP server ${this.name} is still starting.`
          : `The MCP server ${this.name} is not connected${this.#reason === null ? "." : `: ${this.#reason}`}`,
      );
    }
    return this.#client;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<CallToolResult> {
    const client = this.#connected();
    return (await client.callTool(
      { name, arguments: args },
      { signal: options.signal, timeout: options.timeoutMs, resetTimeoutOnProgress: true },
    )) as CallToolResult;
  }

  async readResource(uri: string, signal: AbortSignal): Promise<ReadResourceResult> {
    return this.#connected().readResource({ uri }, { signal });
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<GetPromptResult> {
    return this.#connected().getPrompt({ name, arguments: args }, { signal });
  }
}
