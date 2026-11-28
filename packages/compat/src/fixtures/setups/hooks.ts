/**
 * Compatibility fixtures for hooks (see ../types.ts), written from Claude Code's public hooks
 * reference and guide (code.claude.com/docs/en/hooks, /hooks-guide). The report's hook items are
 * checked by compat's suite; `expected.approval` (what waits for consent) by the engine's, with
 * its trust store.
 */
import type { CompatFixture } from "../types.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The hooks guide's example: a PreToolUse script that blocks `rm -rf`. */
const BLOCK_RM = `#!/bin/sh
# Reads the hook input on stdin and refuses destructive removals.
command=$(cat | sed -n 's/.*"command":"\\([^"]*\\)".*/\\1/p')
case "$command" in
  *"rm -rf"*) echo "rm -rf is not allowed in this project" >&2; exit 2 ;;
esac
exit 0
`;

const command = (cmd: string, extra: Record<string, unknown> = {}) => ({
  type: "command",
  command: cmd,
  ...extra,
});

export const FIXTURES: Record<string, CompatFixture> = {
  "hooks/project-pre-tool-use": {
    description:
      "A project's PreToolUse hook on Bash that blocks rm -rf: loaded, and waiting for consent (hooks guide).",
    files: {
      "project/.claude/settings.json": json({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [command(".claude/hooks/block-rm.sh")] }],
        },
      }),
      "project/.claude/hooks/block-rm.sh": BLOCK_RM,
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "PreToolUse on Bash: .claude/hooks/block-rm.sh",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
      ],
      approval: { items: 1 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/claude-user-hooks": {
    description:
      "Hooks in Claude Code's own user settings run commands written for another app, so they wait for consent too (PLAN, Compatibility details).",
    files: {
      "home/.claude/settings.json": json({
        hooks: {
          PostToolUse: [{ matcher: "Edit|Write", hooks: [command("npm run lint --silent")] }],
          Stop: [{ hooks: [command("say done", { timeout: 5 })] }],
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "PostToolUse on Edit|Write: npm run lint --silent",
          scope: "user",
          origin: "claude",
          status: "loaded",
        },
        { kind: "hook", name: "Stop: say done", scope: "user", origin: "claude", status: "loaded" },
      ],
      approval: { items: 2 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/dawg-user-hooks": {
    description: "The person's own ~/.dawg hooks need no consent.",
    files: {
      "home/.dawg/settings.json": json({
        hooks: {
          UserPromptSubmit: [{ hooks: [command("~/bin/prompt-guard")] }],
          SessionStart: [{ matcher: "startup", hooks: [command("git status --short")] }],
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "UserPromptSubmit: ~/bin/prompt-guard",
          scope: "user",
          origin: "dawg",
          status: "loaded",
        },
        {
          kind: "hook",
          name: "SessionStart on startup: git status --short",
          scope: "user",
          origin: "dawg",
          status: "loaded",
        },
      ],
      approval: null,
    },
    ignoreKinds: ["settings"],
  },

  "hooks/other-handler-types": {
    description:
      "Tier 2 events and the http, prompt, agent and mcp_tool handler types run; a model a hook names is mapped (hooks reference, principle 4).",
    files: {
      "project/.claude/settings.json": json({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [
                {
                  type: "http",
                  url: "http://localhost:8080/check",
                  headers: { Authorization: "Bearer $HOOK_TOKEN" },
                  allowedEnvVars: ["HOOK_TOKEN"],
                },
              ],
            },
          ],
          PreCompact: [{ matcher: "auto", hooks: [command("./save-notes.sh")] }],
          Stop: [
            { hooks: [{ type: "prompt", prompt: "Did the tests pass? $ARGUMENTS", model: "haiku" }] },
          ],
          PermissionRequest: [
            { matcher: "Bash", hooks: [{ type: "mcp_tool", server: "policy", tool: "check" }] },
          ],
          SubagentStop: [{ hooks: [{ type: "agent", prompt: "Check the agent's work." }] }],
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "PreToolUse on Write: http://localhost:8080/check",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
        {
          kind: "hook",
          name: "PreCompact on auto: ./save-notes.sh",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
        {
          kind: "hook",
          name: "Stop: Did the tests pass? $ARGUMENTS",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["mapped to the helper model"],
        },
        {
          kind: "hook",
          name: "PermissionRequest on Bash: policy check",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
        {
          kind: "hook",
          name: "SubagentStop: Check the agent's work.",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["only read files"],
        },
      ],
      approval: { items: 5 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/not-yet-supported": {
    description:
      "Tier 3 events dawg does not run yet, a handler type on an event Claude Code does not run it on, an address allowedHttpHookUrls leaves out, and an event Claude Code does not document are reported with why (hooks reference).",
    files: {
      "project/.claude/settings.json": json({
        allowedHttpHookUrls: ["https://hooks.example.com/*"],
        hooks: {
          FileChanged: [{ matcher: ".envrc", hooks: [command("direnv reload")] }],
          PreCompact: [{ hooks: [{ type: "prompt", prompt: "Keep the plan." }] }],
          PermissionRequest: [{ hooks: [{ type: "agent", prompt: "Is this safe?" }] }],
          PostToolUse: [{ hooks: [{ type: "http", url: "http://localhost:8080/log" }] }],
          BeforeTool: [{ hooks: [command("./never.sh")] }],
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "FileChanged on .envrc: direnv reload",
          scope: "project",
          origin: "claude",
          status: "not-supported",
          notes: ["FileChanged hooks yet"],
        },
        {
          kind: "hook",
          name: "PreCompact: Keep the plan.",
          scope: "project",
          origin: "claude",
          status: "not-supported",
          notes: ["does not run prompt hooks on PreCompact"],
        },
        {
          kind: "hook",
          name: "PermissionRequest: Is this safe?",
          scope: "project",
          origin: "claude",
          status: "not-supported",
          notes: ["does not run agent hooks on PermissionRequest"],
        },
        {
          kind: "hook",
          name: "PostToolUse: http://localhost:8080/log",
          scope: "project",
          origin: "claude",
          status: "not-supported",
          notes: ["allowedHttpHookUrls"],
        },
        {
          kind: "hook",
          name: "BeforeTool: ./never.sh",
          scope: "project",
          origin: "claude",
          status: "not-supported",
          notes: ["not an event Claude Code documents"],
        },
      ],
      // Everything documented counts, so consent given now covers them if they ever run; the
      // undocumented event never fires, so it is not offered.
      approval: { items: 4 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/partly-supported-fields": {
    description:
      "A command hook with a status message, a field Claude Code does not document and a bad timeout: it runs, and each is named.",
    files: {
      "project/.dawg/settings.json": json({
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit",
              hooks: [
                command("npx prettier --write .", {
                  statusMessage: "Formatting",
                  retries: 3,
                  timeout: "soon",
                }),
              ],
            },
          ],
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "PostToolUse on Edit: npx prettier --write .",
          scope: "project",
          origin: "dawg",
          status: "partly-supported",
          notes: ["statusMessage is not shown", "Not used by dawg: retries", "timeout:"],
        },
      ],
      approval: { items: 1 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/reads-transcript": {
    description:
      "A Stop hook whose script parses transcript_path: it runs, with the spec's known gap noted.",
    files: {
      "project/.claude/settings.json": json({
        hooks: { Stop: [{ hooks: [command("python3 .claude/hooks/summarise.py")] }] },
      }),
      "project/.claude/hooks/summarise.py":
        "import json, sys\nevent = json.load(sys.stdin)\nwith open(event['transcript_path']) as f:\n    print(len(f.readlines()))\n",
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "Stop: python3 .claude/hooks/summarise.py",
          scope: "project",
          origin: "claude",
          status: "partly-supported",
          notes: ["transcript_path"],
        },
      ],
      approval: { items: 1 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/disable-all": {
    description:
      "disableAllHooks in the person's settings turns every hook off, so nothing waits for consent (hooks reference).",
    files: {
      "home/.dawg/settings.json": json({ disableAllHooks: true }),
      "project/.claude/settings.json": json({
        hooks: { PreToolUse: [{ matcher: "*", hooks: [command("./audit.sh")] }] },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "PreToolUse: ./audit.sh",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["disableAllHooks"],
        },
      ],
      approval: null,
    },
    ignoreKinds: ["settings"],
  },

  "hooks/every-project-file": {
    description:
      "Hooks in all four of a project's settings files merge; one defined identically in two files runs once (hooks reference).",
    files: {
      "project/.claude/settings.json": json({
        hooks: { PostToolUse: [{ matcher: "Write", hooks: [command("npm test")] }] },
      }),
      "project/.dawg/settings.json": json({
        hooks: { PostToolUse: [{ matcher: "Write", hooks: [command("npm test")] }] },
      }),
      "project/.claude/settings.local.json": json({
        hooks: { Notification: [{ matcher: "permission_prompt", hooks: [command("say hi")] }] },
      }),
      "project/.dawg/settings.local.json": json({
        hooks: { SessionEnd: [{ hooks: [command("./cleanup.sh")] }] },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "PostToolUse on Write: npm test",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["runs once"],
        },
        {
          kind: "hook",
          name: "PostToolUse on Write: npm test",
          scope: "project",
          origin: "dawg",
          status: "loaded",
        },
        {
          kind: "hook",
          name: "Notification on permission_prompt: say hi",
          scope: "local",
          origin: "claude",
          status: "loaded",
        },
        {
          kind: "hook",
          name: "SessionEnd: ./cleanup.sh",
          scope: "local",
          origin: "dawg",
          status: "loaded",
        },
      ],
      approval: { items: 4 },
    },
    ignoreKinds: ["settings"],
  },

  "hooks/invalid-entries": {
    description: "Entries that do not follow the documented shape are reported and skipped.",
    files: {
      "project/.claude/settings.json": json({
        hooks: {
          PreToolUse: "./check.sh",
          Stop: [{ hooks: [{ type: "command" }] }, { matcher: "x" }],
        },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "hooks.PreToolUse",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["Expected a list of matcher groups"],
        },
        {
          kind: "hook",
          name: "hooks.Stop[0].hooks[0].command",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["needs a command"],
        },
        {
          kind: "hook",
          name: "hooks.Stop[1].hooks",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["needs a list of hooks"],
        },
      ],
      approval: null,
    },
    ignoreKinds: ["settings"],
  },

  "hooks/with-mcp-servers": {
    description:
      "A project's .mcp.json servers and its hooks are approved together, once (spec, principle 3).",
    files: {
      "project/.mcp.json": json({
        mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
      }),
      "project/.claude/settings.json": json({
        hooks: { SessionStart: [{ hooks: [command("cat .claude/context.md")] }] },
      }),
    },
    expected: {
      items: [
        {
          kind: "hook",
          name: "SessionStart: cat .claude/context.md",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
      ],
      approval: { items: 2 },
    },
    ignoreKinds: ["settings", "mcp-server"],
  },
};
