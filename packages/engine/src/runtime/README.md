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

const engine = createEngine({
  storeRoot: "~/.dawg",                    // absolute in practice
  homeDir: os.homedir(),
  models: { connect: async (modelId) => ({ client, slot: 0, utility: { client, slot: 1 } }) },
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
| `models` | `{ connect(modelId \| null) => ModelConnection }`: `{ client, slot?, utility?: { client, slot? } }`. `utility` is where titles go; give it its own slot on the bundled runtime |
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
| `createSession(NewSessionOptions)`: `{ cwd, projectDir?, title?, mode?, model?, effort?, additionalDirectories?, capabilities? }` | `session.create` | Loads settings and instruction files, gathers the environment (git with read-only commands), builds the prefix, writes the session-context message |
| `resumeSession(id, { capabilities? })` | `session.resume` | Returns the open runtime if there is one |
| `forkSession(id, { point?, title?, cwd?, capabilities? })` | `session.fork` | `point`: end (default; stops before a running turn), `beforeTurn`, `afterTurn`. Title defaults to the parent's plus " (fork)". A different `cwd` is refused |
| `listSessions({ projectDir?, query?, includeArchived?, limit?, cursor? })` | `session.list` | `{ sessions: SessionSummary[], nextCursor }`, newest activity first |
| `renameSession(id, title)`, `archiveSession(id, archived?)` | `session.rename`, `session.archive` | Open or not |
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
| `snapshot() => SessionSnapshot` | create/resume/fork result | `commands` is left empty for the command registry |
| `summary() => SessionSummary` | | |
| `subscribe(listener)`, `eventsAfter(afterSeq, limit?)`, `lastSeq` | events, `session.replay` | |
| `setCapabilities(partial)` | `initialize` | When a different client attaches |
| `close()` | | Interrupts a running turn, stops background commands, flushes and releases the transcript |
| `id`, `cwd`, `projectDir`, `mode`, `status`, `busy`, `closed`, `activeTurnId`, `modelSetting`, `effort`, `additionalDirectories`, `tasks`, `view`, `prefix`, `requestMessages()`, `modelInfo()`, `pending()`, `backgroundTasks()`, `capabilities` | | Read-only views |

Errors are `RuntimeError` with `code` `SessionNotFound`, `SessionBusy`, `InvalidState` or
`RequestNotFound`, named after the protocol errors they map to.

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
compaction) is closed with the events a client expects (`request.resolved` cancelled,
`tool.finished` interrupted, `turn.finished` interrupted, `session.status` idle). A session with
no event log (a fork, or a transcript written by another tool) gets events rebuilt from its
transcript, numbered from 1. `<session dir>/runtime.json` caches mode, model, effort, last `seq`
and whether the last turn failed, so listing never replays transcripts.

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
and appends a `plan_approved` note; plans are also saved under `<storeRoot>/plans/`.

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
