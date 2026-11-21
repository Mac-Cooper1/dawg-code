# Phase 0 — Foundations

_Draft spec. Roadmap: [PLAN.md](../../PLAN.md) section 9. Shared conventions: [README](README.md)._

## Outcome

A repo that builds and tests itself on every push, an eval harness that can score any coding agent on a fixed set of tasks, and a first scoreboard showing how existing harnesses do on our target model. Those baseline numbers are what Phase 2 has to match.

## Scope

**In**

- Repo scaffold, licence, contribution basics.
- CI on macOS arm64 and x64.
- The eval harness: task format, runner, harness adapters, metrics, scoreboard.
- The first 10–12 eval tasks.
- Baseline runs of OpenCode, Pi and the real Claude Code.
- The developer inference setup (a hosted endpoint until the reference Mac arrives).

**Out**

- Any product code beyond empty packages.
- The mock model server's full behaviour (Phase 2 fleshes it out; Phase 0 only needs a stub for CI).

## Depends on

- A hosted OpenAI-compatible endpoint serving the target model (Qwen3.8-27B), and its API key.
- GitHub repo access. Nothing from other phases.

## Design

### Repo scaffold

| Item            | Choice                                                           |
| --------------- | ---------------------------------------------------------------- |
| Workspace       | pnpm, with `apps/*`, `packages/*`, `evals` as members            |
| TypeScript      | One base `tsconfig`, strict, project references between packages |
| Lint and format | Biome, one config at the root                                    |
| Tests           | Vitest, one config per package                                   |
| Licence         | Apache-2.0: `LICENSE`, and a `NOTICE` file for ported code       |
| README          | What it is, status, and a not-affiliated line                    |
| Secrets         | `.env` for local keys, git-ignored; `.env.example` committed     |

Packages are created empty with a build script and one passing test each, so CI is meaningful from the first commit.

### CI

One workflow, three jobs:

| Job     | Runs on             | Does                                                                                                                        |
| ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `check` | Linux               | Install, lint, type-check, unit tests                                                                                       |
| `build` | macOS arm64 and x64 | Build every package and the (empty) desktop app                                                                             |
| `smoke` | macOS arm64         | Fetch the pinned `llama-server`, load a tiny model (under 1 GB, cached between runs), send one chat request, assert a reply |

The `smoke` job exists from Phase 0 so the runtime pin is exercised continuously. Eval runs are not part of per-push CI: they are slow and cost money. They run by hand or on a schedule.

### Eval harness

The harness answers one question: _given this agent, this model and this task, did the task get done, and at what cost?_

**Task format.** One directory per task under `evals/tasks/<id>/`:

```
task.yaml       id, title, prompt, tags, timeout, trials
fixture/        the starting project, copied to a temp workspace for each run
setup.sh        optional: install dependencies, initialise git
check.sh        exit 0 = pass. Runs after the agent finishes.
```

`check.sh` is the only judge. It runs tests, greps output or compares files. No model grades another model's work.

**Runner.** For each agent × model × task × trial:

1. Copy `fixture/` to a fresh temp workspace, run `setup.sh`, commit the starting state.
2. Start the agent headless with the task prompt, a temp home directory, and the endpoint pointed at the recording proxy.
3. Enforce the timeout. Collect the agent's transcript and the proxy's record.
4. Run `check.sh`. Save the result and the final diff.

Trials default to 3 per task, because runs are not deterministic.

**Agent adapters.** Each adapter knows how to launch one agent headless and where its transcript ends up:

| Adapter       | Launch                                | Notes                                                       |
| ------------- | ------------------------------------- | ----------------------------------------------------------- |
| `dawg`        | `dawg -p`                             | Added in Phase 2                                            |
| `opencode`    | Its headless run mode                 | OpenAI-compatible endpoint                                  |
| `pi`          | Its print / JSON mode                 | OpenAI-compatible endpoint                                  |
| `claude-code` | `claude -p` with `ANTHROPIC_BASE_URL` | Needs an Anthropic-format endpoint, so the proxy translates |

**Recording proxy.** A small pass-through server between every agent and the endpoint. It forwards requests unchanged and records them, which gives the same measurements for every agent regardless of what each one logs:

- prompt tokens in the first request (the fixed prefix an agent sends before any work);
- number of requests, prompt and completion tokens in total;
- tool calls whose arguments were not valid JSON or did not match the declared schema;
- when the endpoint is a local `llama-server`: tokens reused from cache versus processed, from the `timings` block.

For the Claude Code adapter the proxy also translates Anthropic Messages requests to OpenAI Chat Completions and back.

**Metrics per run**

| Metric                      | Source                                          |
| --------------------------- | ----------------------------------------------- |
| Pass / fail                 | `check.sh`                                      |
| Wall time, model requests   | Runner, proxy                                   |
| Prefix tokens, total tokens | Proxy                                           |
| Malformed tool calls        | Proxy                                           |
| Failed edits                | Agent transcript, where the adapter can read it |
| Cache reuse ratio           | Proxy, local runtime only                       |

**Scoreboard.** Results are appended to `evals/results/<date>-<agent>-<model>.jsonl`. A report command aggregates them into a Markdown table: pass rate per task and overall, with medians for the cost metrics. Baseline reports are committed.

### The first task set

| #   | Task                                                 | Checks                             |
| --- | ---------------------------------------------------- | ---------------------------------- |
| 1   | Fix a failing unit test                              | Test suite passes                  |
| 2   | Add a feature touching two files                     | New tests pass                     |
| 3   | Rename a function across a small codebase            | Builds, no old name remains        |
| 4   | Write a script and run it                            | Output file matches                |
| 5   | Answer a question about a repo                       | Answer file contains the key facts |
| 6   | Edit code with tabs and trailing whitespace          | Exact diff matches                 |
| 7   | A five-step task needing a task list                 | All five artefacts exist           |
| 8   | Recover from a command that fails first              | Final state correct                |
| 9   | Work in a file longer than one read                  | Correct change at the right place  |
| 10  | Long-context task: many files read before the change | Tests pass                         |
| 11  | Use a provided MCP tool                              | Tool was called; result used       |
| 12  | Use a provided skill                                 | Skill's convention followed        |

Tasks 11 and 12 need features from Phase 4 and stay skipped until then. Fixtures are small original projects written for this suite, in at least two languages.

### Developer inference setup

- `DAWG_DEV_ENDPOINT_URL`, `DAWG_DEV_API_KEY`, `DAWG_DEV_MODEL` in `.env`.
- A `pnpm dev:ping` command that sends one chat request with one tool defined and prints the reply and token usage. It is the quickest check that the endpoint supports tool calling the way we need.
- Hosted providers may serve a different precision than our local quantizations. Record the provider and precision in each result file.

## Work breakdown

1. Scaffold the workspace, licence, README, Biome, Vitest, empty packages.
2. CI: `check` and `build` jobs.
3. Runtime pin file and fetch script; CI `smoke` job.
4. Recording proxy (pass-through and recording first, Anthropic translation second).
5. Eval runner, task format, `opencode` and `pi` adapters.
6. Tasks 1–10 with fixtures and checkers.
7. Report command and scoreboard format.
8. `claude-code` adapter through the translating proxy.
9. Baseline runs; commit the reports.

## Testing

- Unit tests for the runner (timeouts, workspace isolation), the proxy (recording, translation round-trips) and the report maths.
- Each task's `check.sh` is tested both ways: it fails on the untouched fixture and passes on a committed reference solution.
- A dry-run agent adapter that applies the reference solution proves the whole pipeline without a model.

## Done when

- CI is green on all three jobs.
- One command runs the suite for a given agent and model and writes a scoreboard.
- Baseline scoreboards for at least two existing harnesses on the target model are committed.
- `pnpm dev:ping` succeeds against the development endpoint.

## Open questions

- Which hosted provider serves the target model with reliable tool calling. Decide by running `dev:ping` against candidates.
- Whether three trials are enough to separate harnesses. Revisit once the first variance numbers exist.
