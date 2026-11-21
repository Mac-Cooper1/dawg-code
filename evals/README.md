# Evals

The eval harness answers one question: _given this agent, this model and this task, did the task get done, and at what cost?_

| Path              | What                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `tasks/`          | One directory per task (format below)                                    |
| `runner/`         | `@dawg/eval-runner`: loads tasks, runs agents, scores, reports           |
| `proxy/`          | The recording proxy that sits between every agent and the model endpoint |
| `results/`        | Result rows (`*.jsonl`) and committed scoreboards                        |
| `results/tmp/`    | Per-run artefacts: stdout, stderr, diff, proxy records (git-ignored)     |

## Task format

```
evals/tasks/<id>/
  task.yaml      required
  fixture/       required  starting project; copied to the root of a fresh temp workspace
  setup.sh       optional  run with cwd = workspace after the copy, before the agent starts
  check.sh       required  run with cwd = workspace after the agent finishes; exit 0 = pass
  check/         optional  hidden checker assets (e.g. hidden tests); never copied into the workspace
  solution/      required  reference solution as an overlay, copied over the workspace
  solution.sh    optional  run with cwd = workspace after the overlay (deletions, required commands)
```

```yaml
id: fix-failing-test          # kebab-case, equal to the directory name
title: Fix a failing unit test
prompt: |                     # the exact text given to the agent
  The test suite fails. Find the bug and fix it.
tags: [python, debugging]
timeout_seconds: 900          # agent wall-clock limit (default 900)
trials: 3                     # optional (default 3)
requires: [mcp]               # optional; features the agent must support, else the task is skipped
```

Unknown fields in `task.yaml` are rejected, so a typo such as `timeout:` fails validation instead of being ignored.

Rules for scripts:

- They run with `bash`, offline and deterministically, with `TASK_DIR` (absolute task directory) and `WORKSPACE` (absolute workspace) set. `HOME` is a throwaway directory, and the environment is a minimal allowlist (no API keys).
- `check.sh` is the only judge. It is killed after 60 seconds, which counts as a fail.
- After `setup.sh`, the runner runs `git init` in the workspace (repo-local identity, global config untouched) and commits the starting state, so a checker can diff against `HEAD`.
- Directories whose names start with `_` or `.` are not tasks (use them for shared helpers).

Every task must fail on the untouched fixture and pass with its reference solution. `validate` checks both.

## Commands

Run from the repo root. Node 24 runs the TypeScript directly.

```sh
node evals/runner/src/cli.ts list                 # tasks and agents
node evals/runner/src/cli.ts validate             # noop must fail, reference must pass, for every task
node evals/runner/src/cli.ts run --agent reference --trials 1   # whole pipeline, no model
node evals/runner/src/cli.ts run --agent opencode --model qwen3.8-27b --tasks fix-failing-test
node evals/runner/src/cli.ts report evals/results/2026-11-20-*.jsonl --out evals/results/scoreboard.md
```

`run` options:

| Option                     | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `--agent <id>`             | `reference`, `noop`, `command`, `opencode`, `pi`, `claude-code`, `dawg`          |
| `--model <name>`           | Model name sent to the endpoint. Default `$DAWG_DEV_MODEL`                       |
| `--endpoint <url>`         | Upstream base URL ending in `/v1`. Default `$DAWG_DEV_ENDPOINT_URL`              |
| `--endpoint-key-env <ENV>` | Env var holding the upstream key. Default `DAWG_DEV_API_KEY`                      |
| `--tasks a,b`              | Only these tasks                                                                 |
| `--trials <n>`             | Override every task's trial count                                                |
| `--concurrency <n>`        | Parallel runs (default 1)                                                        |
| `--keep`                   | Keep the workspace of runs that did not pass; the path is printed                |
| `--label <text>`           | Stored in every row; use it for the provider and precision                       |
| `--agent-cmd <template>`   | Command template for `--agent command`                                           |
| `--agent-bin <path>`       | Executable for `opencode`, `pi`, `claude-code` or `dawg`                         |
| `--agent-features a,b`     | Extra features the agent claims (matched against `requires`)                     |
| `--proxy-cmd <command>`    | How to launch the proxy. Default `node evals/proxy/src/cli.ts`                   |
| `--tasks-dir`, `--results-dir` | Defaults `evals/tasks`, `evals/results`                                      |

The CLI reads the repo's `.env` if present (existing environment variables win). `reference` and `noop` need no endpoint, model or proxy.

`run` exits non-zero if a task failed to load or a run ended in `error` (the runner could not run it: setup failed, proxy or agent failed to start, interrupted). A task that the agent simply failed is not an error.

### What one run does

For each task × trial:

1. Create a temp directory holding `workspace/` (fixture copy), `home/` (the agent's throwaway `HOME`), `script-home/` and `tmp/`. Run `setup.sh`, then `git init` and commit the starting state.
2. Start the recording proxy (`--upstream <endpoint> --port 0 --record <artefacts>/proxy.jsonl --upstream-key-env <ENV>`), wait for its `listening` line.
3. Run the adapter with the task's timeout. The agent gets the proxy URL, a dummy key and a minimal environment; on timeout the whole process group gets SIGTERM, then SIGKILL. Background children left behind by an agent that exits are killed too.
4. Stop the proxy (SIGTERM, so it flushes), save the agent's diff against the starting commit (`diff.patch`, including untracked files and the agent's own commits), then run `check.sh` (60 s limit).
5. Append a result row, compute metrics from the proxy records, delete the temp directory (unless `--keep` and the run did not pass).

Artefacts per run go to `evals/results/tmp/<run-id>/`: `agent.stdout.log`, `agent.stderr.log` (for `opencode`, `pi`, `claude-code` and `dawg` stdout is the JSON event transcript), `setup.*.log`, `check.*.log`, `diff.patch`, `proxy.jsonl`, `proxy.stderr.log`.

### Results and metrics

Rows are appended to `evals/results/<YYYY-MM-DD>-<agent>-<model-slug>.jsonl` (UTC date of the run start). Each row holds the agent, model, sanitised endpoint (no credentials or query), label, task, trial, `status` (`pass`, `fail`, `skipped`, `error`), check and agent exit codes and timeouts, agent wall time, and:

| Metric                 | Source                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `requests`             | Proxy records whose `api` is not `other`                                            |
| `prefix_tokens`        | `prompt_tokens` of the first such record that reports usage                         |
| `prompt_tokens`, `completion_tokens` | Sums over those records (null when none reports usage)                 |
| `tool_calls`, `malformed_tool_calls` | Malformed = `arguments_valid_json === false` or `schema_valid === false` |
| `cache_reuse_ratio`    | `sum(cache_n) / sum(cache_n + prompt_n)` over records with `timings`, else null      |
| `failed_edits`         | Reserved for transcript parsing; always null for now                                |

API keys are never written: the runner passes the key's env var _name_ to the proxy and never reads its value.

`report` turns one or more result files into a Markdown scoreboard: a summary per agent and model, then per-task pass rates with medians of the cost metrics (malformed tool calls are a total), skipped tasks and errors. Errors count as failures in the pass rate but are left out of the cost medians. The output depends only on the rows, so it is stable and diffable.

## Agent adapters

An adapter launches one agent headless. It lives in `runner/src/adapters/`:

```ts
interface AgentAdapter {
  id: string;
  features: ReadonlySet<string>; // matched against task `requires`; "*" = everything
  needsEndpoint: boolean;        // false: no proxy, no model (reference, noop)
  run(ctx: RunContext): Promise<AgentRunResult>;
}
```

`RunContext` gives the workspace, prompt, throwaway `homeDir` and `tmpDir`, the `artifactsDir`, the timeout and abort signal, and `endpoint` (`openaiBaseUrl` = `http://127.0.0.1:<port>/v1`, `anthropicBaseUrl` = `http://127.0.0.1:<port>`, a dummy `apiKey`, `model`).

| Adapter       | Launch                                                                                       | Status          |
| ------------- | -------------------------------------------------------------------------------------------- | --------------- |
| `reference`   | Copies `solution/` over the workspace, runs `solution.sh`                                    | Tested          |
| `noop`        | Nothing; every task must fail                                                                | Tested          |
| `command`     | Your `--agent-cmd` template                                                                  | Tested          |
| `opencode`    | `opencode run --standalone --auto --format json --model dawg-eval/<model> <prompt>`, provider config in `$HOME/.config/opencode/opencode.json` | Unverified |
| `pi`          | `pi --mode json --no-session --provider dawg-eval --model <model> <prompt>`, `models.json` in `$PI_CODING_AGENT_DIR` | Unverified |
| `claude-code` | `claude -p <prompt> --output-format stream-json --verbose --model <model> --dangerously-skip-permissions` with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | Unverified |
| `dawg`        | `dawg -p` with the Phase 2 headless flags                                                    | Placeholder     |

"Unverified" means the command, environment and config files were built from each tool's public documentation (URLs in `runner/src/adapters/external.ts`) and are unit-tested, but have not been run against the real binary. Check them before the first baseline run.

### The `command` adapter

The escape hatch for any CLI agent:

```sh
node evals/runner/src/cli.ts run --agent command --model qwen3.8-27b \
  --agent-cmd 'my-agent --base-url {openai_base_url} --model {model} --prompt-file {prompt_file}'
```

Placeholders: `{prompt}`, `{prompt_file}`, `{workspace}`, `{home}`, `{artifacts}`, `{openai_base_url}`, `{anthropic_base_url}`, `{model}`, `{api_key}`. The template is split into words first (shell-style quotes, no expansion) and placeholders are substituted inside each word, so the prompt is always one argument and never reaches a shell. Wrap it in `bash -c '…'` if you need one. The process also gets `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `DAWG_EVAL_MODEL`, `DAWG_EVAL_WORKSPACE` and `DAWG_EVAL_PROMPT_FILE`.

### Adding an adapter

1. Write a `buildXLaunch(ctx): LaunchSpec` in `runner/src/adapters/external.ts` that returns the command, args, extra env and any config files (written under `ctx.homeDir`, never into the workspace, so they do not show up in the diff). Use `ctx.endpoint`, never a real key.
2. Wrap it with `adapter("<id>", [features], build)`, add the id to `ADAPTER_IDS` and `createAdapter` in `adapters/index.ts`.
3. Unit-test the built `LaunchSpec` in `adapters/adapters.test.ts`. Cite the docs you built it from in a comment.
4. Run one task with `--keep` and read the artefacts before trusting the numbers.

Adapters that do not fit the "one process" shape implement `AgentAdapter.run` directly; `executeLaunch` in `adapters/launch.ts` handles process groups, timeouts and log files.

## Isolation, and its limits

Each run gets a fresh workspace and `HOME` under the system temp directory, and the agent's environment is built from an allowlist (`PATH`, locale, `TERM`, `SHELL`, `USER`), so the user's own agent configs and API keys are not visible to it. This is not a sandbox: an agent can still read anything on disk, including the task directory with its hidden `check/` and `solution/`. Treat the scores as honest-effort results, not adversarial ones.
