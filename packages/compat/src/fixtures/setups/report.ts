/**
 * Compatibility fixtures for the report (see ../types.ts): instruction files and their imports,
 * settings files, subagents, MCP servers and the kinds dawg does not run yet, written from
 * Claude Code's public docs (memory, settings, settings-reference, sub-agents, mcp,
 * claude-directory, output-styles). Skills, commands and hooks have fixtures of their own.
 */
import type { CompatFixture } from "../types.ts";

const agent = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nYou are ${name}.\n`;

export const FIXTURES: Record<string, CompatFixture> = {
  "report/empty-home": {
    description: "A home and a project with nothing set up: the report is empty.",
    files: {},
    expected: { items: [], approval: null },
  },

  "report/instructions-with-imports": {
    description:
      "CLAUDE.md files at each level, @ imports (nested, from home, missing) and a path-limited rule (docs: memory).",
    files: {
      "home/.claude/CLAUDE.md": "# Mine\n\nFollow @~/notes/style.md.\n",
      "home/notes/style.md": "Short sentences.\n",
      "project/CLAUDE.md":
        "# Tally\n\nSee @docs/conventions.md for conventions and @docs/missing.md.\n",
      "project/docs/conventions.md": "Use pytest. Testing: @testing.md\n",
      "project/docs/testing.md": "Run `uv run pytest -q`.\n",
      "project/CLAUDE.local.md": "My sandbox URL is http://localhost:3000.\n",
      "project/.claude/rules/tests.md": '---\npaths:\n  - "tests/**/*.py"\n---\n\nUse fixtures.\n',
      "project/.claude/rules/style.md": "Prefer dataclasses.\n",
    },
    expected: {
      items: [
        { kind: "instructions", name: "~/.claude/CLAUDE.md", scope: "user", origin: "claude", status: "loaded" },
        {
          kind: "instructions",
          name: "~/notes/style.md",
          scope: "user",
          origin: "claude",
          status: "loaded",
          notes: ["Imported by ~/.claude/CLAUDE.md."],
        },
        {
          kind: "instructions",
          name: "CLAUDE.md",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Import @docs/missing.md"],
        },
        {
          kind: "instructions",
          name: "docs/conventions.md",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Imported by CLAUDE.md."],
        },
        {
          kind: "instructions",
          name: "docs/testing.md",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Imported by CLAUDE.md."],
        },
        { kind: "instructions", name: ".claude/rules/style.md", scope: "project", origin: "claude", status: "loaded" },
        {
          kind: "instructions",
          name: ".claude/rules/tests.md",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Loaded when the agent works on files matching “tests/**/*.py”."],
        },
        { kind: "instructions", name: "CLAUDE.local.md", scope: "local", origin: "claude", status: "loaded" },
      ],
      approval: null,
    },
  },

  "report/agents-md": {
    description:
      "AGENTS.md read in place of CLAUDE.md when the project has none, at the root and in a folder (docs: memory, AGENTS.md).",
    files: {
      "project/AGENTS.md": "Run `make test` before you finish.\n",
      "project/lib/AGENTS.md": "This folder is pure functions.\n",
    },
    expected: {
      items: [
        { kind: "instructions", name: "AGENTS.md", scope: "project", origin: "claude", status: "loaded" },
        {
          kind: "instructions",
          name: "lib/AGENTS.md",
          scope: "nested",
          origin: "claude",
          status: "loaded",
          notes: ["Loaded when the agent works on files in lib/."],
        },
      ],
      approval: null,
    },
  },

  "report/settings-keys": {
    description:
      "Settings files with keys dawg uses, keys it does not use yet, keys for Anthropic's cloud and models, and a bad value (docs: settings, settings-reference).",
    files: {
      "home/.claude/settings.json": JSON.stringify({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { allow: ["Bash(npm run lint)"], deny: ["Read(./.env)"] },
      }),
      "project/.claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(uv run pytest *)"], defaultMode: "acceptEdits" },
        env: { PYTHONDONTWRITEBYTECODE: "1", ANTHROPIC_API_KEY: "sk-test" },
        theme: "dark",
        spinnerTipsEnabled: false,
        sandbox: { enabled: true },
        enabledMcpjsonServers: ["db"],
        model: "claude-sonnet-5",
        apiKeyHelper: "~/bin/get-key.sh",
        forceLoginMethod: "claudeai",
      }),
      "project/.claude/settings.local.json": JSON.stringify({
        permissions: { ask: ["Bash(git push *)"], defaultMode: "bypassPermissions", sometimes: true },
      }),
    },
    expected: {
      items: [
        { kind: "settings", name: "~/.claude/settings.json", scope: "user", origin: "claude", status: "loaded" },
        {
          kind: "settings",
          name: ".claude/settings.json",
          scope: "project",
          origin: "claude",
          status: "partly-supported",
          notes: [
            "Not used by dawg yet: theme, spinnerTipsEnabled.",
            "which only your own settings can do, so ignored here: enabledMcpjsonServers.",
            "Names Anthropic models; dawg uses its own choice of model instead: model.",
            "do nothing in dawg: apiKeyHelper, forceLoginMethod.",
            "not passed to sessions: env.ANTHROPIC_API_KEY.",
          ],
        },
        {
          kind: "settings",
          name: ".claude/settings.local.json",
          scope: "local",
          origin: "claude",
          status: "partly-supported",
          notes: [
            "Not used by dawg yet: permissions.sometimes.",
            "cannot start sessions in bypassPermissions mode",
          ],
        },
        {
          kind: "other",
          name: "sandbox",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Turns the sandbox on for shell commands."],
        },
      ],
      approval: null,
    },
  },

  "report/dawg-overrides-claude": {
    description:
      "dawg's .dawg files next to Claude Code's .claude ones: both settings files load, and a .dawg subagent or MCP server of the same name wins (spec, principle 1).",
    files: {
      "home/.claude/agents/reviewer.md": agent("reviewer", "Reviews code for Claude Code"),
      "home/.dawg/agents/reviewer.md": agent("reviewer", "Reviews code for dawg"),
      "project/.claude/agents/planner.md": agent("planner", "Plans changes"),
      "project/.dawg/agents/planner.md": agent("planner", "Plans changes, dawg's way"),
      "project/.claude/agents/scribe.md": agent("scribe", "Writes the changelog"),
      "home/.claude/agents/scribe.md": agent("scribe", "Writes notes"),
      "project/.claude/settings.json": JSON.stringify({ permissions: { allow: ["Read"] } }),
      "project/.dawg/settings.json": JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }),
      "home/.claude.json": JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["-y", "@example/github-mcp"] } },
      }),
      "home/.dawg/mcp.json": JSON.stringify({
        mcpServers: { github: { type: "http", url: "https://mcp.example.com/github" } },
      }),
    },
    expected: {
      items: [
        { kind: "settings", name: ".claude/settings.json", scope: "project", origin: "claude", status: "loaded" },
        { kind: "settings", name: ".dawg/settings.json", scope: "project", origin: "dawg", status: "loaded" },
        {
          kind: "agent",
          name: "reviewer",
          scope: "user",
          origin: "claude",
          status: "loaded",
          notes: ["Not used: ~/.dawg/agents/reviewer.md defines “reviewer” too"],
        },
        { kind: "agent", name: "reviewer", scope: "user", origin: "dawg", status: "loaded" },
        {
          kind: "agent",
          name: "planner",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Not used: .dawg/agents/planner.md defines “planner” too"],
        },
        { kind: "agent", name: "planner", scope: "project", origin: "dawg", status: "loaded" },
        {
          kind: "agent",
          name: "scribe",
          scope: "user",
          origin: "claude",
          status: "loaded",
          notes: ["Not used: .claude/agents/scribe.md defines “scribe” too"],
        },
        { kind: "agent", name: "scribe", scope: "project", origin: "claude", status: "loaded" },
        {
          kind: "mcp-server",
          name: "github",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["Not used: ~/.dawg/mcp.json defines “github” too"],
        },
        {
          kind: "mcp-server",
          name: "github",
          scope: "user",
          origin: "dawg",
          status: "loaded",
          notes: ["Connects to https://mcp.example.com/github over HTTP."],
        },
      ],
      approval: null,
    },
  },

  "report/nested-directories": {
    description:
      "Instruction files and rules in folders inside the project, loaded when the agent works there; agents in subfolders; dependencies skipped (docs: memory, sub-agents).",
    files: {
      "project/CLAUDE.md": "# Monorepo\n",
      "project/packages/api/CLAUDE.md": "The API uses FastAPI.\n",
      "project/packages/api/.claude/rules/db.md": "Migrations go through alembic.\n",
      "project/packages/web/CLAUDE.local.md": "Use my staging URL.\n",
      "project/node_modules/some-lib/CLAUDE.md": "Not ours.\n",
      "project/.claude/agents/review/security.md": agent("security", "Looks for security problems"),
    },
    expected: {
      items: [
        { kind: "instructions", name: "CLAUDE.md", scope: "project", origin: "claude", status: "loaded" },
        {
          kind: "instructions",
          name: "packages/api/CLAUDE.md",
          scope: "nested",
          origin: "claude",
          status: "loaded",
          notes: ["Loaded when the agent works on files in packages/api/."],
        },
        {
          kind: "instructions",
          name: "packages/api/.claude/rules/db.md",
          scope: "nested",
          origin: "claude",
          status: "loaded",
          notes: ["packages/api/"],
        },
        {
          kind: "instructions",
          name: "packages/web/CLAUDE.local.md",
          scope: "nested",
          origin: "claude",
          status: "loaded",
          notes: ["packages/web/"],
        },
        { kind: "agent", name: "security", scope: "project", origin: "claude", status: "loaded" },
      ],
      approval: null,
    },
  },

  "report/subagents": {
    description:
      "Subagent files, well-formed and not: missing fields, YAML that does not parse, no front matter (docs: sub-agents).",
    files: {
      "project/.claude/agents/code-reviewer.md": agent(
        "code-reviewer",
        "Reviews code for quality and best practices",
        "tools: Read, Glob, Grep\nmodel: sonnet\n",
      ),
      "project/.claude/agents/no-description.md": "---\nname: no-description\n---\n\nHello.\n",
      "project/.claude/agents/broken.md": "---\nname: [broken\ndescription: x\n---\n",
      "project/.claude/agents/plain.md": "Just a prompt, no front matter.\n",
      "home/.claude/agents/debugger.md": agent("debugger", "Finds the cause of failures"),
    },
    expected: {
      items: [
        { kind: "agent", name: "debugger", scope: "user", origin: "claude", status: "loaded" },
        {
          kind: "agent",
          name: "code-reviewer",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["model “sonnet” is mapped to the session's model"],
        },
        {
          kind: "agent",
          name: "no-description",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["Needs a description in its front matter"],
        },
        {
          kind: "agent",
          name: "broken",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["not valid YAML"],
        },
        {
          kind: "agent",
          name: "plain",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["Needs a name and a description in its front matter"],
        },
      ],
      approval: null,
    },
  },

  "report/mcp-locations": {
    description:
      "MCP servers in each place they can be defined: .mcp.json, ~/.claude.json (the person's and per project), ~/.dawg/mcp.json, and a definition that is wrong (docs: mcp).",
    files: {
      "project/.mcp.json": JSON.stringify({
        mcpServers: {
          db: { command: "npx", args: ["-y", "@example/db-server"], env: { DB_URL: "${DB_URL}" } },
          docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
          broken: { url: "https://broken.example.com/mcp" },
        },
      }),
      "home/.claude.json": `{
  "numStartups": 12,
  "mcpServers": { "github": { "type": "stdio", "command": "github-mcp", "args": [] } },
  "projects": {
    "{{project}}": {
      "mcpServers": { "stripe": { "type": "http", "url": "https://mcp.stripe.com" } }
    },
    "/somewhere/else": {
      "mcpServers": { "elsewhere": { "command": "x" } }
    }
  }
}`,
      "home/.dawg/mcp.json": JSON.stringify({
        mcpServers: { notes: { type: "sse", url: "https://notes.example.com/sse?key=secret" } },
      }),
    },
    // The project's .mcp.json servers wait for the person's consent (spec, principle 3); the
    // broken one can never start and is not offered. Servers in ~/.claude.json are imported,
    // not approved, and never started from there.
    expected: {
      items: [
        {
          kind: "mcp-server",
          name: "db",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Runs a local command: npx -y @example/db-server.", "so dawg will ask before starting it"],
        },
        {
          kind: "mcp-server",
          name: "docs",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Connects to https://docs.example.com/mcp over HTTP."],
        },
        {
          kind: "mcp-server",
          name: "broken",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["Has a url but no type"],
        },
        {
          kind: "mcp-server",
          name: "github",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["Runs a local command: github-mcp.", "import it"],
        },
        {
          kind: "mcp-server",
          name: "stripe",
          scope: "local",
          origin: "claude",
          status: "not-supported",
          notes: ["Yours, for this project only.", "Connects to https://mcp.stripe.com/ over HTTP.", "import it"],
        },
        {
          kind: "mcp-server",
          name: "notes",
          scope: "user",
          origin: "dawg",
          status: "loaded",
          notes: ["Connects to https://notes.example.com/sse over SSE"],
        },
      ],
      approval: { items: 2 },
    },
  },

  "report/other-kinds": {
    description:
      "Output styles, the status line, plugins and marketplaces, keybindings, terminal themes, workflows and .worktreeinclude (docs: claude-directory, settings-reference, output-styles).",
    files: {
      "home/.claude/settings.json": JSON.stringify({
        statusLine: { type: "command", command: "~/.claude/statusline.sh" },
        outputStyle: "Explanatory",
        enabledPlugins: { "formatter@acme-tools": true, "linter@acme-tools": false },
        extraKnownMarketplaces: { "acme-tools": { source: { source: "github", repo: "acme/tools" } } },
      }),
      "home/.claude/statusline.sh": "#!/bin/sh\necho ready\n",
      "home/.claude/output-styles/teacher.md": "---\nname: Teacher\ndescription: Explains as it goes\n---\n\nTeach.\n",
      "project/.claude/output-styles/review.md": "Review mode.\n",
      "home/.claude/keybindings.json": JSON.stringify({ bindings: [] }),
      "home/.claude/plugins/installed_plugins.json": JSON.stringify({}),
      "home/.claude/themes/dusk.json": JSON.stringify({ base: "dark", overrides: {} }),
      "project/.claude/workflows/release.js": "export default async function release() {}\n",
      "project/.worktreeinclude": ".env\n",
    },
    expected: {
      items: [
        { kind: "settings", name: "~/.claude/settings.json", scope: "user", origin: "claude", status: "loaded" },
        {
          kind: "other",
          name: "Status line",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["Runs ~/.claude/statusline.sh.", "Custom status lines arrive in Phase 5."],
        },
        {
          kind: "other",
          name: "Output style setting: Explanatory",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["Output styles arrive in Phase 5."],
        },
        {
          kind: "other",
          name: "Plugin: formatter@acme-tools",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["Plugins and marketplaces arrive in Phase 5."],
        },
        {
          kind: "other",
          name: "Plugin: linter@acme-tools",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["Turned off in this file."],
        },
        {
          kind: "other",
          name: "Plugin marketplace: acme-tools",
          scope: "user",
          origin: "claude",
          status: "not-supported",
        },
        { kind: "other", name: "Output style: Teacher", scope: "user", origin: "claude", status: "not-supported" },
        { kind: "other", name: "Output style: review", scope: "project", origin: "claude", status: "not-supported" },
        {
          kind: "other",
          name: "Keybindings",
          scope: "user",
          origin: "claude",
          status: "not-supported",
          notes: ["custom keybindings arrive in Phase 5"],
        },
        { kind: "other", name: "Installed plugins", scope: "user", origin: "claude", status: "not-supported" },
        { kind: "other", name: "Terminal theme: dusk", scope: "user", origin: "claude", status: "not-supported" },
        {
          kind: "other",
          name: "Workflow: /release",
          scope: "project",
          origin: "claude",
          status: "not-supported",
          notes: ["Workflows arrive in Phase 5."],
        },
        {
          kind: "other",
          name: ".worktreeinclude",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["into each new worktree"],
        },
      ],
      approval: null,
    },
  },

  "report/invalid-json": {
    description:
      "Files that are not valid JSON, or not the shape the docs give, each reported as invalid rather than skipped.",
    files: {
      "project/.claude/settings.json": "{ not json",
      "project/.mcp.json": "[1, 2",
      "home/.claude.json": "{,}",
      "home/.dawg/mcp.json": JSON.stringify({ mcpServers: ["github"] }),
      "home/.dawg/settings.json": "[]",
    },
    expected: {
      items: [
        {
          kind: "settings",
          name: "~/.dawg/settings.json",
          scope: "user",
          origin: "dawg",
          status: "invalid",
          notes: ["Expected a JSON object at the top level"],
        },
        {
          kind: "settings",
          name: ".claude/settings.json",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["Not valid JSON"],
        },
        {
          kind: "mcp-server",
          name: "~/.claude.json",
          scope: "user",
          origin: "claude",
          status: "invalid",
          notes: ["Not valid JSON"],
        },
        {
          kind: "mcp-server",
          name: "mcpServers",
          scope: "user",
          origin: "dawg",
          status: "invalid",
          notes: ["should map server names to their definitions"],
        },
        {
          kind: "mcp-server",
          name: ".mcp.json",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["Not valid JSON"],
        },
      ],
      approval: null,
    },
  },
};
