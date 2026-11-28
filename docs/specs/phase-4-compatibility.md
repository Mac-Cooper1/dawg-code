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

As built (2026-11-27, round 3): tiers 1 and 2 run with all five handler types, each on the events the reference lists for it (an agent hook on PermissionRequest, or a prompt hook on PreCompact, is reported and skipped). Tier 3 runs PostToolBatch, UserPromptExpansion (skills, custom commands and MCP prompts, checked before they expand, so a block also stops a skill's inline shell; `command_source` is `userSettings`, `projectSettings` or `mcp`), StopFailure, and Elicitation and ElicitationResult. Where the docs leave room, dawg settles it so:

- **PermissionRequest** runs only where a prompt would be shown, or where nobody can answer one (headless, a client without prompts); its allow then runs the call instead of refusing it. Deny wins over allow. A new input is checked against the tool's schema and the rules again: a deny rule refuses it, and an ask rule asks the person with the new input. `updatedPermissions`: `addRules` for the session, or saved to the project's personal dawg file for `localSettings`; `projectSettings` and `userSettings` hold for the session only, since dawg never writes Claude Code's files; `setMode` only to a mode the settings allow; `addDirectories`. `replaceRules` and `removeRules` are not applied. A prompt hook's `ok: true` grants the request; `ok: false` leaves the prompt to the person.
- **PostToolUseFailure** runs after a call that ran and failed (it threw, or its result is an error), not after one the person stopped or one that was refused. A shell command's `error` starts with `Exit code N`.
- **PreCompact and PostCompact** run around `/compact`, "summarise from here" and automatic compaction, not around trimming one oversized result. A blocked manual compaction ends as failed, with the reason; a blocked automatic one is skipped, and a context overflow then fails the request.
- **http**: redirects are not followed, so `allowedHttpHookUrls` holds for the address the event reaches; an empty list allows nothing. **prompt** asks the helper model, else the session's, with any `model` mapped. On PreToolUse, `ok: true` lets the call go on to the usual permission check; it is not an allow. **agent** runs as a read-only subagent (Read, Grep, Glob, 50 requests at most), listed with the session's agents as type "hook"; it fires no subagent hooks of its own, and a subagent's own agent hooks fail, since subagents start no agents. **mcp_tool** calls go through the session's servers with no permission check, wait for a server still connecting on events that can block, and are skipped on SessionStart at launch.
- **Elicitation** hooks run before the form is shown, also where nobody could answer it (headless): an accepted form must pass the same check as the person's answer, or it is refused and the person is asked; a decline wins over a cancel, and a cancel over an accept. When a hook answers, ElicitationResult hooks do not run. **ElicitationResult** runs on every answer the person gives; an accept without `content` keeps theirs, and the result is checked against the form too. Notification hooks get `elicitation_dialog` (or `elicitation_url_dialog`) when a request has waited as long as a permission prompt would, and `elicitation_response` once it is answered. A subagent's request runs the parent session's hooks, since it is shown there.
- `once` is ignored in settings files and `async` is honoured on command hooks only, as documented; a project's hooks of every type wait for consent, and the trust dialog says where an http hook sends events and which variables go with them.
- Left for later in tier 3: InstructionsLoaded, PermissionDenied (no auto mode), CwdChanged, DirectoryAdded, ConfigChange, FileChanged, PreSkillShellCommand, WorktreeCreate and WorktreeRemove, PreModelSwitch and PostModelSwitch, Setup, MessageDisplay, and the task and teammate events.

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

As built (2026-11-27, round 3):

- `memory` and `mcpServers` are honoured too. Settings → Subagents (named so because "Agents" is kept for a later feature) lists every definition a project's new sessions get, built-ins included, as loaded, partly supported, needs approval, invalid or overridden (`project.subagents`), with "Open file". Its "New subagent" form writes `<name>.md` (lowercase words joined by hyphens, as the docs describe names) to `~/.dawg/agents` or the project's `.dawg/agents`, never under `.claude` and never over an existing file (`subagent.create`). `/agents` opens that page in the app and prints the listing, with the session's own agents, in `dawg`; Claude Code's own `/agents` now only says where the files go.
- MCP for typed agents: with no `tools` list an agent gets the session's MCP tools; a list narrows them by exact name, by a prefix ending in `*`, or by a server alone (`mcp__github`, as permission rules name a server); `disallowedTools` takes them away the same way, by prefix as documented. dawg settles what the docs leave open: a server named in `mcpServers` (by reference or inline) is granted whole beside a `tools` list, and inline servers add to the session's rather than replace them. ToolSearch, CallMcpTool and the resource tools reach only the agent's servers and tools. Read-only built-ins get no MCP tools.
- An inline server in a project's agent file is project code: it is in the trust hash and starts only once the project's code is approved, and never gets the variables a project's server is denied. One in Claude Code's agent files in the home folder (`~/.claude/agents`) runs code dawg did not write, so, like Claude Code's user hooks, it waits for approval given once for every project (decided 2026-11-27); that file's tool grants and mode need none. One in the person's own `~/.dawg/agents` needs no approval.
- As documented, the model cannot send more work to an agent the person stopped.
- Left: the `Agent` tool's `name`, `model` and `effort` parameters (and `SendMessage` by name); the `--agents` flag; the `hooks`, `effort`, `omitClaudeMd`, `initialPrompt`, `autoCompactWindow` and `color` fields (reported as partly supported); Claude Code's newer default of starting custom agents in the background.

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

As built (2026-11-27), signing in and a session's own servers:

- Sign-in runs on the SDK's `auth()`: discovery (RFC 9728, then RFC 8414), dynamic registration when offered, PKCE S256, `state` checked. The browser comes back to `http://localhost:PORT/callback` (the form Claude Code documents), served on 127.0.0.1 and, as a best effort, on ::1 at the same port: one flow, the first matching return wins, both close together, five minutes. Only "Sign in" (Settings → MCP servers, `/mcp login`, `mcp.signIn`) starts one; a plain connect never registers dawg. A `-p` run never signs in and names the servers it went without.
- A definition's `oauth` object takes the documented `clientId`, `callbackPort`, `authServerMetadataUrl` and `scopes`. Claude Code keeps a client secret in its Keychain from `claude mcp add`; dawg has no `add`, so it reads `MCP_CLIENT_SECRET` (the variable Claude Code documents for skipping its prompt) at sign-in and keeps it with the sign-in. The app has no field for a secret yet.
- Tokens and registrations go through `McpCredentialStore`, keyed by scope, name and URL origin. The Keychain (one generic-password item per server, service `dawg-code.mcp.<hash of the data root>`, secrets on `security -i`'s standard input) is the default on macOS for the app and the CLI; `DAWG_CREDENTIAL_STORE=file` (0600) or `memory` choose otherwise. `security -i` cuts lines at 4,095 characters, so an unusually large sign-in spans a few numbered items.
- A refused token is first checked against the store (the other process may have renewed it), then renewed with the refresh token, one renewal at a time; a refused renewal makes the server "needs sign-in" with that reason.
- `--mcp-config` (repeatable, a later one wins) and `--strict-mcp-config`, and `session.create`'s `mcpServers` and `strictMcpConfig`, apply to new sessions only; `mcp.list` and the sign-in methods take an optional `sessionId` to reach them.

As built (2026-11-27), elicitation and the resource tools:

- dawg declares both modes (`elicitation: {form: {}, url: {}}`), as Claude Code does. A request is shown in the session whose call to that server is in flight; the SDK does not say which call a server's request relates to, so when calls of two sessions sharing the server are in flight, or none is, dawg declines rather than guess, and the calls' results say so. One session's form is never shown in another.
- Nobody to ask (a `-p` run, a client without the `elicitation` capability): declined at once, with a note in the tool result. An interrupt answers "cancel". A subagent's request is shown in the parent session, labelled with the agent (app and CLI, a background agent's at the CLI prompt too), and the parent's hooks run on it; it outlives the parent's turn unless that turn is interrupted. A turn waiting on a request is not kept across quitting, since the server's request goes with the process.
- The form is checked against the requested schema in the engine, the app and the CLI alike (`elicitationIssues`). URL mode shows the site and the full address and opens it only when the person asks; only http and https addresses up to 8,192 characters are offered.
- Time spent waiting for the person does not count against a call's timeout: the clock stops while the request waits and goes on with what was left.
- `ListMcpResourcesTool` (one server's or all, templates included, MCP Apps pages left out) and `ReadMcpResourceTool` (by server and URI) ask no permission, as documented. They are in a session's tool list whenever it has MCP servers when the list is decided; results are wrapped as data and capped like other MCP results, and binary contents are saved to a file.
- Not yet: the `URLElicitationRequiredError` (-32042) answer to a call, and `notifications/elicitation/complete` (ignored, as unknown ids must be). The `Elicitation` and `ElicitationResult` hooks are under Hooks.

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

As built (2026-11-27, `@anthropic-ai/sandbox-runtime` 0.0.83):

- Off until a settings file, Settings → Permissions or `dawg --sandbox` turns it on (`sandbox.enabled` defaults to false, as documented). `autoAllowBashIfSandboxed` defaults to false and `allowUnsandboxedCommands` to true, as the settings reference now says.
- Booleans follow settings precedence; lists merge. dawg's own rule on top of the documented scopes, a deliberate difference from Claude Code (decided 2026-11-27): a project's shared file cannot turn on auto-allow or loosen isolation (local binding, sockets, Mach lookups, weaker isolation), and opens writes only inside the project. The compatibility report names each key that is ignored, and why.
- Hosts a project's files (shared or personal, `.claude` or `.dawg`) open to sandboxed commands are project-supplied power (principle 3): each is an approval item ("Network access to example.com (sandbox)") counted in the trust store's hash, and stays off the list until the person approves the project's setup. The person's own settings' hosts need no approval.
- `WebFetch(domain:…)` rules add to the allowed and denied hosts; `Read`/`Edit` deny rules become read and write denies, so they hold for commands no analysis can see into.
- One proxy and one system-log reader per process, started by the first sandboxed command and stopped when the last engine closes. Commands get a temp folder of their own (`$TMPDIR/dawg-sandbox-*`), removed with it; nothing else is written to disk on macOS.
- Elsewhere: Linux works when bubblewrap, socat and ripgrep are installed (not tested here); Windows is not supported. Where the sandbox cannot run, commands run without it and say so, unless `failIfUnavailable` is set.

### Web tools

**WebFetch** (`url`, `prompt`)

- Fetches the page, converts HTML to markdown, caps the size, and caches for a few minutes.
- The page text and the caller's prompt go to the model in a side request, and that answer is the tool result. This keeps large pages out of the main context.
- Each new domain asks permission; `WebFetch(domain:example.com)` rules are honoured.
- Requests to localhost and private network addresses are refused, and redirects are re-checked.

**WebSearch** (`query`, allowed and blocked domains)

- A provider interface with one method. There is no built-in search service, so the tool is absent until a provider is configured.
- Providers: any MCP server that offers search, or a search API the user supplies a key for.
- The suggested service is Brave Search (an independent index with a free plan), chosen by the project owner on 2026-11-27. Settings → Web marks it, and on the command line a key with no service named is taken as a Brave key. Tavily and a self-hosted SearXNG are the alternatives.

Fetched pages and search results are untrusted. They are wrapped and labelled as data in the model's context, and the prompt tells the model not to follow instructions found in them.

### Memory

- A per-project memory folder at `~/.dawg/projects/<project-key>/memory/`, with a `MEMORY.md` index whose first lines are loaded at session start, and topic files read on demand.
- The model maintains it with the ordinary file tools, under instructions for when to save and when not to.
- `/memory` opens the instruction files and the memory folder for editing.
- Subagent memory scopes (user, project, local) from the agent front matter map to folders under `~/.dawg` and the project.

As built (2026-11-27, round 3), subagent memory: the scopes map to `<data root>/agent-memory/<agent>/` (`user`, `~/.dawg/agent-memory/` by default), `<project root>/.dawg/agent-memory/<agent>/` (`project`, meant to be committed) and `<project root>/.dawg/agent-memory-local/<agent>/` (`local`), where the project root is the main working tree, as for the project's memory. As documented, the agent's prompt holds instructions and the first 200 lines (25 KB) of its MEMORY.md, Read, Write and Edit join its tools, and its file tools work in the folder without asking; it does nothing with auto memory off. The index is read at the agent's first task and kept for its later ones in the session. Claude Code's `.claude/agent-memory*` folders are not read, as its project memory is not.

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
- Whether memory written by Claude Code for the same project should be offered for import.
