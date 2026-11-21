# Technical specs

One spec per roadmap phase in [PLAN.md](../../PLAN.md) section 9. Each says what the phase delivers, how it is built, and how we know it is done. The depth is deliberately general: enough to start building and to review a design against. Finer details get settled in code and pull requests, and the spec is updated when a decision changes.

| Phase | Spec                                                      | Delivers                                                                 |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0     | [Foundations](phase-0-foundations.md)                     | Repo, CI, eval harness, baseline scores                                  |
| 1     | [Model layer](phase-1-model-layer.md)                     | One-click model download and a running local runtime                     |
| 2     | [Engine core](phase-2-engine-core.md)                     | The agent loop, core tools, permissions, sessions, headless CLI          |
| 3     | [Desktop app](phase-3-desktop-app.md)                     | The full app UI: sidebar, transcript, panes                              |
| 4     | [Compatibility](phase-4-compatibility.md)                 | Hooks, skills, commands, subagents, MCP, checkpoints, sandbox, web tools |
| 5     | [Long tail and release](phase-5-long-tail-and-release.md) | Remaining features, signing, notarization, auto-update                   |

**Order.** 0 → 1 → 2 → 4 → 5. Phase 3 runs alongside Phase 2: it needs the app shell from Phase 1 and the protocol from Phase 2, and can be built against a mock engine until the real one is ready.

**Every spec has the same sections:** Outcome, Scope, Depends on, Design, Work breakdown, Testing, Done when, Open questions.

## Shared conventions

These apply to every phase. A spec only repeats them where it adds something.

### Names

| Thing                       | Name                                           |
| --------------------------- | ---------------------------------------------- |
| App                         | dawg-code                                      |
| Command-line tool           | `dawg`                                         |
| Config directories          | `.dawg/` in a project, `~/.dawg/` for the user |
| Environment variable prefix | `DAWG_`                                        |
| npm scope for packages      | `@dawg/*`                                      |

### Repo and toolchain

- A pnpm workspace with TypeScript in strict mode, ES modules only.
- Vitest for unit and integration tests, Playwright for app end-to-end tests, Biome for lint and formatting.
- The Node version is the one bundled with the pinned Electron release. `packages/*` must run on plain Node with no Electron imports, so the engine also works headless.
- Layout as in PLAN.md section 5: `apps/desktop`, `packages/{protocol,engine,compat,models,cli}`, `evals/`, `catalog/`.

### Processes

| Process       | Runs                                                             | Notes                                                              |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Main          | Electron main: windows, menus, terminals, updater, model manager | Thin; no agent logic                                               |
| Renderer      | The React UI                                                     | Sandboxed, no Node access                                          |
| Engine host   | `packages/engine`, hosting every open session                    | An Electron utility process in the app; the CLI runs it in-process |
| Runtime       | `llama-server`                                                   | One child process, owned by the model manager                      |
| Tool children | Shell commands, hooks, MCP servers                               | Spawned by the engine host                                         |

### The engine protocol

The UI, the CLI and the tests all talk to the engine through one protocol, defined as schemas in `packages/protocol` (the source of truth for the TypeScript types).

- **Framing:** JSON-RPC 2.0 messages. In the app they travel over a message port; headless, as newline-delimited JSON on stdio.
- **Requests** go from client to engine: create or resume a session, send a prompt, interrupt, change mode or model, answer a permission request.
- **Events** go from engine to client as notifications: text and reasoning deltas, tool started / progress / finished, permission requested, plan proposed, task list updated, usage updated, compaction, session status, errors.
- **Versioning:** the protocol carries a version number. Additive changes keep it; breaking changes bump it.

Phase 2 owns the full definition. Phase 3 consumes it.

### Where data lives

```
~/.dawg/
  settings.json               user settings
  state.json                  app state: window layout, recent projects
  projects/<project-key>/     one folder per project; the key is the project path
    sessions/<id>.jsonl         with non-alphanumeric characters replaced by "-"
    sessions/<id>/subagents/    subagent transcripts
    sessions/<id>/tool-results/ large tool outputs spilled to files
    file-history/<id>/          checkpoints
    memory/                     auto memory
  runtime/slots/              saved prompt caches
  plans/                      plan-mode documents
  logs/
~/.cache/huggingface/hub/     model files, in the standard shared layout
<project>/.dawg/
  settings.json               shared project settings (committed)
  settings.local.json         personal project settings (not committed)
  worktrees/                  per-session git worktrees
```

Anything under `.claude/` or `~/.claude/` is read, never written.

### Security baseline

- The runtime listens on 127.0.0.1 only, on a random port, behind a per-launch API key passed by file, not on the command line.
- The renderer runs with context isolation and the sandbox on, and no Node integration. It reaches the system only through a typed preload API whose inputs are validated against schemas.
- No remote code or remote pages in the main window. Rendered markdown is sanitized.
- Secrets (OAuth tokens, API keys) go in the macOS Keychain, never in settings files or logs.
- No telemetry by default.

### Testing baseline

- Every package has unit tests. CI runs lint, type-check and tests on every push.
- Anything that talks to a model has a test against a **mock model server**: a small scripted OpenAI-compatible server that replays fixed responses, so loop and UI tests are deterministic.
- Changes to prompts, tool descriptions or tool behaviour are also judged on the eval suite from Phase 0.

### Clean-room rule

The behaviour reference is Claude Code's public documentation and our own testing. No spec, prompt, test or implementation is derived from Claude Code's source. Where a spec says "as documented", it means the public docs listed in PLAN.md section 14, re-read at implementation time, since they change.

### Hardware assumption

Specs assume the reference machine in PLAN.md section 10: Apple Silicon with 64 GB or more. Nothing is designed down for smaller machines.
