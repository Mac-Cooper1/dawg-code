/**
 * The compatibility report in the mock engine (`project.inspect`): what the real engine would find
 * in the mock's projects and home folder, so Settings → Project setup and the first-open notice
 * show a full report in tests and the browser preview. Hooks and consent come from trust.ts; this
 * adds the rest, in the order the real report lists items.
 *
 * The setup it pretends to read:
 * - `~/code/tally`: CLAUDE.md with an import, `.claude/settings.json` with keys dawg ignores, a
 *   subagent, an MCP server in `.mcp.json`, an output style, and a subagent file that is broken.
 * - `~/code/notes-cli`: CLAUDE.md and the settings file trust.ts reads hooks from.
 * - `~/code/dawg-site`: AGENTS.md only, which loads as it does in Claude Code (no notice).
 * - The home folder: `~/.claude/CLAUDE.md`, both settings files, an MCP server in
 *   `~/.claude.json` and custom keybindings.
 */
import type { CompatItem, CompatSource } from "@dawg/protocol";

const KIND_ORDER: readonly CompatItem["kind"][] = [
  "instructions",
  "settings",
  "command",
  "skill",
  "agent",
  "hook",
  "mcp-server",
  "other",
];
const SCOPE_ORDER: readonly CompatSource["scope"][] = [
  "user",
  "project",
  "local",
  "nested",
  "flags",
];

/** The real report's order: by kind, then scope, then name, then path. */
export function sortReportItems(items: readonly CompatItem[]): CompatItem[] {
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...items].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      SCOPE_ORDER.indexOf(a.source.scope) - SCOPE_ORDER.indexOf(b.source.scope) ||
      text(a.name, b.name) ||
      text(a.source.path, b.source.path),
  );
}

function item(
  kind: CompatItem["kind"],
  name: string,
  path: string,
  scope: CompatSource["scope"],
  status: CompatItem["status"],
  notes: string[] = [],
  origin: CompatSource["origin"] = "claude",
): CompatItem {
  return { kind, name, source: { path, origin, scope }, status, notes };
}

function homeItems(home: string): CompatItem[] {
  return [
    item("instructions", "~/.claude/CLAUDE.md", `${home}/.claude/CLAUDE.md`, "user", "loaded"),
    item(
      "settings",
      "~/.claude/settings.json",
      `${home}/.claude/settings.json`,
      "user",
      "partly-supported",
      ["Names Anthropic models; dawg uses its own choice of model instead: model."],
    ),
    item(
      "settings",
      "~/.dawg/settings.json",
      `${home}/.dawg/settings.json`,
      "user",
      "loaded",
      [],
      "dawg",
    ),
    item("mcp-server", "linear", `${home}/.claude.json`, "user", "not-supported", [
      "Connects to https://mcp.linear.app/mcp over HTTP.",
      "In Claude Code's own settings, so dawg does not start it from there: import it (Settings → MCP servers, or /mcp import) to copy it into ~/.dawg/mcp.json.",
    ]),
    item("other", "Keybindings", `${home}/.claude/keybindings.json`, "user", "not-supported", [
      "dawg has its own shortcuts; custom keybindings arrive in Phase 5.",
    ]),
  ];
}

function tallyItems(project: string): CompatItem[] {
  return [
    item("instructions", "CLAUDE.md", `${project}/CLAUDE.md`, "project", "loaded"),
    item("instructions", "docs/money.md", `${project}/docs/money.md`, "project", "loaded", [
      "Imported by CLAUDE.md.",
    ]),
    item(
      "settings",
      ".claude/settings.json",
      `${project}/.claude/settings.json`,
      "project",
      "partly-supported",
      [
        "Not used by dawg yet: spinnerTipsEnabled.",
        "For a feature that arrives later in Phase 4, so ignored for now: sandbox.",
      ],
    ),
    item("agent", "reviewer", `${project}/.claude/agents/reviewer.md`, "project", "not-supported", [
      "Subagents arrive later in Phase 4.",
    ]),
    item(
      "agent",
      "release-notes",
      `${project}/.claude/agents/release-notes.md`,
      "project",
      "invalid",
      ["Needs a description in its front matter, as Claude Code requires."],
    ),
    item("mcp-server", "postgres", `${project}/.mcp.json`, "project", "loaded", [
      "Runs a local command: npx -y @modelcontextprotocol/server-postgres.",
      "Defined in the project's files, so dawg will ask before starting it, as Claude Code does.",
    ]),
    item(
      "other",
      "Output style: Reviewer",
      `${project}/.claude/output-styles/reviewer.md`,
      "project",
      "not-supported",
      ["Output styles arrive in Phase 5."],
    ),
  ];
}

/** Everything the mock "finds" for a project (or only the home folder), hooks aside. */
export function mockSetupItems(projectDir: string | null, homeDir: string): CompatItem[] {
  const home = homeDir.replace(/\/+$/, "");
  const items = homeItems(home);
  const project = projectDir?.replace(/\/+$/, "") ?? null;
  if (project === `${home}/code/tally`) items.push(...tallyItems(project));
  if (project === `${home}/code/notes-cli`) {
    items.push(
      item("instructions", "CLAUDE.md", `${project}/CLAUDE.md`, "project", "loaded"),
      item(
        "settings",
        ".claude/settings.json",
        `${project}/.claude/settings.json`,
        "project",
        "loaded",
      ),
    );
  }
  if (project === `${home}/code/dawg-site`) {
    items.push(item("instructions", "AGENTS.md", `${project}/AGENTS.md`, "project", "loaded"));
  }
  return items;
}
