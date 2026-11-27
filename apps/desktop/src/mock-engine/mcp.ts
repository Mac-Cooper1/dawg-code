// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP definitions write ${VAR} variables literally
/**
 * MCP servers in the mock engine, answered as the real engine answers them (Phase 4: `mcp.list`,
 * `mcp.restart`, `mcp.setEnabled`, `mcp.importPreview`, `mcp.import`, `mcp.session`).
 *
 * The setup it pretends to read:
 * - `~/.dawg/mcp.json`: `github`, a local command with three tools, connected.
 * - `~/code/tally/.mcp.json`: `postgres`, connected, and `docs`, a remote server that wants a
 *   sign-in.
 * - `~/.claude.json` (Claude Code's own): `linear`, for every project, which the import copies
 *   into `~/.dawg/mcp.json`; a WebSocket server it leaves out.
 *
 * No Node APIs (the mock runs in a browser tab too).
 */
import type { CommandInfo, McpImportPlan, McpResourceInfo, McpServerInfo } from "@dawg/protocol";
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
        reason:
          "The server wants you to sign in first. Signing in to MCP servers arrives later in dawg.",
        tools: [],
        prompts: 0,
        resources: 0,
        enabled: true,
        notes: [],
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
        },
        {
          name: "docs",
          scope: "project",
          source: { path: file, origin: "claude", scope: "project" },
          transport: "http",
          target: "https://docs.example.com/mcp",
          state: "needs-sign-in",
          reason:
            "The server wants you to sign in first. Signing in to MCP servers arrives later in dawg.",
          tools: [],
          prompts: 0,
          resources: 0,
          enabled: true,
          notes: ["Its OAuth settings are not used yet; signing in to MCP servers arrives later."],
        },
      );
    }
    return servers
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

  list(projectDir: string | null) {
    return {
      projectDir,
      servers: this.#servers(projectDir),
      importable: this.#imported ? 0 : 1,
    };
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
