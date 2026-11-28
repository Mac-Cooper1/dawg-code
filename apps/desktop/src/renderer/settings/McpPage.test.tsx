// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP definitions write ${VAR} variables literally
import type { McpImportPlan, McpServerInfo } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { McpListing } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { McpPage, type McpPageProps } from "./McpPage.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;

const GITHUB: McpServerInfo = {
  name: "github",
  scope: "user",
  source: { path: `${HOME}/.dawg/mcp.json`, origin: "dawg", scope: "user" },
  transport: "stdio",
  target: "npx -y @modelcontextprotocol/server-github",
  state: "connected",
  reason: null,
  tools: [
    { name: "mcp__github__create_issue", tool: "create_issue", description: "Open an issue" },
    { name: "mcp__github__get_issue", tool: "get_issue", description: "Get an issue by number" },
  ],
  prompts: 1,
  resources: 0,
  enabled: true,
  notes: [],
  signIn: null,
};

const DB: McpServerInfo = {
  name: "db",
  scope: "project",
  source: { path: `${TALLY}/.mcp.json`, origin: "claude", scope: "project" },
  transport: "stdio",
  target: "db-mcp --read-only",
  state: "needs-approval",
  reason: "Defined in the project's .mcp.json, so it starts once you approve the project's code.",
  tools: [],
  prompts: 0,
  resources: 0,
  enabled: true,
  notes: [],
  signIn: null,
};

const BROKEN: McpServerInfo = {
  ...DB,
  name: "search",
  scope: "user",
  source: { path: `${HOME}/.dawg/mcp.json`, origin: "dawg", scope: "user" },
  transport: "http",
  target: "https://search.example.com/mcp",
  state: "failed",
  reason: "Could not start it: fetch failed",
  notes: ["${SEARCH_HOST} is not set, so it stays as written."],
};

/** A remote server that wants a sign-in. */
const LINEAR: McpServerInfo = {
  ...GITHUB,
  name: "linear",
  transport: "http",
  target: "https://mcp.linear.app/mcp",
  state: "needs-sign-in",
  reason: "The server wants you to sign in first.",
  tools: [],
  prompts: 0,
  signIn: { status: "signed-out", problem: null },
};

const SIGNED_IN: McpServerInfo = {
  ...LINEAR,
  state: "connected",
  reason: null,
  tools: [{ name: "mcp__linear__list_issues", tool: "list_issues", description: "List issues" }],
  signIn: { status: "signed-in", problem: null },
};

const AUTHORIZE = "https://mcp.linear.app/authorize?response_type=code&state=x";

const PLAN: McpImportPlan = {
  from: `${HOME}/.claude.json`,
  to: `${HOME}/.dawg/mcp.json`,
  hash: "sha256:abc",
  items: [
    {
      name: "linear",
      project: null,
      transport: "http",
      target: "https://mcp.linear.app/mcp",
      secrets: ["header Authorization"],
      action: "copy",
      reason: null,
    },
    {
      name: "realtime",
      project: TALLY,
      transport: null,
      target: "wss://realtime.example.com/mcp",
      secrets: [],
      action: "skip",
      reason: "dawg does not connect to MCP servers over WebSocket yet.",
    },
  ],
};

function listing(overrides: Partial<McpListing> = {}): McpListing {
  return { projectDir: TALLY, servers: [DB, GITHUB, BROKEN], importable: 1, ...overrides };
}

function setup(theme: "dark" | "light", overrides: Partial<McpPageProps> = {}) {
  const props: McpPageProps = {
    projects: [{ dir: TALLY, name: "tally" }],
    initialProject: TALLY,
    homeDir: HOME,
    listMcpServers: vi.fn(async (projectDir: string | null) => listing({ projectDir })),
    restartMcpServer: vi.fn(async (_dir: string | null, name: string) =>
      name === "search" ? { ...BROKEN, state: "connected" as const, reason: null } : GITHUB,
    ),
    setMcpServerEnabled: vi.fn(async () => true),
    previewMcpImport: vi.fn(async () => PLAN),
    importMcpServers: vi.fn(async () => ({ imported: 1, path: `${HOME}/.dawg/mcp.json` })),
    signInMcpServer: vi.fn(async () => ({ url: AUTHORIZE })),
    signOutMcpServer: vi.fn(async () => LINEAR),
    cancelMcpSignIn: vi.fn(async () => LINEAR),
    onOpenLink: vi.fn(),
    onReview: vi.fn(),
    ...overrides,
  };
  renderInTheme(<McpPage {...props} />, theme);
  return props;
}

describe.each(THEMES)("McpPage (%s)", (theme) => {
  it("lists each server with its source, transport, state and why", async () => {
    const props = setup(theme);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("MCP servers");
    const list = await screen.findByRole("list", { name: "MCP servers" });
    expect(props.listMcpServers).toHaveBeenCalledWith(TALLY);
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement === list);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("db");
    expect(rows[0]).toHaveTextContent("Waits for your approval");
    expect(rows[0]).toHaveTextContent("~/code/tally/.mcp.json");
    expect(rows[0]).toHaveTextContent("Claude Code’s file, shared with the project");
    expect(rows[1]).toHaveTextContent("github");
    expect(rows[1]).toHaveTextContent("Connected");
    expect(rows[1]).toHaveTextContent("Local command");
    expect(rows[1]).toHaveTextContent("2 tools, 1 prompt");
    expect(rows[2]).toHaveTextContent("Failed");
    expect(rows[2]).toHaveTextContent("Could not start it: fetch failed");
    expect(rows[2]).toHaveTextContent("is not set, so it stays as written");
  });

  it("shows a server's tools on request", async () => {
    const user = userEvent.setup();
    setup(theme);
    const toggle = await screen.findByRole("button", { name: "2 tools, 1 prompt" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tools = screen.getByRole("list", { name: "github’s tools" });
    expect(tools).toHaveTextContent("mcp__github__create_issue Open an issue");
    expect(tools).toHaveTextContent("mcp__github__get_issue");
  });

  it("restarts a server and turns one off", async () => {
    const user = userEvent.setup();
    const props = setup(theme);
    await user.click(await screen.findByRole("button", { name: "Restart search" }));
    expect(props.restartMcpServer).toHaveBeenCalledWith(TALLY, "search");
    const github = screen.getByRole("switch", { name: "github" });
    expect(github).toBeChecked();
    await user.click(github);
    expect(props.setMcpServerEnabled).toHaveBeenCalledWith(TALLY, "github", false);
    // A server waiting for approval cannot be restarted; its review is offered instead.
    expect(screen.queryByRole("button", { name: "Restart db" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(props.onReview).toHaveBeenCalledWith(TALLY);
  });

  it("imports Claude Code's servers only after showing what would be copied", async () => {
    const user = userEvent.setup();
    const props = setup(theme);
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Import 1 server from Claude Code?",
    });
    const items = within(dialog).getByRole("list", { name: "What the import copies" });
    expect(items).toHaveTextContent("linear");
    expect(items).toHaveTextContent("Copies values that may be secrets: header Authorization.");
    expect(items).toHaveTextContent(
      "Left out: dawg does not connect to MCP servers over WebSocket",
    );
    expect(props.importMcpServers).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(props.importMcpServers).toHaveBeenCalledWith("sha256:abc");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Copied 1 server into ~/.dawg/mcp.json.",
    );
  });

  it("says when there are no servers, and when the list failed", async () => {
    setup(theme, {
      listMcpServers: vi.fn(async (projectDir: string | null) =>
        listing({ projectDir, servers: [], importable: 0 }),
      ),
    });
    expect(await screen.findByText("No MCP servers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import…" })).toBeNull();
  });

  it("signs in to a server that wants it: the page opens in the browser, Signing in… offers Cancel", async () => {
    const user = userEvent.setup();
    let signingIn = false;
    const props = setup(theme, {
      listMcpServers: vi.fn(async (projectDir: string | null) =>
        listing({
          projectDir,
          servers: [
            GITHUB,
            signingIn ? { ...LINEAR, signIn: { status: "signing-in", problem: null } } : LINEAR,
          ],
        }),
      ),
      signInMcpServer: vi.fn(async () => {
        signingIn = true;
        return { url: AUTHORIZE };
      }),
    });
    const button = await screen.findByRole("button", { name: "Sign in to linear" });
    // A server that needs nothing has no sign-in buttons.
    expect(screen.queryByRole("button", { name: "Sign in to github" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out of github" })).toBeNull();
    await user.click(button);
    expect(props.signInMcpServer).toHaveBeenCalledWith(TALLY, "linear");
    expect(props.onOpenLink).toHaveBeenCalledWith(AUTHORIZE);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Signing in… Finish in your browser; dawg waits five minutes for it.",
    );
    expect(screen.queryByRole("button", { name: "Sign in to linear" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel signing in to linear" }));
    expect(props.cancelMcpSignIn).toHaveBeenCalledWith(TALLY, "linear");
  });

  it("signs out of a signed-in server", async () => {
    const user = userEvent.setup();
    const props = setup(theme, {
      listMcpServers: vi.fn(async (projectDir: string | null) =>
        listing({ projectDir, servers: [SIGNED_IN] }),
      ),
    });
    const row = await screen.findByRole("list", { name: "MCP servers" });
    expect(row).toHaveTextContent("Connected");
    expect(within(row).queryByRole("button", { name: "Sign in to linear" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Sign out of linear" }));
    expect(props.signOutMcpServer).toHaveBeenCalledWith(TALLY, "linear");
  });

  it("says in plain words why a sign-in did not start or finish", async () => {
    const user = userEvent.setup();
    setup(theme, {
      listMcpServers: vi.fn(async (projectDir: string | null) =>
        listing({
          projectDir,
          servers: [
            {
              ...LINEAR,
              signIn: {
                status: "signed-out",
                problem: "The sign-in was declined at the authorization server.",
              },
            },
          ],
        }),
      ),
      signInMcpServer: vi.fn(async () => ({
        error: "Could not start signing in to linear: fetch failed.",
      })),
    });
    const list = await screen.findByRole("list", { name: "MCP servers" });
    expect(list).toHaveTextContent("The sign-in was declined at the authorization server.");
    await user.click(within(list).getByRole("button", { name: "Sign in to linear" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not start signing in to linear: fetch failed.",
    );
  });

  it("names a failure to list them", async () => {
    setup(theme, { listMcpServers: vi.fn(async () => ({ error: "The engine is not ready." })) });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not list the MCP servers: The engine is not ready.",
    );
  });
});
