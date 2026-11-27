# Session runtime

The engine and the per-session runtime: what turns the building blocks (model client, tool-call
pipeline, permission engine, session store, tools, prompt assembler, compactor) into a working
coding agent. A protocol server and the command-line tool both sit on this API; it speaks the
protocol's shapes (`SessionSnapshot`, `SessionSummary`, events) so the server is a thin mapping.
Spec: `docs/specs/phase-2-engine-core.md`. The turn loop and the tool executor it drives live in
`../loop/`; the interactive tools in `../tools/interactive/`.

```ts
// Exported from src/runtime/index.ts. The package index (src/index.ts) does not re-export it
// yet; until it does, import it by path.
import { createEngine } from "./runtime/index.ts";

// One pool object per server, handed to every session: they share its slots.
const pool = { slots: [0] };
const titles = { slots: [1] };
const engine = createEngine({
  storeRoot: "~/.dawg",                    // absolute in practice
  homeDir: os.homedir(),
  models: { connect: async (modelId) => ({ client, pool, utility: { client, pool: titles } }) },
  capabilities: { permissionPrompts: false }, // headless: asks become denials
});
const session = await engine.createSession({ cwd: "/path/to/project" });
const stop = session.subscribe((event) => send(event.event, event.payload));
const outcome = await session.run({ content: [{ type: "text", text: "Fix the failing test" }] });
await engine.close();
```

## Engine

`new Engine(options)` takes every dependency by injection; `createEngine(options)` is the same
with the real prompt assembler, compactor and token estimator, and the default model profile,
filled in.

| Option | Meaning |
| --- | --- |
| `storeRoot` | Data root (`~/.dawg`); sessions under `projects/`, plan files under `plans/` |
| `homeDir` | User settings, `~/.claude/CLAUDE.md`, `~` in rules |
| `models` | `{ connect(modelId \| null) => ModelConnection }`: `{ client, pool?, slot?, utility?: { client, pool?, slot? } }`. `pool` is the server's conversation slots (see "Sharing the model"); `slot` a fixed slot, ignored with a pool. `utility` is where titles go; give it a pool (or slot) of its own on the bundled runtime |
| `assembler`, `compactor`, `estimator` | The `PromptAssembler`, `Compactor`, `TokenEstimator` contracts |
| `profile` | A `ModelProfile`, or `(endpoint) => ModelProfile` |
| `permissions?` | A `PermissionEngine`; default `createPermissionEngine()` |
| `tools?` | Fixed order; default `[...CORE_TOOLS, ...INTERACTIVE_TOOLS, ...WEB_TOOLS]`. A tool with `offered(services)` is listed only in sessions opened while it answers true (WebSearch: while a search service is set); a session's list never changes after it opens |
| `webSearch?` | `() => SearchProvider \| null`: the search service WebSearch uses, read when a session opens and on every search (default none). WebFetch's prompt goes to the session's `utility` model (`ToolContext.utility`), see `tools/web-fetch/web-fetch.ts` |
| `toolLimits?`, `limits?` | `ToolLimits`; `RuntimeLimits` (turn limit 200 requests, result spill at 100,000 characters, retries, repeat thresholds 3 and 5, compaction file copies, mention size) |
| `capabilities?` | `{ permissionPrompts, questions, planApproval }`, each default true; a session may override |
| `checkpointRetention?` | How many of a session's latest checkpoints keep their files (default 100); see "Checkpoints and rewind" |
| `autoMemory?` | Auto memory (default false; the app and the CLI turn it on); see "Memory" |
| `trust?` | `CodeTrust`: consent for the code a setup supplies (`../trust/`). Default `NO_CODE_TRUST`, under which only the person's own `~/.dawg` hooks run; the app and the CLI pass `createTrustStore({ storeRoot, homeDir })` |
| `settingsFlags?` | Command-line settings (`--allowedTools`, `--permission-mode`, `--add-dir`) |
| `externalImports?` | Instruction-file imports from outside the project; default "block" |
| `ripgrepPath?`, `generateTitles?` (default true), `durability?` (default "batched") | |
| `clock?`, `newId?(kind)`, `environment?` | For tests: time, ids (`message`, `request`, `call`, `compaction`), session-context facts |

| Method | Protocol method | Notes |
| --- | --- | --- |
| `createSession(NewSessionOptions)`: `{ cwd, projectDir?, title?, mode?, model?, effort?, additionalDirectories?, capabilities? }` | `session.create` | Loads settings and instruction files, gathers the environment (git with read-only commands), builds the prefix, writes the session-context message. `projectDir` (default `cwd`) is the project a worktree session belongs to: see "Worktree sessions and personal settings" |
| `resumeSession(id, { capabilities? })` | `session.resume` | Returns the open runtime if there is one |
| `forkSession(id, { point?, title?, cwd?, capabilities? })` | `session.fork` | `point`: end (default; stops before a running turn), `beforeTurn`, `afterTurn`. Title defaults to the parent's plus " (fork)". A different `cwd` is refused |
| `listSessions({ projectDir?, query?, includeArchived?, limit?, cursor? })` | `session.list` | `{ sessions: SessionSummary[], nextCursor }`, newest activity first |
| `renameSession(id, title)`, `archiveSession(id, archived?)` | `session.rename`, `session.archive` | Open or not |
| `deleteSession(id)` | `session.delete` | Open or not. An open session's running turn or compaction is interrupted, then `session.deleted` goes out as its last event (never stored) and it closes. Removes the transcript, the session folder and its plan files; while forks exist, its `tool-results/` stay for them, and go with the last fork. `InvalidState` while another process has it open. While it runs, resuming, forking, renaming, archiving or deleting the session is `InvalidState` "This session is being deleted."; a delete that fails leaves the session as it was |
| `replay(id, afterSeq, limit?)` | `session.replay` | Open or not; `{ events, lastSeq, hasMore }` |
| `clearSession(id)` | `/clear` | Closes the session and opens a new one with the same mode, model, effort and directories |
| `get(id)`, `openSessions()` | | Open runtimes |
| `subscribe(listener)` | | Events of every open session |
| `close()` | | Closes every open session |

## SessionRuntime

| Member | Protocol | Notes |
| --- | --- | --- |
| `prompt(PromptInput) => Promise<{ turnId }>` | `session.prompt` | Resolves once the prompt is in the transcript; the turn runs on. `SessionBusy` while a turn or compaction runs |
| `run(PromptInput) => Promise<TurnOutcome>` | | `prompt` then `waitForIdle` |
| `waitForIdle() => Promise<TurnOutcome \| null>` | | `{ turnId, stopReason, finalText, error, usage, durationMs }` of the latest turn |
| `interrupt() => boolean` | `session.interrupt` | Turn or compaction; false when nothing ran |
| `setMode(mode)` | `session.setMode` | `InvalidState` when bypass is disabled by settings |
| `setModel(model)` | `session.setModel` | Not during a turn; resets an effort the new model lacks |
| `setEffort(effort \| null)` | `session.setEffort` | Must be one of the model's levels |
| `respondPermission(requestId, PermissionResponse)` | `permission.respond` | `RequestNotFound` when unknown or already resolved |
| `respondQuestion(requestId, QuestionResponse)` | `question.respond` | |
| `respondPlan(requestId, PlanResponse)` | `plan.respond` | |
| `addDirectory(path)` | `/add-dir` | |
| `rename(title)`, `setArchived(archived)` | | |
| `compact(focus?) => Promise<CompactionOutcome>` | `/compact` | Not during a turn |
| `checkpoints()` | `session.checkpoints` | One per prompt, oldest first, with the files and what a restore would do |
| `restoreFiles(checkpointId, overwrite)`, `summarizeFrom(checkpointId, focus)` | `session.rewind` | Not during a turn; `rewindSession(engine, runtime, input)` (`rewind.ts`) adds the fork |
| `memory` | `/memory` | MEMORY.md as the session opened (`MemoryIndex`), or null when auto memory is off |
| `contextUsage()` | `/context` | `{ contextWindow, contextUsed, measured, compactAt, breakdown }`: after a request the same numbers as `usage`, before one an estimate |
| `background() => BackgroundTask[]` | snapshot `background` | The session's background commands, oldest first; see "Background commands" |
| `readBackgroundOutput(taskId, offset, limit)` | `background.output` | `{ text, nextOffset, totalBytes, done }` |
| `stopBackground(taskId) => Promise<boolean>` | `background.stop` | Resolves once the command has ended; false when it had ended already |
| `snapshot() => SessionSnapshot` | create/resume/fork result | `commands` is left empty for the command registry |
| `summary() => SessionSummary` | | |
| `subscribe(listener)`, `eventsAfter(afterSeq, limit?)`, `lastSeq` | events, `session.replay` | |
| `setCapabilities(partial)` | `initialize` | When a different client attaches |
| `close()` | | Interrupts a running turn, stops background commands, flushes and releases the transcript |
| `id`, `cwd`, `projectDir`, `mode`, `status`, `busy`, `closed`, `activeTurnId`, `modelSetting`, `effort`, `additionalDirectories`, `tasks`, `view`, `prefix`, `requestMessages()`, `modelInfo()`, `pending()`, `backgroundTasks()`, `capabilities` | | Read-only views |

Errors are `RuntimeError` with `code` `SessionNotFound`, `SessionBusy`, `InvalidState`,
`RequestNotFound` or `InvalidParams` (an unknown background task), named after the protocol
errors they map to.

## Events and their numbers

Events are the protocol's, in the protocol's order (README of `@dawg/protocol`). Every payload
carries `sessionId`, `seq` and `time`; `seq` starts at 1 and grows by one per event across
resumes.

They are stored in `<session dir>/events.jsonl` (beside `tool-results/`), one line per event,
written synchronously as each is emitted, so the file is in `seq` order and survives the process
being killed. Streaming events (`message.delta`, `reasoning.delta`, `tool.progress`,
`prompt.progress`) are not written: the `*.finished` events carry the whole facts, and the
protocol lets a replay leave them out. While a message or tool is still running, its streaming
events are kept in memory and replayed; once it finishes they are dropped.

So that numbers given to unwritten streaming events are never handed out again after a crash,
the log reserves numbers in blocks of 256 (`{"reserve": n}`) and marks a clean close
(`{"closed": lastSeq}`). Reopening continues right after a clean close, so a client never sees a
gap across an ordinary restart; after a crash it continues above every number that could have
been used, leaving a gap, which replays allow.

On reopening, anything the crash left open (a turn, a message, a tool call, a request, a
compaction, a background command) is closed with the events a client expects
(`request.resolved` cancelled, `tool.finished` interrupted, `turn.finished` interrupted,
`background.updated` stopped with reason `session_end`, `session.status` idle).

The exception is a turn that was only waiting on the person (`waiting-turn.ts`): its requests
are open, no reply was streaming, and its reply's remaining calls have no results yet. Closing a
session in that state (the app quitting) lets the turn go without ending it, and reopening it,
after a close or a crash, brings it back as it was: the session is busy with that turn and
waiting, the same requests are in `pending()` and the snapshot, and no event is sent. The first
answer carries the turn on: the remaining calls run (each announced once; a permission answer
stands whatever the rules say by then), then the loop goes on. Interrupting it first ends it as
an interrupted turn, with its requests cancelled. Clients that cannot answer that kind of request
get the old behaviour. While it waits closed, `runtime.json` says `waitingOn`, so a listing
reports the session `waiting`. A session with
no event log (a fork, or a transcript written by another tool) gets events rebuilt from its
transcript, numbered from 1. `<session dir>/runtime.json` caches mode, model, effort, last `seq`,
whether the last turn failed and what a turn waits on, so listing never replays transcripts.

## Background commands

Bash with `run_in_background` starts a command in the session's registry
(`../tools/bash/background.ts`), which lives in memory for one run of the session. The runtime
turns it into events: `background.updated` with the whole task (`BackgroundTask`) when a command
starts, and again when it ends, whether it exited, was stopped (by `background.stop`, the model's
TaskStop, a time or output limit) or went with the session on close. The events are stored like
other non-streaming events, so a replay rebuilds the list; the latest event for a `taskId` is its
state.

- `background()` (the snapshot's `background`) lists this run's commands, a running one with its
  output so far, and those of earlier runs, rebuilt from the stored events. Those have all ended:
  closing a session stops its commands. Oldest first.
- Task ids (`bash-<n>`) continue across resumes and forks, after the highest id the stored events
  name, so the model and clients never see one id used for two commands.
- `readBackgroundOutput(taskId, offset, limit)` reads the command's output file: at most `limit`
  bytes from byte `offset`, as plain text (control sequences were removed as it was written),
  never splitting a UTF-8 character. A page ends before a character cut off at the limit, an
  offset inside a character moves on to the next one, and a page holds at least one whole
  character, so paging by `nextOffset` always moves on. `totalBytes` is the file's size; `done`
  is true once the command has ended and the page reaches the end. Commands of earlier runs are
  read from the output file the Bash call's result named.
- `stopBackground(taskId)` stops the command and everything it started, as TaskStop does (reason
  `requested`), and resolves once it has ended. False when it had ended already. The model hears
  of it through the usual note at the next safe point.
- An unknown task id is `InvalidParams`.

## Turns, history and persistence

- A turn is named after the sequence number of its prompt record: `turn-<seq>`. That keeps ids
  stable across resume and fork, and lets a fork point name a turn without an index.
- Every message enters the transcript as it enters history: the prompt, each reply, each result
  (in call order, as soon as all earlier results are in), each note, each state change. A crash
  loses nothing that was complete. On reopening, calls left without results get "interrupted"
  results and an `interrupted` note, so history is valid for chat templates.
- The prefix (system message and tool schemas) is built from the tools and instruction files at
  start and again only after compaction. It is not stored; resuming rebuilds the same bytes from
  the same files, so the next request after a resume is the one the original would have sent.
- Later facts reach the model as notes (`PromptAssembler.note`) appended at safe points: at the
  start of a turn (before the prompt) and after a batch's results are all in, never between a
  call and its result. Mode changes, date changes, plan approval, finished background commands,
  added directories, instruction files for newly touched directories, repetition and cut-off
  replies. What the model was last told (mode, date) is read back from the view by matching the
  assembler's rendering of each possible note, so a live session and a resumed one agree.
- Prompts go through `PromptAssembler.prompt` and every tool result's text through
  `PromptAssembler.quote` before it is stored, so nothing from outside can pass for a note.
- Requests carry the profile's sampling, `maxOutputTokens`, effort (when the model has levels),
  parallel calls (when profile and template allow), the slot, and `chat_template_kwargs` from the
  profile; the compactor gets the same settings.

## Permissions and the person

Each call's subject goes to the permission engine with the session's live mode and rules. An ask
emits `permission.requested`, sets the status to `waiting`, and waits; an interrupt cancels it.
"Allow always" saves the rules (the response's, else the suggestions) to
`.dawg/settings.local.json` through `addPermissionRules` and adds them to the running session at
once; if the file cannot be written the rule still applies for the session and an `error` event
says so. With `permissionPrompts` off, an ask is a denial. Questions and plans work the same way
through `SessionServices`; with `questions` or `planApproval` off the tool is told nobody can
answer. Approving a plan switches to the mode the answer names, else to the mode before plan mode,
and appends a `plan_approved` note; plans are also saved under `<storeRoot>/plans/`. The plan
request (`plan.proposed`, and `pending` in the snapshot) carries `modeBeforePlan`, the mode an
approval without a mode leads to: the mode before plan mode, or "default" when that was plan mode
itself or settings turn it off. It is read back from the transcript's state records on resume.

### Settings changes in an open session

At the start of each turn the session stats its settings files (`settings-reload.ts`) and loads
them again only when one appeared, went or changed (modification time, size or inode); the
engine stamps them just before the first load, so an edit made meanwhile is still seen. Live
from the next turn: the allow, ask and deny rules; `disableBypassPermissionsMode` (a session in
bypassPermissions mode drops to "default", is told so, and an `error` event says why); and `env`
for the turn's commands. "Allow always" rules follow the file they were saved to, so removing one
in the settings stops it; one that could not be saved holds for the rest of the session. Not
live: `additionalDirectories` (part of the session's state and of what the model was told; use
`addDirectory`) and `defaultMode` (it only picks a new session's mode). If a file that was
readable no longer is (half-saved, not JSON), the session keeps the settings it had, says so once
with an `error` event, and tries again next turn.

### Worktree sessions and personal settings

A session created with a `projectDir` other than its `cwd` (a worktree of that project) belongs
to the project: it is the summary's `projectDir`, kept in the side folder's `runtime.json` across
resumes, and passed on to forks and `/clear`. Its personal settings (`.dawg/settings.local.json`
and `.claude/settings.local.json`) are the project's, and "Allow always" saves there, so a rule
outlives the worktree and applies to the project's other sessions from their next turn. The shared
files (`.dawg/settings.json`, `.claude/settings.json`) still come from `cwd`, since they are
committed and the branch may change them; the user's files are the same for every session. The
reload stamps exactly these files. Rules keep their meaning: a project-relative rule such as
`Edit(/src/**)` is read against the session's `cwd`, so it covers the worktree's own files.

## Sharing the model

With one local model, sessions running at once share it. llama-server keeps one prompt cache per
slot; two requests sent to one slot are served one at a time anyway and evict each other's cache,
but the engine would not know who waits. So the engine schedules slots itself
(`../model/slots.ts`):

- A provider that owns a server's slots (the bundled runtime) returns the same `pool` object,
  `{ slots: number[] }`, with every connection to that server. The engine keeps one
  `SlotScheduler` per pool object. Servers whose slots are not ours (Ollama, LM Studio, a remote
  API, a llama-server someone else runs) get no pool, and their requests go out at once.
- Every conversation request, turn or compaction, takes a slot before it is sent (`id_slot` is
  set to it) and gives it back when its stream ends: finished, failed, aborted, or abandoned. A
  session holds no slot while its tools run.
- First come, first served. A session gets the slot it used last when that one is free (its
  cache is there), else the free slot used longest ago.
- While a request waits, the session's status is "working" with the message "Waiting for the
  model" and `queuePosition` (1 = next), in `session.status` and in `summary()`. A new
  `session.status` goes out each time the position moves, and "Working" again once the request
  has its slot. An interrupt ends the wait at once; nothing is sent and no slot is held.
- Titles go through the scheduler of the `utility` pool, so two sessions' titles take turns on
  the title slot too; a session never shows as queued for one.
- A helper model (a tiny model in a server of its own) can take every side request instead:
  `sideClient({ routes, endpoint, onFallback })` (`model/side.ts`) is a `utility.client` with no
  pool that asks per request where to go, takes a slot on the helper's or the main model's side
  scheduler, and sends a request the helper does not start answering (unreachable, an error, or
  nothing within 60 s) to the main model instead. Its `endpoint` is the helper's while there is
  one, so WebFetch sizes the page to the helper's window and the helper's profile shapes the
  request. The app's engine host and the command line both use it.
- The owner of a lease is a string: the session's id, or a subagent's session id. A fork's
  first request prefers its parent's last slot (`SlotRequest.prefer`), where its start is cached.
- The parts: `SlotScheduler.acquire({ owner, signal?, onQueue? })` resolves with a lease
  `{ slot, release() }`; `scheduledClient(client, scheduler, { owner, onQueue? })` wraps a
  `ModelClient` so each `stream` takes and gives back a lease, and reports the place in line
  (null once the wait ends).

## Usage

`usage` (in the snapshot, `usage.updated` and a turn's outcome) is the protocol's `Usage`:
`contextUsed` is the endpoint's count at the last request (prompt and reply), or the estimated
size a compaction left. `compactAt` is the size above which the session compacts before a turn
(the profile's threshold of the window), null when the window is unknown. `breakdown` splits
`contextUsed` into `systemPrompt`, `instructions` (the instruction files rendered into the
prefix; ones added later as notes count as messages), `tools` and `messages`, each estimated
with the engine's token estimator and scaled to add up exactly to `contextUsed` (the remainder
goes to `messages`). `usage.updated` goes out after each request, after a compaction (which reads
the instruction files again and rebuilds the prefix) or a trim, and after a model switch. On
resume the figures are rebuilt from the transcript and split again. `/context` shows the same
numbers, through `contextUsage()`.

## Compaction

Before each request the next request's size is predicted (the last reported prompt size plus an
estimate of what was appended since, or an exact count when there is no report). Past the
profile's threshold, one oversized result is trimmed if that is enough, otherwise the compactor
runs (`compaction.started`/`finished`, a `compact` record, instruction files reloaded and the
prefix rebuilt). It is skipped while history is under a tenth of the window or has grown less
than that since the last compaction, and never runs while calls wait for results. A context
overflow from the model forces a compaction and one retry. `/compact` runs it between turns.

## Skills and custom commands

The session's skills and custom commands (`../skills/`, read by `@dawg/compat`) are loaded when it
opens: the person's (`~/.claude`, `~/.dawg`), then the project's from the repository root down to
`cwd` (`.dawg` over `.claude`). Their listing (name and description of each the agent may load,
sorted) is a segment of the static prefix, before the instruction files, and the `Skill` tool is
offered when there is at least one; both stay as they are for the whole session, so the cache
survives a skill added meanwhile (it appears in the next session). Folders inside the project add
their skills as a note once the agent reads or edits a file there.

- `prompt(input, options?)`: `options.command` shows the command as typed in `turn.started`;
  `options.invocation` grants the skill's `allowed-tools` (allow rules) and `disallowed-tools`
  (deny rules) until the person's next message, through `#permissionState`.
- The `Skill` tool renders a body (arguments, `${CLAUDE_*}` variables, `!` commands judged by the
  permission engine and never asking, `@` files when reading them needs no asking) and grants
  likewise. An identical reload answers "already loaded".
- Project code (a skill or command from the project's files with inline shell or
  `allowed-tools`, compat's `isProjectCode`) needs `ctx.trust.allows` (principle 3): until the
  project is approved its shell does not run (it answers with where to approve) and its grants
  do not apply. The person's own skills need no approval.
- After compaction the latest invocation of each skill is re-attached right after the summary,
  newest first within 5,000 tokens each and 25,000 in all (less on a small window); on reopening,
  what is in the view is found again (`SessionSkills.restore`).
- `runtime.skills` is what the host builds each session's command registry from
  (`sessionCommandRegistry`), so the snapshot's `commands` and `/name` include them.

## Hooks

Tier 1 events with `command` handlers (`../hooks/`, read by `@dawg/compat`), as the hooks
reference documents them: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart,
SessionEnd, Notification. Each handler that runs is reported with `hook.ran`.

- They come from every settings file and change with them: at the start of a turn, when the
  settings reload, the hooks are read again. `disableAllHooks` is read after precedence.
- Consent: a handler runs only when `ctx.trust.allows(source, projectDir)` and its definition is
  still the one on disk; held-back hooks get one `hook.skipped` per session for each state of the
  definitions. The person's switches (`CodeTrust.switches`) turn single hooks off.
- **PreToolUse** runs before the permission check (executor `preToolUse`): deny wins over
  everything; allow skips the prompt but not deny rules; ask forces a prompt showing the hook's
  reason; `updatedInput` replaces the input, is validated against the tool's schema, and is what
  the rules judge and the tool runs with. **PostToolUse** runs after a call that succeeded.
  Their context and feedback are notes at the next safe point.
- **UserPromptSubmit** runs in `prompt()` before anything is written: a block rejects with
  `InvalidState` "A UserPromptSubmit hook blocked this prompt: …" and the prompt never enters the
  transcript; context is a note right after the prompt.
- **Stop** runs when the model ends its turn (`onStop`): a block or added context keeps the turn
  going with a note; `stop_hook_active` is true once a Stop hook has done so this turn, and after
  8 continuations without a tool call the next block is overridden.
- **SessionStart** runs when the session opens (`startup`, `resume`, `clear`, `fork`) without
  holding `session.create` up, and after a compaction (`compact`); the first prompt waits for it,
  so its context goes in first. **SessionEnd** runs in `close()` (`clear` for `/clear`, else
  `other`), within its 1.5 s budget. **Notification** fires when a permission request is still
  waiting after `limits.permissionNotificationMs` (6 s), and when no prompt follows a turn
  within `limits.idleNotificationMs` (60 s).
- `continue: false` ends the turn at the next safe point, with the stop reason as a note.

## MCP servers

The session's MCP servers (`../mcp/`, configuration read by `@dawg/compat`): a session's own
(`NewSessionOptions.mcpServers`), the person's for this project (`~/.dawg/mcp.json` →
`projects`), the project's `.mcp.json`, then the person's for every project (`~/.dawg/mcp.json`);
Claude Code's `~/.claude.json` only through the import (`mcp.importPreview`, `mcp.import`,
`/mcp import`). `${VAR}` and `${VAR:-default}` expand from the environment and the settings' `env`.

- They start when the session opens (`SessionMcp.open`): a project's only with
  `ctx.trust.allows` (or the person's own `enableAllProjectMcpServers` / `enabledMcpjsonServers`),
  none that `disabledMcpjsonServers`, `deniedMcpServers`, `allowedMcpServers` or the person's
  switch keeps off. The engine's `McpManager` shares one connection between sessions of one folder
  with the same expanded definition, restarts a failed one with growing pauses
  (`MCP_RESTART_DELAYS_MS`), and stops one a few seconds after the last session lets go.
- Before the first request (`#settleMcp`, in `prompt()`, or when a turn brought back carries on)
  the session waits up to `MCP_START_WAIT_MS` for servers still starting, then decides its tool
  list once: the tools themselves (`mcp__server__tool`) when their schemas take less than
  `MCP_SCHEMA_SHARE` of the window, otherwise `ToolSearch` and `CallMcpTool` with a sorted
  listing in the prefix's MCP segment; either way the two fixed tools are added while some server
  was not ready, so one that connects later is reached by search. Server instructions go into the
  segment. The list never changes afterwards.
- `CallMcpTool` hands each call to the tool it names (`ToolDefinition.resolve`), so PreToolUse
  hooks, permission rules and the run see `mcp__server__tool` and its checked arguments; a call by
  an MCP tool's own name where only the dispatcher is offered goes through it (toolcall pipeline).
- Results over `MCP_RESULT_MAX_CHARS` (or `MAX_MCP_OUTPUT_TOKENS`) are saved to `tool-results/`
  and replaced by their start and the path. `@server:scheme://…` in a prompt attaches that
  resource; prompts are `/mcp__server__prompt` commands (the host adds them to the session's
  registry as servers connect).

## Subagents

The `Agent` and `SendMessage` tools and what they start (`../agents/`, spec: Phase 4,
"Subagents"); `EngineOptions.subagents` (default true) turns them off.

- **Definitions.** The built-ins Explore and Plan (read-only: no write tools, plan mode whatever
  the parent's mode, and a shell call that could change something is refused rather than asked)
  and general-purpose, then the agent files compat reads (`~/.claude`, `~/.dawg`, the project's
  `.claude` and `.dawg` from the repository root down; project over person, nearer over higher,
  `.dawg` over `.claude`). A file named like a built-in replaces it. The list is in the per
  session `Agent` tool's description and its `subagent_type` enum, fixed when the session opens.
  `fork` is a copy of the conversation.
- **A child session.** Each agent runs in an ordinary `SessionRuntime` given a `SubagentRole`:
  its transcript is `<session dir>/subagents/<id>-agent-<n>.jsonl` with its own side folder;
  `engine.replay` serves it (live or stored), listings never see it. A typed agent's prefix
  replaces the core instructions with `SUBAGENT_CORE` and its role (`PromptAssembler.prefix`'s
  `agent`), with its tool subset and no MCP tools; a fork keeps its parent's prefix and tools and
  starts from a copy of its view (every open call given a result), so it shares the cache. The
  child is closed after each task and reopened by `SendMessage`.
- **Permissions.** Calls are judged by the parent's rules, live, plus a file's `Tool(spec)`
  grants; the mode is the parent's unless the file sets one (`agentMode`: a parent in bypass,
  acceptEdits or plan keeps its mode). Project files' grants and a mode looser than the parent's
  need the project's code approved (they are in the trust hash). Prompts are raised in the parent
  with `PermissionRequest.agent`; "allow always" saves for the parent.
- **Scheduling.** `AgentSeats` per slot scheduler: as many seats as the pool's conversation
  slots. A main conversation holds one while its turn runs and lends it while it waits on its
  foreground agents; an agent waits for a seat (status queued, `queuePosition`). No pool, no
  limit.
- **Background.** The call returns at once; when the agent ends the parent gets a note, and an
  idle parent is woken with a turn whose prompt is "Background agent agent-N finished."
- **Hooks.** SubagentStart (its context goes into the agent's history) and SubagentStop (a block
  keeps the agent going, at most 8 times) fire from the parent's settings; in the child only
  PreToolUse and PostToolUse fire, with `agent_id` and `agent_type`.
- **Isolation.** `isolation: "worktree"`: the engine makes `<repo>/.dawg/worktrees/agent-…` on
  `dawg/agent-…` itself (the CLI has no worktree service, and headless runs have nobody to ask),
  and removes it with its branch after a task that left no changes.
- **Skills.** A `context: fork` skill loaded with the `Skill` tool runs as a subagent of its
  `agent` type; run by the person, the turn asks the model to start it.

## Checkpoints and rewind

`../checkpoints/` and `rewind.ts`; spec "Checkpoints and rewind".

- **A checkpoint per prompt.** `prompt()` opens one, named by the turn's id, as soon as the
  prompt is in the transcript. Just before a call that changes files runs, the executor tells the
  session (`ExecutorHost.fileChanges`) which files the tool's permission subject names (`edit`:
  Write and Edit today, and any later tool that reports one); the first time a checkpoint changes
  a file, its content is saved, or the fact that it did not exist. After the call, whatever its
  outcome, the file's new content is noted as a hash. Shell commands are not tracked.
- **Subagents.** An agent's file changes, foreground or background, go to the parent's
  checkpoint for the turn that started it (or sent it its latest task), marked with the agent
  (`SubagentRole.fileChanges`, through `AgentHost.fileChanges`), so rewinding the parent puts them
  back and the listing names the agent (`CheckpointFile.agents`). Restoring goes by when each
  file was first changed, not by checkpoint order, since a background agent can change files
  after later turns did. A rewind is refused (`InvalidState`) while an agent still works in the
  background: the person stops it or lets it finish first.
- **On disk**, beside the session's other side files: `<session dir>/file-history/checkpoints.jsonl`
  (append-only records: checkpoint, backup, state) and `file-history/blobs/<sha-256>` (each content
  stored once). So it survives quitting and resuming, and goes when the session is deleted.
  `checkpointRetention` (100) latest checkpoints keep their files; older ones are dropped with the
  contents nothing else uses. They stay listed (`tracked: false`) for rewinding the conversation.
- **Listing** (`session.checkpoints`) is built from the log's `turn.started` events, so every
  prompt of the conversation is a point, with its files from the file history.
- **Restoring files** puts each file changed from the checkpoint on (by that turn or a later one)
  back to its content at the first change at or after it, and deletes files made since. A file
  whose content is not what the file tools last left (the person, another program or a shell
  command changed it) stops the restore before anything changes, unless `overwrite`. Folders and
  files that are no longer regular files are skipped with a reason. The model is told at the next
  safe point which files changed under it.
- **Rewinding the conversation** forks the session `beforeTurn` the checkpoint's turn (titled
  "… (rewound)"); the client shows the fork in the original's place, the original is kept. A fork
  copies its parent's file history (contents hard-linked): checkpoints of turns it copied stay
  listed, the others come along hidden, never listed, but restoring to an earlier checkpoint still
  undoes them, since restoring goes by when changes happened, not by which conversation made them.
- **Summarising from a point** is a manual compaction with `from`: the summarising request sends
  the whole view (the cache holds) and asks about the part from that prompt on; the view keeps
  what is before it word for word and ends with the summary note. Refused when an earlier
  compaction already took that prompt out of the view.

## Memory

`../memory/`; spec "Memory". On with `autoMemory`, unless the highest-precedence settings file
that sets `autoMemoryEnabled` sets it false.

- **The folder** is `<storeRoot>/projects/<project key>/memory/`, `MEMORY.md` its index. The key is
  the session folders' (`projectKey`, with its collision handling) of the project's root: the main
  working tree of the git repository the session's `projectDir` is in (read from `.git`, no git
  command), else `projectDir`. A session in a subfolder, and a worktree session (its `.git` file
  leads to `<main>/.git/worktrees/<name>`), share the project's memory. Claude Code's own memory
  under `~/.claude/projects/` is not read.
- **Loading.** When a session opens (created, resumed or forked), the first 200 lines of MEMORY.md,
  at most 25 KB, go into the prefix's last segment with instructions on when to save and when not
  to. They stay as they were for the runtime's life, compactions included, so the cached prefix
  holds; changes appear the next time a session opens. Topic files are read on demand.
- **Permissions.** The folder is the permission state's `memoryDirectories`: the file tools read
  and change files in it without asking, in every mode but plan, while deny and ask rules and
  protected names inside it still apply; shell commands get nothing from it.
- **Subagents** get their scopes' folders from `agentMemoryDirectory({ scope, agentName,
  storeRoot, projectDir })` (`user`: `<storeRoot>/agent-memory/<agent>`; `project` and `local`:
  `<project root>/.dawg/agent-memory[-local]/<agent>`), to pass as their `memoryDirectories`.
- `/memory` makes the folder and an empty MEMORY.md when there are none, and lists them with the
  instruction files.

## Not here

Slash commands (`session.command`) and their registry; filing worktree sessions under a separate
`projectDir` (accepted, but sessions are filed under `cwd`); warming the prompt cache through the
supervisor at session start.
