# Phase 2 — Engine core

_Draft spec. Roadmap: [PLAN.md](../../PLAN.md) section 9. Shared conventions: [README](README.md)._

## Outcome

A working coding agent with no UI of its own: `dawg -p "fix the failing test"` reads code, edits files, runs commands, asks permission, and finishes the job using a local model. It scores at least as well on the eval suite as the best existing harness on the same model. The desktop app in Phase 3 is a client of this engine.

## Scope

**In**

- The engine protocol (`packages/protocol`).
- The agent loop and the model client, with tool-call validation and repair.
- Tools: Read, Write, Edit, Bash, Glob, Grep, the task list, ask-the-user questions, and the plan-mode tools.
- Permission modes and rules; the layered settings loader.
- Instruction files (`CLAUDE.md`, `AGENTS.md`).
- Sessions on disk: create, resume, fork, rename.
- Compaction and context accounting.
- Core slash commands and the headless CLI.
- The full mock model server for tests.

**Out**

- Hooks, skills, custom commands, subagents, MCP, checkpoints, sandbox, web tools, memory (Phase 4).
- Any UI (Phase 3).

The task list and ask-the-user tools are listed as second-priority in PLAN.md section 8. They are built here because plan mode leans on them and they are small.

## Depends on

- Phase 0: eval harness and baselines.
- Phase 1: the `Endpoint` abstraction and the supervisor's cache hooks. Development can use a remote endpoint throughout.

## Design

### Protocol

JSON-RPC 2.0, schemas in `packages/protocol`.

**Requests (client → engine)**

| Method                                                       | Purpose                                           |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `initialize`                                                 | Exchange protocol version and client capabilities |
| `session.create` / `session.resume` / `session.fork`         | Open a session in a working directory             |
| `session.list` / `session.rename` / `session.archive`        | Manage stored sessions                            |
| `session.prompt`                                             | Send a user message (text, file mentions, images) |
| `session.interrupt`                                          | Stop the current turn                             |
| `session.setMode` / `session.setModel` / `session.setEffort` | Change how the session runs                       |
| `session.command`                                            | Run a slash command                               |
| `permission.respond`                                         | Answer a permission request                       |
| `question.respond`                                           | Answer an ask-the-user question                   |
| `plan.respond`                                               | Approve or reject a proposed plan                 |

**Events (engine → client)**, each carrying a session id and a sequence number:

| Event                                                    | Carries                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `session.status`                                         | `idle`, `working`, `waiting` (on the user), `error`                              |
| `message.started` / `message.delta` / `message.finished` | Assistant text as it streams                                                     |
| `reasoning.delta`                                        | Reasoning text as it streams                                                     |
| `tool.started` / `tool.progress` / `tool.finished`       | A tool call, its live output, its result (including a structured diff for edits) |
| `permission.requested`                                   | What is being asked, why, and the choices                                        |
| `question.asked` / `plan.proposed`                       | An ask-the-user question; a plan awaiting approval                               |
| `tasks.updated`                                          | The task list                                                                    |
| `usage.updated`                                          | Context used and available, tokens, speed, cache reuse                           |
| `prompt.progress`                                        | How much of the prompt the model has read                                        |
| `compaction.started` / `compaction.finished`             | Context being summarised                                                         |
| `error`                                                  | A typed, user-presentable error                                                  |

A client that reconnects asks for events after a sequence number and gets a replay from the transcript.

### The turn loop

```
receive prompt
loop:
  build request  = static prefix + tool schemas + history
  stream reply   → emit deltas; collect text, reasoning, tool calls
  if no tool calls: finish turn
  for each tool call:
    validate arguments          (repair or return an error to the model)
    decide permission           (allow / ask the user / deny)
    execute                     (read-only calls in parallel, others in order)
    append result to history
  if over the context threshold: compact
```

**Stop conditions:** a reply with no tool calls; the turn limit; an interrupt; an unrecoverable error.

**Interrupts.** The model stream is aborted, running commands get SIGINT then SIGKILL, and every tool call still without a result gets an "interrupted" result, because chat templates require each call to have one.

**Guards**

| Problem                                                | Response                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| Empty reply (no text, no tool calls)                   | Retry once                                                 |
| The same call with the same result three times running | Append a note telling the model it is repeating itself     |
| Five times running                                     | Stop the turn and tell the user                            |
| Stream drops mid-reply                                 | Retry the request once; the cached prefix makes this cheap |

### Model client

Speaks OpenAI Chat Completions with streaming to the session's `Endpoint`.

- **Request extras for the bundled runtime:** `cache_prompt`, `id_slot` (each agent pinned to its slot), `timings_per_token`, `return_progress`, `parallel_tool_calls` when the template supports it, and `reasoning_effort` when the template lists effort levels in `/props`.
- **Reasoning** arrives as a separate field and is stored in history, because current model cards require it to be sent back.
- **Usage** comes from the response; the `timings` block gives tokens reused from cache versus processed.
- Other endpoint kinds get the plain OpenAI request with none of the extras.

**Tool-call pipeline.** Every call the model makes goes through:

1. **Parse** the arguments as JSON. On failure, try a tolerant repair (trailing commas, unclosed brackets, stray text around the object).
2. **Validate** against the tool's schema. Coerce safe mismatches (a number sent as a string).
3. **On failure,** return a tool result that names the field, the problem and the expected shape. Do not run the tool.
4. **Recover prose calls.** If the reply contains no structured calls but its text holds a recognisable call (for example inside `<tool_call>` tags or a fenced JSON block naming a known tool), treat it as a call.

Tool schemas are linted at load for constructs known to break grammar-constrained decoding. The count of malformed calls is reported in `usage.updated` and to the eval harness.

### Prompt assembly and cache stability

The request is built so that everything before the newest message is byte-identical from one request to the next.

| Order | Segment                                                                           | Changes                                                                       |
| ----- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1     | Core instructions                                                                 | Only with an app update                                                       |
| 2     | Tool guidance and tool schemas                                                    | Only when the tool set changes                                                |
| 3     | Instruction files (`CLAUDE.md` and friends)                                       | Only when those files change; picked up at session start and after compaction |
| 4     | Session context message: working directory, platform, date, git branch and status | Written once at session start, never rewritten                                |
| 5     | Conversation history                                                              | Append-only                                                                   |

Rules:

- Nothing volatile in segments 1–3: no timestamps, no counters, no reordered lists.
- Later facts (the date rolled over, a file changed on disk, the mode changed) are **appended** as short system-note messages, never edited into earlier text.
- History is never rewritten except by compaction.
- A test asserts that two consecutive requests in a session share an identical prefix up to the previous request's end.
- At session start the engine asks the supervisor to warm segments 1–3, and to restore a saved cache when one matches.

All prompt text is written for this project. Each instruction must earn its place on the eval suite.

### Tools

Names and input fields follow Claude Code's public tool reference so that permission rules and, later, hooks written for it keep working. Limits below are the documented ones; they are settings, not constants.

| Tool                             | Inputs                                                                        | Behaviour                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read`                           | `file_path`, `offset`, `limit`                                                | Returns numbered lines. Default cap 2,000 lines; large files must be read in ranges. Images are returned as images for vision models. Records the file as "read" for the edit rules.                                                |
| `Write`                          | `file_path`, `content`                                                        | Creates or overwrites. Overwriting an existing file requires a prior `Read` of its current contents.                                                                                                                                |
| `Edit`                           | `file_path`, `old_string`, `new_string`, `replace_all`                        | Replaces text. See matching below.                                                                                                                                                                                                  |
| `Bash`                           | `command`, `timeout`, `run_in_background`, `description`                      | Runs in the project. Default timeout 120 s, maximum 600 s. Output over about 30,000 characters is cut to head and tail and the full text saved to a file. The working directory persists between calls; environment changes do not. |
| `Glob`                           | `pattern`, `path`                                                             | File paths matching a pattern, newest first, capped.                                                                                                                                                                                |
| `Grep`                           | `pattern`, `path`, `glob`, `type`, `output_mode`, context flags, `head_limit` | Regex search using the bundled ripgrep.                                                                                                                                                                                             |
| `TodoWrite`                      | `todos[]`                                                                     | Replaces the session's task list; emits `tasks.updated`.                                                                                                                                                                            |
| `AskUserQuestion`                | `questions[]` with options                                                    | Pauses the turn until the user answers.                                                                                                                                                                                             |
| `EnterPlanMode` / `ExitPlanMode` | — / `plan`                                                                    | Switches to read-only planning; presents the plan for approval.                                                                                                                                                                     |

**Edit matching.** Tried in order, stopping at the first that yields exactly one match (or any number with `replace_all`):

1. Exact.
2. Ignoring trailing whitespace on each line.
3. Ignoring differences in leading indentation, re-indenting the replacement to fit the file.
4. Normalising line endings and common Unicode look-alikes (smart quotes, non-breaking spaces).

Zero matches returns the closest region of the file with a short diff against `old_string`. Several matches returns their line numbers and asks for more context. A file changed on disk since it was read is refused with a request to read it again.

**Shared behaviour.** Every tool returns either a result or a structured error the model can act on. Oversized results are saved under the session's `tool-results/` folder and replaced by a summary plus the path. Read-only tools (`Read`, `Glob`, `Grep`) may run concurrently; everything else runs in the order the model emitted it.

### Permissions

**Modes**

| Mode                | File edits                           | Shell commands          | Notes                                                                   |
| ------------------- | ------------------------------------ | ----------------------- | ----------------------------------------------------------------------- |
| `default`           | Ask                                  | Ask                     | Read-only tools never ask                                               |
| `acceptEdits`       | Allow inside the working directories | Ask                     |                                                                         |
| `plan`              | Blocked                              | Read-only commands only | Leaves via `ExitPlanMode` approval                                      |
| `dontAsk`           | Deny whatever would have asked       | Same                    | For unattended runs                                                     |
| `bypassPermissions` | Allow                                | Allow                   | Deny rules still apply; cannot be enabled from a project's own settings |

**Rules** use the documented `Tool(specifier)` form in `permissions.allow`, `.ask` and `.deny`:

| Example                | Matches                            |
| ---------------------- | ---------------------------------- |
| `Bash(npm run test *)` | Commands starting with that prefix |
| `Read(./secrets/**)`   | Paths, in gitignore-style patterns |
| `Edit(src/**)`         | Edits and writes under `src/`      |
| `Bash`                 | Every use of the tool              |

**Decision order:** deny rules, then ask rules, then allow rules, then the mode's default. Precedence details are confirmed against the public permissions page during implementation.

**Shell command matching** parses the command first. A command joined with `&&`, `;`, `|` or containing substitutions is split, and _every_ part must be allowed, so an allowed prefix cannot smuggle a second command.

**Asking.** A request emits `permission.requested` and sets the session to `waiting`. The answers are: allow once; allow always (a rule is written to `.dawg/settings.local.json`); deny, optionally with a message that is given to the model.

**Always asked, whatever the mode except bypass:** writes to `.git/`, to settings files under `.dawg/` and `.claude/`, and outside the working directories.

### Settings

Merged from highest to lowest precedence:

1. Command-line flags
2. `<project>/.dawg/settings.local.json`, then `<project>/.claude/settings.local.json`
3. `<project>/.dawg/settings.json`, then `<project>/.claude/settings.json`
4. `~/.dawg/settings.json`, then `~/.claude/settings.json`

Permission lists are combined across levels; single values are overridden. From `.claude` files only the keys we implement are used (in this phase: `permissions`, `env`, additional directories). Keys that only make sense for Anthropic's service, such as model names and API settings, are ignored. Unknown keys are logged at debug level.

### Instruction files

Loaded as documented for Claude Code's memory files:

- `~/.claude/CLAUDE.md`, then each `CLAUDE.md` and `CLAUDE.local.md` from the filesystem root down to the working directory.
- `AGENTS.md` is read wherever a `CLAUDE.md` would be and none exists.
- `@path` imports inside those files, up to five levels deep.
- `.claude/rules/*.md`, with optional `paths:` front matter limiting when a rule applies.
- A `CLAUDE.md` in a subdirectory is added (as an appended note) the first time the agent reads a file there.

### Sessions

One append-only JSONL file per session. This is our own format; it is not meant to be byte-compatible with any other tool's.

| Record        | Holds                                                                             |
| ------------- | --------------------------------------------------------------------------------- |
| `meta`        | Session id, working directory, title, created time, protocol version, forked-from |
| `user`        | A user message and its attachments                                                |
| `assistant`   | Text, reasoning and tool calls of one reply                                       |
| `tool_result` | The result of one tool call                                                       |
| `note`        | A system note appended to context                                                 |
| `state`       | Mode, model, effort or task-list changes                                          |
| `compact`     | A compaction boundary and its summary                                             |

- **Resume** replays the file to rebuild history and state. **Fork** copies records up to a chosen point into a new file that names its parent.
- A small index per project caches titles, status and last-activity time for fast listing. It can always be rebuilt from the files.
- Titles are generated from the first prompt by a short model call after the first turn.

### Context accounting and compaction

- Context size comes from the endpoint's reported window, never an assumption. Usage is taken from server-reported counts; `POST /v1/chat/completions/input_tokens` gives exact counts on the bundled runtime, with a character-based estimate elsewhere.
- **Compaction** runs automatically at a threshold (default 65% of the window) and on `/compact [focus]`:
  1. Ask the model for a structured summary of the conversation so far: goal, decisions, files touched, current state, open tasks.
  2. Start a new history holding the summary, the task list, the last few turns verbatim, and fresh copies of the most recently read files.
  3. Write a `compact` record. The transcript keeps everything; only the model's view shrinks.
- Because the static prefix (segments 1–3) is unchanged, its cache survives compaction. Only the summary and the kept turns are processed again.
- A single oversized tool result is trimmed before compaction is considered.

### Slash commands

Built in this phase: `/help`, `/clear`, `/compact`, `/context`, `/model`, `/effort`, `/mode` (also `/plan`), `/resume`, `/rename`, `/export`, `/add-dir`, `/init`, `/status`, `/permissions`. Commands are a registry in the engine, so Phase 4 can add user-defined ones.

### Headless CLI

```
dawg -p "<prompt>" [--output-format text|json|stream-json] [--model <id>] [--endpoint <url>]
     [--permission-mode <mode>] [--allowedTools <rules>] [--disallowedTools <rules>]
     [--max-turns <n>] [--continue | --resume <id>] [--cwd <dir>]
```

- `text` prints the final message. `json` prints one object with the result, usage and session id. `stream-json` prints protocol events as newline-delimited JSON.
- With no one to ask, a permission request is denied unless a rule allows it.
- Exit code 0 on success, non-zero on error, turn limit or interrupt.
- `dawg` with no `-p` starts a minimal interactive prompt, enough for development before the app exists.

### Mock model server

A scripted OpenAI-compatible server used by tests in this and later phases. A script is a list of replies (text, reasoning, tool calls, or faults such as malformed JSON, a dropped stream, an empty reply), matched to incoming requests in order. It records every request so tests can assert on what the engine sent.

## Work breakdown

1. Protocol schemas and the transport interface (message port and stdio).
2. Mock model server.
3. Model client with streaming and the tool-call pipeline.
4. Turn loop with interrupts and guards.
5. `Read`, `Glob`, `Grep`; then `Write`, `Edit`; then `Bash` with timeouts and background runs.
6. Settings loader and the permission engine.
7. Prompt assembly, instruction files, the prefix-stability test.
8. Sessions: write, resume, fork, index.
9. Context accounting and compaction.
10. Task list, ask-the-user, plan mode.
11. Slash commands; headless CLI; the `dawg` eval adapter.
12. Eval runs, prompt and tool iteration until the bar is met.

## Testing

| Layer         | What                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit          | Each tool, including an edit-matching table of awkward cases; permission rule matching, including command-splitting attacks; settings merge order; instruction-file discovery |
| Scripted loop | Whole turns against the mock server: multi-step tool use, malformed calls, empty replies, dropped streams, interrupts mid-tool, repeat detection                              |
| Property      | Prefix stability across a long scripted session; resume reproduces the exact request the original session would have sent next                                                |
| Eval          | The Phase 0 suite, tasks 1–10, three trials each                                                                                                                              |

## Done when

- Overall pass rate on the suite is at least that of the best baseline harness on the same model and endpoint.
- The prefix-stability test passes, and on the bundled runtime the cache reuse ratio across a long session stays above 0.95 outside compactions.
- A session can be interrupted, quit, resumed and forked without losing or corrupting history.
- Every permission mode behaves as its table row says, verified by tests.
- If the first criterion is not met within the phase's timebox, the engine path is reconsidered as described in PLAN.md section 4.

## Open questions

- Whether to request grammar-constrained tool arguments on every call or only after a failure. Decide on eval results and speed.
- How many recent turns to keep verbatim through compaction.
- Whether reasoning from older turns can be dropped at compaction for models whose cards allow it.
