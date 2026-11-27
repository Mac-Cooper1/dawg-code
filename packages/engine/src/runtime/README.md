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
| `tools?` | Fixed order; default `[...CORE_TOOLS, ...INTERACTIVE_TOOLS]` |
| `toolLimits?`, `limits?` | `ToolLimits`; `RuntimeLimits` (turn limit 200 requests, result spill at 100,000 characters, retries, repeat thresholds 3 and 5, compaction file copies, mention size) |
| `capabilities?` | `{ permissionPrompts, questions, planApproval }`, each default true; a session may override |
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
- The owner of a lease is a string, the session's id. Subagents (Phase 4) will use their own
  owner within the session and the same pools.
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

## Not here

Slash commands (`session.command`) and their registry; filing worktree sessions under a separate
`projectDir` (accepted, but sessions are filed under `cwd`); warming the prompt cache through the
supervisor at session start.
