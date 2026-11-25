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

`PROTOCOL_VERSION` (currently 1) names one wire format. Additive changes keep it: new methods, new
events, new optional params, new result or event fields. Anything else bumps it, including adding
a value to an enum the engine sends (except `ErrorInfo.kind`, where unknown kinds arrive as
`"other"`).

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
| `initialize` | Exchange versions and capabilities | `protocolVersion`, `client {name, version}`, `capabilities {permissionPrompts, questions, planApproval}` (each defaults to true) | `protocolVersion`, `engine {name, version}`, `capabilities {methods[], events[], maxMessageLength}` |
| `session.create` | Open a new session in a directory | `cwd`, `projectDir?` (when `cwd` is a worktree), `title?`, `mode?`, `model?`, `effort?`, `additionalDirectories?` | `SessionSnapshot` |
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
| `permission.respond` | Answer a permission request | `sessionId`, `requestId`, `response` (`allow {scope: once/always, rules?}` or `deny {message?}`) | `{}` |
| `question.respond` | Answer an ask-the-user question | `sessionId`, `requestId`, `response` (`answered {answers: QuestionAnswer[]}` or `dismissed {message?}`) | `{}` |
| `plan.respond` | Approve or reject a proposed plan | `sessionId`, `requestId`, `response` (`approve {mode?}` or `reject {message?}`) | `{}` |

`SessionSnapshot` is `session: SessionSummary`, `modelInfo`, `additionalDirectories`, `tasks`,
`usage` (null before the first request), `pending` (unanswered permission/question/plan requests,
oldest first), `activeTurnId`, and `commands` (`{name, description, argumentHint}` for the `/`
menu).

`SessionSummary` is `id`, `title` (null until generated), `cwd`, `projectDir`, `createdAt`,
`lastActivityAt`, `status`, `queuePosition` (see `session.status`), `mode`, `model`, `effort`,
`archived`, `forkedFrom {sessionId, point}` or null, and `lastSeq`. A session not open anywhere
reports `idle`, or `error` if its last turn failed.

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
- `permission.respond`, `question.respond` and `plan.respond` fail with `RequestNotFound` when the
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
| `session.status` | Idle, working, waiting on the person, or error | `status`, `waitingOn` (permission/question/plan or null), `message` (short sidebar line or null), `queuePosition` (while the turn waits for a model busy with other sessions: 1 = next; else null) |
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
| `tool.finished` | The call's result | `turnId`, `toolCallId`, `toolName`, `outcome` (success, error, denied, invalid, interrupted), `content` (what the model was given), `display` (`ToolDisplay`: diff, file, command, search) or null, `durationMs`. A command's display carries `output` (what it printed, plain text) and `notes` (the sentences added for the model after it, without the exit code), so a client never has to take the model's text apart. |
| `permission.requested` | A tool call needs permission | `turnId`, `request: PermissionRequest` (requestId, toolCallId, toolName, input, title, reason, suggestions, display?) |
| `question.asked` | The model asks the person questions | `turnId`, `requestId`, `toolCallId`, `questions: Question[]` |
| `plan.proposed` | A plan awaits approval | `turnId`, `requestId`, `toolCallId`, `plan` (Markdown), `planPath`, `modeBeforePlan` (the mode approving returns to unless the answer names one) |
| `request.resolved` *added* | A pending request is no longer pending. Needed so every client (and a replay) can close the card, including when the turn ended without an answer. | `kind` (permission/question/plan), `turnId`, `requestId`, `outcome` (answered/cancelled), `response` (the answer, or null) |
| `tasks.updated` | The whole task list | `tasks: TaskItem[]` |
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
5. `permission.requested`, `question.asked` and `plan.proposed` are each followed by exactly one
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
