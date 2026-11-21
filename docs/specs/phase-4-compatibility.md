# Phase 4 — Compatibility

_Draft spec. Roadmap: [PLAN.md](../../PLAN.md) section 9. Shared conventions: [README](README.md)._

## Outcome

Point the app at a project and a home directory already set up for Claude Code, and it loads and runs what it finds: hooks, skills, custom commands, subagents and MCP servers. This phase also adds the remaining features a regular user expects: checkpoints and rewind, a sandbox for shell commands, web tools, and memory.

## Scope

**In**

- `packages/compat`: readers for each Claude Code convention.
- Hooks, skills, custom commands, subagents, MCP.
- Checkpoints and rewind.
- macOS sandbox for shell commands.
- Web fetch and web search.
- Auto memory.
- A trust prompt for project-supplied code, a compatibility report, and a compatibility test suite.
- The UI each feature needs.

**Out**

- Plugins and marketplaces, output styles, status line, keybindings, LSP, scheduled tasks, workflows (Phase 5).

## Depends on

- Phase 2: the tool registry, permission engine, settings loader, sessions.
- Phase 3: the UI for prompts and panes.

## Design

### Principles

1. **Read their formats, keep our state.** Files under `.claude/` and `~/.claude/` are parsed read-only. Equivalent `.dawg/` locations are read too and win on conflict.
2. **The public docs are the contract.** Each reader is built from the documented format, with fixtures written by us from those docs. Fields we do not support are reported, not silently dropped.
3. **Project-supplied code needs consent.** Hooks and MCP servers defined inside a project run arbitrary commands. The first time a project is opened, and whenever those definitions change, the app lists them and asks before enabling any. Approval is stored per project, keyed by a hash of the definitions.
4. **Model fields are mapped, not obeyed.** Agent and skill files may name Anthropic models (`sonnet`, `haiku`, `inherit`). Every name maps to the session's model unless the user sets an alias, for example pointing `haiku` at a small utility model.

### Hooks

**Source.** The `hooks` key of any settings file, in the documented shape: event name → list of `{ matcher, hooks: [handler] }`.

**Running a hook**

| Step        | Behaviour                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Match       | `*` or empty matches all; otherwise exact tool names, `A\|B` alternatives, or a regular expression, against the tool name                                                                     |
| Input       | JSON on stdin: the documented common fields (session id, transcript path, working directory, event name, permission mode) plus the event's own (tool name, tool input, tool response, prompt) |
| Environment | `CLAUDE_PROJECT_DIR` and `DAWG_PROJECT_DIR`, plus the settings `env`                                                                                                                          |
| Concurrency | All handlers matching one event run in parallel; identical commands run once                                                                                                                  |
| Exit 0      | Success. Standard output is parsed as JSON if it is JSON; for prompt-submit and session-start it is otherwise added to context                                                                |
| Exit 2      | Blocking. Standard error is given to the model, and the action is stopped where the event allows it                                                                                           |
| Other exit  | Non-blocking error, shown to the user, execution continues                                                                                                                                    |
| JSON output | The documented fields: permission decision (allow / deny / ask) with a reason, modified tool input, added context, stop / continue                                                            |
| Timeout     | The documented default per handler type, overridable per handler                                                                                                                              |

**Handler types,** in build order: `command` first; then `http`; then `prompt` and `agent`, which call the local model; then `mcp_tool`.

**Events,** in build order. Claude Code documents more than 30; the tiers reflect how often real configurations use them.

| Tier | Events                                                                                      |
| ---- | ------------------------------------------------------------------------------------------- |
| 1    | PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd, Notification     |
| 2    | PermissionRequest, PostToolUseFailure, SubagentStart, SubagentStop, PreCompact, PostCompact |
| 3    | The rest, as each underlying feature exists                                                 |

A pre-tool-use decision feeds the permission engine: `deny` wins over everything, `allow` skips the prompt but not deny rules, `ask` forces a prompt.

**Known gap.** Hooks get a transcript path, and some scripts parse that file. Our transcript format is our own, so those scripts will not work unchanged. The compatibility report flags hooks that read the transcript.

### Skills

**Source.** `<root>/skills/<name>/SKILL.md` with front matter, where root is `~/.claude`, `~/.dawg`, a project's `.claude` or `.dawg`, or a nested directory's.

| Aspect           | Behaviour                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Listing          | Each skill's name and description go into the static prompt, sorted, at session start. This is the only part always in context. |
| Invocation       | The `Skill` tool loads the body. Supporting files are read on demand with `Read`.                                               |
| User invocation  | `/<name> [arguments]`, unless the skill opts out                                                                                |
| Substitutions    | `$ARGUMENTS`, the skill-directory variable, and inline shell output, which goes through the permission engine                   |
| Front matter     | Name, description, allowed tools, model (mapped), "run in a forked context" (runs as a subagent), and the invocation switches   |
| After compaction | Loaded skill bodies are re-attached, within a size cap                                                                          |

Skills added while a session is running appear in the next session, so the cached prefix is not invalidated mid-conversation.

### Custom commands

`<root>/commands/**/*.md`, the older form of user-defined slash commands. Each file becomes `/<name>`, with subdirectories as a namespace. Front matter (description, argument hint, allowed tools, model) and `$ARGUMENTS` / positional arguments are supported. Internally a command is registered as a user-invocable skill.

### Subagents

**Source.** Markdown files with front matter in `<root>/agents/`. Name and description are required; tools, disallowed tools, model (mapped), permission mode, turn limit, skills, background and isolation are honoured.

**Built in:** `Explore` (read-only search), `Plan` (read-only design), `general-purpose`. Their prompts are written for this project.

**The `Agent` tool** takes a description, a prompt, an agent type, and optional background and isolation flags.

| Aspect      | Behaviour                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Context     | A fresh history with the agent's own prompt and tool subset. A _fork_ starts from a copy of the parent's history instead.                 |
| Transcript  | Its own file under the session's `subagents/` folder                                                                                      |
| Permissions | Inherits the parent's rules and mode unless the agent file sets a mode. Prompts are shown in the parent session, labelled with the agent. |
| Result      | The agent's final message is returned to the parent as the tool result                                                                    |
| Background  | The tool returns at once; the parent is told when the agent finishes                                                                      |
| Isolation   | Optionally runs in its own git worktree                                                                                                   |
| Follow-up   | A finished or idle agent can be sent another message by id                                                                                |

**Scheduling on one model.** Each running agent needs a cache slot. The main agent holds slot 0; subagents take free slots and run in parallel when there are enough, and queue when there are not. The UI shows queued agents as queued. A fork is cheap to start because it shares the parent's cached prefix.

### MCP

Built on the official TypeScript SDK.

**Configuration sources,** highest precedence first: a session's own additions, the project's `.mcp.json`, the user's `~/.dawg/mcp.json`, and servers imported from Claude Code's user configuration. Importing from another tool's configuration is an explicit, one-time action that shows what will be copied, because that file can contain credentials.

| Aspect              | Behaviour                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Transports          | stdio and streamable HTTP; legacy SSE for older servers                                        |
| Variables           | `${VAR}` and `${VAR:-default}` expansion in commands, arguments, URLs and headers              |
| Trust               | Project-defined servers need approval (principle 3)                                            |
| Auth                | OAuth with PKCE through the SDK; tokens in the Keychain                                        |
| Tool names          | `mcp__<server>__<tool>`, as permission rules and hooks expect                                  |
| Resources           | Listed and attachable with `@` mentions                                                        |
| Prompts             | Exposed as slash commands                                                                      |
| Elicitation         | A server's request for input is shown as a form                                                |
| Server instructions | Added to the prompt at session start                                                           |
| Large results       | Capped, with the remainder saved to a file                                                     |
| Lifecycle           | Servers start with the session, are restarted on failure with backoff, and are stopped with it |

**Keeping the prompt stable.** The tool list sent to the model must not change mid-session, or the whole cache is lost.

- If the connected servers' schemas are small relative to the context window, they are all included at session start.
- Otherwise only a sorted list of tool names with one-line descriptions is included, plus two fixed tools: `ToolSearch`, which returns full schemas as a result, and a dispatcher that calls an MCP tool by name with arguments the engine validates against that schema.
- Either way, permissions and hooks see the real `mcp__server__tool` name.
- Servers that connect after the session started are reachable through the search path.

The threshold between the two modes, and whether the dispatcher costs accuracy, are settled on the eval suite (tasks 11 and 12 switch on in this phase).

### Checkpoints and rewind

- Before each user prompt is processed, a checkpoint is opened. The first time a file tool changes a file within that checkpoint, the file's prior content is saved under `file-history/<session>/`.
- **Rewind** (`/rewind`, or Esc twice) lists checkpoints and offers: restore files, restore the conversation, both, or summarise from that point.
- Restoring the conversation forks the transcript at that point; nothing is deleted.
- Changes made by shell commands are not tracked, as in Claude Code. The UI says so, and the Changes pane with git remains the full picture.
- A retention limit keeps the most recent checkpoints per session.

### Sandbox

Shell commands can run inside macOS's Seatbelt sandbox, using the open-source sandbox runtime (Apache-2.0).

| Aspect     | Default when on                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Writes     | The working directories and temp only                                                                        |
| Reads      | Broad, minus configured deny paths                                                                           |
| Network    | Through a local proxy that allows listed domains only                                                        |
| Escapes    | A command that fails in the sandbox can be retried outside it, which goes through a normal permission prompt |
| Exclusions | Named commands that cannot work sandboxed run outside, with a prompt                                         |

- The `sandbox` settings keys are read in their documented form.
- With the sandbox on, sandboxed commands can be auto-allowed, which removes most prompts safely.
- The package's interface is confirmed at implementation time; it is young and still changing.

### Web tools

**WebFetch** (`url`, `prompt`)

- Fetches the page, converts HTML to markdown, caps the size, and caches for a few minutes.
- The page text and the caller's prompt go to the model in a side request, and that answer is the tool result. This keeps large pages out of the main context.
- Each new domain asks permission; `WebFetch(domain:example.com)` rules are honoured.
- Requests to localhost and private network addresses are refused, and redirects are re-checked.

**WebSearch** (`query`, allowed and blocked domains)

- A provider interface with one method. There is no built-in search service, so the tool is absent until a provider is configured.
- Providers: any MCP server that offers search, or a search API the user supplies a key for.

Fetched pages and search results are untrusted. They are wrapped and labelled as data in the model's context, and the prompt tells the model not to follow instructions found in them.

### Memory

- A per-project memory folder at `~/.dawg/projects/<project-key>/memory/`, with a `MEMORY.md` index whose first lines are loaded at session start, and topic files read on demand.
- The model maintains it with the ordinary file tools, under instructions for when to save and when not to.
- `/memory` opens the instruction files and the memory folder for editing.
- Subagent memory scopes (user, project, local) from the agent front matter map to folders under `~/.dawg` and the project.

### Compatibility report

`dawg compat [path]`, also shown in the app the first time a project is opened:

| Section          | Lists                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Loaded           | Every instruction file, skill, command, agent, hook and MCP server found, and where it came from |
| Needs approval   | Project-supplied hooks and servers awaiting consent                                              |
| Partly supported | Items using fields or events not implemented yet, naming each one                                |
| Not supported    | Items that depend on Anthropic's cloud                                                           |

### UI additions

- A project trust dialog (principle 3) and a settings page for hooks, listing each with its source and an on / off switch.
- Settings pages for MCP servers (status, tools, sign-in, restart) and for skills and agents (listing, source, open file).
- Hook activity and subagents as transcript items; subagents expandable to their own transcript.
- A checkpoint timeline for rewind.
- A sandbox indicator on shell-command cards.

## Work breakdown

1. Compatibility test fixtures and the report command, so every later step has something to pass.
2. Project trust store and dialog.
3. Custom commands and skills.
4. Hooks: tier 1 events with command handlers; then tier 2; then other handler types.
5. MCP: stdio and HTTP, tools, permissions; then OAuth, resources, prompts, elicitation; then the deferred-schema path.
6. Subagents: built-ins, the `Agent` tool, slot scheduling; then agent files, background, forks, worktree isolation.
7. Checkpoints and rewind.
8. Sandbox.
9. Web fetch, then web search providers.
10. Memory.
11. UI additions alongside each feature.

## Testing

| Layer       | What                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixtures    | A library of small `.claude/` setups written from the public docs, one per feature and per edge case, each with expected behaviour                                                                      |
| Unit        | Each parser against valid, invalid and partly supported files; hook matcher and exit-code tables; variable expansion                                                                                    |
| Integration | Hooks that block, modify input and add context, against the scripted engine; a test MCP server over each transport, including an OAuth flow and a crash; subagent scheduling with one and several slots |
| Security    | A project whose hooks and servers are not approved runs none of them; web fetch refuses private addresses; sandboxed commands cannot write outside the project                                          |
| Eval        | Tasks 11 and 12, plus the full suite re-run to confirm no regression from the larger prompt                                                                                                             |
| Real setups | The app pointed at several real, varied Claude Code configurations, with the report reviewed by hand                                                                                                    |

## Done when

- Opening a project with an existing `.claude/` directory, and a home with `~/.claude/`, loads every supported item, and the compatibility report accounts for everything it found.
- Tier 1 and 2 hooks behave as documented, including blocking and input modification.
- MCP servers over stdio and HTTP work, including one that needs OAuth.
- A subagent can be started in the foreground and background, and its transcript opened.
- Rewind restores files and conversation to any recent checkpoint.
- With the sandbox on, a command cannot write outside the project or reach an unlisted domain.
- The compatibility suite passes in CI, and the eval pass rate has not dropped from Phase 2.

## Open questions

- Whether to offer an export of our transcript in a shape transcript-reading hooks expect.
- The schema-size threshold for deferring MCP tools, and whether the dispatcher approach holds up in evals.
- Which search provider to document as the default suggestion.
- Whether memory written by Claude Code for the same project should be offered for import.
