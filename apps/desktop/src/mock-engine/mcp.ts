// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP definitions write ${VAR} variables literally
/**
 * MCP servers in the mock engine, answered as the real engine answers them (Phase 4: `mcp.list`,
 * `mcp.restart`, `mcp.setEnabled`, `mcp.importPreview`, `mcp.import`, `mcp.session`; round 3:
 * `mcp.signIn`, `mcp.signOut`, `mcp.cancelSignIn`, and a session's own servers).
 *
 * The setup it pretends to read:
 * - `~/.dawg/mcp.json`: `github`, a local command with three tools, connected.
 * - `~/code/tally/.mcp.json`: `postgres`, connected, and `docs`, a remote server that wants a
 *   sign-in. "Sign in" gives an address on docs.example.com; the browser's return is pretended
 *   on the next listing after it, which shows `docs` connected and signed in.
 * - `~/.claude.json` (Claude Code's own): `linear`, for every project, which the import copies
 *   into `~/.dawg/mcp.json`; a WebSocket server it leaves out.
 *
 * No Node APIs (the mock runs in a browser tab too).
 */
import type {
  CommandInfo,
  McpImportPlan,
  McpResourceInfo,
  McpServerInfo,
  McpSignInInfo,
} from "@dawg/protocol";
import { ErrorCodes, RpcError } from "@dawg/protocol";

function tools(server: string, list: [string, string][]): McpServerInfo["tools"] {
  return list
    .map(([tool, description]) => ({ name: `mcp__${server}__${tool}`, tool, description }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export class MockMcp {
  readonly #homeDir: string;
  /** Names the person turned off. */
  readonly #off = new Set<string>();
  #imported = false;
  /** Remote servers waiting for the browser, and those signed in. */
  readonly #signingIn = new Set<string>();
  readonly #signedIn = new Set<string>();
  /** Each session's own servers (`session.create`'s `mcpServers`), and whether only those. */
  readonly #sessionServers = new Map<
    string,
    { servers: Record<string, unknown>; strict: boolean }
  >();

  constructor(homeDir: string) {
    this.#homeDir = homeDir;
  }

  #servers(projectDir: string | null): McpServerInfo[] {
    const home = this.#homeDir;
    const mine = `${home}/.dawg/mcp.json`;
    const servers: McpServerInfo[] = [
      {
        name: "github",
        scope: "user",
        source: { path: mine, origin: "dawg", scope: "user" },
        transport: "stdio",
        target: "npx -y @modelcontextprotocol/server-github",
        state: "connected",
        reason: null,
        tools: tools("github", [
          ["get_issue", "Get an issue by number"],
          ["list_pull_requests", "List the open pull requests"],
          ["create_issue", "Open an issue"],
        ]),
        prompts: 1,
        resources: 0,
        enabled: true,
        notes: [],
        signIn: null,
      },
    ];
    if (this.#imported) {
      servers.push({
        name: "linear",
        scope: "user",
        source: { path: mine, origin: "dawg", scope: "user" },
        transport: "http",
        target: "https://mcp.linear.app/mcp",
        state: "needs-sign-in",
        reason: "The server wants you to sign in first.",
        tools: [],
        prompts: 0,
        resources: 0,
        enabled: true,
        notes: [],
        signIn: { status: "signed-out", problem: null },
      });
    }
    if (projectDir === `${home}/code/tally`) {
      const file = `${projectDir}/.mcp.json`;
      servers.push(
        {
          name: "postgres",
          scope: "project",
          source: { path: file, origin: "claude", scope: "project" },
          transport: "stdio",
          target: "npx -y @modelcontextprotocol/server-postgres ${DATABASE_URL}",
          state: "connected",
          reason: null,
          tools: tools("postgres", [["query", "Run a read-only SQL query"]]),
          prompts: 0,
          resources: 2,
          enabled: true,
          notes: [],
          signIn: null,
        },
        {
          name: "docs",
          scope: "project",
          source: { path: file, origin: "claude", scope: "project" },
          transport: "http",
          target: "https://docs.example.com/mcp",
          state: "needs-sign-in",
          reason: "The server wants you to sign in first.",
          tools: [],
          prompts: 0,
          resources: 0,
          enabled: true,
          notes: [],
          signIn: { status: "signed-out", problem: null },
        },
      );
    }
    return servers
      .map((server) => this.#withSignIn(server))
      .map((server) =>
        this.#off.has(server.name)
          ? {
              ...server,
              state: "off" as const,
              reason: "Turned off in Settings → MCP servers.",
              tools: [],
              prompts: 0,
              resources: 0,
              enabled: false,
            }
          : server,
      )
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  #plan(): McpImportPlan {
    const items: McpImportPlan["items"] = [
      {
        name: "linear",
        project: null,
        transport: "http",
        target: "https://mcp.linear.app/mcp",
        secrets: ["header Authorization"],
        action: this.#imported ? "skip" : "copy",
        reason: this.#imported
          ? "dawg already has a server of this name in ~/.dawg/mcp.json; yours is kept."
          : null,
      },
      {
        name: "realtime",
        project: null,
        transport: null,
        target: "wss://realtime.example.com/mcp",
        secrets: [],
        action: "skip",
        reason: "dawg does not connect to MCP servers over WebSocket yet.",
      },
    ];
    return {
      from: `${this.#homeDir}/.claude.json`,
      to: `${this.#homeDir}/.dawg/mcp.json`,
      hash: this.#imported ? null : "sha256:mock-import",
      items,
    };
  }

  /** A remote server as its sign-in stands: signing in, or signed in and connected. */
  #withSignIn(server: McpServerInfo): McpServerInfo {
    if (server.signIn === null) return server;
    if (this.#signingIn.has(server.name)) {
      return { ...server, signIn: { status: "signing-in", problem: null } };
    }
    if (!this.#signedIn.has(server.name)) return server;
    const signIn: McpSignInInfo = { status: "signed-in", problem: null };
    return {
      ...server,
      state: "connected",
      reason: null,
      tools: tools(server.name, [
        ["search", "Search the documentation"],
        ["get_page", "Read one page"],
      ]),
      signIn,
    };
  }

  /** A session's own servers, as `session.create` gave them: a local or a remote definition. */
  #own(sessionId: string): McpServerInfo[] {
    const own = this.#sessionServers.get(sessionId);
    if (own === undefined) return [];
    return Object.entries(own.servers).map(([name, raw]) => {
      const definition = (raw ?? {}) as { type?: unknown; url?: unknown; command?: unknown };
      const remote = typeof definition.url === "string";
      return this.#withSignIn({
        name,
        scope: "session",
        source: { path: "<session>", origin: "dawg", scope: "flags" },
        transport: remote ? (definition.type === "sse" ? "sse" : "http") : "stdio",
        target: remote ? String(definition.url) : String(definition.command ?? ""),
        state: remote ? "needs-sign-in" : "connected",
        reason: remote ? "The server wants you to sign in first." : null,
        tools: remote ? [] : tools(name, [["run", "Run the server's one tool"]]),
        prompts: 0,
        resources: 0,
        enabled: true,
        notes: [],
        signIn: remote ? { status: "signed-out", problem: null } : null,
      });
    });
  }

  /** Records a new session's own servers (`session.create`). */
  setSessionServers(
    sessionId: string,
    servers: Record<string, unknown> | undefined,
    strict: boolean | undefined,
  ): void {
    if (servers === undefined && strict !== true) return;
    this.#sessionServers.set(sessionId, { servers: servers ?? {}, strict: strict === true });
  }

  list(projectDir: string | null, sessionId?: string) {
    let servers = this.#servers(projectDir);
    if (sessionId !== undefined) {
      const own = this.#own(sessionId);
      const strict = this.#sessionServers.get(sessionId)?.strict === true;
      const names = new Set(own.map((s) => s.name));
      servers = [...own, ...(strict ? [] : servers.filter((s) => !names.has(s.name)))].sort(
        (a, b) => (a.name < b.name ? -1 : 1),
      );
    }
    // The browser "comes back" once a listing has shown the sign-in on its way.
    for (const name of this.#signingIn) {
      this.#signingIn.delete(name);
      this.#signedIn.add(name);
    }
    return { projectDir, servers, importable: this.#imported ? 0 : 1 };
  }

  #remote(projectDir: string | null, name: string, sessionId?: string): McpServerInfo {
    const server =
      (sessionId === undefined ? undefined : this.#own(sessionId).find((s) => s.name === name)) ??
      this.#find(projectDir, name);
    if (server.signIn === null) {
      throw new RpcError(
        ErrorCodes.InvalidState,
        `${name} runs on this computer; only remote servers sign in.`,
      );
    }
    return server;
  }

  signIn(projectDir: string | null, name: string, sessionId?: string) {
    this.#remote(projectDir, name, sessionId);
    this.#signedIn.delete(name);
    this.#signingIn.add(name);
    const host = name === "linear" ? "mcp.linear.app" : "docs.example.com";
    return {
      url: `https://${host}/authorize?response_type=code&client_id=dawg-mock&code_challenge=mock&code_challenge_method=S256&state=mock`,
    };
  }

  signOut(projectDir: string | null, name: string, sessionId?: string) {
    this.#remote(projectDir, name, sessionId);
    this.#signingIn.delete(name);
    this.#signedIn.delete(name);
    return { server: this.#remote(projectDir, name, sessionId) };
  }

  cancelSignIn(projectDir: string | null, name: string, sessionId?: string) {
    this.#remote(projectDir, name, sessionId);
    this.#signingIn.delete(name);
    return { server: this.#remote(projectDir, name, sessionId) };
  }

  #find(projectDir: string | null, name: string): McpServerInfo {
    const server = this.#servers(projectDir).find((s) => s.name === name);
    if (server === undefined) {
      throw new RpcError(ErrorCodes.InvalidParams, `No MCP server is named ${name}.`);
    }
    return server;
  }

  restart(projectDir: string | null, name: string) {
    return { server: this.#find(projectDir, name) };
  }

  setEnabled(projectDir: string | null, name: string, enabled: boolean) {
    this.#find(projectDir, name);
    if (enabled) this.#off.delete(name);
    else this.#off.add(name);
    return { enabled };
  }

  importPreview(): McpImportPlan {
    return this.#plan();
  }

  import(hash: string) {
    if (hash !== this.#plan().hash) {
      throw new RpcError(
        ErrorCodes.InvalidState,
        "Claude Code's servers changed since the list was shown, so nothing was copied. Look at the list again.",
      );
    }
    this.#imported = true;
    return { imported: 1, path: `${this.#homeDir}/.dawg/mcp.json` };
  }

  /** What a session in `cwd` gets for its composer. */
  session(cwd: string): { resources: McpResourceInfo[]; prompts: CommandInfo[] } {
    const prompts: CommandInfo[] = this.#off.has("github")
      ? []
      : [
          {
            name: "mcp__github__pr_review",
            description: "Review a pull request (MCP)",
            argumentHint: "<number>",
            source: "user",
            kind: "command",
          },
        ];
    const resources: McpResourceInfo[] =
      cwd === `${this.#homeDir}/code/tally` && !this.#off.has("postgres")
        ? [
            {
              server: "postgres",
              uri: "postgres://tally/schema",
              name: "Schema",
              description: "The tables and their columns",
              mimeType: "text/plain",
              mention: "@postgres:postgres://tally/schema",
            },
            {
              server: "postgres",
              uri: "postgres://tally/migrations",
              name: "Migrations",
              description: "Migrations applied so far",
              mimeType: "text/plain",
              mention: "@postgres:postgres://tally/migrations",
            },
          ]
        : [];
    return { resources, prompts };
  }
}
