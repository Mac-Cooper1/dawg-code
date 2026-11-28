# @dawg/protocol

The engine protocol: how every client (the desktop app, the command-line tool, tests) talks to the
engine. The zod schemas in `src/` are the source of truth; the TypeScript types are derived from
them. Specs: "The engine protocol" in `docs/specs/README.md` and "Protocol" in
`docs/specs/phase-2-engine-core.md`.

```ts
import { createClient, createMemoryTransportPair, createServer } from "@dawg/protocol";

const [clientEnd, engineEnd] = createMemoryTransportPair();
const server = createServer(engineEnd, handlers); // handlers: Partial<Handlers>
const client = createClient(clientEnd);

await client.initialize({ client: { name: "app", version: "1.0.0" }, capabilities: {} });
const { session } = await client.request("session.create", { cwd: "/path/to/project" });
client.onEvent((event) => reducer(event)); // EngineEvent: { event, payload }
const { turnId } = await client.request("session.prompt", {
  sessionId: session.id,
  prompt: { content: [{ type: "text", text: "Fix the failing test" }] },
});
// ... later, in the engine:
server.notify("message.delta", { sessionId, seq, time: Date.now(), turnId, messageId, text });
```

## Wire format

- JSON-RPC 2.0, one message at a time (batches are refused with Invalid Request).
- Requests go client to engine only. Events go engine to client as notifications: the method is
  the event name, the params are the payload.
- Every payload is plain JSON: times are numbers (milliseconds since the epoch), absent values are
  `null` in events and omitted in params, never `undefined`.
- Schemas **strip unknown fields** instead of rejecting them, and clients **ignore unknown
  events**, so a newer peer can talk to an older one.
- A client may send the notification `rpc.cancel` `{ id }` to abandon a request. The engine answers
  it at once with `RequestCancelled` and aborts the handler's `AbortSignal`.

## Versioning

`PROTOCOL_VERSION` (currently 2) names one wire format. Additive changes keep it: new methods, new
events, new optional params, new result or event fields. Anything else bumps it, including adding
a value to an enum the engine sends (except `ErrorInfo.kind`, where unknown kinds arrive as
`"other"`).

| Version | Since   | What changed                                                                                                                                                                 |
| ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2       | Phase 4 | Tool display kinds `web-fetch`, `web-search` and `mcp`; the pending request kind `elicitation`, in `PendingRequest`, `request.resolved` and `session.status` `waitingOn` |
| 1       | Phase 1 | The first wire format                                                                                                                                                        |

The engine speaks one version, so a client built for version 1 is refused at `initialize` and says
the app and engine are out of step. Stored sessions keep the version they were written with, and
version 1 sessions still open: their records are a subset of version 2's.

`initialize` must be the first request. The client sends its version; the engine either speaks it
and echoes it back, or answers `UnsupportedProtocolVersion` (-32004) with
`data: { requested, supported: number[] }`. There is no downgrade. On a mismatch the client closes
the connection and tells the person the app and engine are out of step. Any other method before
`initialize` succeeds gets `NotInitialized`; a second `initialize` gets `InvalidState`.
`createServer` enforces all of this; `client.initialize()` fills in the version and checks the
answer.

## Methods

Results that are "nothing" are `{}`, so fields can be added later. "Open" means created, resumed
or forked on this connection; a connection receives events for the sessions it has open.

| Method | Purpose | Params | Result |
| --- | --- | --- | --- |
| `initialize` | Exchange versions and capabilities | `protocolVersion`, `client {name, version}`, `capabilities {permissionPrompts, questions, planApproval, elicitation}` (each defaults to true; `elicitation` *added*: an MCP server's requests for input) | `protocolVersion`, `engine {name, version}`, `capabilities {methods[], events[], maxMessageLength}` |
| `session.create` | Open a new session in a directory | `cwd`, `projectDir?` (when `cwd` is a worktree), `title?`, `mode?`, `model?`, `effort?`, `additionalDirectories?`, `mcpServers?` *added* (the session's own MCP servers, a `.mcp.json` `mcpServers` object; they come first and need no approval), `strictMcpConfig?` *added* (only those) | `SessionSnapshot` |
| `session.resume` | Open a stored session | `sessionId` | `SessionSnapshot` |
| `session.fork` | Copy a session up to a point into a new one, and open it | `sessionId`, `point?` (`end`, `beforeTurn {turnId}`, `afterTurn {turnId}`; default end), `title?`, `cwd?` | `SessionSnapshot` of the new session |
| `session.list` | List stored sessions, newest activity first | `projectDir?`, `query?`, `includeArchived?`, `limit?`, `cursor?` | `sessions: SessionSummary[]`, `nextCursor` |
| `session.rename` | Set a session's title | `sessionId`, `title` | `session: SessionSummary` |
| `session.archive` | Archive or unarchive | `sessionId`, `archived?` (default true) | `session: SessionSummary` |
| `session.delete` | Delete a stored session for good, open or not | `sessionId` | `{}` |
| `session.prompt` | Send a message and start a turn | `sessionId`, `prompt {content: ContentPart[], mentions?: {path, startLine?, endLine?}[]}` | `turnId` |
| `session.interrupt` | Stop the running turn or compaction | `sessionId` | `interrupted` (false if nothing ran) |
| `session.setMode` | Change the permission mode | `sessionId`, `mode` | `mode` |
| `session.setModel` | Change the model | `sessionId`, `model` | `model`, `modelInfo`, `effort` (reset to null if no longer valid) |
| `session.setEffort` | Change the reasoning effort | `sessionId`, `effort` (null = model default) | `effort` |
| `session.command` | Run a slash command | `sessionId`, `name` (no slash), `args` (default "") | `output` (Markdown or null), `turnId` (if it started a turn), `openedSession` (if it opened another session, e.g. `/clear`) |
| `session.replay` | Events after a sequence number, for reconnecting or rebuilding a view | `sessionId`, `afterSeq` (0 = all), `limit?` | `events: {event, payload}[]`, `lastSeq`, `hasMore` |
| `session.checkpoints` *added* | The checkpoints a session can rewind to: one per prompt, made before it was processed | `sessionId` | `checkpoints: Checkpoint[]` oldest first (`id`, `turnId`, `time`, `prompt` as typed, `tracked` (false once retention dropped its files), `files: {path, change: created/modified, agents: SubagentLabel[]}[]` its turn changed with file tools (with the subagents it started that changed them), `restore: {path, action: write/delete, changedOutside}[]` what restoring files to it would do), `retention` |
| `session.rewind` *added* | Go back to a checkpoint. Not during a turn (`SessionBusy`), nor while a subagent works in the background (`InvalidState`); an unknown id is `InvalidParams` | `sessionId`, `checkpointId`, `action` (`both`, `conversation`, `files`, `summarize`), `overwrite?` (default false), `instructions?` (for `summarize`) | `outcome` (`done`, or `conflicts` when files changed outside the file tools and `overwrite` was not set: nothing changed), `conflicts: string[]`, `files: {restored, deleted, skipped: {path, reason}[]}` or null, `session` (the fork the conversation goes on in, open on this connection, for `both` and `conversation`) or null, `prompt` (the checkpoint's prompt, to put back in the composer) or null. `summarize` starts a compaction of everything from the prompt on and returns; `compaction.*` events report it |
| `background.output` | Read a background command's output | `sessionId`, `taskId`, `offset?` (bytes, default 0), `limit?` (bytes, default 256 KiB, at most 1 MiB) | `text` (plain text), `nextOffset`, `totalBytes`, `done` |
| `background.stop` | Stop a background command | `sessionId`, `taskId` | `stopped` (false if it had ended) |
| `subagent.stop` *added* | Stop a subagent of the session that is queued or running (Phase 4, subagents) | `sessionId` (the parent), `agentId` | `stopped` (false if it had ended). `InvalidParams` for an unknown agent |
| `project.skills` *added* | Every skill and custom command a project's sessions get, for Settings → Skills and commands. Read-only | `projectDir` (absolute, or null for only the person's own) | `projectDir`, `skills: SkillInfo[]`, `commands: SkillInfo[]` (`name`, `kind`, `description`, `argumentHint`, `source`, `userInvocable`, `modelInvocable`, `status`, `notes`), those not used and those in folders inside the project included |
| `project.subagents` *added* | Every subagent a project's new sessions can start, for Settings → Subagents and `/agents`. Read-only | `projectDir` (absolute, or null for the built-ins and the person's own) | `projectDir`, `agents: SubagentDefinition[]` (the built-ins, then the files in reading order: `name`, `description`, `builtIn`, `source`, `tools`, `disallowedTools`, `model` as written, `mappedModel` (null: the session's), `permissionMode`, `readOnly`, `maxTurns`, `skills`, `memory`, `memoryDirectory`, `mcpServers: {name, inline}[]`, `background`, `isolation`, `status` loaded/partly-supported/needs-approval/invalid/overridden, `overriddenBy`, `notes`), `folders: {user, project}` (where `subagent.create` writes) |
| `subagent.create` *added* | Writes a new agent file in the documented front matter format, as `<name>.md` in `~/.dawg/agents` or the project's `.dawg/agents`, never under `.claude` and never over a file | `projectDir`, `scope` (user/project), `name`, `description`, `prompt?`, `tools?`, `disallowedTools?`, `model?`, `permissionMode?`, `memory?`, `background?`, `isolation?` | `path`, `agent: SubagentDefinition`. A bad name or no description is `InvalidParams`; a file of that name already there is `InvalidState` |
| `project.inspect` *added* | The compatibility report for a project and the person's home, with the consent its code needs. An item that would run but waits for consent is `needs-approval` | `projectDir` (absolute, or null for only the person's own) | `CompatReport`: `projectDir`, `items: CompatItem[]`, `approval` (`CodeApproval`: `hash`, `approved`, `items`; null when nothing needs consent) |
| `project.trust` *added* | Approve (or take back) the code a project supplies: hooks from its settings files and Claude Code's user settings, its skills and commands with `!` shell or `allowed-tools`, its `.mcp.json` servers | `projectDir`, `hash` (the `approval.hash` the person saw), `approved` | `approved`. `InvalidState` when the hash no longer matches the definitions on disk |
| `hooks.list` *added* | Every hook that applies, for Settings → Hooks | `projectDir` (absolute, or null) | `projectDir`, `hooks: HookInfo[]` (`id`, `event`, `matcher`, `type`, `command`, `timeout`, `source`, `status`, `notes`, `enabled`), `disabledBy` (the file whose `disableAllHooks` is on, or null) |
| `hooks.setEnabled` *added* | The person's switch for one hook, kept in dawg's data folder | `projectDir`, `id`, `enabled` | `enabled`. `InvalidParams` for an id no longer in the files |
| `mcp.list` *added* | The MCP servers a project's sessions get, for Settings → MCP servers | `projectDir` (absolute, or null for only the person's own), `sessionId?` (an open session's servers instead, its own among them) | `projectDir`, `servers: McpServerInfo[]` (`name`, `scope` session/local/project/user, `source`, `transport` stdio/http/sse or null, `target`, `state` connected/starting/failed/needs-approval/needs-sign-in/off, `reason`, `tools`, `prompts`, `resources`, `enabled`, `notes`, `signIn` (`status` signed-out/signing-in/signed-in, `problem`; null for a server that signs in no way; never a token)), `importable` (Claude Code's servers not in dawg yet) |
| `mcp.restart` *added* | Stops a server and starts it again; one no session uses is started to check it | `projectDir`, `name` | `server: McpServerInfo`. `InvalidParams` for a name not defined |
| `mcp.setEnabled` *added* | The person's switch for one server, kept in dawg's data folder; off stops it | `projectDir`, `name`, `enabled` | `enabled` |
| `mcp.importPreview` *added* | What importing Claude Code's servers (`~/.claude.json`) into `~/.dawg/mcp.json` would copy, secrets named but not shown | `{}` | `McpImportPlan`: `from`, `to`, `hash` (null when nothing to copy), `items` (`name`, `project`, `transport`, `target`, `secrets`, `action` copy/skip, `reason`) |
| `mcp.import` *added* | Copies the plan the person saw | `hash` | `imported`, `path`. `InvalidState` when Claude Code's file changed since |
| `mcp.session` *added* | What a session's connected servers offer the composer now | `sessionId` | `resources: McpResourceInfo[]` (`server`, `uri`, `name`, `description`, `mimeType`, `mention`), `prompts: CommandInfo[]` (`/mcp__server__prompt`) |
| `mcp.signIn` *added* | Starts signing in to a remote server with OAuth: the engine listens on 127.0.0.1 for the browser's return and finishes in the background (`mcp.list` follows it to connected). `InvalidState` for a server that cannot sign in, and for a client that answers nothing (a `-p` run) | `projectDir`, `name`, `sessionId?` | `url`: the authorization page for the client to open |
| `mcp.signOut` *added* | Forgets a server's tokens and dawg's registration with it | `projectDir`, `name`, `sessionId?` | `server: McpServerInfo` |
| `mcp.cancelSignIn` *added* | Stops a sign-in on its way | `projectDir`, `name`, `sessionId?` | `server: McpServerInfo` |
| `permission.respond` | Answer a permission request | `sessionId`, `requestId`, `response` (`allow {scope: once/always, rules?}` or `deny {message?}`) | `{}` |
| `question.respond` | Answer an ask-the-user question | `sessionId`, `requestId`, `response` (`answered {answers: QuestionAnswer[]}` or `dismissed {message?}`) | `{}` |
| `plan.respond` | Approve or reject a proposed plan | `sessionId`, `requestId`, `response` (`approve {mode?}` or `reject {message?}`) | `{}` |
| `elicitation.respond` *added* | Answer an MCP server's request for input (`elicitation.ts`) | `sessionId`, `requestId`, `action` (accept/decline/cancel), `content?` (with accept in form mode: the answers by field name) | `{}`. `InvalidParams` when the content does not fit the fields (`elicitationIssues` says why; the request stays pending) |

`SessionSnapshot` is `session: SessionSummary`, `modelInfo`, `additionalDirectories`, `tasks`,
`usage` (null before the first request), `pending` (unanswered permission/question/plan/elicitation requests,
oldest first), `activeTurnId`, `commands` (`{name, description, argumentHint, source?, kind?}`
for the `/` menu: `source` is builtin, user or project, `kind` command or skill; missing means a
built-in command; the session's own skills and custom commands are in it), and `background` (the
session's background commands, oldest first). A turn a skill or custom command started has
`turn.started.command` set, and its `prompt` is the command as typed; the model was sent its
expansion.

A subagent is a child session: `session.replay` with its `sessionId` returns its events
(read-only: it is never opened on a connection, no live events are pushed for it, and
`session.list` leaves it out). Its permission prompts are raised in the parent session with
`PermissionRequest.agent` (`SubagentLabel`: `agentId`, `sessionId`, `agentType`,
`description`) set; their `toolCallId` is a call in the agent's session and their `turnId` may be
one of its turns. When a background agent ends while its parent is idle, the engine starts a
parent turn whose prompt begins "Background agent".

`SessionSummary` is `id`, `title` (null until generated), `cwd`, `projectDir`, `createdAt`,
`lastActivityAt`, `status`, `queuePosition` (see `session.status`), `mode`, `model`, `effort`,
`archived`, `forkedFrom {sessionId, point}` or null, and `lastSeq`. A session not open anywhere
reports `idle`, `error` if its last turn failed, or `waiting` if it stopped while its turn waited
on the person: resuming it brings that turn back with its requests in `pending`, and answering
one carries the turn on.

`Usage` is `contextWindow`, `contextUsed`, `last` (the latest request's token counts and speeds),
`totals`, `compactAt` (the context size above which the engine compacts on its own before a turn,
or null when it never does) and `breakdown` (`systemPrompt`, `instructions`, `tools`, `messages`:
an estimated split that adds up to `contextUsed`).

### Semantics

- **Nothing long holds a request open.** `session.prompt` resolves as soon as the turn is accepted,
  with its `turnId`; the turn's progress and end arrive as events. A command that runs the model
  (`/init`, `/compact`) likewise returns a `turnId` or lets `compaction.*` events report.
- **One turn at a time.** `session.prompt` while a turn runs (including while it waits on the
  person) fails with `SessionBusy`. Clients queue follow-up messages themselves.
- **Do not rely on the order of a response and the events it causes.** Match them by `turnId`.
- `permission.respond`, `question.respond`, `plan.respond` and `elicitation.respond` fail with `RequestNotFound` when the
  request is unknown or already resolved (another window answered, or the turn ended).
- Session methods other than create, resume, fork, list, rename, archive, delete and replay need
  the session open on this connection, otherwise `InvalidState`. An unknown id is
  `SessionNotFound`.
- Rename, archive and delete work on stored sessions whether or not they are open.
- `session.delete` interrupts a running turn or compaction first, then closes the session on every
  connection (each gets `session.deleted`) and removes its files. Forks of it keep working. A
  session another process has open (a `dawg` run in a terminal) is `InvalidState`.
- A client that set a capability to false never receives that kind of request: the engine
  resolves it itself (a permission request is denied unless a rule allows it).

## Events

Every payload carries `sessionId`, `seq` and `time`. Names marked *added* are not in the spec's
table; each exists because a client cannot otherwise rebuild the view from events alone.

| Event | Purpose | Fields |
| --- | --- | --- |
| `session.status` | Idle, working, waiting on the person, or error | `status`, `waitingOn` (permission/question/plan/elicitation or null), `message` (short sidebar line or null), `queuePosition` (while the turn waits for a model busy with other sessions: 1 = next; else null) |
| `session.deleted` *added* | The session was deleted. Without it, another window showing the session would not learn it is gone. | none beyond the common fields |
| `session.updated` *added* | The session's settings, sent whole when one changes (title generated, mode switched by a tool or `/mode`, model, effort, archive, `/add-dir`). Without it a client never learns of changes the engine makes itself. | `title`, `mode`, `model`, `modelInfo`, `effort`, `archived`, `additionalDirectories`, `changed: string[]` |
| `turn.started` *added* | A turn began. Carries the person's message, which no other event does. | `turnId`, `prompt`, `command {name, args}` or null |
| `turn.finished` *added* | A turn ended, and why. The last event of the turn. | `turnId`, `stopReason` (completed, turn_limit, interrupted, error), `finalText`, `error`, `durationMs` |
| `message.started` | An assistant reply began | `turnId`, `messageId` |
| `message.delta` | Text to append to the reply | `turnId`, `messageId`, `text` |
| `message.finished` | The reply in full | `turnId`, `messageId`, `text`, `reasoning` (or null), `toolCalls: {toolCallId, toolName}[]` |
| `reasoning.delta` | Reasoning text to append | `turnId`, `messageId`, `text` |
| `tool.started` | A tool call, with its parsed arguments | `turnId`, `messageId`, `toolCallId`, `toolName`, `input` |
| `tool.progress` | Live output or a status line | `turnId`, `toolCallId`, `progress` (`output {stream, text}` or `status {message}`) |
| `tool.finished` | The call's result | `turnId`, `toolCallId`, `toolName`, `outcome` (success, error, denied, invalid, interrupted), `content` (what the model was given), `display` (`ToolDisplay`: diff, file, command, search, web-fetch, web-search, mcp) or null, `durationMs`. A command's display carries `output` (what it printed, plain text) and `notes` (the sentences added for the model after it, without the exit code), so a client never has to take the model's text apart. |
| `permission.requested` | A tool call needs permission | `turnId`, `request: PermissionRequest` (requestId, toolCallId, toolName, input, title, reason, suggestions, display?) |
| `question.asked` | The model asks the person questions | `turnId`, `requestId`, `toolCallId`, `questions: Question[]` |
| `plan.proposed` | A plan awaits approval | `turnId`, `requestId`, `toolCallId`, `plan` (Markdown), `planPath`, `modeBeforePlan` (the mode approving returns to unless the answer names one) |
| `elicitation.requested` *added* | An MCP server asked the person for input while one of the session's calls to it was in progress (`elicitation.ts`) | `turnId`, `requestId`, `toolCallId` (the call, or null when several of the session's calls were open), `server`, `message` (untrusted: show as plain text), `mode` (form/url), `fields: ElicitationField[]` (the form: string with format and length limits, number/integer with minimum and maximum, boolean, select, multiselect, each with `title`, `description`, `required`, `default`; empty in URL mode), `url` (URL mode: open only when the person asks), `agent?` (`SubagentLabel`, when a subagent's call caused it: raised in the parent, as its permission requests are) |
| `request.resolved` *added* | A pending request is no longer pending. Needed so every client (and a replay) can close the card, including when the turn ended without an answer. | `kind` (permission/question/plan/elicitation), `turnId`, `requestId`, `outcome` (answered/cancelled), `response` (the answer, or null; for an elicitation `{action, content}`) |
| `tasks.updated` | The whole task list | `tasks: TaskItem[]` |
| `hook.ran` *added* | One hook handler ran, for the transcript | `turnId` (null at session start and end, and for a refused prompt), `toolCallId` (PreToolUse, PostToolUse), `hook` (`event`, `matcher`, `type`, `command`, `source`), `outcome` (success, blocked, error, timeout), `exitCode`, `durationMs`, `decision` (allow, deny, ask, block, or null), `message` |
| `hook.skipped` *added* | Hooks were held back because they wait for consent; once per session for each state of the definitions | `turnId`, `projectDir`, `sources: CompatSource[]` |
| `background.updated` *added* | A background command started, ended or was stopped. Without it a client never learns that a command the model left running has finished. | `task: BackgroundTask` (`taskId`, `command`, `description`, `cwd`, `status` running/completed/failed/stopped, `exitCode`, `signal`, `stopReason`, `startedAt`, `endedAt`, `outputBytes`) |
| `subagent.updated` *added* | A subagent of this session was started, queued, moved on or ended (`subagents.ts`). Sent whole on the parent, stored; the latest per `agentId` is its state | `agent: SubagentInfo` (`agentId`, `sessionId` of its own session, `agentType`, `description`, `toolCallId` and `turnId` of the parent call that started its current task, `fork`, `background`, `status` queued/running/completed/failed/stopped, `queuePosition`, `worktree`, `startedAt`, `endedAt`, `toolUses`, `activity`, `result`, `error`) |
| `usage.updated` | Context and token counts | `usage: Usage` |
| `prompt.progress` | How much of the prompt the model has read | `turnId`, `total`, `cached`, `processed` |
| `compaction.started` | Context is being summarised | `compactionId`, `trigger` (auto/manual), `turnId` or null, `contextUsed`, `contextWindow`, `focus` |
| `compaction.finished` | Summarising ended | `compactionId`, `outcome` (completed/failed/interrupted), `summary`, `contextBefore`, `contextAfter`, `error` |
| `error` | A typed, user-presentable error | `turnId` or null, `error: {kind, message, detail, retryable}` |

## Ordering guarantees

Within one session:

1. `seq` starts at 1 and grows by exactly one per event emitted, across resumes; it is never
   reused. Live events arrive in `seq` order.
2. Turns do not overlap. `session.status` "working" precedes `turn.started`; `turn.finished` is the
   last event carrying that `turnId`; `session.status` "idle" or "error" follows it.
3. For one message: `message.started`, then any `reasoning.delta` and `message.delta`, then
   `message.finished`. Messages within a turn do not interleave.
4. A message's `tool.started` events follow its `message.finished`, in the order of its
   `toolCalls`. For one call: `tool.started`, then any `tool.progress`, then exactly one
   `tool.finished`. Every started call finishes before `turn.finished`, also on interrupt or error
   (outcome "interrupted"). Read-only calls may run concurrently, so events of different calls
   may interleave.
5. `permission.requested`, `question.asked`, `plan.proposed` and `elicitation.requested` are each followed by exactly one
   `request.resolved` with the same `requestId`, before `turn.finished`. While any request is
   pending, the session's status is "waiting".
6. `compaction.started` is followed by `compaction.finished` with the same `compactionId`, with no
   message or tool events between them.
7. The `finished` events carry whole facts: `message.finished.text` replaces the deltas, and
   `turn.started`, `tool.finished`, `tasks.updated`, `usage.updated` and `session.updated` are
   complete on their own.
8. `session.deleted` is the session's last event. A running turn is interrupted before it, so its
   `turn.finished` (stop reason "interrupted") comes first.

### Replay and reconnecting

`session.replay` returns stored events with `seq > afterSeq`, ascending, with their original
`seq`. The engine may leave out deltas of finished messages and progress of finished tools, so a
replay can have gaps in `seq`; rule 7 makes that safe. To catch up without losing or doubling
events:

1. Keep a per-session high-water `seq`.
2. While a replay is outstanding, buffer live events for that session.
3. Apply the replay, then the buffered events with `seq > lastSeq`, then go live.
4. Ignore any event whose `seq` is not above the high-water mark.

## Errors

| Code | Name | Meaning |
| --- | --- | --- |
| -32700 | `ParseError` | A frame was not valid JSON (answered with `id: null`) |
| -32600 | `InvalidRequest` | Not a valid JSON-RPC message, a batch, or an oversized line |
| -32601 | `MethodNotFound` | Unknown or unimplemented method |
| -32602 | `InvalidParams` | Params failed the schema; `data.issues: {path, message}[]` |
| -32603 | `InternalError` | A handler threw, or returned a result that failed its schema |
| -32001 | `SessionNotFound` | No stored session has that id |
| -32002 | `SessionBusy` | A turn is running |
| -32003 | `InvalidState` | Not allowed now (session not open here, already initialized, mode refused) |
| -32004 | `UnsupportedProtocolVersion` | See Versioning |
| -32005 | `NotInitialized` | `initialize` has not succeeded yet |
| -32006 | `RequestNotFound` | Permission/question/plan request unknown or already resolved |
| -32007 | `RequestCancelled` | The client cancelled the request |
| -32050 | `RequestTimeout` | Client-side only: no answer in time |
| -32051 | `ConnectionClosed` | Client-side only: the transport closed first |

The client rejects with `RpcError` (`code`, `message`, `data`) in every case. Handlers throw
`RpcError` to choose the code; anything else becomes `InternalError`.

## Transports

All share one interface: `send`, `onMessage`, `onError`, `onClose`, `close`, `closed`. Messages
received before the first listener is added are held for it.

- `createNdjsonTransport({ input, output, maxLineLength? })`: one JSON message per line over Node
  streams (stdio). Handles split lines, several lines per chunk, split UTF-8 characters, CRLF and
  blank lines. Invalid JSON and lines over `maxLineLength` (default 64 Mi characters) are reported
  through `onError` and skipped; the server answers them with `ParseError` / `InvalidRequest`.
  Input end or an I/O error closes it.
- `createMemoryTransportPair()`: two linked ends for tests. Delivery is asynchronous and passes
  through JSON, so non-JSON payloads fail here as they would on stdio.
- `createMessagePortTransport(port)`: any `MessagePortLike` (DOM `MessagePort`, Electron's
  `MessagePortMain`, Node's `worker_threads` port). Posts plain objects; also accepts JSON strings.

## Peers

- `createClient(transport, { timeoutMs?, validateParams?, onProblem? })`: typed
  `request(method, params, { timeoutMs?, signal? })` (default timeout 30 s, 0 for none),
  `initialize()`, `on(event, listener)`, `onEvent(listener)`, `close()`. Results are validated;
  invalid events are dropped and reported through `onProblem`; unknown events are ignored. Pending
  requests reject with `ConnectionClosed` when the transport closes.
- `createServer(transport, handlers, { validateOutgoing?, requireInitialize?, supportedVersions?, onProblem? })`:
  validates params, enforces the `initialize` gate, dispatches to `handlers[method](params, { id, signal })`,
  validates results and `notify(event, payload)` payloads unless `NODE_ENV` is "production", and
  maps thrown errors to JSON-RPC errors.

## Registries and types

- `methods` and `events`: runtime registries of the schemas, keyed by name. `METHOD_NAMES`,
  `EVENT_NAMES`, `isMethodName`, `isEventName`, `parseEvent`.
- `MethodMap` (`{ params, result }` per method, as a client sees them), `MethodParams<M>`,
  `MethodResult<M>`, and for servers `ParsedParams<M>` and `ResultInput<M>`.
- `EventMap` / `EventPayload<E>` (as received) and `EventInputMap` / `EventPayloadInput<E>` (as
  sent). `EngineEvent` is the `{ event, payload }` union a reducer switches on.
