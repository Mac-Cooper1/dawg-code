# @dawg/cli: the `dawg` command

A coding agent for local models, on the command line. The engine runs in this process and the
command talks to it through the engine protocol (a protocol client and the engine host joined by
an in-memory transport), so it exercises exactly the path the desktop app uses.

```
dawg [options] [prompt]          interactive session, optionally starting with a prompt
dawg -p [options] [prompt]       one unattended turn; prints the result and exits
dawg serve [options]             the engine protocol on standard input and output
```

Run it from a checkout with `pnpm dawg ...` (or `node packages/cli/src/main.ts ...`).

## Where the model comes from

One of:

| Source | How |
| --- | --- |
| `--endpoint <url>` | Any OpenAI-compatible root, e.g. `http://127.0.0.1:8080/v1` (a `/v1` left off is tried once). The models are listed, and the real context window is taken from what the server reports: llama-server's `/props`, the model listing, or, when the listing says nothing, Ollama's or LM Studio's own API on the same host. `--model` picks the model; it is required when the server lists several and none is loaded. |
| `--model-file <path.gguf>` | Runs the file with the bundled llama-server under the runtime supervisor, on 127.0.0.1 with a per-launch key, and stops it on every way out (normal exit, error, Ctrl+C, SIGTERM; the supervisor's watchdog covers a killed process). `--context-size <tokens>` sets the window per conversation (default 32768; the server is given two slots, one for the conversation and one for titles, so `-c` is twice that). If the runtime has not been fetched: `pnpm fetch-runtime`, or set `DAWG_RUNTIME_BIN`. |
| neither | `DAWG_ENDPOINT` is used as `--endpoint`; without it the command explains what to pass and exits 2. |

**The API key** comes from `DAWG_API_KEY` only, never from a flag. It is given to the HTTP client
and nothing else: it is not printed, logged or written, and it is removed from the environment
before any tool runs, so the agent's commands cannot read it.

The model profile (sampling, output limit, template options) is chosen from the model id by
family (`qwen3.8`, `qwen3.6`, `laguna-xs-2.1`, `gpt-oss`), else the default profile.

## Options

| Option | Meaning |
| --- | --- |
| `-p`, `--print` | Run one turn unattended and exit. The prompt is the arguments, or standard input when there are none (up to 10 MB). A prompt that starts with a known slash command (`/init`, `/status`, ...) runs that command. |
| `--output-format text\|json\|stream-json` | With `-p`. See below. |
| `--endpoint <url>`, `--model <id>`, `--model-file <path>`, `--context-size <n>` | See above. |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` (`manual` means `default`). Refused (exit 2) when settings turn bypass off. |
| `--dangerously-skip-permissions` | The same as `--permission-mode bypassPermissions`. |
| `--allowedTools <rules...>`, `--allowed-tools` | Allow rules in the documented form: `Read`, `Bash(npm test *)`, `"Bash,Edit"`. Several words may follow one flag; words that are not shaped like rules (a prompt) end the list. |
| `--disallowedTools <rules...>`, `--disallowed-tools` | Deny rules, same form. Deny rules apply in every mode, bypass included. |
| `--max-turns <n>` | Most model requests in one turn (default 200). |
| `-c`, `--continue` | Continue the most recent session in the working directory (a new one if there is none). |
| `-r`, `--resume <id>` | Resume a session by id, from any directory. It runs in its own working directory. |
| `--cwd <dir>` | The working directory (default: the current one). |
| `--add-dir <dir...>` | More directories the agent may read and edit. Several may follow one flag. |
| `--verbose` | Diagnostics on standard error: the endpoint chosen, one line per tool call, protocol problems. |
| `-h`, `--help`; `-v`, `--version` | |

Settings are layered as the engine's spec says (flags, then `.dawg/settings.local.json`, then
`.dawg/settings.json`, then `~/.dawg/settings.json`, with the `.claude` files read alongside).
Data goes under `$DAWG_HOME`, else `~/.dawg`.

## Output with `-p`

Standard output holds the result and nothing else; everything else goes to standard error.

- `text`: the final message of the turn.
- `json`: one line, one object:

  ```json
  { "type": "result", "result": "Fixed the rounding.", "stopReason": "completed", "isError": false,
    "error": null, "sessionId": "...", "turnId": "turn-4", "numRequests": 5, "durationMs": 8123,
    "usage": { "contextWindow": 32768, "contextUsed": 9120, "last": { ... }, "totals": { ... } } }
  ```

  `stopReason` is `completed`, `turn_limit`, `interrupted` or `error`; `error` is the protocol's
  `ErrorInfo` when it is `error`. `numRequests` counts this run's model requests; `usage` is the
  session's (totals include earlier runs of a resumed session).
- `stream-json`: every protocol event of the session, one JSON object per line, exactly as the
  protocol sends it: `{"event": "message.delta", "payload": {"sessionId": ..., "seq": ..., ...}}`
  (see `packages/protocol/README.md`). The last turn event is `turn.finished`.

Nobody can answer during a `-p` run: a permission request is denied unless a rule or the mode
allows it, and the question and plan tools are told that nobody can answer. No title is generated
for the session (it would cost a model request after the turn).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The turn completed (or the command answered) |
| 1 | A model or engine error: endpoint unreachable, the model failed, the turn ended in error |
| 2 | Bad usage: unknown or conflicting flags, no prompt, no model configured, unknown session, a refused mode |
| 3 | The turn stopped at the `--max-turns` limit |
| 130 | Interrupted by SIGINT (Ctrl+C) |
| 143 | Stopped by SIGTERM |

The first SIGINT interrupts the turn cleanly (the transcript records it, every tool call gets a
result) and the command exits 130; a second one exits at once. SIGTERM does the same with 143.

## Interactive mode

`dawg` without `-p`. Lines you type are prompts; lines starting with `/` are slash commands
(`/help` lists them; `/exit` quits). The reply streams as it is written, each tool call gets one
line with its outcome, and edits show a compact diff. Permission requests ask
`y` (allow once), `a` (allow always: a rule is saved to `.dawg/settings.local.json`) or
`n [reason]`; questions take an option number or free text; plans take `y`, `e` (approve and
accept edits) or `n [feedback]`. Ctrl+C interrupts a running turn; a second Ctrl+C, or one at the
prompt, quits. Plain text only: no colours or cursor movement, so it works through pipes, where the
answers to prompts are simply the next lines of input. The end of input quits after the running
turn, answering anything still asked with "no".

## `dawg serve`

The engine protocol over standard input and output as newline-delimited JSON, for another process
to drive (`createNdjsonTransport` and `createClient` from `@dawg/protocol` on the other end).
Standard output carries protocol messages only. Takes the model and settings options; sessions,
prompts and modes come from the client. When the input ends, every session is closed (a running
turn is interrupted first) and the process exits 0.

## Examples

```sh
# Against the scripted mock server (prints {"event":"listening",...,"baseUrl":...})
node packages/mock-model/src/cli.ts --script script.json --port 0 &
pnpm dawg -p "write hello.txt" --endpoint http://127.0.0.1:<port>/v1 --allowedTools Write

# Against a real endpoint
export DAWG_API_KEY=...      # only if the server wants one
pnpm dawg -p "fix the failing test" --endpoint http://127.0.0.1:8080/v1 \
  --permission-mode acceptEdits --allowedTools "Bash(npm test *)" --output-format json

# Continue, resume, pipe
pnpm dawg -p "now run the linter" -c --endpoint "$DAWG_ENDPOINT"
git diff | pnpm dawg -p --endpoint "$DAWG_ENDPOINT"

# A local model file with the bundled runtime
pnpm dawg --model-file ~/models/Qwen3.8-27B-UD-Q4_K_M.gguf --context-size 65536
```
